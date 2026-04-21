# Plurum → Mem0 Parity Plan

**Goal:** close LongMemEval-S gap to Mem0 so that every category is within
**≤ 5 points** of their published score.

Companion to `docs/mem0-analysis.md`. Read that first.

---

## Target

| Category | Mem0 score | Plurum floor | Plurum today (oracle, small-n) |
|---|---|---|---|
| single-session-user | 97.1 | **≥ 92.1** | 100 (n=12) — likely ahead |
| single-session-assistant | 100.0 | **≥ 95.0** | 33 (n=6) — unstable, probably the real gap |
| single-session-preference | 96.7 | **≥ 91.7** | 84 (n=31) — close, needs +8 |
| knowledge-update | 96.2 | **≥ 91.2** | 68 (n=22) — biggest known gap |
| temporal-reasoning | 93.2 | **≥ 88.2** | 80 (dedicated n=50) — close, +8 |
| multi-session | 86.5 | **≥ 81.5** | 62 (n=21) — second biggest gap |
| overall | ~93.4 | **≥ 88.4** | ~68 (mixed n=100) |

These are our acceptance gates. Any change we ship has to move numbers on
these categories without regressing others.

---

## Scope — what's in, what's out

**In scope**
- Extraction prompt rewrite (biggest-leverage single change)
- Extraction context: last-K turns + top-K existing memories passed to the extractor
- MD5 hash dedup at write time
- Entity store as a separate Postgres table
- Spread-attenuated entity boost
- Memory linking inside the extractor (collapse supersession into extraction)
- Observation Date / Current Date distinction
- Adaptive BM25 sigmoid normalization
- spaCy-based query entity extraction (latency + cost)
- Memory answer prompt review (benchmark/run.py) — compare against Mem0's
- Extraction-model trial (gpt-4o-mini → gpt-4o on a 50q sample)
- Full LongMemEval-S benchmark run (500 questions, all categories)

**Out of scope**
- 30+ vector store adapters
- Procedural memory mode (agent execution traces — not LME-relevant)
- Graph memory mode (Mem0 has a separate `GraphMemory` class with Neo4j; big lift, benchmark-marginal)
- SQLite history table (Postgres history is enough)
- SDK surface parity with mem0 (separate initiative if Harmona wants it later)

---

## Phase 1 — Extraction prompt rewrite (biggest lever)

**Why first:** ~500 line mem0 prompt catches failure modes our 150-line prompt
doesn't. Best-leverage single change. Expected: +10-15 points overall.

**Files touched**
- `app/services/memory_service.py` — `EXTRACTION_SYSTEM_PROMPT`
- `app/services/memory_service.py` — `extract_from_turn` (simplification)

**New prompt requirements** (adopted from mem0 with our additions)

Rules the prompt MUST enforce:
1. **No echo extraction.** If the user said X and the assistant confirmed X,
   extract once from the user's message, not twice.
2. **Multi-topic exhaustion checklist.** End of prompt: "For conversations
   with 10+ messages, typically extract 5–15 memories. If fewer than 3,
   re-read the conversation — you are almost certainly missing information."
3. **No detail contamination.** Don't import context from existing memories
   unless the new message explicitly references it.
4. **No fabrication.** Every detail must trace to the input.
5. **No within-response duplication.** Each fact appears exactly once in
   the output regardless of how many messages mention it.
6. **Preserve proper nouns, titles, quantities verbatim.** "Ferrari 488 GTB"
   not "sports car". "416 pages" not "about 400".
7. **Meaning preservation trap cases.** Specifically warn: "Didn't get to bed
   until 2 AM" = went TO BED at 2 AM; "Can't stop eating chocolate" ≠ has
   stopped eating chocolate.
8. **Contextually rich, not atomic.** One memory captures fact + transition
   + motivation + emotional state, not fragments.
9. **Self-contained.** Replace every pronoun with "User" or specific name.

Keep from our current prompt:
- 5-dimension mandate for dated events (what/when/where/who/why)
- `memory_subject` field (user/assistant) — this is our `attributed_to` equivalent
- `event_date_start` / `event_date_end` for structured temporal fields
- `entities` array

Add new fields to the extraction output:
- `linked_memory_ids`: UUIDs of existing memories this new one relates to
  (same entity, updated preference, continuation, contradiction)

