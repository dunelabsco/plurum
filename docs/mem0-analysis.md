# Mem0 Technical Analysis

Analysis of the Mem0 codebase (`research/mem0/`) with an eye toward closing
the LongMemEval benchmark gap. Source of truth for every claim here is a
specific file path in Mem0's repo.

---

## 1. Executive summary

Mem0 is roughly what we are, with four meaningful structural differences:

| Area | Mem0 | Plurum (today) | Gap |
|---|---|---|---|
| Extraction prompt depth | ~500 lines, 6 explicit failure-mode rules, exhaustive multi-topic checklist | ~150 lines, 2 rules | **major** |
| Memory linking at extraction time | `linked_memory_ids` produced by the extractor in one LLM call | Separate post-hoc `_find_supersedable` pass | **medium** |
| Entity store | Parallel collection; entities have `linked_memory_ids`; entity boost is spread-attenuated | Entities live in `metadata["entities"]` JSON; no separate store | **medium** |
| Temporal grounding | Observation Date vs Current Date distinction; all relative refs resolved to absolute dates in-prompt | Single `session_date` passed in; no explicit "current date vs observation date" rule | **minor** |

Mem0 is additive-only (no UPDATE/DELETE logic in OSS) — deduplication happens
inside the extractor via `linked_memory_ids`, not as a separate step.

Plurum has three things Mem0 doesn't:
- LLM cross-encoder reranker on every search (they have optional Cohere)
- 3-way RRF fusion (they use additive score + semantic threshold)
- Dedicated preference-extraction pass (boosted our preference from 30% → 84%)
- Collective + private two-layer model (their whole product is personal memory only)

---

## 2. Architecture overview (their side)

**Entry point**

```python
from mem0 import Memory        # self-hosted (OSS)
from mem0 import MemoryClient  # managed (Cloud API)
m = Memory(config=MemoryConfig())
m.add(messages, user_id="u1")
m.search(query, filters={"user_id": "u1"})
```

Core class in `mem0/memory/main.py:331`. Public API:
`add`, `search`, `get`, `get_all`, `update`, `delete`, `delete_all`, `history`.
Sync + async variants (`Memory`, `AsyncMemory`).

**Data flow for `add()`**

1. Fetch last 10 session messages (context).
2. Vector-search the existing user's memories (top ~10) to give the extractor
   deduplication candidates.
3. **Single LLM call** with `ADDITIVE_EXTRACTION_PROMPT` — returns
   `{"memory": [{"id": "0", "text": "...", "attributed_to": "user",
   "linked_memory_ids": [...]}]}`.
4. Batch-embed all extracted texts.
5. Hash-dedupe against existing (MD5 of text).
6. Upsert to vector store + write SQLite history row.
7. For each extracted entity, upsert to parallel entity store.

**Data flow for `search()`**

1. Lemmatize query; extract entities with spaCy.
2. Embed query.
3. **Three retrieval arms in parallel**:
   - Semantic: `top_k * 4` (or ≥ 60) from vector store
   - Keyword: BM25 on lemmatized payload
   - Entity boost: for each query-entity, vector-search the entity store
     (threshold ≥ 0.5), boost matched entities' `linked_memory_ids`
4. Score: `(semantic + bm25 + entity_boost) / max_possible`
   — semantic threshold (default 0.1) gates the whole row
5. Optional reranker pass (Cohere / HF / LLM)
6. Return top-k

---

## 3. Extraction — where the biggest gap lives

### Mem0's `ADDITIVE_EXTRACTION_PROMPT`

Location: `research/mem0/mem0/configs/prompts.py:468-957`. ~500 lines.

The prompt enforces six explicit rules that ours doesn't:

1. **No echo extraction** — if the user said it and the assistant merely
   restated/confirmed/summarized it, extract once from the user's version.
2. **No first-topic dominance** — mandatory multi-topic checklist at the end:
   "For conversations with 10+ messages, you should typically extract 5-15
   memories. If you have fewer than 3, re-read — you are almost certainly
   missing information."
3. **No detail contamination** — don't import context from existing memories
   into new extractions unless the new message explicitly references them.
4. **No fabrication** — every detail must trace to the inputs.
5. **No implicit attribute inference** — don't infer gender/age/ethnicity.
6. **No within-response duplication** — each fact appears exactly once in the
   output regardless of how many messages mention it.

### Memory-quality rules

- **Contextually rich, not atomic.** "User has a dog named Poppy and their
  morning walks together are the highlight of their day" — not just "User
  has a dog".
- **Capture transitions.** "User switched from almond milk to oat milk lattes
  after developing an almond sensitivity" — not "User prefers oat milk".
- **Self-contained.** Replace every pronoun with "User" or a specific name.
- **Concise but complete (15–80 words).** Dense single-sentence memories.
- **Preserve proper nouns, titles, quantities verbatim.** "Ferrari 488 GTB",
  not "sports car". "416 pages", not "about 400". "A Court of Thorns and
  Roses", not "a fantasy book".
