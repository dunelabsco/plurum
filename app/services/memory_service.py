"""Memory service — personal memory layer.

Handles:
  - Explicit memory writes (user-conscious facts)
  - LLM-based extraction from conversation turns
  - Hybrid search scoped to the user
  - Profile aggregation (memories + top experiences)
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from openai import OpenAI

from app.config import get_settings
from app.repositories.experience_repo import ExperienceRepository
from app.repositories.memory_repo import MemoryRepository
from app.services.embedding_service import get_embedding_service

logger = logging.getLogger(__name__)


def _coerce_iso_date(value) -> Optional[str]:
    """Best-effort coerce an LLM-returned date into an ISO string Postgres can accept.

    Accepts 'YYYY-MM-DD', 'YYYY-MM-DDTHH:MM:SS', datetime, None, empty string.
    Returns None for anything unparseable — we'd rather lose a date than 500.
    """
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    # Common LLM output: "YYYY-MM-DD" → valid Postgres TIMESTAMPTZ literal
    # We don't need to parse; Postgres handles ISO dates directly.
    # Do a light sanity check so we don't submit obvious garbage.
    if len(s) >= 8 and s[:4].isdigit() and s[4] == "-":
        return s
    return None


EXTRACTION_SYSTEM_PROMPT = """You extract DURABLE, RETRIEVABLE memories about a user from a conversation turn.

Return a JSON object with this exact schema:
{
  "memories": [
    {
      "content": "self-contained sentence",
      "memory_type": "fact|preference|observation|note",
      "importance": "high|medium|low",
      "event_date_start": "YYYY-MM-DD" or null,
      "event_date_end": "YYYY-MM-DD" or null,
      "entities": ["entity name 1", "entity name 2"]
    }
  ]
}

═══════════════════════════════════════════════════════════════
CORE PRINCIPLES
═══════════════════════════════════════════════════════════════
- Extract things worth remembering long-term: preferences, stable facts, important events, situational context.
- Do NOT extract: transient task state, routine chit-chat, things already widely known.
- Each memory is a SINGLE standalone sentence — no pronouns referring to prior turns.
- Prefer fewer high-quality memories over many low-value ones.
- If the turn has nothing worth remembering, return {"memories": []}.

═══════════════════════════════════════════════════════════════
5-DIMENSION CAPTURE (WHAT / WHEN / WHERE / WHO / WHY)
═══════════════════════════════════════════════════════════════
For every memory about a dated event, aim to capture all five:

  WHAT  — the action or fact itself ("picked up Dell XPS 13")
  WHEN  — absolute date if possible, or resolved relative date
  WHERE — location if mentioned ("at the Apple Store", "in Berlin")
  WHO   — every person/entity involved ("with her sister Rachel", "from colleague Tom")
  WHY   — motivation, outcome, emotion if stated ("because the old one died")

Dense, information-rich memories retrieve better than sparse ones.

GOOD: "On January 28, 2026, user picked up their new Dell XPS 13 at the Apple Store with her sister Rachel because her old MacBook died."
SPARSE (bad): "User has a new Dell XPS 13."

═══════════════════════════════════════════════════════════════
TEMPORAL FIELDS — STRUCTURED
═══════════════════════════════════════════════════════════════
If the memory describes a specific dated event, emit:
  event_date_start: ISO date of when it started/happened (YYYY-MM-DD)
  event_date_end:   ISO date of when it ended (same as start for single-day events)

Single-day event: both fields equal.  Date range: start < end.  Undated/ongoing: both null.

Resolution rules:
  - ABSOLUTE date ("January 28th", "March 3, 2026") → use that date directly
  - RELATIVE date ("last week", "two weeks ago", "yesterday") + session_date provided
    → resolve to absolute: session_date MINUS the offset
      ex: session_date = 2026-03-17, "two weeks ago" → event_date_start = 2026-03-03
  - RELATIVE date, NO session_date → leave event_date_start/end null but preserve phrase in content
  - DURATION without a date ("for 3 weeks", "since February") → preserve in content, dates optional

Also preserve every date reference inside `content` verbatim, even after emitting structured fields.
The structured fields are additional, not a replacement.

═══════════════════════════════════════════════════════════════
ENTITIES
═══════════════════════════════════════════════════════════════
For every memory, list the key named things it refers to in `entities`:
  - Products ("Dell XPS 13", "Samsung Galaxy S22")
  - Places ("Apple Store", "St. Mary's Church", "Berlin")
  - People ("Rachel", "Tom", "Dr. Smith")
  - Events/groups ("Holi", "Page Turners book club")
  - Specific items ("The Nightingale", "Adidas running shoes")

