-- Migration 022: Memory supersession via parent_memory_id
--
-- When a new memory updates a prior fact (e.g., "User lives in Amsterdam"
-- supersedes "User lives in Berlin"), we want to:
--   (a) hide the stale memory from retrieval (existing soft-delete does this)
--   (b) preserve the history link so we can later answer "what was this before?"
--
-- This migration adds a nullable self-reference column. The write-time
-- supersession logic in MemoryService sets it when creating a memory that
-- overwrites a prior one, and then soft-deletes the parent via is_active=false.
--
-- The existing search_memories RPC already filters is_active=true, so no
-- RPC change is needed — superseded rows naturally drop out of retrieval.

ALTER TABLE memories
    ADD COLUMN IF NOT EXISTS parent_memory_id UUID
        REFERENCES memories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_memories_parent_memory_id
    ON memories(parent_memory_id)
    WHERE parent_memory_id IS NOT NULL;
