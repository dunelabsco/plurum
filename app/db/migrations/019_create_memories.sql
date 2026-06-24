-- Migration 019: Personal memory layer
--
-- Separate from the collective `experiences` table:
--   - experiences: structured reasoning, agent-scoped, publishable to the collective
--   - memories: lightweight facts about a specific user, user-scoped, private by default
--
-- Scoping: `user_id` is the primary key for isolation. `agent_id` is the agent
-- that produced the memory (attribution). `session_id` is optional (from which
-- Plurum session this was extracted, if any).

-- ============================================================================
-- MEMORIES TABLE
-- ============================================================================

CREATE TABLE memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    short_id VARCHAR(8) UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(4), 'hex'),

    -- Scoping
    user_id UUID NOT NULL,                                -- owning user (from Supabase auth)
    agent_id UUID REFERENCES agents(id) ON DELETE SET NULL, -- agent that produced it
    session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,

    -- Content
    content TEXT NOT NULL,                                -- the memory itself (a fact, preference, observation)
    memory_type VARCHAR(20) NOT NULL DEFAULT 'fact',      -- fact | preference | observation | note

    -- Raw turn context (optional — when extracted from a conversation)
    source_user TEXT,                                     -- original user message
    source_assistant TEXT,                                -- original assistant response

    -- Metadata
    metadata JSONB NOT NULL DEFAULT '{}',
    importance VARCHAR(10) NOT NULL DEFAULT 'medium',     -- high | medium | low

    -- Search
    embedding vector(1536),
    search_vector tsvector,

    -- Lifecycle
    is_active BOOLEAN NOT NULL DEFAULT true,              -- soft delete / forget
    expires_at TIMESTAMPTZ,                               -- optional auto-forget (e.g., "exam tomorrow")

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT memories_type_check CHECK (memory_type IN ('fact', 'preference', 'observation', 'note')),
    CONSTRAINT memories_importance_check CHECK (importance IN ('high', 'medium', 'low'))
);

-- Indexes for scoped reads
CREATE INDEX idx_memories_user_id ON memories(user_id);
CREATE INDEX idx_memories_user_active ON memories(user_id, is_active) WHERE is_active = true;
CREATE INDEX idx_memories_agent_id ON memories(agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX idx_memories_session_id ON memories(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_memories_type ON memories(memory_type);
CREATE INDEX idx_memories_created_at ON memories(created_at DESC);
CREATE INDEX idx_memories_expires_at ON memories(expires_at) WHERE expires_at IS NOT NULL;

-- Vector index for semantic recall
CREATE INDEX idx_memories_embedding ON memories
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- Full-text search vector
CREATE OR REPLACE FUNCTION update_memory_search_vector()
RETURNS TRIGGER AS $$
BEGIN
    NEW.search_vector := to_tsvector('english', COALESCE(NEW.content, ''));
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER memory_search_vector_trigger
    BEFORE INSERT OR UPDATE OF content ON memories
    FOR EACH ROW
    EXECUTE FUNCTION update_memory_search_vector();

CREATE INDEX idx_memories_search_vector ON memories USING gin(search_vector);

-- ============================================================================
-- SEARCH RPC: hybrid vector + keyword, scoped to user
-- ============================================================================

CREATE OR REPLACE FUNCTION search_memories(
    p_user_id UUID,
    query_text TEXT,
    query_embedding vector(1536),
    match_count INT DEFAULT 10,
    memory_type_filter TEXT DEFAULT NULL,
    vector_weight FLOAT DEFAULT 0.5,
    keyword_weight FLOAT DEFAULT 0.5
)
RETURNS TABLE (
    id UUID,
    short_id VARCHAR(8),
    content TEXT,
    memory_type VARCHAR(20),
    importance VARCHAR(10),
    metadata JSONB,
    agent_id UUID,
    session_id UUID,
    created_at TIMESTAMPTZ,
    similarity FLOAT,
    keyword_rank FLOAT,
    combined_score FLOAT
)
LANGUAGE plpgsql AS $$
DECLARE
    k CONSTANT INT := 60;  -- RRF constant (same as experiences search for consistency)
BEGIN
    RETURN QUERY
    WITH vector_results AS (
        SELECT
            m.id AS mem_id,
            (1 - (m.embedding <=> query_embedding))::FLOAT AS sim,
            ROW_NUMBER() OVER (ORDER BY m.embedding <=> query_embedding) AS v_rank
        FROM memories m
        WHERE m.user_id = p_user_id
          AND m.is_active = true
          AND m.embedding IS NOT NULL
          AND (memory_type_filter IS NULL OR m.memory_type = memory_type_filter)
          AND (m.expires_at IS NULL OR m.expires_at > NOW())
        ORDER BY m.embedding <=> query_embedding
        LIMIT match_count * 3
    ),
    keyword_results AS (
        SELECT
            m.id AS mem_id,
            ts_rank_cd(m.search_vector, websearch_to_tsquery('english', query_text))::FLOAT AS kw_rank,
            ROW_NUMBER() OVER (
                ORDER BY ts_rank_cd(m.search_vector, websearch_to_tsquery('english', query_text)) DESC
            ) AS k_rank
        FROM memories m
        WHERE m.user_id = p_user_id
          AND m.is_active = true
          AND m.search_vector @@ websearch_to_tsquery('english', query_text)
          AND (memory_type_filter IS NULL OR m.memory_type = memory_type_filter)
          AND (m.expires_at IS NULL OR m.expires_at > NOW())
        ORDER BY kw_rank DESC
        LIMIT match_count * 3
    ),
    rrf_combined AS (
        SELECT
            COALESCE(v.mem_id, kw.mem_id) AS mem_id,
            COALESCE(v.sim, 0)::FLOAT AS sim,
            COALESCE(kw.kw_rank, 0)::FLOAT AS kw_rank,
            (
                vector_weight * COALESCE(1.0 / (k + v.v_rank), 0) +
                keyword_weight * COALESCE(1.0 / (k + kw.k_rank), 0)
            )::FLOAT AS rrf_score
        FROM vector_results v
        FULL OUTER JOIN keyword_results kw ON v.mem_id = kw.mem_id
    )
    SELECT
        m.id, m.short_id, m.content, m.memory_type, m.importance, m.metadata,
        m.agent_id, m.session_id, m.created_at,
        c.sim AS similarity,
        c.kw_rank AS keyword_rank,
        c.rrf_score AS combined_score
    FROM rrf_combined c
    JOIN memories m ON m.id = c.mem_id
    ORDER BY c.rrf_score DESC
    LIMIT match_count;
END;
$$;

-- ============================================================================
-- ROW LEVEL SECURITY
-- Service role has full access. RLS enforces per-user isolation at the API layer.
-- ============================================================================

ALTER TABLE memories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access" ON memories;
CREATE POLICY "Service role full access" ON memories
    FOR ALL TO service_role USING (true) WITH CHECK (true);