- **Meaning-preserving.** The prompt has specific trap cases: "Didn't get to
  bed until 2 AM" = went TO BED at 2 AM, not slept until 2 AM.

### Temporal grounding (two-date model)

Mem0's extractor receives both:

- **Observation Date** — when the conversation actually happened. Used to
  resolve every relative reference ("yesterday", "last week", "recently").
- **Current Date** — today's system date. Explicitly *not* used to resolve
  references — only for contextual awareness.

This matters when re-ingesting old conversations: "last week" in a 2023
transcript should resolve to 2023, not today.

Our current impl passes `session_date` and the extractor uses it, but we
don't distinguish current vs observation date. Minor but exploitable.

### Memory linking at extraction time

```json
{"memory": [
  {"id": "0", "text": "...", "attributed_to": "user",
   "linked_memory_ids": ["uuid-of-related-existing-memory"]}
]}
```

The extractor is handed existing-memory UUIDs as context and produces the
links itself. **One LLM call**. No separate supersession round trip.

Link criteria spelled out in the prompt:
- Same entity / same topic
- Updated preference (an evolved opinion on something previously captured)
- Continuation (follow-up event in a narrative)
- Contradiction (new info conflicts with existing)

### Agent-context suffix

When `agent_id` is set without `user_id`, the prompt is suffixed with rules
for framing memories from the agent's perspective ("Agent was informed that
[fact]", "Agent learned that [fact]"). File `prompts.py:947-957`.

### Legacy prompts still in the file

`FACT_RETRIEVAL_PROMPT`, `USER_MEMORY_EXTRACTION_PROMPT`,
`AGENT_MEMORY_EXTRACTION_PROMPT`, `DEFAULT_UPDATE_MEMORY_PROMPT` — all exist
in `prompts.py` but are not used by the OSS `Memory` class. They appear to
be cloud-platform-only or deprecated.

---

## 4. Retrieval & scoring

### Hybrid scoring formula

`mem0/utils/scoring.py`

```
combined = (semantic + bm25 + entity_boost) / max_possible

max_possible:
  semantic only:                     1.0
  semantic + keyword:                2.0
  semantic + keyword + entity:       2.5
  semantic + entity (no keyword):    1.5

if semantic < threshold (default 0.1): skip this row entirely
```

Simpler than our RRF (k=60, 3-way) but with an important property: the
semantic threshold gates the whole row. Keyword-only hits with zero
semantic score are dropped. We don't do that — we include them.

### BM25 normalization via adaptive sigmoid

```python
# mem0/utils/scoring.py:16-54
def get_bm25_params(query_length):
    if num_terms <= 3:   return (5.0, 0.7)   # short query
    elif num_terms <= 6: return (7.0, 0.6)
    elif num_terms <= 9: return (9.0, 0.5)
    elif num_terms <= 15:return (10.0, 0.5)
    else:                return (12.0, 0.5)  # long query

normalized = 1 / (1 + exp(-steepness * (raw_bm25 - midpoint)))
```

Query-length-adaptive sigmoid maps raw BM25 to [0, 1]. Short queries use a
steeper sigmoid; long queries use a gentler one. Prevents long queries from
having unfairly high BM25 scores.

### Entity store

`mem0/memory/main.py:389-411`

Separate vector collection (`{collection_name}_entities` in Qdrant) — not
just a metadata field. Each entity row carries:

```json
{
  "data": "entity text (e.g., 'Rachel' or 'Ferrari 488 GTB')",
  "entity_type": "PROPER|QUOTED|COMPOUND|NOUN",
  "linked_memory_ids": ["uuid1", "uuid2", ...]
}
```

Lazily initialized on first write. Upserted when a new memory is added
(if entity similarity ≥ 0.95, append to existing entity's linked list; else
create new entity row).

### Spread-attenuated entity boost

`mem0/memory/main.py:1478-1481`

```
boost = similarity × 0.5 / (1 + 0.001 × (num_linked_memories − 1)²)
```

An entity linked to 100 memories is boosted ~10,000× less than one linked to
just one memory. Prevents hub entities like "User" or "work" from
amplifying every result.

We don't have this attenuation.

---

## 5. Storage

### History DB

SQLite (always; not configurable). `mem0/memory/storage.py:102-127`.

```sql
CREATE TABLE history (
    id           TEXT PRIMARY KEY,
    memory_id    TEXT,
    old_memory   TEXT,
    new_memory   TEXT,
    event        TEXT,       -- ADD | UPDATE | DELETE | NONE
    created_at   DATETIME,
    updated_at   DATETIME,
    is_deleted   INTEGER,
    actor_id     TEXT,
    role         TEXT        -- user | assistant
);

CREATE TABLE messages (
    id              TEXT PRIMARY KEY,
    session_scope   TEXT,    -- serialized session filters
    role            TEXT,
    content         TEXT,
    name            TEXT,
    created_at      DATETIME
);
```

### Vector store payload

