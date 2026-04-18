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


EXTRACTION_SYSTEM_PROMPT = """You extract DURABLE, RETRIEVABLE memories from a user↔assistant conversation turn.

Return a JSON object with this exact schema:
{
  "memories": [
    {
      "content": "self-contained sentence",
      "memory_type": "fact|preference|observation|note",
      "memory_subject": "user|assistant",
      "importance": "high|medium|low",
      "event_date_start": "YYYY-MM-DD" or null,
      "event_date_end": "YYYY-MM-DD" or null,
      "entities": ["entity name 1", "entity name 2"]
    }
  ]
}

═══════════════════════════════════════════════════════════════
WHAT TO EXTRACT — FOUR EQUAL-PRIORITY CATEGORIES
═══════════════════════════════════════════════════════════════
All four matter equally. Do not skip any kind just because others are present.

1. **USER FACTS** — things the user states about themselves, their world, events.
   "I picked up my Dell XPS 13 on Jan 28" → User picked up Dell XPS 13 on 2026-01-28.

2. **USER PREFERENCES** — likes, dislikes, opinions, stated habits.
   "I prefer Python 3.11 over 3.10" → User prefers Python 3.11 over Python 3.10.
   PREFERENCES ARE AS IMPORTANT AS DATED EVENTS — extract them eagerly.

3. **ASSISTANT-STATED FACTS** — information the assistant shared that the user may be asked about later.
   "The assistant said: Python 3.12 introduced the `type` statement"
   → Python 3.12 introduced the `type` statement (assistant-stated).
   Use memory_subject="assistant" for these. DO NOT skip assistant statements.

4. **OBSERVATIONS** — inferences from behavior or mentions ("User often works late on Fridays").

DO NOT extract: transient task state, small-talk, generic acknowledgments ("got it", "thanks"), things widely known.
Each memory is a SINGLE standalone sentence — no pronouns referring to prior turns.
If the turn has nothing worth remembering, return {"memories": []}.

═══════════════════════════════════════════════════════════════
memory_subject — USER OR ASSISTANT
═══════════════════════════════════════════════════════════════
- "user"      — the fact is ABOUT the user or STATED by the user about themselves/the world
- "assistant" — the fact was PROVIDED by the assistant (e.g., a factual claim, recommendation, definition)

Always set memory_subject. When in doubt, ask: "if someone asks 'what did the user say about X' or 'what did the assistant tell me about X', which memory would answer it?"

═══════════════════════════════════════════════════════════════
memory_type GUIDE
═══════════════════════════════════════════════════════════════
  fact         — objective statement ("User lives in SF", "Python 3.12 released in Oct 2023")
  preference   — like/dislike/opinion/habit ("User prefers Python 3.11")
  observation  — inferred pattern ("User often works late on Fridays")
  note         — freeform, use sparingly

═══════════════════════════════════════════════════════════════
WHEN A MEMORY IS A DATED EVENT
═══════════════════════════════════════════════════════════════
For dated events, aim to capture as many of these as the source mentions:
  WHAT   — the action or fact itself
  WHEN   — absolute date if possible, or relative resolved via session_date
  WHERE  — location if mentioned
  WHO    — every person/entity involved
  WHY    — motivation, outcome, emotion if stated

Denser memories retrieve better than sparse ones — but never invent detail that isn't in the source.

For NON-EVENT memories (preferences, identity facts, assistant-stated info), skip the 5-dim template.
Write the clearest single-sentence version of the fact. Example:

  Turn: "I prefer Python 3.11"
  → "User prefers Python 3.11 over other versions." (fact-sentence, no event structure)

═══════════════════════════════════════════════════════════════
TEMPORAL FIELDS (event_date_start / event_date_end)
═══════════════════════════════════════════════════════════════
Only set these when the memory describes a specific dated event.
Leave null for preferences, identity facts, assistant-stated generic facts.

Single-day event: both fields equal.  Date range: start < end.

Resolution rules (when session_date is provided):
  - ABSOLUTE date ("January 28th", "March 3, 2026") → use directly
  - RELATIVE date ("last week", "two weeks ago") → resolve to absolute: session_date MINUS the offset
      ex: session_date = 2026-03-17, "two weeks ago" → 2026-03-03
  - NO session_date available → leave null; preserve phrase inside content
  - DURATION ("for 3 weeks", "since February") → preserve in content, dates optional

Also preserve every date reference inside `content` verbatim even after emitting the structured fields.

═══════════════════════════════════════════════════════════════
ENTITIES
═══════════════════════════════════════════════════════════════
For every memory, list the key named things it refers to in `entities`:
  - Products ("Dell XPS 13", "Samsung Galaxy S22")
  - Places ("Apple Store", "St. Mary's Church", "Berlin")
  - People ("Rachel", "Tom", "Dr. Smith")
  - Events/groups ("Holi", "Page Turners book club")
  - Specific items ("The Nightingale", "Adidas running shoes")
  - Topics/technologies ("Python 3.11", "PostgreSQL")

Exclude bare generic nouns ("phone", "car", "meeting") unless qualified.
Use canonical form when obvious ("Dell XPS 13" not "my laptop").
Include 0–5 entities per memory.

═══════════════════════════════════════════════════════════════
EXAMPLES (covers all 4 categories)
═══════════════════════════════════════════════════════════════

### USER FACT (dated event)
Turn: USER: "I picked up my Dell XPS 13 on January 28th"  (session_date 2026-02-01)
→ {
    "content": "On January 28, 2026, user picked up their new Dell XPS 13 laptop.",
    "memory_type": "fact", "memory_subject": "user", "importance": "high",
    "event_date_start": "2026-01-28", "event_date_end": "2026-01-28",
    "entities": ["Dell XPS 13"]
  }

### USER PREFERENCE (no date)
Turn: USER: "I prefer Python 3.11 over 3.10 for the type inference"
→ {
    "content": "User prefers Python 3.11 over Python 3.10 because of the type inference.",
    "memory_type": "preference", "memory_subject": "user", "importance": "high",
    "event_date_start": null, "event_date_end": null,
    "entities": ["Python 3.11", "Python 3.10"]
  }

### ASSISTANT-STATED FACT (important!)
Turn: USER: "what's the capital of Portugal?"
      ASSISTANT: "The capital of Portugal is Lisbon, which sits along the Tagus River."
→ {
    "content": "The capital of Portugal is Lisbon, located along the Tagus River. (Assistant-stated fact.)",
    "memory_type": "fact", "memory_subject": "assistant", "importance": "medium",
    "event_date_start": null, "event_date_end": null,
    "entities": ["Portugal", "Lisbon", "Tagus River"]
  }

### ASSISTANT RECOMMENDATION (also extract!)
Turn: ASSISTANT: "For that Rust cross-compile problem I'd try cargo-zigbuild — it handles arm64 cleanly."
→ {
    "content": "Assistant recommended cargo-zigbuild for Rust arm64 cross-compilation.",
    "memory_type": "fact", "memory_subject": "assistant", "importance": "high",
    "event_date_start": null, "event_date_end": null,
    "entities": ["cargo-zigbuild", "Rust", "arm64"]
  }

### MULTIPLE MEMORIES FROM ONE TURN
Turn: USER: "I'm a backend engineer, mostly Go, and I just moved to Berlin last week."  (session_date 2026-04-10)
→ {
    "memories": [
      {
        "content": "User is a backend engineer.",
        "memory_type": "fact", "memory_subject": "user", "importance": "high",
        "entities": []
      },
      {
        "content": "User primarily works with Go.",
        "memory_type": "preference", "memory_subject": "user", "importance": "high",
        "entities": ["Go"]
      },
      {
        "content": "On 2026-04-03 (a week before 2026-04-10), user moved to Berlin.",
        "memory_type": "fact", "memory_subject": "user", "importance": "high",
        "event_date_start": "2026-04-03", "event_date_end": "2026-04-03",
        "entities": ["Berlin"]
      }
    ]
  }

═══════════════════════════════════════════════════════════════
IMPORTANCE
═══════════════════════════════════════════════════════════════
  high   — identity, explicit preferences, dated events, key relationships, major assistant answers
  medium — useful situational context, general assistant-provided info
  low    — minor details, filler assistant statements
"""


