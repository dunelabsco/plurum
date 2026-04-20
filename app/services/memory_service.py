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
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from openai import OpenAI

from app.config import get_settings
from app.repositories.experience_repo import ExperienceRepository
from app.repositories.memory_repo import MemoryRepository
from app.services.embedding_service import get_embedding_service
from app.services.reranker_service import get_reranker_service

logger = logging.getLogger(__name__)


def _norm_content(s: str) -> str:
    """Normalize a memory content string for dedupe comparison."""
    return " ".join((s or "").lower().split())


def _merge_dedupe(primary: list[dict], extras: list[dict]) -> list[dict]:
    """Append extras to primary, skipping near-duplicates by normalized content.

    Dedupe rule: two memories are duplicates if one's normalized content is a
    prefix of the other's (first 80 chars). This catches the common case where
    the preference extractor emits a shorter restatement of something the main
    extractor already produced.
    """
    seen = [_norm_content(p.get("content", ""))[:80] for p in primary if isinstance(p, dict)]
    merged = list(primary)
    for e in extras:
        if not isinstance(e, dict):
            continue
        key = _norm_content(e.get("content", ""))[:80]
        if not key:
            continue
        if any(key == s or key.startswith(s) or s.startswith(key) for s in seen if s):
            continue
        merged.append(e)
        seen.append(key)
    return merged


def _is_reasoning_model(model: str) -> bool:
    """Reasoning models (gpt-5*, o1*, o3*, o4*) reject `temperature` and
    require `max_completion_tokens` instead of `max_tokens`."""
    if not model:
        return False
    m = model.lower()
    return any(tag in m for tag in ("gpt-5", "o1-", "o3-", "o4-"))


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


PREFERENCE_EXTRACTION_PROMPT = """You find USER PREFERENCES stated or clearly implied in a conversation turn.

A preference is a like, dislike, opinion, stated habit, or stated routine —
anything of the form "user prefers / likes / dislikes / avoids / typically
does / has a habit of / wants". Preferences are often missed by general
extractors because they hide inside narrative or opinion statements.

Return JSON:
{
  "memories": [
    {
      "content": "self-contained sentence naming the preference",
      "memory_type": "preference",
      "memory_subject": "user",
      "importance": "high|medium|low",
      "entities": ["entity1", ...]
    }
  ]
}

Rules:
  - Only emit memory_type="preference"; nothing else.
  - Always memory_subject="user" (this prompt is for user preferences).
  - If the turn contains no preference, return {"memories": []}.
  - A single turn can yield several preferences — emit all of them.
  - Be eager, not conservative. If the user says "I really love X" or
    "I always do Y" or "X over Y" or "I can't stand Z", that's a preference.
  - entities: products, places, people, technologies, topics, specific items.

Examples:
  "I only drink oat milk in coffee" → pref: "User prefers oat milk in coffee."
  "Rust > Go for me" → pref: "User prefers Rust over Go."
  "I usually run on weekends" → pref: "User typically runs on weekends."
  "Hate vertical monitors" → pref: "User dislikes vertical monitors."
"""


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
WHEN A MEMORY IS A DATED EVENT — 5-DIMENSION MANDATE
═══════════════════════════════════════════════════════════════
If a memory describes a specific dated event, the `content` sentence MUST
incorporate every dimension below that the source mentions. This is not
optional — temporal-reasoning retrieval depends on these signals being
present in the embedded text, not inferred from metadata.

  WHAT   — the action or fact itself (REQUIRED, always present)
  WHEN   — absolute date (REQUIRED if the source gives any time reference;
           resolve relative times like "last week" via session_date)
  WHERE  — location (REQUIRED if mentioned — do not drop it)
  WHO    — every person/entity involved (REQUIRED if mentioned)
  WHY    — motivation, outcome, emotion (REQUIRED if stated)

Rules:
  - If the source mentions a dimension, it MUST appear in the content sentence.
  - Never invent a dimension that isn't in the source.
  - A date reference anywhere in the source makes this a dated event — capture
    WHEN in both the sentence and event_date_start/end.
  - Denser single-sentence memories retrieve dramatically better than sparse ones.

For NON-EVENT memories (preferences, identity facts, assistant-stated generic
info), skip the 5-dim template. Write the clearest single-sentence version
of the fact. Example:

  Turn: "I prefer Python 3.11"
  → "User prefers Python 3.11 over other versions." (fact-sentence, no event structure)

### DATED EVENT — GOOD vs BAD
Turn: USER: "I met Rachel at the Apple Store on Jan 28 to pick up my Dell XPS 13 — she was thrilled."  (session_date 2026-02-01)

BAD (drops WHO, WHERE, WHY):
  "On January 28, 2026, user picked up their Dell XPS 13."

