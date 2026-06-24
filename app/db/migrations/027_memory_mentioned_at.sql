-- Migration 027: Add mentioned_at column to memories
--
-- Phase 4a of mem0/hindsight parity work. The memories table already has
-- event_date_start/event_date_end (when the event actually OCCURRED). What
-- we lack is the mirror signal — when the conversation MENTIONED the fact.
--
-- Hindsight's retrieval stack distinguishes these two explicitly:
--   occurred: the moment the event took place in the real world
--   mentioned_at: the moment the user/assistant brought it up in chat
--
-- This matters for two reasons:
--
--   (1) Relative-reference resolution at answer time. "Last Friday" in a
--       message from 2023-05-24 means May 19, 2023 — anchor to mentioned_at,
--       not to the current_date. Without mentioned_at we conflate the two
--       and mis-resolve relative dates for older memories.
--
--   (2) Temporal retrieval arm (migration 028). We want to boost memories
--       whose occurred-span OR mention-span intersects the query's time
--       window, since LME questions like "how many doctor visits in March"
--       may need either signal.
--
-- Back-fill strategy:
--   - For rows created going forward, MemoryService populates mentioned_at
--     from the turn's observation_date (= the session's wall-clock date).
--   - For legacy rows we leave NULL. The retrieval code treats NULL as
--     "unknown" and falls back to event_date or created_at.

ALTER TABLE memories
    ADD COLUMN IF NOT EXISTS mentioned_at TIMESTAMPTZ;

-- Range index for the temporal arm. Partial index on rows that actually
-- have a mentioned_at, matching the partial-index pattern we use elsewhere.
CREATE INDEX IF NOT EXISTS idx_memories_mentioned_at
    ON memories(mentioned_at)
    WHERE mentioned_at IS NOT NULL;