class MemoryService:
    def __init__(self):
        self.repo = MemoryRepository()
        self.experience_repo = ExperienceRepository()
        self.embedding = get_embedding_service()
        settings = get_settings()
        self._openai = OpenAI(api_key=settings.openai_api_key)
        # Configurable via settings.extraction_model (env: PLURUM_EXTRACTION_MODEL)
        self._extraction_model = settings.extraction_model

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
            # Log at ERROR so failures are visible in Vercel logs. A silent
            # swallow here is how we wasted a 6-hour benchmark run.
            logger.error(
                "Memory extraction failed (model=%s): %s",
                self._extraction_model, e,
            )
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
            # Merge entities + memory_subject into metadata so they're
            # retrievable without additional schema changes.
            cand_metadata = dict(metadata or {})
            entities = cand.get("entities") or []
            if isinstance(entities, list) and entities:
                cand_metadata["entities"] = [
                    e.strip() for e in entities if isinstance(e, str) and e.strip()
                ]
            memory_subject = cand.get("memory_subject")
            if memory_subject in ("user", "assistant"):
                cand_metadata["memory_subject"] = memory_subject

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
        """Hybrid search over the user's memories (vector + keyword + entity, RRF-fused, reranked)."""
        embedding = self.embedding.generate_embedding(query[:8000])
        # Extract entities from the query so the RPC can run the entity arm.
        query_entities = self._extract_query_entities(query)
        results = self.repo.search(
            user_id=user_id,
            query_text=query,
            query_embedding=embedding,
            match_count=limit,
            memory_type=memory_type,
            query_entities=query_entities,
        )
        return {
            "query": query,
            "query_entities": query_entities,
            "results": results,
            "total_found": len(results),
        }

    # -----------------------------------------------------------------------
    # Query entity extraction (for entity retrieval arm)
    # -----------------------------------------------------------------------

    _QUERY_ENTITY_PROMPT = (
        "Extract named entities from this search query. Return ONLY a JSON object "
        "of the form {\"entities\": [\"entity1\", \"entity2\"]}. Include products, "
        "places, people, organizations, events, book/movie titles, specific technologies. "
        "Exclude generic nouns (car, phone, meeting) unless qualified. Use canonical "
        "form. Max 5 entities. If none, return {\"entities\": []}."
    )

    def _extract_query_entities(self, query: str) -> list[str]:
        """Light LLM call to pull entities from the search query.

        Cheap: single gpt-4o-mini call with max_tokens=80. Returns empty list on
        any failure — entity arm then becomes a no-op, not a search break.
        """
        if not query or len(query.strip()) < 3:
            return []
        try:
            resp = self._openai.chat.completions.create(
                model="gpt-4o-mini",  # small + fast, quality isn't critical here
                messages=[
                    {"role": "system", "content": self._QUERY_ENTITY_PROMPT},
                    {"role": "user", "content": query[:1000]},
                ],
                response_format={"type": "json_object"},
                temperature=0.0,
                max_tokens=120,
            )
            raw = resp.choices[0].message.content or "{}"
            data = json.loads(raw)
            ents = data.get("entities") or []
            if not isinstance(ents, list):
                return []
            return [
                str(e).strip() for e in ents
                if isinstance(e, (str, int, float)) and str(e).strip()
            ][:5]
        except Exception as e:
            logger.debug("query entity extraction failed: %s", e)
            return []

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
