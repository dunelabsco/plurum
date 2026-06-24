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

-- Fast metadata-only operation on any Postgres version.
ALTER TABLE memories
    ADD COLUMN IF NOT EXISTS content_hash CHAR(32);

-- Partial unique — only enforced on active, hashed rows. Existing rows
-- without a hash are ignored; new writes from MemoryService will populate
-- the column, and from that point on exact-content duplicates for the
-- same user are blocked. Soft-deleted rows likewise drop out of the index
-- so a "forget then re-learn" cycle still works.
--
-- The index is NOT created CONCURRENTLY here because the Supabase SQL
-- editor can't run CONCURRENTLY inside a transaction. On a 25K-row table
-- this finishes in well under a second; if we ever cross a few million
-- rows we'd redo it with CREATE INDEX CONCURRENTLY from a direct psql
-- connection (not the SQL editor).
CREATE UNIQUE INDEX IF NOT EXISTS uq_memories_user_content_hash
    ON memories(user_id, content_hash)
    WHERE is_active = true AND content_hash IS NOT NULL;

-- Lookup index for dedup checks that aren't unique-constrained (e.g.
-- inside a transaction before insert). Partial so it ignores the NULL
-- legacy rows.
CREATE INDEX IF NOT EXISTS idx_memories_content_hash
    ON memories(content_hash)
    WHERE content_hash IS NOT NULL;

-- NOTE — legacy back-fill
-- --------------------------------------------------------------------
-- We deliberately DO NOT back-fill existing rows here. A single-statement
-- UPDATE on a 25K+ memories table hits Supabase's SQL-editor statement
-- timeout. If you want to back-fill later (optional — not required for
-- correctness), run this in batches from a direct psql connection:
--
--   DO $$
--   DECLARE
--     batch_size INT := 2000;
--     rows_updated INT;
--   BEGIN
--     LOOP
--       UPDATE memories
--       SET    content_hash = md5(lower(btrim(coalesce(content, ''))))
--       WHERE  id IN (
--         SELECT id FROM memories
--         WHERE  content_hash IS NULL
--         LIMIT  batch_size
--       );
--       GET DIAGNOSTICS rows_updated = ROW_COUNT;
--       EXIT WHEN rows_updated = 0;
--       COMMIT;
--     END LOOP;
--   END $$;
--
-- Until back-filled, legacy rows simply don't participate in hash-dedup.
-- New writes start enforcing the constraint immediately.
