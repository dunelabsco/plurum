-- Migration 023: Content-hash dedup for memories
--
-- Mem0 dedupes at write time via MD5(content). We've been relying on the LLM
-- to notice repeats and on our RRF+rerank to de-prioritize dupes at read
-- time — but we were still inserting exact-duplicate memories on repeat
-- extraction calls. This migration adds a per-user unique constraint on the
-- content hash so a retry or a repeated turn can't double-store.
--
-- Behavior:
--   - `content_hash` is a 32-char hex of MD5(lower(trim(content))).
--   - A partial UNIQUE index covers only active rows, so soft-deleted
--     memories with the same content don't block a fresh re-insert after
--     a user explicitly forgot something.
--   - Populated at write time by MemoryService; back-fill below handles
--     any existing rows.

ALTER TABLE memories
    ADD COLUMN IF NOT EXISTS content_hash CHAR(32);

-- Back-fill: compute hash for every existing row. Safe to run multiple times.
UPDATE memories
SET    content_hash = md5(lower(btrim(coalesce(content, ''))))
WHERE  content_hash IS NULL;

-- Partial unique — only enforced on active rows. Soft-deleted rows can keep
-- whatever hash they had without blocking re-inserts.
CREATE UNIQUE INDEX IF NOT EXISTS uq_memories_user_content_hash
    ON memories(user_id, content_hash)
    WHERE is_active = true AND content_hash IS NOT NULL;

-- Lookup index for dedup checks that aren't unique-constrained (e.g. inside
-- a transaction before insert).
CREATE INDEX IF NOT EXISTS idx_memories_content_hash
    ON memories(content_hash)
    WHERE content_hash IS NOT NULL;
