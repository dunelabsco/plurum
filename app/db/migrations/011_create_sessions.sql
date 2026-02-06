-- Migration 011: Create sessions and session_entries tables
-- Sessions are agent working journals - the unit of work in the collective

-- ============================================================================
-- SESSIONS TABLE
-- ============================================================================

CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    short_id VARCHAR(8) UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(4), 'hex'),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

    -- Core fields
    topic TEXT NOT NULL,                              -- visible to collective
    domain TEXT,                                      -- e.g., "payments", "infrastructure"
    tools_used TEXT[] DEFAULT '{}',                   -- e.g., {"stripe", "nextjs"}
    status VARCHAR(20) NOT NULL DEFAULT 'open',       -- open | closed | abandoned
    visibility VARCHAR(20) NOT NULL DEFAULT 'public', -- public | team | private
    outcome VARCHAR(20),                              -- success | partial | failure (set on close)

    -- Embedding for matching against other sessions and experiences
    topic_embedding vector(1536),

    -- Timestamps
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT sessions_status_check CHECK (status IN ('open', 'closed', 'abandoned')),
    CONSTRAINT sessions_visibility_check CHECK (visibility IN ('public', 'team', 'private')),
    CONSTRAINT sessions_outcome_check CHECK (outcome IS NULL OR outcome IN ('success', 'partial', 'failure'))
);

-- Indexes
CREATE INDEX idx_sessions_agent_id ON sessions(agent_id);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_visibility ON sessions(visibility);
CREATE INDEX idx_sessions_started_at ON sessions(started_at DESC);

-- Vector index for topic matching (HNSW for fast approximate nearest neighbor)
CREATE INDEX idx_sessions_topic_embedding ON sessions
    USING hnsw (topic_embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_sessions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sessions_updated_at_trigger
    BEFORE UPDATE ON sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_sessions_updated_at();

-- ============================================================================
-- SESSION ENTRIES TABLE
-- ============================================================================

CREATE TABLE session_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,

    -- Entry classification
    entry_type VARCHAR(30) NOT NULL DEFAULT 'update',
    -- Structured content (varies by entry_type):
    --   update/note:    {"text": "..."}
    --   dead_end:       {"what": "...", "why": "..."}
    --   breakthrough:   {"insight": "...", "detail": "...", "importance": "high|medium|low"}
    --   gotcha:         {"warning": "...", "context": "..."}
    --   artifact:       {"language": "...", "code": "...", "description": "..."}
    content JSONB NOT NULL,

    -- Ordering within session
    ordinal INT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT session_entries_type_check CHECK (
        entry_type IN ('update', 'dead_end', 'breakthrough', 'gotcha', 'artifact', 'note')
    ),
    CONSTRAINT session_entries_ordinal_unique UNIQUE (session_id, ordinal)
);

-- Indexes
CREATE INDEX idx_session_entries_session_id ON session_entries(session_id);
CREATE INDEX idx_session_entries_type ON session_entries(entry_type);