```json
{
  "data": "memory text",
  "text_lemmatized": "lemma form for BM25",
  "hash": "md5 of text",
  "created_at": "...",
  "updated_at": "...",
  "user_id": "...",
  "agent_id": "...",
  "run_id": "...",
  "actor_id": "optional speaker name",
  "role": "user|assistant",
  "attributed_to": "user|assistant",
  "metadata": { "key": "value" }
}
```

### Vector stores supported

30+ providers via pluggable factory: Qdrant (default), Pinecone, ChromaDB,
**pgvector**, Weaviate, Milvus, MongoDB, Redis, Elasticsearch, OpenSearch,
Databricks, Azure variants, Supabase, Vertex AI, Faiss, S3 Vectors, Cassandra,
Turbopuffer, Upstash, Baidu, and more.

We can ignore this entirely — Postgres is fine for our scale.

### Multi-tenancy model

Three scope keys, at least one required on every call:
- `user_id` — the end user
- `agent_id` — a specific agent instance
- `run_id` — a specific conversation/session

Filters combine additively: `filters={"user_id": "u1", "agent_id": "a1"}`.

---

## 6. Procedural memory (not LME-relevant, but worth noting)

`mem0/configs/prompts.py:326-402` — `PROCEDURAL_MEMORY_SYSTEM_PROMPT`.

When `memory_type="procedural_memory"` and `agent_id` set, mem0 stores
verbatim agent execution traces: every action, every raw output, chronological
step numbers, key findings, current context. Designed for long-running agents
(scraping, multi-step tasks) that need to recall their own execution history.

Not LongMemEval-relevant. Skip for now.

---

## 7. What Mem0 does better than us today

1. **Extraction-prompt rigor.** Their 500-line prompt catches failure modes
   ours doesn't (echo, first-topic dominance, detail contamination, fabrication,
   within-response duplication, proper-noun loss, meaning preservation).

2. **Single-call extraction with linking.** `linked_memory_ids` in the
   extractor output eliminates our separate supersession LLM/RPC round.

3. **Entity store as a parallel collection.** Entity-aware retrieval that
   finds memories via entities even when the query doesn't exactly lexical-
   match the memory content.

4. **Spread-attenuated entity boost.** Prevents hub entities from polluting
   results.

5. **Semantic threshold gating on the whole row.** Dropping rows with weak
   semantic score even if keyword score is high.

6. **Two-date temporal model.** Observation Date vs Current Date.

7. **Adaptive BM25 sigmoid.** Query-length-aware keyword normalization.

## 8. What we do better than Mem0 today

1. **LLM cross-encoder reranker** on every search. Theirs is optional.
2. **3-way RRF fusion** — vector + keyword + entity. More composable than
   their additive scoring.
3. **Dedicated preference extraction pass.** Lifted our preference score
   30%→84% on oracle.
4. **Supersession with `parent_memory_id`.** Explicit history link; their
   OSS is additive-only with no formal supersession.
5. **Collective + private two-layer model.** Mem0 has no shared / published
   experiences. This is still our core differentiator.

## 9. What NOT to copy from Mem0

- **30+ vector store abstraction** — premature complexity.
- **SQLite history table** — can add later if audit becomes a real need.
- **Procedural memory mode** — niche (agent execution traces), not
  LongMemEval-relevant.
- **Additive-only extraction (no supersession).** Our explicit supersession
  is better for knowledge-update category.
- **Five reranker providers.** One good one is enough; we already have it.

---

## 10. Benchmark context

Mem0's published LongMemEval-S numbers:

| Category | Mem0 |
|---|---|
| single-session-user | 97.1 |
| single-session-assistant | 100 |
| single-session-preference | 96.7 |
| knowledge-update | 96.2 |
| temporal-reasoning | 93.2 |
| multi-session | 86.5 |

They don't have LME-specific tuning in their repo (checked — no references
to LongMemEval in the code). Their scores come from the general-purpose
architecture described above. That means every lift in our scores has to
come from the same general-purpose knobs: prompt quality, retrieval fusion,
entity linking, temporal grounding.

---

## File reference index

| Topic | Mem0 file path |
|---|---|
| Main memory class | `mem0/memory/main.py:331-2932` |
| Client class | `mem0/client/main.py` |
| Extraction prompt (V3) | `mem0/configs/prompts.py:468-957` |
| Dynamic prompt builder | `mem0/configs/prompts.py:1016-1062` |
| Agent-context suffix | `mem0/configs/prompts.py:947-957` |
| Procedural memory prompt | `mem0/configs/prompts.py:326-402` |
| Hybrid scoring | `mem0/utils/scoring.py` |
| BM25 adaptive sigmoid | `mem0/utils/scoring.py:16-54` |
| Entity store + boost | `mem0/memory/main.py:389-454,1432-1491` |
| SQLite history schema | `mem0/memory/storage.py:102-127` |
| Vector store factory | `mem0/vector_stores/configs.py:40-67` |
| Config base | `mem0/configs/base.py` |
