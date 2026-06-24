-- Migration 024: Entity store
--
-- Phase 2 of mem0 parity. Our entity arm currently lives in
-- `memories.metadata->'entities'` as JSONB text — which means the search
-- RPC can only boost via exact LOWER() text match. That misses
-- cross-session entity identity like "Dr. Smith" ↔ "primary care physician"
-- and explains a big chunk of the multi-session benchmark failures where
-- the same person or object is referred to differently across sessions.
--
-- This migration introduces a dedicated entities table, scoped per user,
-- with embeddings. At write time we upsert each memory's entities here
-- (vector-match first, fall back to insert). At read time the search RPC
-- looks up query entities by vector similarity and pulls every linked
-- memory id — so semantically equivalent entity names converge.
--
-- Keeping `memories.metadata->'entities'` intact: the legacy field still
-- works as a cheap JSONB field for backwards-compat; the NEW search path
-- draws from this table instead.

CREATE TABLE IF NOT EXISTS entities (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id            UUID NOT NULL,
    text               TEXT NOT NULL,
    text_normalized    TEXT NOT NULL,          -- lower(trim(text))
    entity_type        VARCHAR(20),            -- PROPER | QUOTED | COMPOUND | NOUN (nullable for v1)
    embedding          vector(1536),
    linked_memory_ids  UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-user scan is the most common access path from the app.
CREATE INDEX IF NOT EXISTS idx_entities_user
    ON entities(user_id);

-- Exact-text lookup path used by the write flow: after a vector match we
-- also verify normalized text equality before merging into an existing
-- entity row. A plain btree is enough since we're matching equality on a
-- normalized string, not doing fuzzy lookups.
CREATE INDEX IF NOT EXISTS idx_entities_user_text_normalized
    ON entities(user_id, text_normalized);

-- HNSW vector index for the read path. Mem0 uses roughly these
-- parameters for their entity store; on our row counts (<= a few thousand
-- entities per user) this is overkill but cheap to maintain.
CREATE INDEX IF NOT EXISTS idx_entities_embedding_hnsw
    ON entities USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- updated_at auto-refresh on any change to linked_memory_ids etc.
CREATE OR REPLACE FUNCTION set_entities_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_entities_updated_at ON entities;
CREATE TRIGGER trigger_entities_updated_at
    BEFORE UPDATE ON entities
    FOR EACH ROW EXECUTE FUNCTION set_entities_updated_at();

-- RLS: same pattern as the memories table. The API layer operates under
-- the service role, and we filter by user_id in application code. We
-- enable RLS with a permissive policy so anon/auth clients can't query
-- entities directly; the service role bypasses RLS.
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS entities_service_all ON entities;
CREATE POLICY entities_service_all
    ON entities FOR ALL
    TO service_role
    USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Read-side RPC: vector-search a user's entities and return linked memory ids.
-- Called by EntityRepository.search and (later, migration 025) by the memory
-- search RPC as input to the entity arm.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION search_entities(
    p_user_id UUID,
    query_embedding vector(1536),
    sim_threshold FLOAT DEFAULT 0.5,
    match_count INT DEFAULT 20
)
RETURNS TABLE (
    id UUID,
    text TEXT,
    text_normalized TEXT,
    entity_type VARCHAR(20),
    linked_memory_ids UUID[],
    similarity FLOAT
)
LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    SELECT
        e.id,
        e.text,
        e.text_normalized,
        e.entity_type,
        e.linked_memory_ids,
        (1 - (e.embedding <=> query_embedding))::FLOAT AS similarity
    FROM entities e
    WHERE e.user_id = p_user_id
      AND e.embedding IS NOT NULL
      AND (1 - (e.embedding <=> query_embedding)) >= sim_threshold
    ORDER BY e.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;
