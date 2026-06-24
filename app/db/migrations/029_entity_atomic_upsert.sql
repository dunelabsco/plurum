-- Migration 029: Dedup entities table + atomic upsert
--
-- Post-hoc audit of the entities table revealed up to 8 duplicate rows per
-- (user_id, text_normalized). Root cause: entity_repo.upsert was
-- check-then-act — SELECT for existing, INSERT on miss — with no
-- transaction boundary. Two concurrent extract calls for the same user +
-- same entity text (e.g., "snake plant") both saw no match, both
-- inserted, and ended up with two rows. Every subsequent upsert appended
-- to only one of them via LIMIT 1, leaving the others permanently
-- abandoned with linked_memory_ids of length 1.
--
-- This migration:
--
--   1. Merges duplicate rows into a single canonical row per
--      (user_id, text_normalized). Winner is the oldest row. The union
--      of all duplicates' linked_memory_ids is written back to the
--      winner.
--
--   2. Adds a UNIQUE constraint on (user_id, text_normalized) so the
--      race can never happen again — concurrent INSERTs will collide
--      on the constraint.
--
--   3. Creates entity_upsert(...) — a single-statement RPC that uses
--      INSERT ... ON CONFLICT DO UPDATE, making upsert atomic end-to-end.
--      The existing read-modify-write pattern in entity_repo.upsert is
--      replaced with a single call to this RPC.
--
--   4. Creates entity_append_memory(...) — atomic array_append for the
--      case where we have an entity_id already and only need to add a
--      link. Fires only for legacy callers; the upsert RPC above is the
--      primary path.

-- ---------------------------------------------------------------------------
-- Step 1 — merge duplicate rows. Keep the oldest row per (user, text_norm),
-- union the linked_memory_ids across all duplicates.
--
-- Run inside a single transaction so a crash mid-merge can't split the work.
-- Supabase SQL editor auto-wraps each statement in a transaction so this is
-- safe.
-- ---------------------------------------------------------------------------

WITH
unioned AS (
    SELECT
        user_id,
        text_normalized,
        COALESCE(
            array_agg(DISTINCT mem_id) FILTER (WHERE mem_id IS NOT NULL),
            ARRAY[]::UUID[]
        ) AS linked
    FROM (
        SELECT
            user_id,
            text_normalized,
            unnest(linked_memory_ids) AS mem_id
        FROM entities
    ) flat
    GROUP BY user_id, text_normalized
),
winners AS (
    SELECT DISTINCT ON (user_id, text_normalized)
        id, user_id, text_normalized
    FROM entities
    ORDER BY user_id, text_normalized, created_at ASC
)
UPDATE entities e
SET linked_memory_ids = u.linked,
    updated_at = NOW()
FROM winners w
JOIN unioned u
  ON u.user_id = w.user_id
 AND u.text_normalized = w.text_normalized
WHERE e.id = w.id;

-- Now delete the losers (every entity row that isn't the oldest for its
-- (user_id, text_normalized) group).
DELETE FROM entities e
WHERE e.id NOT IN (
    SELECT DISTINCT ON (user_id, text_normalized) id
    FROM entities
    ORDER BY user_id, text_normalized, created_at ASC
);

-- ---------------------------------------------------------------------------
-- Step 2 — add the uniqueness constraint. Must come AFTER dedup or it fails.
-- ---------------------------------------------------------------------------

ALTER TABLE entities
    ADD CONSTRAINT uq_entities_user_text UNIQUE (user_id, text_normalized);

-- ---------------------------------------------------------------------------
-- Step 3 — atomic upsert RPC.
-- Replaces entity_repo.upsert's find_match + create / append_memory_id
-- pattern with a single SQL statement. Under contention, Postgres
-- serializes the ON CONFLICT branch, so two concurrent callers for the
-- same (user, text) both end up with one entity row and both their
-- memory_ids in linked_memory_ids.
--
-- The ON CONFLICT branch intentionally leaves `embedding` alone (we
-- keep the first embedding we computed for this entity — later upserts
-- don't overwrite it) and only touches linked_memory_ids and updated_at.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION entity_upsert(
    p_user_id          UUID,
    p_text             TEXT,
    p_text_normalized  TEXT,
    p_embedding        vector(1536),
    p_memory_id        UUID,
    p_entity_type      VARCHAR(20) DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql AS $$
DECLARE
    result_id UUID;
BEGIN
    INSERT INTO entities (
        user_id, text, text_normalized, embedding,
        linked_memory_ids, entity_type
    )
    VALUES (
        p_user_id, p_text, p_text_normalized, p_embedding,
        ARRAY[p_memory_id], p_entity_type
    )
    ON CONFLICT (user_id, text_normalized) DO UPDATE
    SET linked_memory_ids = CASE
            WHEN p_memory_id = ANY(entities.linked_memory_ids)
                THEN entities.linked_memory_ids
            ELSE array_append(entities.linked_memory_ids, p_memory_id)
        END,
        updated_at = NOW()
    RETURNING id INTO result_id;

    RETURN result_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Step 4 — atomic append-only RPC. Kept for any legacy caller that already
-- has an entity_id in hand. Idempotent: a second call with the same
-- memory_id is a no-op.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION entity_append_memory(
    p_entity_id UUID,
    p_memory_id UUID
)
RETURNS VOID
LANGUAGE sql AS $$
    UPDATE entities
    SET linked_memory_ids = array_append(linked_memory_ids, p_memory_id),
        updated_at = NOW()
    WHERE id = p_entity_id
      AND NOT (p_memory_id = ANY(linked_memory_ids));
$$;
