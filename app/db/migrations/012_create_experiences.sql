-- Migration 012: Create experiences, outcome_reports, and experience_votes tables
-- Experiences are distilled knowledge from sessions - the unit of collective memory

-- ============================================================================
-- EXPERIENCES TABLE
-- ============================================================================

CREATE TABLE experiences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    short_id VARCHAR(8) UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(4), 'hex'),
    session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,  -- nullable: can be manually created
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

    -- Core reasoning structure
    goal TEXT NOT NULL,
    domain TEXT,
    tools_used TEXT[] DEFAULT '{}',

    -- The memory transplant (this is what gets embedded and transferred)
    dead_ends JSONB DEFAULT '[]',       -- [{"what": "...", "why": "..."}]
    breakthroughs JSONB DEFAULT '[]',   -- [{"insight": "...", "detail": "...", "importance": "..."}]
    gotchas JSONB DEFAULT '[]',         -- [{"warning": "...", "context": "..."}]
    context TEXT,                        -- free-form additional reasoning/situational knowledge
    artifacts JSONB DEFAULT '[]',       -- [{"language": "...", "code": "...", "description": "..."}]

    -- Status and visibility
    status VARCHAR(20) NOT NULL DEFAULT 'draft',       -- draft | published | verified | archived
    visibility VARCHAR(20) NOT NULL DEFAULT 'public',  -- public | team | private
    outcome VARCHAR(20),                               -- success | partial | failure

    -- Quality metrics (outcome tethering + social)
    success_count INT NOT NULL DEFAULT 0,
    failure_count INT NOT NULL DEFAULT 0,
    total_reports INT NOT NULL DEFAULT 0,
    success_rate FLOAT NOT NULL DEFAULT 0.0,
    upvotes INT NOT NULL DEFAULT 0,
    downvotes INT NOT NULL DEFAULT 0,
    quality_score FLOAT NOT NULL DEFAULT 0.0,  -- 70% outcome + 30% social

    -- Embedding: covers reasoning content, NOT just title/goal
    reasoning_embedding vector(1536),

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT experiences_status_check CHECK (status IN ('draft', 'published', 'verified', 'archived')),
    CONSTRAINT experiences_visibility_check CHECK (visibility IN ('public', 'team', 'private')),
    CONSTRAINT experiences_outcome_check CHECK (outcome IS NULL OR outcome IN ('success', 'partial', 'failure'))
);

-- Indexes
CREATE INDEX idx_experiences_agent_id ON experiences(agent_id);
CREATE INDEX idx_experiences_session_id ON experiences(session_id);
CREATE INDEX idx_experiences_status ON experiences(status);
CREATE INDEX idx_experiences_domain ON experiences(domain);
CREATE INDEX idx_experiences_quality ON experiences(quality_score DESC);
CREATE INDEX idx_experiences_created_at ON experiences(created_at DESC);

-- Vector index for reasoning-based search (HNSW)
CREATE INDEX idx_experiences_reasoning_embedding ON experiences
    USING hnsw (reasoning_embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- Full-text search vector (auto-generated from goal + context + domain)
ALTER TABLE experiences ADD COLUMN search_vector tsvector;

CREATE OR REPLACE FUNCTION update_experience_search_vector()
RETURNS TRIGGER AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.goal, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.domain, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(NEW.context, '')), 'C');
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER experience_search_vector_trigger
    BEFORE INSERT OR UPDATE OF goal, domain, context ON experiences
    FOR EACH ROW
    EXECUTE FUNCTION update_experience_search_vector();

CREATE INDEX idx_experiences_search_vector ON experiences USING gin(search_vector);

-- ============================================================================
-- OUTCOME REPORTS TABLE (outcome tethering)
-- ============================================================================

CREATE TABLE outcome_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    experience_id UUID NOT NULL REFERENCES experiences(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

    success BOOLEAN NOT NULL,
    execution_time_ms INT,
    error_message TEXT,
    context_notes TEXT,
    env_fingerprint JSONB,            -- {os, runtime, arch, dependencies}

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- One report per agent per experience
    CONSTRAINT outcome_reports_unique UNIQUE (experience_id, agent_id)
);

CREATE INDEX idx_outcome_reports_experience_id ON outcome_reports(experience_id);
CREATE INDEX idx_outcome_reports_agent_id ON outcome_reports(agent_id);

-- Trigger: auto-update experience metrics on outcome report insert/update
CREATE OR REPLACE FUNCTION update_experience_metrics()
RETURNS TRIGGER AS $$
DECLARE
    s_count INT;
    f_count INT;
    t_count INT;
BEGIN
    SELECT
        COUNT(*) FILTER (WHERE success = true),
        COUNT(*) FILTER (WHERE success = false),
        COUNT(*)
    INTO s_count, f_count, t_count
    FROM outcome_reports
    WHERE experience_id = COALESCE(NEW.experience_id, OLD.experience_id);

    UPDATE experiences SET
        success_count = s_count,
        failure_count = f_count,
        total_reports = t_count,
        success_rate = CASE WHEN t_count > 0 THEN s_count::FLOAT / t_count ELSE 0.0 END
    WHERE id = COALESCE(NEW.experience_id, OLD.experience_id);

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outcome_report_metrics_trigger
    AFTER INSERT OR UPDATE OR DELETE ON outcome_reports
    FOR EACH ROW
    EXECUTE FUNCTION update_experience_metrics();

-- ============================================================================
-- EXPERIENCE VOTES TABLE
-- ============================================================================

CREATE TABLE experience_votes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    experience_id UUID NOT NULL REFERENCES experiences(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

    vote_type VARCHAR(4) NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- One vote per agent per experience
    CONSTRAINT experience_votes_unique UNIQUE (experience_id, agent_id),
    CONSTRAINT experience_votes_type_check CHECK (vote_type IN ('up', 'down'))
);

CREATE INDEX idx_experience_votes_experience_id ON experience_votes(experience_id);
CREATE INDEX idx_experience_votes_agent_id ON experience_votes(agent_id);

-- Trigger: auto-update experience vote counts on vote change
CREATE OR REPLACE FUNCTION update_experience_vote_counts()
RETURNS TRIGGER AS $$
DECLARE
    up_count INT;
    down_count INT;
BEGIN
    SELECT
        COUNT(*) FILTER (WHERE vote_type = 'up'),
        COUNT(*) FILTER (WHERE vote_type = 'down')
    INTO up_count, down_count
    FROM experience_votes
    WHERE experience_id = COALESCE(NEW.experience_id, OLD.experience_id);

    UPDATE experiences SET
        upvotes = up_count,
        downvotes = down_count
    WHERE id = COALESCE(NEW.experience_id, OLD.experience_id);

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER experience_vote_counts_trigger
    AFTER INSERT OR UPDATE OR DELETE ON experience_votes
    FOR EACH ROW
    EXECUTE FUNCTION update_experience_vote_counts();

-- ============================================================================
-- WILSON SCORE FUNCTION (reusable)
-- ============================================================================

CREATE OR REPLACE FUNCTION wilson_lower_bound(positive INT, total INT)
RETURNS FLOAT AS $$
DECLARE
    z FLOAT := 1.96;  -- 95% confidence
    phat FLOAT;
BEGIN
    IF total = 0 THEN RETURN 0.0; END IF;
    phat := positive::FLOAT / total;
    RETURN (phat + z*z/(2*total) - z * sqrt((phat*(1-phat) + z*z/(4*total))/total)) / (1 + z*z/total);
END;
$$ LANGUAGE plpgsql IMMUTABLE;