Exclude generic nouns ("phone", "car", "meeting") unless qualified ("my new car", "the Friday meeting").
Include 0–5 entities per memory. Use canonical form when obvious ("Dell XPS 13" not "my laptop").

═══════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════
Turn: "I picked up my Dell XPS 13 on January 28th"  (session_date 2026-02-01)
→ {
    "content": "On January 28, 2026, user picked up their new Dell XPS 13 laptop.",
    "memory_type": "fact", "importance": "high",
    "event_date_start": "2026-01-28", "event_date_end": "2026-01-28",
    "entities": ["Dell XPS 13"]
  }

Turn: "I started the marigold seeds two weeks ago"  (session_date 2026-03-17)
→ {
    "content": "On March 3, 2026 (two weeks before 2026-03-17), user started marigold seeds at home.",
    "memory_type": "fact", "importance": "medium",
    "event_date_start": "2026-03-03", "event_date_end": "2026-03-03",
    "entities": ["marigolds"]
  }

Turn: "I prefer Python 3.11 over 3.10 for the type inference"
→ {
    "content": "User prefers Python 3.11 over Python 3.10 because of the type inference.",
    "memory_type": "preference", "importance": "high",
    "event_date_start": null, "event_date_end": null,
    "entities": ["Python 3.11", "Python 3.10"]
  }

═══════════════════════════════════════════════════════════════
IMPORTANCE
═══════════════════════════════════════════════════════════════
  high   — identity, explicit preferences, dated events with specific timestamps, key relationships
  medium — useful situational context
  low    — minor details worth storing but unlikely to be asked about