**Consolidate the two-pass extraction into one.**
Our dedicated preference extractor was a workaround for a weak main prompt.
If the rewritten prompt extracts preferences reliably, kill the second pass.
Saves ~2s per turn.

Keep supersession via `parent_memory_id`, but feed it from
`linked_memory_ids` emitted by the extractor. Rules:
- If a linked memory has the same `memory_subject` and same `memory_type`
  AND the new memory contradicts / updates it → set `parent_memory_id` on
  the new row, soft-delete the parent.
- Otherwise: leave parent intact (they're related but not superseded).

**Temporal model**
Prompt receives TWO dates:
- `observation_date`: when the conversation happened (existing
  `session_date` renamed for clarity)
- `current_date`: today's date (new, for awareness only; do NOT use to
  resolve "yesterday" etc.)

**Extraction context** (new — mem0 passes three things the extractor needs)
The extractor receives, in addition to the current turn:
- **Last K turns** (K=10 default) from the same session — for pronoun and
  reference resolution ("she", "it", "there"). Without this, extracting
  from mid-session fails on anaphora.
- **Top K existing memories** (K=10) for the same user, retrieved via the
  same hybrid search we use for `/memories/search`. The extractor uses these
  for deduplication and populates `linked_memory_ids` against them. Without
  this context the extractor can't produce links.
- **Session summary** (optional, K=0 for now) — one sentence of prior
  session context if available. Out of scope for v1 of this phase.

Implementation detail: `extract_from_turn` signature gains
`session_history: list[dict]` and internally does a pre-extraction search
for existing memories. Both are rendered as JSON blocks in the user prompt.

**MD5 hash dedup at write** (cheap guard)
Before insert, compute `md5(normalized_content)` and check a new
`memories.content_hash` column (unique on `user_id, content_hash`). If a
row already exists for that user with the same hash → skip insert and
return the existing memory id. ~15 lines of code including a migration
for the new column + unique index.

**Acceptance criteria for Phase 1**
- Cheap validation: 50-question per-category runs on each of
  {user, preference, knowledge-update, temporal-reasoning, multi-session,
  assistant}.
- All six categories ≥ current score. Zero regressions.
- If any category regresses > 3 points, iterate the prompt before moving on.
- Hash dedup: at least 10% reduction in memory count on the same 50q runs
  (rough indicator that we were inserting duplicates before).

---

## Phase 2 — Entity store as a Postgres table

**Why:** mem0's entity boost is only meaningful because they have a real
entity store with linked memories and similarity lookup. Our entities in
metadata don't support this.

**Files touched**
- `app/db/migrations/023_entity_store.sql` (new)
- `app/repositories/entity_repo.py` (new)
- `app/services/memory_service.py` — on write, upsert entities;
  on search, compute entity boosts
- `app/db/migrations/024_search_memories_with_entity_boost.sql` — updated RPC

**Schema**

```sql
CREATE TABLE entities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    text TEXT NOT NULL,
    text_normalized TEXT NOT NULL,         -- lowercased, trimmed
    entity_type VARCHAR(20),               -- PROPER | QUOTED | COMPOUND | NOUN
    embedding vector(1536),
    linked_memory_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_entities_user ON entities(user_id);
CREATE INDEX idx_entities_text_trgm ON entities USING gin(text_normalized gin_trgm_ops);
CREATE INDEX idx_entities_embedding ON entities
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
```

**Write path**
On memory create, for each entity in `entities`:
1. Normalize text (lowercase, trim).
2. Vector-search existing entities for same user with sim ≥ 0.95 and exact
   normalized-text match.
3. If match: append new memory id to its `linked_memory_ids`.
4. If no match: insert new entity row with this memory id.

**Read path — spread-attenuated entity boost**
For each query entity:
1. Vector-search entity store for same user, threshold ≥ 0.5.
2. For each matched entity: compute
   `boost = similarity × 0.5 / (1 + 0.001 × (len(linked_memory_ids) − 1)²)`
3. Sum boosts by memory id across all matched entities.

