"""Memory service — personal memory layer.

Handles:
  - Explicit memory writes (user-conscious facts)
  - LLM-based extraction from conversation turns
  - Hybrid search scoped to the user
  - Profile aggregation (memories + top experiences)
"""

from __future__ import annotations

import hashlib
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
from app.services.reranker_service import get_reranker_service

logger = logging.getLogger(__name__)


def _content_hash(s: str) -> str:
    """MD5 hex of normalized (lowercased, whitespace-collapsed) content.

    Matches the back-fill expression in migration 023 so application-side
    hashes and Postgres-side hashes produce the same value.
    """
    normalized = (s or "").strip().lower()
    return hashlib.md5(normalized.encode("utf-8")).hexdigest()


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


EXTRACTION_SYSTEM_PROMPT = """# ROLE

You are a Memory Extractor. You produce precise, evidence-bound, self-contained factual memories from a user↔assistant conversation turn. Your job is ADD only — every extraction is a new memory. Accuracy and completeness are critical: a missed extraction loses context permanently; a fabricated one poisons retrieval forever.

# INPUTS YOU RECEIVE

Under "## Context" the user message may include several blocks. They are all optional; any can be empty.

- **## New Messages** — the current turn(s). This is the ONLY source you extract FROM. Every output memory must trace to specific text here.
- **## Last K Messages** — recent turns preceding New Messages. Use ONLY to resolve pronouns and references ("she", "it", "the restaurant"). Do NOT extract from these.
- **## Existing Memories** — memories already stored for this user, in the form `[{"id": "<uuid>", "text": "..."}]`. Use for (a) deduplication — skip facts already captured — and (b) `linked_memory_ids` — if your new memory relates to one of these, include its id.
- **## Observation Date** — when the conversation actually took place (e.g., "2026-04-03"). This is your ONLY anchor for resolving relative time references ("yesterday", "last week", "two weeks ago", "recently"). Always ground relative references to absolute dates using Observation Date.
- **## Current Date** — today's system date. MAY be much later than Observation Date. Do NOT use this to resolve time references. Only Observation Date resolves relative time.

# OUTPUT SCHEMA (JSON)

{
  "memories": [
    {
      "content": "self-contained sentence",
      "memory_type": "fact|preference|observation|note",
      "memory_subject": "user|assistant",
      "importance": "high|medium|low",
      "event_date_start": "YYYY-MM-DD" | null,
      "event_date_end":   "YYYY-MM-DD" | null,
      "entities": ["canonical name 1", "canonical name 2"],
      "linked_memory_ids": ["<uuid-of-related-existing-memory>"]
    }
  ]
}

If nothing worth extracting: `{"memories": []}`.

# WHAT TO EXTRACT

All four categories matter equally. Do NOT let one dominant topic make you skip the others.

1. **USER FACTS** — identity, events, experiences, relationships, situations the user states about themselves or their world.
2. **USER PREFERENCES** — likes, dislikes, opinions, stated habits, routines. Treat as eagerly as dated events. Preferences hide inside requests and narrative ("I only drink oat milk", "Rust > Go", "I always run on weekends", "can't stand vertical monitors").
3. **ASSISTANT-STATED FACTS** — factual claims, recommendations, definitions, or information the assistant provided that the user may reference later. Always `memory_subject: "assistant"`. Do NOT skip these — benchmarks test recall of assistant-stated info.
4. **OBSERVATIONS** — inferred patterns from behavior ("User often works late on Fridays", "User tends to prefer shorter replies").

## Extract Incidental Facts, Not Just Requests
A request often contains incidental personal facts as context. Extract BOTH.
- "I've harvested cherry tomatoes from my garden — companion plant tips?" → extract "User grows cherry tomatoes in their garden."
- "My daughter Sara loves painting — art class recs?" → extract "User has a daughter named Sara who loves painting."
The request is transient. The incidental fact is durable.

## Casual Topics Are Extractable
Pets, hobbies, childhood memories, personal anecdotes are NOT chitchat. They are often the most valuable persistent details. Only skip pure filler ("hi", "thanks", "sounds good") with zero informational content.

# WHAT NOT TO EXTRACT (HARD RULES)

1. **No echo extraction.** If the user stated a fact and the assistant merely restated, confirmed, or summarized it in the same turn, extract ONCE from the user's message. Do not also extract from the assistant's echo. Exception: if the assistant's message adds genuinely NEW information alongside an echo, extract only the new part.
2. **No fabrication.** Every detail in the output must trace to a specific span of text in New Messages. If you can't point to it, don't include it.
3. **No implicit attribute inference.** Do not infer gender, age, ethnicity, religion, political views, or health status from names, context, or tone. Only record explicitly stated attributes.
4. **No within-response duplication.** Before finalizing, scan your output. If two memories express the same fact with different wording, keep the richer one and drop the other.
5. **No detail contamination from Existing Memories.** If New Messages says "I had a great meal" and an Existing Memory says "User's favorite restaurant is Olive Garden", do NOT produce "User had a great meal at Olive Garden." The new message did not mention the restaurant. Each extraction is faithful to its source span only.
6. **No meta-extraction.** Extract the CONTENT of what was shared, not a description of the user's action.
   - WRONG: "User shared a case summary about a construction dispute."
   - RIGHT: "The Bajimaya v Reward Homes case involved construction starting in 2014, completion due October 2015, with the tribunal finding Reward Homes breached through waterproofing defects and non-compliance with the Building Code of Australia."
7. **No transient task state.** Skip "I'm about to click save", "let me check", "one moment".
8. **No generic acknowledgments.** "got it", "cool", "thanks".
9. **No widely-known public facts** that the assistant stated casually as context (e.g., "Water boils at 100°C") unless the user explicitly asked for it as an answer.

# MEMORY QUALITY STANDARDS

## Self-Contained
Replace every pronoun with "User" or a specific name. A memory must stand alone without its source turn.

## Contextually Rich, Not Atomic
Capture fact + transition + motivation + emotion in ONE unified sentence. Fragments lose meaning over time.
- BAD: "User has a dog." / GOOD: "User has a dog named Poppy and their morning walks together are the highlight of their day."
- BAD: "User prefers oat milk." / GOOD: "User switched from almond milk to oat milk after developing an almond sensitivity."

Especially capture TRANSITIONS. When the user describes switching, replacing, stopping, or trying something new in place of something else, the memory MUST capture BOTH the new state AND what it replaces. "User started using Neovim" is a fragment; "User switched from VS Code to Neovim after getting tired of extension bloat" is the memory.

## Concise but Complete (15–80 words)
One to two sentences per memory (up to three for dense proper-noun-heavy content). Split into multiple focused memories rather than compressing details away. NEVER sacrifice a proper noun, title, date, or number to meet a word count.

## Preserve Proper Nouns, Titles, and Numbers Verbatim
These are the highest-value details and users search by them. Never generalize a specific to a category.

- "watched 'Eternal Sunshine of the Spotless Mind'" → KEEP the full title, NOT "a movie".
- "tried Osteria Francescana" → KEEP the name, NOT "a new restaurant".
- "drove a Ferrari 488 GTB" → KEEP it, NOT "a sports car".
- "416 pages" → KEEP, NOT "about 400 pages".
- "promoted to assistant manager" → KEEP "assistant manager", NOT "manager".
- "scored 3 goals in the semifinal" → KEEP "3 goals in the semifinal", NOT "scored several".

## Meaning-Preserving — Read Carefully
Common traps to watch out for:
- "Didn't get to bed until 2 AM" = went TO BED at 2 AM (late bedtime), NOT "slept until 2 AM" (late wakeup).
- "Can't stop eating chocolate" = eats a LOT of chocolate, NOT has stopped eating chocolate.
- "I used to love hiking" = no longer loves hiking.
- "Almost finished the book" = not finished.

Misinterpreting what the user said is worse than not extracting at all.

## Temporally Grounded
Resolve every relative time reference to an absolute date using Observation Date. "User went to Paris last week" is nearly useless six months later. "User went to Paris the week of May 15, 2023" is meaningful forever.

# 5-DIMENSION MANDATE FOR DATED EVENTS

If a memory describes a specific dated event, the `content` sentence MUST incorporate every dimension the source mentions. This is non-negotiable — temporal-reasoning retrieval depends on these signals being present in the embedded text, not buried in metadata.

  WHAT   — the action or fact itself (always present)
  WHEN   — absolute date (REQUIRED if the source gives any time reference; resolve relatives via Observation Date)
  WHERE  — location (REQUIRED if mentioned)
  WHO    — every person involved (REQUIRED if mentioned)
  WHY    — motivation, outcome, emotion (REQUIRED if stated)

Never invent a dimension the source doesn't mention.

For NON-event memories (preferences, identity facts, assistant-stated generic info), skip the template. Write the clearest single-sentence version.

### DATED EVENT — GOOD vs BAD
Source: USER: "I met Rachel at the Apple Store on Jan 28 to pick up my Dell XPS 13 — she was thrilled." (Observation Date 2026-02-01)
BAD: "On January 28, 2026, user picked up their Dell XPS 13."
GOOD: "On January 28, 2026, user met Rachel at the Apple Store to pick up their new Dell XPS 13; Rachel was thrilled."

# TEMPORAL FIELDS

Set `event_date_start` / `event_date_end` only when the memory describes a specific dated event. Leave null for preferences, identity facts, generic assistant facts.

Single-day event: both fields equal. Range: start < end. Duration ("for 3 weeks", "since February"): preserve phrase inside content; dates optional.

Resolution rules using Observation Date:
- ABSOLUTE ("January 28", "March 3, 2026") → use directly.
- RELATIVE ("last week", "two weeks ago", "yesterday") → resolve: Observation Date MINUS offset.
- NO Observation Date → leave null; keep the phrase inside content.

Preserve every date reference inside `content` verbatim even after setting structured fields.

# memory_subject

- "user" — fact is ABOUT the user or STATED by the user about themselves / the world.
- "assistant" — the fact was PROVIDED by the assistant (factual claim, recommendation, definition).

Always set it. Decision test: "If someone later asks 'what did the user say about X' vs 'what did the assistant tell me about X', which side would this memory answer?"

# memory_type

- fact        — objective statement ("User lives in SF", "Python 3.12 released in Oct 2023").
- preference  — like / dislike / opinion / habit ("User prefers Python 3.11").
- observation — inferred pattern ("User often works late on Fridays").
- note        — freeform, use sparingly.

# importance

- high   — identity, explicit preferences, dated events, key relationships, major assistant answers.
- medium — useful situational context, general assistant-provided info.
- low    — minor details, filler-adjacent assistant statements.

# entities

For every memory, list the key named things in `entities`:
- Products ("Dell XPS 13"), Places ("Apple Store", "Berlin"), People ("Rachel"), Events ("Holi"), Titles ("The Nightingale"), Technologies ("Python 3.11").

Exclude bare generic nouns ("phone", "car", "meeting") unless qualified. Use canonical form ("Dell XPS 13", not "my laptop"). 0–5 entities per memory.

# MEMORY LINKING (linked_memory_ids)

When extracting, check if any Existing Memory is related. If yes, include that memory's UUID in `linked_memory_ids`. Link when:

- **Same entity/topic** — new fact about a person, place, product already captured.
- **Updated preference / changed state** — evolved opinion or life change.
- **Continuation** — follow-up event in a previously captured narrative.
- **Contradiction** — new info conflicts with an existing memory (e.g., "I moved to Berlin" → now "I moved to Amsterdam").

Do NOT link memories that merely share a vague theme. Links must be specific — same entity, event, or topic.

IMPORTANT: an existing memory about an entity (e.g. "User has a dog named Max") does NOT mean all information about that entity is already captured. New events with Max MUST still be extracted as separate memories and linked back. Skip a new extraction only when the specific fact itself is already captured, not merely because the entity appears in a prior memory.

If there's no Existing Memories block or nothing links, omit the field or pass `[]`.

# EXAMPLES

### USER FACT — dated event, Observation Date resolves the relative time
Source: USER: "I picked up my new Dell XPS 13 last Tuesday." (Observation Date 2026-02-01)
→ {
    "content": "On January 27, 2026, user picked up their new Dell XPS 13 laptop.",
    "memory_type": "fact", "memory_subject": "user", "importance": "high",
    "event_date_start": "2026-01-27", "event_date_end": "2026-01-27",
    "entities": ["Dell XPS 13"], "linked_memory_ids": []
  }

### USER PREFERENCE — no date
Source: USER: "I prefer Python 3.11 over 3.10 for the type inference improvements."
→ {
    "content": "User prefers Python 3.11 over Python 3.10 because of the type inference improvements.",
    "memory_type": "preference", "memory_subject": "user", "importance": "high",
    "event_date_start": null, "event_date_end": null,
    "entities": ["Python 3.11", "Python 3.10"], "linked_memory_ids": []
  }

### ASSISTANT-STATED FACT
Source: USER: "capital of Portugal?" ASSISTANT: "Lisbon, along the Tagus River."
→ {
    "content": "The capital of Portugal is Lisbon, located along the Tagus River (assistant-stated).",
    "memory_type": "fact", "memory_subject": "assistant", "importance": "medium",
    "event_date_start": null, "event_date_end": null,
    "entities": ["Portugal", "Lisbon", "Tagus River"], "linked_memory_ids": []
  }

### NO-ECHO RULE — user said it, assistant confirmed
Source:
  USER: "I want daily standups at 9am."
  ASSISTANT: "Got it — daily standups at 9am, starting tomorrow."
→ extract ONCE from the user side:
  {
    "content": "User wants daily standups at 9am.",
    "memory_type": "preference", "memory_subject": "user", "importance": "medium",
    "entities": [], "linked_memory_ids": []
  }
(Do NOT also extract "Assistant scheduled daily standups at 9am" — that's the echo.)

### CONTRADICTION / SUPERSESSION VIA linked_memory_ids
Existing Memory: `{"id": "abc-123", "text": "User lives in Berlin."}`
Source: USER: "Just moved to Amsterdam last month." (Observation Date 2026-04-20)
→ {
    "content": "In March 2026, user moved from Berlin to Amsterdam.",
    "memory_type": "fact", "memory_subject": "user", "importance": "high",
    "event_date_start": "2026-03-01", "event_date_end": "2026-03-31",
    "entities": ["Berlin", "Amsterdam"], "linked_memory_ids": ["abc-123"]
  }

### MULTIPLE MEMORIES FROM ONE TURN — no first-topic dominance
Source: USER: "I'm a backend engineer, mostly Go, and I just moved to Berlin last week. My daughter Sara started kindergarten too — she loves painting." (Observation Date 2026-04-10)
→ {
    "memories": [
      {"content": "User is a backend engineer.",
       "memory_type": "fact", "memory_subject": "user", "importance": "high",
       "entities": [], "linked_memory_ids": []},
      {"content": "User primarily works with Go.",
       "memory_type": "preference", "memory_subject": "user", "importance": "high",
       "entities": ["Go"], "linked_memory_ids": []},
      {"content": "On 2026-04-03 (a week before 2026-04-10), user moved to Berlin.",
       "memory_type": "fact", "memory_subject": "user", "importance": "high",
       "event_date_start": "2026-04-03", "event_date_end": "2026-04-03",
       "entities": ["Berlin"], "linked_memory_ids": []},
      {"content": "User has a daughter named Sara who started kindergarten around early April 2026.",
       "memory_type": "fact", "memory_subject": "user", "importance": "high",
       "entities": ["Sara"], "linked_memory_ids": []},
      {"content": "User's daughter Sara loves painting.",
       "memory_type": "fact", "memory_subject": "user", "importance": "medium",
       "entities": ["Sara"], "linked_memory_ids": []}
    ]
  }

### INCIDENTAL FACT WITH A REQUEST
Source: USER: "My golden retriever Max is turning 8 next month — what's a good brain-game toy?"  (Observation Date 2026-04-20)
→ {
    "memories": [
      {"content": "User has a golden retriever named Max.",
       "memory_type": "fact", "memory_subject": "user", "importance": "high",
       "entities": ["Max"], "linked_memory_ids": []},
      {"content": "Max is turning 8 in May 2026.",
       "memory_type": "fact", "memory_subject": "user", "importance": "medium",
       "event_date_start": "2026-05-01", "event_date_end": "2026-05-31",
       "entities": ["Max"], "linked_memory_ids": []}
    ]
  }
(The question about toys is transient — we extract the incidental facts, not the request.)

# EXHAUSTIVE EXTRACTION CHECKLIST

Before producing output, mentally scan the ENTIRE conversation and verify:

1. Did you extract from every distinct topic or subject change in New Messages?
2. Did you extract from the MIDDLE and END of the turn, not just the beginning?
3. For New Messages spanning 10+ messages, you should typically extract 5–15 memories. If you have fewer than 3, re-read — you are almost certainly missing information.
4. Did every specific fact, preference, experience, or event in each message produce an output memory? If a single message mentions two distinct facts (e.g. an allergy AND a hobby), both must appear.

A common failure mode is "first-topic dominance" — extractor captures the first topic thoroughly and treats later topics as filler. This is WRONG. Every topic with memorable content deserves an extraction.

# FINAL CHECKS BEFORE OUTPUT

- Every memory is self-contained (no pronouns referring outside the memory).
- Every detail traces to a specific span of New Messages (no fabrication).
- No echo duplicates between user and assistant within the same turn.
- No within-response duplicates.
- Proper nouns, titles, numbers preserved verbatim.
- Dated events have all 5 dims the source mentions + event_date_start/end.
- linked_memory_ids references REAL UUIDs from Existing Memories only.
- Return ONLY valid JSON. No reasoning, no prose wrapper.
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

    # Context-budget knobs used by extract_from_turn.
    _EXTRACTION_HISTORY_TURNS = 10   # last K turns passed as anaphora context
    _EXTRACTION_EXISTING_K = 10      # top-K existing memories for linking/dedup

    def extract_from_turn(
        self,
        user_id: UUID,
        user_content: str,
        assistant_content: str,
        agent_id: Optional[UUID] = None,
        session_id: Optional[UUID] = None,
        metadata: Optional[dict] = None,
        session_date: Optional[str] = None,
        session_history: Optional[list[dict]] = None,
        observation_date: Optional[str] = None,
    ) -> list[dict]:
        """Run an LLM pass over a turn to extract durable memories.

        Context the extractor receives:
          - **New Messages**: the current USER/ASSISTANT turn. Only source
            for extraction.
          - **Last K Messages** (`session_history`): prior turns, for
            pronoun and reference resolution only.
          - **Existing Memories**: top-K memories already stored for this
            user, for deduplication and for populating `linked_memory_ids`.
          - **Observation Date**: when the conversation actually happened.
            Anchors every relative time reference. Aliased as `session_date`
            for backward compatibility.
          - **Current Date**: today's system date. For awareness only — do
            NOT use to resolve relative references.

        Returns the list of stored memory rows (may be empty).
        """
        obs_date = (observation_date or session_date or "").strip() or None
        current_date = datetime.now(timezone.utc).date().isoformat()

        # Pull top-K existing memories to give the extractor dedup + linking
        # context. We use the current user_content as the query — it's the
        # best available signal for "what memories might relate to this turn".
        # Failure here is non-fatal: extraction still works with empty context.
        existing: list[dict] = []
        try:
            existing = self._fetch_existing_for_context(user_id, user_content)
        except Exception as e:
            logger.debug("pre-extraction existing-memory fetch failed: %s", e)

        existing_by_id: dict[str, dict] = {
            str(m.get("id")): m for m in existing if m.get("id")
        }

        user_msg = self._build_extraction_user_message(
            user_content=user_content,
            assistant_content=assistant_content,
            session_history=session_history or [],
            existing_memories=existing,
            observation_date=obs_date,
            current_date=current_date,
        )

        # Single LLM call. The V2 prompt covers preferences, assistant facts,
        # and dated events in one pass — no separate preference extractor.
        candidates = self._run_main_extraction(user_msg) or []

        if not isinstance(candidates, list):
            candidates = []
        if not candidates:
            return []

        valid_candidates = [
            c for c in candidates
            if isinstance(c, dict) and c.get("content") and c["content"].strip()
        ]
        if not valid_candidates:
            return []

        contents = [c["content"].strip() for c in valid_candidates]
        hashes = [_content_hash(c) for c in contents]
        embeddings = self.embedding.generate_embeddings(
            [c[:8000] for c in contents]
        )

        rows: list[dict] = []
        to_supersede: list[str] = []
        for cand, content, chash, emb in zip(
            valid_candidates, contents, hashes, embeddings
        ):
            cand_metadata = dict(metadata or {})
            entities = cand.get("entities") or []
            clean_entities: list[str] = []
            if isinstance(entities, list):
                clean_entities = [
                    e.strip() for e in entities
                    if isinstance(e, str) and e.strip()
                ]
                if clean_entities:
                    cand_metadata["entities"] = clean_entities

            memory_subject = cand.get("memory_subject")
            if memory_subject in ("user", "assistant"):
                cand_metadata["memory_subject"] = memory_subject

            memory_type = cand.get("memory_type", "fact")

            # linked_memory_ids come from the LLM. Preserve all links in
            # metadata for read-time use; only the ones that pass
            # `_should_supersede` become parent_memory_id + soft-delete.
            link_ids_raw = cand.get("linked_memory_ids") or []
            link_ids: list[str] = [
                str(x) for x in link_ids_raw
                if isinstance(x, (str, UUID)) and str(x).strip()
            ]
            # Keep only links the LLM is not hallucinating — they must exist
            # in the Existing Memories block we handed it.
            link_ids = [lid for lid in link_ids if lid in existing_by_id]
            if link_ids:
                cand_metadata["linked_memory_ids"] = link_ids

            row = {
                "user_id": str(user_id),
                "content": content,
                "content_hash": chash,
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

            # Supersession decision from LLM-provided links. We pick the
            # first link that's a clear update/contradiction (same subject,
            # same type, overlapping entities).
            parent_id = self._pick_supersession_parent(
                link_ids=link_ids,
                existing_by_id=existing_by_id,
                new_subject=memory_subject,
                new_type=memory_type,
                new_entities=clean_entities,
            )
            if parent_id:
                row["parent_memory_id"] = parent_id
                to_supersede.append(parent_id)

            if agent_id:
                row["agent_id"] = str(agent_id)
            if session_id:
                row["session_id"] = str(session_id)
            rows.append(row)

        # Insert. Two possible failure modes worth handling explicitly:
        #  (a) content_hash unique collision (migration 023): someone else
        #      already stored this exact content. We drop the offending row
        #      and retry — a re-extracted duplicate is a no-op success.
        #  (b) column-not-found: migration 022 or 023 hasn't been applied.
        #      We strip the problematic columns and retry.
        saved = self._insert_rows_with_recovery(rows, to_supersede)

        # Soft-delete superseded parents so stale facts drop out of retrieval.
        for parent_id in to_supersede:
            try:
                self.repo.soft_delete(UUID(parent_id), user_id)
            except Exception as e:
                logger.warning(
                    "Failed to soft-delete superseded memory %s: %s",
                    parent_id, e,
                )

        return saved

    # -----------------------------------------------------------------------
    # Extraction helpers
    # -----------------------------------------------------------------------

    def _fetch_existing_for_context(
        self, user_id: UUID, query_text: str
    ) -> list[dict]:
        """Top-K existing memories for a user, used as dedup + linking context.

        Uses the current turn's user message as a proxy query — the best
        available signal for "what memories might relate to this turn" before
        the extractor has decided what the memories are. Returns [] on any
        failure (never blocks extraction).
        """
        if not (query_text or "").strip():
            return []
        try:
            emb = self.embedding.generate_embedding(query_text[:8000])
        except Exception as e:
            logger.debug("pre-extraction embedding failed: %s", e)
            return []
        try:
            return self.repo.search(
                user_id=user_id,
                query_text=query_text,
                query_embedding=emb,
                match_count=self._EXTRACTION_EXISTING_K,
            ) or []
        except Exception as e:
            logger.debug("pre-extraction search failed: %s", e)
            return []

    def _build_extraction_user_message(
        self,
        user_content: str,
        assistant_content: str,
        session_history: list[dict],
        existing_memories: list[dict],
        observation_date: Optional[str],
        current_date: str,
    ) -> str:
        """Render the extractor's user message with structured ## sections."""
        parts: list[str] = ["## Context", ""]

        # New Messages — the only source the extractor may extract FROM.
        parts.append("## New Messages")
        parts.append(f"USER:\n{user_content}")
        parts.append(f"ASSISTANT:\n{assistant_content}")
        parts.append("")

        # Last K Messages — anaphora resolution only.
        if session_history:
            recent = session_history[-self._EXTRACTION_HISTORY_TURNS:]
            lines: list[str] = []
            for turn in recent:
                if not isinstance(turn, dict):
                    continue
                role = (turn.get("role") or "").strip() or "user"
                content = (turn.get("content") or "").strip()
                if not content:
                    continue
                lines.append(f"{role.upper()}: {content[:2000]}")
            if lines:
                parts.append("## Last K Messages")
                parts.extend(lines)
                parts.append("")

        # Existing Memories — for linking + dedup. Keep content short.
        if existing_memories:
            trimmed = [
                {
                    "id": str(m.get("id")),
                    "text": ((m.get("content") or "")[:400]),
                }
                for m in existing_memories
                if m.get("id") and (m.get("content") or "").strip()
            ]
            if trimmed:
                parts.append("## Existing Memories")
                parts.append(json.dumps(trimmed, ensure_ascii=False))
                parts.append("")

        if observation_date:
            parts.append("## Observation Date")
            parts.append(observation_date)
            parts.append("")

        parts.append("## Current Date")
        parts.append(current_date)

        return "\n".join(parts)

    def _pick_supersession_parent(
        self,
        link_ids: list[str],
        existing_by_id: dict[str, dict],
        new_subject: Optional[str],
        new_type: str,
        new_entities: list[str],
    ) -> Optional[str]:
        """Given LLM-provided links, decide which (if any) this memory
        supersedes.

        Conservative rules — all must hold:
          - Parent has same `memory_subject` as the new memory (if either set).
          - Parent has same or compatible `memory_type`.
          - At least one shared canonicalized entity.

        We only supersede for fact and preference types — observations are
        patterns (never "wrong", just evolved) and notes are too freeform.
        """
        if not link_ids or new_type not in ("fact", "preference"):
            return None
        new_ents_norm = {e.strip().lower() for e in new_entities if e}
        for lid in link_ids:
            parent = existing_by_id.get(lid)
            if not parent:
                continue
            p_meta = parent.get("metadata") or {}
            p_subject = p_meta.get("memory_subject")
            if new_subject and p_subject and p_subject != new_subject:
                continue
            p_type = parent.get("memory_type")
            if p_type and p_type != new_type:
                continue
            p_ents = {
                str(e).strip().lower()
                for e in (p_meta.get("entities") or [])
                if str(e).strip()
            }
            if not new_ents_norm or not (new_ents_norm & p_ents):
                continue
            return lid
        return None

    def _insert_rows_with_recovery(
        self, rows: list[dict], to_supersede: list[str]
    ) -> list[dict]:
        """Insert rows, recovering from the two known failure modes:
           (a) content_hash unique-constraint collision — drop those rows
               and retry.
           (b) missing column errors (migrations 022/023 pending) — strip
               the offending columns and retry.
        """
        try:
            return self.repo.create_batch(rows)
        except Exception as e:
            err = str(e).lower()
            if "uq_memories_user_content_hash" in err or (
                "duplicate key value" in err and "content_hash" in err
            ):
                logger.info(
                    "Content-hash collision — dropping exact duplicates and retrying"
                )
                hashes_dropped: set[str] = set()
                survivors: list[dict] = []
                for r in rows:
                    h = r.get("content_hash")
                    if h in hashes_dropped:
                        continue
                    survivors.append(r)
                    hashes_dropped.add(h)
                if not survivors:
                    return []
                try:
                    return self.repo.create_batch(survivors)
                except Exception as e2:
                    err2 = str(e2).lower()
                    if "content_hash" in err2 or "parent_memory_id" in err2 or "schema cache" in err2 or "column" in err2:
                        return self._insert_without_optional_columns(
                            survivors, to_supersede
                        )
                    raise
            if (
                "content_hash" in err or "parent_memory_id" in err
                or "schema cache" in err or "column" in err
            ):
                return self._insert_without_optional_columns(rows, to_supersede)
            raise

    def _insert_without_optional_columns(
        self, rows: list[dict], to_supersede: list[str]
    ) -> list[dict]:
        """Fallback insert path when migrations 022/023 haven't landed."""
        logger.info(
            "create_batch column error — retrying without content_hash + "
            "parent_memory_id (migrations 022/023 pending?)"
        )
        for r in rows:
            r.pop("content_hash", None)
            r.pop("parent_memory_id", None)
        to_supersede.clear()
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
    # Main extraction LLM call
    # -----------------------------------------------------------------------

    def _run_main_extraction(self, user_msg: str) -> list[dict]:
        """Invoke the V2 extractor; returns candidate memories or [].

        The new prompt asks for 5–15 memories on busy turns and emits a
        `linked_memory_ids` array, so we budget output tokens generously
        (2000 for non-reasoning, 3000 for reasoning models — the latter
        burn the budget on internal reasoning before emitting JSON).
        """
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
                kwargs["max_completion_tokens"] = 3000
            else:
                # Temperature 0.0: with response_format=json_object and a
                # prescriptive prompt, variance is pure downside — it
                # caused a 1/3 miss rate on a basic multi-topic test.
                kwargs["temperature"] = 0.0
                kwargs["max_tokens"] = 2000
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
