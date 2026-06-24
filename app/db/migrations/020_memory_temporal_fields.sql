-- Migration 020: Temporal fields on memories (Phase 1 of retrieval upgrade)
--
-- Context: benchmarking revealed we lose temporal info during extraction.
-- LongMemEval temporal-reasoning accuracy was 74% → 84% after adding session_date
-- anchoring. This phase gives us structured date fields so the LLM can emit
-- absolute event dates explicitly (not just embed them in free-form content),
-- and search can filter/boost by them later.
--
-- Design: event_date_start / event_date_end are separate from created_at.
--   - created_at: when the memory was stored (system time)
--   - event_date_start/end: when the event described actually occurred
--
-- Both are nullable — most memories aren't dated events (preferences, identity facts).
-- When the extractor detects a dated event ("I picked up my car on Jan 28"),
-- it populates both fields (equal for single-day events, different for ranges).

ALTER TABLE memories
  ADD COLUMN event_date_start TIMESTAMPTZ,
  ADD COLUMN event_date_end   TIMESTAMPTZ;

-- Partial index: only memories with a start date get indexed (most won't have one)
CREATE INDEX idx_memories_event_date_start
  ON memories(user_id, event_date_start DESC)
  WHERE event_date_start IS NOT NULL;

-- Range index for "between X and Y" temporal queries
CREATE INDEX idx_memories_event_date_range
  ON memories(user_id, event_date_start, event_date_end)
  WHERE event_date_start IS NOT NULL;