**Fusion**
Stay on RRF (our existing approach) — don't switch to mem0's additive
scoring wholesale. But add:
- Semantic threshold gate: drop rows where semantic similarity < 0.1 before
  fusion (mem0's semantic gate idea).
- Entity arm now draws from the entity-store lookup, not `metadata.entities`.

**Acceptance criteria for Phase 2**
- Same 50-question per-category validation as Phase 1.
- Multi-session ≥ Phase 1 score (this change most helps multi-session
  because named-entity linking carries across sessions).
- No regression on anything.

---

## Phase 3 — Adaptive BM25 sigmoid + query-length gating

**Why:** small but cheap. Normalizes BM25 scores before RRF so long queries
don't dominate the keyword arm.

**Files touched**
- `app/services/memory_service.py` — or directly in the search RPC
- `app/db/migrations/025_search_memories_adaptive_bm25.sql`

**Change**
Replace raw `ts_rank_cd` values with a sigmoid-normalized score:

```
num_terms = count_tokens(query)
midpoint, steepness = lookup_table(num_terms)  # mem0's table
normalized = 1 / (1 + exp(-steepness × (raw - midpoint)))
```

Then feed `normalized` into RRF.

**Acceptance criteria for Phase 3**
- Zero regression on all 6 categories.
- Preference + temporal both +1 point or better (these are the categories
  where BM25 matters most — proper nouns, dated references).

---

## Phase 3.5 — Answer-prompt review (cheap, possibly high-yield)

**Why:** our answer prompt lives in `benchmark/run.py`; mem0 has its own
`MEMORY_ANSWER_PROMPT` in `research/mem0/mem0/configs/prompts.py`. If theirs
produces more LongMemEval-judge-friendly answers, we get free lift without
touching Plurum code.

**Steps**
1. Read mem0's `MEMORY_ANSWER_PROMPT` verbatim.
2. Compare structure against our `ANSWER_SYSTEM_PROMPT` and
   `PREFERENCE_SYSTEM_PROMPT` in `benchmark/run.py`.
3. If theirs is cleaner, port it (with our category-aware switch — we keep
   the preference-narrative branch either way).
4. Re-run the diagnose script over last run's wrongs to check whether
   correctness improves on the same retrieved memories.

**Acceptance criteria**
- Re-running the 50 wrong-preference questions with ported prompt either
  matches or beats 84% previous score.
- No regression on other categories (verify on the 50q/category oracle runs).

---

## Phase 3.6 — spaCy for query entity extraction

**Why:** our search path does a gpt-4o-mini call (~1s, ~$0.001) for
query-entity extraction. Mem0 uses local spaCy. We can cut latency and
cost without touching retrieval quality.

**Files touched**
- `app/services/memory_service.py` — `_extract_query_entities`
- `requirements.txt` — add `spacy` + language model

**Steps**
1. `pip install spacy && python -m spacy download en_core_web_sm`.
2. Replace the gpt-4o-mini call with a spaCy NER pass. Extract PROPN, ORG,
   GPE, PRODUCT, WORK_OF_ART, EVENT entities.
3. Keep the existing gpt-4o-mini branch as a fallback if spaCy model load
   fails.

**Acceptance criteria**
- Search latency drops by ~700ms on p50 (verify with `time curl`).
- Zero regression on the same 50q/category validation set.

---

## Phase 3.7 — Extraction-model trial (gpt-4o-mini → gpt-4o)

**Why:** mem0's published benchmark likely uses GPT-4-class for extraction.
We default to gpt-4o-mini for cost. Before committing to the prompt rewrite
fully, sanity-check whether model choice explains some of the gap.

**Steps**
1. Set `PLURUM_EXTRACTION_MODEL=gpt-4o` in Railway env var.
2. Run 50q on the two weakest categories (knowledge-update, multi-session).
3. Compare scores + cost.
4. If gpt-4o lifts scores by ≥ 5 points in either category for acceptable
   cost, make it the default for customers willing to pay. Keep
   gpt-4o-mini as the cheap default.

**Acceptance criteria**
- Clear cost-per-point-gained number to guide product-tier decisions.
- No change required if gpt-4o doesn't outperform gpt-4o-mini materially
  (the prompt does most of the work).

---

## Phase 4 — Full LongMemEval-S benchmark

**Why:** Mem0's published numbers are on full 500-question LME-S. We've only
run oracle. We need apples-to-apples.

**Files touched**
- None (use existing `benchmark/run.py`)

**Command**
```bash
cd ~/plurum/benchmark
PLURUM_INGEST_PARALLELISM=8 python run.py \
    --dataset s \
    --run-tag v15-full-s \
    --skip-done
```

**Cost budget**
- OpenAI: ~$60–100 (extract + search + answer)
- Time: ~12–20 hours on current infra (Railway + VPS)

**Acceptance criteria for Phase 4**
- Per-category scores within 5 points of mem0 published numbers.
- If any category fails, diagnose with `diagnose_wrong.py`, iterate the
  relevant piece (usually prompt), re-run just that category.

---

## Timeline

| Week | Phase | Deliverable |
|---|---|---|
| 1 | Phase 1 | Rewritten extraction prompt, preference pass removed, linked_memory_ids flowing, last-K turns + top-K existing memories passed as context, MD5 hash dedup |
| 1 | Phase 1 validation | Per-category 50q runs show zero regression, ≥ +5 on weak categories |
| 2 | Phase 2 | Entity store live, spread-attenuated boost integrated |
| 2 | Phase 3 | Adaptive BM25 sigmoid in RPC |
| 2 | Phase 3.5 | Answer-prompt review + potential port |
| 2 | Phase 3.6 | spaCy swapped in for query entity extraction |
| 2 | Phase 3.7 | gpt-4o extraction trial on 50q × 2 worst categories |
| 3 | Phase 4 (partial) | Full LME-S run #1, category diagnosis |
| 4 | Phase 4 (iterate) | Target gaps, second full run, publish numbers |

---

## Risk register

| Risk | Mitigation |
|---|---|
| New extraction prompt regresses preference category (our current strong point) | Validate preference-only on 50 questions before merging. If regressed, iterate prompt. |
| Consolidating the preference pass into main prompt causes a recall miss | Keep the dedicated preference pass as a fallback behind a feature flag until main-prompt parity is proven. |
| Entity store write path adds too much latency on extract | Make entity upsert async / fire-and-forget, like `sync_turn`. |
| Full-S benchmark takes > 20 hours and breaks Railway | Use client-side parallelism (already in place: PLURUM_INGEST_PARALLELISM=8). Retry with smaller batches if 5xx rate climbs. |
| OpenAI cost blows up on full-S run | Budget $100 cap. If exceeded, drop to 200-question stratified sample. |
| Supersession threshold with new prompt breaks | Keep `parent_memory_id` logic guarded; if column missing or any error, fall back to plain insert. Already implemented this way. |
| Hash dedup's unique index breaks legacy inserts | Add column + index with `CREATE INDEX CONCURRENTLY`. Handle `UniqueViolation` in the repo layer by returning the existing row rather than raising. |
| Pre-extraction search for "existing memories" blows up latency | Cap K=10, reuse the in-process cache if same user searched recently within 30s. If extract latency rises past 8s, make pre-search async with a short timeout and fall back to empty context. |
| spaCy model install breaks the Railway deploy | Pin exact version in requirements.txt; include fallback to the gpt-4o-mini path if the model fails to load at service boot. |
| gpt-4o extraction doubles the bill | Keep it behind an env var, off by default. Use it only for paid-tier or benchmark runs. |

---

## Success = ship date

When all six categories are within 5 points of mem0 AND zero category has
regressed from current Plurum numbers, we:

1. Publish the full LME-S scorecard as a blog post (Harmona pitch material).
2. Commit + tag `v15-mem0-parity`.
3. Update the pitch deck's slide 5 with the new numbers.
4. Email Hakan: "Here are the apples-to-apples numbers you asked about."

Done = ready to re-pitch.

---

## Open questions

- Should we gather mem0's actual prompt text into our repo as reference
  material? (Fair-use, single-company research use.) Yes — it's already in
  `research/mem0/mem0/configs/prompts.py` and that's what this plan cites.
- Do we want mem0-compatible SDK shape (`Memory` class with `add`/`search`)
  in the same sprint? **No** — separate initiative. Benchmark parity first,
  then SDK compatibility if Harmona or other customers ask.
- Graph memory / knowledge graph? **No for now** — mem0 doesn't have one
  either; their entity store is simpler and we'll match that.