"""


class MemoryService:
    def __init__(self):
        self.repo = MemoryRepository()
        self.experience_repo = ExperienceRepository()
        self.embedding = get_embedding_service()
        settings = get_settings()
        self._openai = OpenAI(api_key=settings.openai_api_key)
        self._extraction_model = "gpt-4o-mini"  # fast + cheap for fact extraction

    # -----------------------------------------------------------------------
    # Explicit create
    # -----------------------------------------------------------------------

    def create(
        self,
        user_id: UUID,
        data: dict,
        agent_id: Optional[UUID] = None,
        session_id: Optional[UUID] = None,
    ) -> dict:
        """Create a single memory with embedding."""
        content = data["content"]
        embedding = self.embedding.generate_embedding(content[:8000])

        row = {
            "user_id": str(user_id),
            "content": content,
            "memory_type": data.get("memory_type", "fact"),
            "importance": data.get("importance", "medium"),
            "metadata": data.get("metadata") or {},
            "embedding": embedding,
        }
        if agent_id:
            row["agent_id"] = str(agent_id)
        if session_id:
            row["session_id"] = str(session_id)
        if data.get("expires_at"):
            row["expires_at"] = data["expires_at"].isoformat() if isinstance(
                data["expires_at"], datetime
            ) else data["expires_at"]

        return self.repo.create(row)

    # -----------------------------------------------------------------------
    # LLM extraction from a turn pair
    # -----------------------------------------------------------------------

    def extract_from_turn(
        self,
        user_id: UUID,
        user_content: str,
        assistant_content: str,
        agent_id: Optional[UUID] = None,
        session_id: Optional[UUID] = None,
        metadata: Optional[dict] = None,
        session_date: Optional[str] = None,
    ) -> list[dict]:
        """Run an LLM pass over a turn to extract durable memories.

        If session_date is provided, the extractor anchors relative time
        references (e.g., "last week") to absolute dates. This is critical
        for temporal-reasoning recall.

        Returns the list of stored memory rows (may be empty).
        """
        date_block = (
            f"SESSION DATE: {session_date.strip()}\n\n"
            f"(Use this date to convert relative times like 'last week' or 'two weeks ago' "
            f"into absolute dates in your extracted memories.)\n\n"
        ) if session_date else ""

        user_msg = (
            f"{date_block}"
            f"USER:\n{user_content}\n\nASSISTANT:\n{assistant_content}"
        )
        try:
            resp = self._openai.chat.completions.create(
                model=self._extraction_model,
                messages=[
                    {"role": "system", "content": EXTRACTION_SYSTEM_PROMPT},
                    {"role": "user", "content": user_msg},
                ],
                response_format={"type": "json_object"},
                temperature=0.2,
                max_tokens=600,
            )
            raw = resp.choices[0].message.content or "{}"
            parsed = json.loads(raw)
            candidates = parsed.get("memories", [])
        except Exception as e:
            logger.warning("Memory extraction failed: %s", e)
            return []

        if not isinstance(candidates, list) or not candidates:
            return []

        # Filter out invalid candidates (missing content)
        valid_candidates = [
            c for c in candidates
            if isinstance(c, dict) and c.get("content") and c["content"].strip()
        ]
        if not valid_candidates:
            return []

        contents = [c["content"].strip() for c in valid_candidates]
        embeddings = self.embedding.generate_embeddings([c[:8000] for c in contents])

        rows = []
        for cand, content, emb in zip(valid_candidates, contents, embeddings):
            # Merge entities into metadata so they're retrievable even before
            # the entity layer lands in Phase 2.
            cand_metadata = dict(metadata or {})
            entities = cand.get("entities") or []
            if isinstance(entities, list) and entities:
                cand_metadata["entities"] = [
                    e.strip() for e in entities if isinstance(e, str) and e.strip()
                ]

            row = {
                "user_id": str(user_id),
                "content": content,
                "memory_type": cand.get("memory_type", "fact"),
                "importance": cand.get("importance", "medium"),
                "metadata": cand_metadata,
                "embedding": emb,
                "source_user": user_content[:2000],
                "source_assistant": assistant_content[:2000],
            }

            # Structured temporal fields (Phase 1 retrieval upgrade)
            eds = _coerce_iso_date(cand.get("event_date_start"))
            ede = _coerce_iso_date(cand.get("event_date_end"))
            if eds:
                row["event_date_start"] = eds
            if ede:
                row["event_date_end"] = ede

            if agent_id:
                row["agent_id"] = str(agent_id)
            if session_id:
                row["session_id"] = str(session_id)
            rows.append(row)

        return self.repo.create_batch(rows)

    # -----------------------------------------------------------------------
    # Reads
    # -----------------------------------------------------------------------

    def get(self, identifier: str, user_id: UUID) -> dict:
        return self.repo.get_by_identifier(identifier, user_id)

    def list_memories(
        self,
        user_id: UUID,
        memory_type: Optional[str] = None,
        limit: int = 20,
        offset: int = 0,
    ) -> dict:
        items, total = self.repo.list_memories(
            user_id=user_id,
            memory_type=memory_type,
            limit=limit,
            offset=offset,
        )
        return {
            "items": items,
            "total": total,
            "limit": limit,
            "offset": offset,
            "has_more": offset + limit < total,
        }

    def search(
        self,
        user_id: UUID,
        query: str,
        memory_type: Optional[str] = None,
        limit: int = 10,
    ) -> dict:
        """Hybrid search over the user's memories."""
        embedding = self.embedding.generate_embedding(query[:8000])
        results = self.repo.search(
            user_id=user_id,
            query_text=query,
            query_embedding=embedding,
            match_count=limit,
            memory_type=memory_type,
        )
        return {
            "query": query,
            "results": results,
            "total_found": len(results),
        }

    def delete(self, identifier: str, user_id: UUID, hard: bool = False) -> None:
        memory = self.repo.get_by_identifier(identifier, user_id)
        if hard:
            self.repo.hard_delete(UUID(memory["id"]), user_id)
        else:
            self.repo.soft_delete(UUID(memory["id"]), user_id)

    # -----------------------------------------------------------------------
    # Profile aggregation (fast path)
    # -----------------------------------------------------------------------

    def profile(
        self,
        user_id: UUID,
        query: Optional[str] = None,
        memory_limit: int = 10,
        experience_limit: int = 5,
    ) -> dict:
        """
        Fast aggregate for prompt hydration.

        Returns:
          - top personal memories (no semantic query: recency-ordered)
          - top collective experiences matching `query` (if provided)
        """
        memories = self.repo.top_memories(user_id=user_id, limit=memory_limit)

        experiences: list[dict] = []
        if query:
            try:
                q_emb = self.embedding.generate_topic_embedding(topic=query)
                experiences = self.experience_repo.search(
                    query_text=query,
                    query_embedding=q_emb,
                    match_count=experience_limit,
                )
            except Exception as e:
                logger.warning("Profile experience search failed: %s", e)
                experiences = []

        return {
            "user_id": str(user_id),
            "memories": memories,
            "experiences": experiences,
            "memory_count": len(memories),
            "generated_at": datetime.now(timezone.utc),
        }