GOOD (all 5 dims):
  "On January 28, 2026, user met Rachel at the Apple Store to pick up their new Dell XPS 13; Rachel was thrilled."

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
    # Fetch this many candidates from the repo before the LLM reranker picks
    # the final top_k. 30 is a good balance — enough for the cross-encoder to
    # find buried gems, small enough to fit comfortably in a single rerank call.
    _RERANK_POOL_SIZE = 30

    def __init__(self):
        self.repo = MemoryRepository()
        self.experience_repo = ExperienceRepository()
        self.embedding = get_embedding_service()
        self.reranker = get_reranker_service()
        settings = get_settings()
        # max_retries handles 429/5xx/network transient failures automatically.
        # Same resilience as the embedding service (see _with_retry there).
        self._openai = OpenAI(api_key=settings.openai_api_key, max_retries=5)
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

        # Run the main extractor and the preference extractor in parallel —
        # they're independent LLM calls and together are ~2x extract latency
        # when run serially. ThreadPoolExecutor works because the OpenAI SDK
        # releases the GIL during network IO.
        with ThreadPoolExecutor(max_workers=2) as pool:
            main_future = pool.submit(self._run_main_extraction, user_msg)
            pref_future = pool.submit(
                self._extract_preferences, user_content, assistant_content
            )
            candidates = main_future.result() or []
            pref_candidates = pref_future.result() or []

        if not isinstance(candidates, list):
            candidates = []

        if pref_candidates:
            candidates = _merge_dedupe(candidates, pref_candidates)

        if not candidates:
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

        # First pass: build rows without supersession info.
        rows = []
        per_row_entities: list[list[str]] = []
        per_row_types: list[str] = []
        per_row_subjects: list[Optional[str]] = []
        for cand, content, emb in zip(valid_candidates, contents, embeddings):
            cand_metadata = dict(metadata or {})
            entities = cand.get("entities") or []
            clean_entities: list[str] = []
            if isinstance(entities, list):
                clean_entities = [
                    e.strip() for e in entities if isinstance(e, str) and e.strip()
                ]
                if clean_entities:
                    cand_metadata["entities"] = clean_entities
            memory_subject = cand.get("memory_subject")
            if memory_subject in ("user", "assistant"):
                cand_metadata["memory_subject"] = memory_subject

            memory_type = cand.get("memory_type", "fact")

            row = {
                "user_id": str(user_id),
                "content": content,
                "memory_type": memory_type,
                "importance": cand.get("importance", "medium"),
                "metadata": cand_metadata,
                "embedding": emb,
                "source_user": user_content[:2000],
                "source_assistant": assistant_content[:2000],
            }

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
            per_row_entities.append(clean_entities)
            per_row_types.append(memory_type)
            per_row_subjects.append(memory_subject)

        # Second pass: parallel supersession lookups. Each check is a single
        # Supabase RPC round-trip; running them concurrently keeps total
        # latency flat regardless of candidate count.
        to_supersede: list[str] = []
        supersede_targets: list[Optional[str]] = [None] * len(rows)
        lookup_indices = [
            i for i, t in enumerate(per_row_types)
            if t in ("fact", "preference") and per_row_entities[i]
        ]
        if lookup_indices:
            def _lookup(i: int) -> tuple[int, Optional[dict]]:
                parent = self._find_supersedable(
                    user_id=user_id,
                    content=rows[i]["content"],
                    embedding=rows[i]["embedding"],
                    entities=per_row_entities[i],
                    memory_type=per_row_types[i],
                    memory_subject=per_row_subjects[i],
                )
                return i, parent

            with ThreadPoolExecutor(max_workers=min(4, len(lookup_indices))) as pool:
                for i, parent in pool.map(_lookup, lookup_indices):
                    if parent:
                        supersede_targets[i] = parent["id"]

        for i, parent_id in enumerate(supersede_targets):
            if parent_id:
                rows[i]["parent_memory_id"] = parent_id
                to_supersede.append(parent_id)

        # Insert; retry without parent_memory_id if migration 022 isn't applied.
        try:
            saved = self.repo.create_batch(rows)
        except Exception as e:
            err = str(e).lower()
            if "parent_memory_id" in err or "schema cache" in err or "column" in err:
                logger.info(
                    "create_batch failed with column error — retrying without "
                    "parent_memory_id (migration 022 pending?): %s", e,
                )
                for r in rows:
                    r.pop("parent_memory_id", None)
                to_supersede = []
                saved = self.repo.create_batch(rows)
            else:
                raise

        # Soft-delete the prior versions so stale facts drop out of retrieval.
        for parent_id in to_supersede:
            try:
                self.repo.soft_delete(UUID(parent_id), user_id)
            except Exception as e:
                logger.warning("Failed to soft-delete superseded memory %s: %s", parent_id, e)

        return saved

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
        """Hybrid search + LLM cross-encoder rerank.

        Stage 1: repo.search fetches `_RERANK_POOL_SIZE` candidates via the
        3-way RRF RPC (vector + keyword + entity).
        Stage 2: RerankerService scores each candidate against the query
        with gpt-4o-mini and returns the top `limit`.
        """
        embedding = self.embedding.generate_embedding(query[:8000])
        # Extract entities from the query so the RPC can run the entity arm.
        query_entities = self._extract_query_entities(query)
        pool = self.repo.search(
            user_id=user_id,
            query_text=query,
            query_embedding=embedding,
            match_count=max(limit, self._RERANK_POOL_SIZE),
            memory_type=memory_type,
            query_entities=query_entities,
        )
        results = self.reranker.rerank(query=query, candidates=pool, top_k=limit)
        return {
            "query": query,
            "query_entities": query_entities,
            "results": results,
            "total_found": len(results),
        }

    # -----------------------------------------------------------------------
    # Main extraction LLM call (separated so it runs in parallel with the
    # preference extractor via ThreadPoolExecutor)
    # -----------------------------------------------------------------------

    def _run_main_extraction(self, user_msg: str) -> list[dict]:
        """Invoke the general extractor; returns candidate memories or []."""
        try:
            is_reasoning = _is_reasoning_model(self._extraction_model)
            kwargs: dict = {
                "model": self._extraction_model,
                "messages": [
                    {"role": "system", "content": EXTRACTION_SYSTEM_PROMPT},
                    {"role": "user", "content": user_msg},
                ],
                "response_format": {"type": "json_object"},
            }
            if is_reasoning:
                kwargs["max_completion_tokens"] = 1200
            else:
                kwargs["temperature"] = 0.2
                kwargs["max_tokens"] = 600
            resp = self._openai.chat.completions.create(**kwargs)
            raw = resp.choices[0].message.content or "{}"
            parsed = json.loads(raw)
            mems = parsed.get("memories", [])
            return mems if isinstance(mems, list) else []
        except Exception as e:
            logger.error(
                "Memory extraction failed (model=%s): %s",
                self._extraction_model, e,
            )
            return []

    # -----------------------------------------------------------------------
    # Supersession (write-time): find a prior memory this new one overrides
    # -----------------------------------------------------------------------

    # Cosine-similarity threshold above which two memories are considered
    # statements of the same underlying fact/preference. Entity overlap is
    # ALSO required — similarity alone overfires on lexically similar but
    # semantically distinct facts ("likes Python" vs "dislikes Python").
    _SUPERSEDE_SIM_THRESHOLD = 0.88

    def _find_supersedable(
        self,
        user_id: UUID,
        content: str,
        embedding: list[float],
        entities: list[str],
        memory_type: str,
        memory_subject: Optional[str],
    ) -> Optional[dict]:
        """Return a prior memory that this new one should supersede, or None.

        Only applies to facts and preferences. Requires both high semantic
        similarity AND at least one shared entity to guard against accidental
        merges of similarly-worded but distinct facts.
        """
        if memory_type not in ("fact", "preference"):
            return None
        if not entities:
            return None
        try:
            candidates = self.repo.search(
                user_id=user_id,
                query_text=content,
                query_embedding=embedding,
                match_count=5,
                memory_type=memory_type,
                query_entities=entities,
            )
        except Exception as e:
            logger.debug("supersede lookup failed: %s", e)
            return None

        entity_set = {e.lower() for e in entities}
        for c in candidates or []:
            sim = c.get("similarity") or 0.0
            if sim < self._SUPERSEDE_SIM_THRESHOLD:
                continue
            cand_meta = c.get("metadata") or {}
            cand_entities = cand_meta.get("entities") or []
            cand_set = {str(e).lower() for e in cand_entities}
            if not (entity_set & cand_set):
                continue
            cand_subj = cand_meta.get("memory_subject")
            if memory_subject and cand_subj and cand_subj != memory_subject:
                continue
            return c
        return None

    # -----------------------------------------------------------------------
    # Preference-dedicated extraction pass
    # -----------------------------------------------------------------------

    def _extract_preferences(
        self,
        user_content: str,
        assistant_content: str,
    ) -> list[dict]:
        """Second pass focused purely on preference recall.

        Uses gpt-4o-mini (not the reasoning model) because the preference
        prompt is simple and latency matters — this runs on every turn.
        Returns [] on any failure so a transient hiccup doesn't break
        extraction overall.
        """
        if not user_content or not user_content.strip():
            return []
        try:
            resp = self._openai.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {"role": "system", "content": PREFERENCE_EXTRACTION_PROMPT},
                    {"role": "user", "content": f"USER:\n{user_content}\n\nASSISTANT:\n{assistant_content}"},
                ],
                response_format={"type": "json_object"},
                temperature=0.1,
                max_tokens=400,
            )
            raw = resp.choices[0].message.content or "{}"
            data = json.loads(raw)
            mems = data.get("memories") or []
            if not isinstance(mems, list):
                return []
            # Force memory_type / memory_subject in case the model drifts.
            cleaned = []
            for m in mems:
                if not isinstance(m, dict) or not (m.get("content") or "").strip():
                    continue
                m["memory_type"] = "preference"
                m["memory_subject"] = "user"
                cleaned.append(m)
            return cleaned
        except Exception as e:
            logger.debug("preference extraction failed: %s", e)
            return []

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
