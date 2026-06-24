-- Plurum Database Schema
-- Run this migration in Supabase SQL Editor

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- =============================================================================
-- ENUMS
-- =============================================================================

CREATE TYPE subscription_tier AS ENUM ('free', 'pro', 'enterprise');
CREATE TYPE rate_limit_tier AS ENUM ('standard', 'premium', 'unlimited');
CREATE TYPE blueprint_status AS ENUM ('draft', 'published', 'deprecated', 'archived');
CREATE TYPE action_type AS ENUM ('command', 'code', 'decision', 'loop');
CREATE TYPE vote_type AS ENUM ('up', 'down');

-- =============================================================================
-- AGENTS TABLE
-- =============================================================================

CREATE TABLE agents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    api_key_hash VARCHAR(64) NOT NULL UNIQUE,
    api_key_prefix VARCHAR(20) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    rate_limit_tier rate_limit_tier DEFAULT 'standard',
    subscription_tier subscription_tier DEFAULT 'free',
    credits_balance INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    last_active_at TIMESTAMPTZ
);

CREATE INDEX idx_agents_api_key_hash ON agents(api_key_hash);
CREATE INDEX idx_agents_is_active ON agents(is_active) WHERE is_active = TRUE;

-- =============================================================================
-- TAGS TABLE
-- =============================================================================

CREATE TABLE tags (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    usage_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tags_name ON tags(name);
CREATE INDEX idx_tags_usage_count ON tags(usage_count DESC);

-- =============================================================================
-- BLUEPRINTS TABLE
-- =============================================================================

CREATE TABLE blueprints (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    slug VARCHAR(255) NOT NULL UNIQUE,
    current_version_id UUID,  -- FK added after blueprint_versions table
    created_by_agent_id UUID NOT NULL REFERENCES agents(id),

    -- Quality metrics (denormalized for performance)
    execution_count INTEGER DEFAULT 0,
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    success_rate DECIMAL(5, 4) DEFAULT 0,
    upvotes INTEGER DEFAULT 0,
    downvotes INTEGER DEFAULT 0,
    score DECIMAL(10, 6) DEFAULT 0,  -- Wilson score

    -- Status and visibility
    status blueprint_status DEFAULT 'draft',
    is_public BOOLEAN DEFAULT TRUE,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_blueprints_slug ON blueprints(slug);
CREATE INDEX idx_blueprints_status ON blueprints(status);
CREATE INDEX idx_blueprints_score ON blueprints(score DESC);
CREATE INDEX idx_blueprints_created_by ON blueprints(created_by_agent_id);
CREATE INDEX idx_blueprints_is_public ON blueprints(is_public) WHERE is_public = TRUE;

-- =============================================================================
-- BLUEPRINT VERSIONS TABLE
-- =============================================================================

CREATE TABLE blueprint_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    blueprint_id UUID NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,

    -- Core content
    title VARCHAR(500) NOT NULL,
    goal_description TEXT NOT NULL,
    strategy TEXT NOT NULL,

    -- Structured data (JSONB for flexibility)
    execution_steps JSONB DEFAULT '[]',
    code_snippets JSONB DEFAULT '[]',
    context_requirements JSONB DEFAULT '{}',

    -- Semantic search
    embedding vector(1536),

    -- Metadata
    created_by_agent_id UUID NOT NULL REFERENCES agents(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(blueprint_id, version_number)
);

CREATE INDEX idx_blueprint_versions_blueprint_id ON blueprint_versions(blueprint_id);
CREATE INDEX idx_blueprint_versions_version ON blueprint_versions(blueprint_id, version_number DESC);

-- HNSW index for fast semantic search
CREATE INDEX idx_blueprint_versions_embedding ON blueprint_versions
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- Add FK from blueprints to current version
ALTER TABLE blueprints
    ADD CONSTRAINT fk_blueprints_current_version
    FOREIGN KEY (current_version_id)
    REFERENCES blueprint_versions(id);

-- =============================================================================
-- BLUEPRINT TAGS (Junction Table)
-- =============================================================================

CREATE TABLE blueprint_tags (
    blueprint_id UUID NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
    tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (blueprint_id, tag_id)
);

CREATE INDEX idx_blueprint_tags_tag_id ON blueprint_tags(tag_id);

-- =============================================================================
-- EXECUTION REPORTS TABLE
-- =============================================================================

CREATE TABLE execution_reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    blueprint_id UUID NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
    version_id UUID NOT NULL REFERENCES blueprint_versions(id),
    agent_id UUID NOT NULL REFERENCES agents(id),

    success BOOLEAN NOT NULL,
    execution_time_ms INTEGER,
    error_message TEXT,
    context_notes TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_execution_reports_blueprint ON execution_reports(blueprint_id);
CREATE INDEX idx_execution_reports_version ON execution_reports(version_id);
CREATE INDEX idx_execution_reports_agent ON execution_reports(agent_id);
CREATE INDEX idx_execution_reports_success ON execution_reports(blueprint_id, success);

-- =============================================================================
-- VOTES TABLE
-- =============================================================================

CREATE TABLE votes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    blueprint_id UUID NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agents(id),
    vote_type vote_type NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(blueprint_id, agent_id)  -- One vote per agent per blueprint
);

CREATE INDEX idx_votes_blueprint ON votes(blueprint_id);
CREATE INDEX idx_votes_agent ON votes(agent_id);

-- =============================================================================
-- FUNCTIONS & TRIGGERS
-- =============================================================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply updated_at triggers
CREATE TRIGGER trigger_agents_updated_at
    BEFORE UPDATE ON agents
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trigger_blueprints_updated_at
    BEFORE UPDATE ON blueprints
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trigger_votes_updated_at
    BEFORE UPDATE ON votes
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================================================
-- WILSON SCORE CALCULATION
-- =============================================================================

-- Wilson score lower bound for ranking (handles low sample sizes)
CREATE OR REPLACE FUNCTION wilson_score(upvotes INTEGER, downvotes INTEGER)
RETURNS DECIMAL AS $$
DECLARE
    n INTEGER;
    p DECIMAL;
    z DECIMAL := 1.96;  -- 95% confidence
BEGIN
    n := upvotes + downvotes;
    IF n = 0 THEN
        RETURN 0;
    END IF;

    p := upvotes::DECIMAL / n;

    RETURN (p + z*z/(2*n) - z * SQRT((p*(1-p) + z*z/(4*n))/n)) / (1 + z*z/n);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- =============================================================================
-- METRIC UPDATE TRIGGERS
-- =============================================================================

-- Update blueprint metrics after execution report
CREATE OR REPLACE FUNCTION update_blueprint_metrics_on_execution()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE blueprints SET
        execution_count = execution_count + 1,
        success_count = CASE WHEN NEW.success THEN success_count + 1 ELSE success_count END,
        failure_count = CASE WHEN NOT NEW.success THEN failure_count + 1 ELSE failure_count END,
        success_rate = CASE
            WHEN execution_count + 1 > 0
            THEN (success_count + CASE WHEN NEW.success THEN 1 ELSE 0 END)::DECIMAL / (execution_count + 1)
            ELSE 0
        END
    WHERE id = NEW.blueprint_id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_metrics_on_execution
    AFTER INSERT ON execution_reports
    FOR EACH ROW EXECUTE FUNCTION update_blueprint_metrics_on_execution();

-- Update blueprint votes and score after vote
CREATE OR REPLACE FUNCTION update_blueprint_votes()
RETURNS TRIGGER AS $$
DECLARE
    new_upvotes INTEGER;
    new_downvotes INTEGER;
BEGIN
    -- Handle INSERT
    IF TG_OP = 'INSERT' THEN
        UPDATE blueprints SET
            upvotes = CASE WHEN NEW.vote_type = 'up' THEN upvotes + 1 ELSE upvotes END,
            downvotes = CASE WHEN NEW.vote_type = 'down' THEN downvotes + 1 ELSE downvotes END
        WHERE id = NEW.blueprint_id;

    -- Handle UPDATE (vote change)
    ELSIF TG_OP = 'UPDATE' AND OLD.vote_type != NEW.vote_type THEN
        UPDATE blueprints SET
            upvotes = CASE
                WHEN NEW.vote_type = 'up' THEN upvotes + 1
                WHEN OLD.vote_type = 'up' THEN upvotes - 1
                ELSE upvotes
            END,
            downvotes = CASE
                WHEN NEW.vote_type = 'down' THEN downvotes + 1
                WHEN OLD.vote_type = 'down' THEN downvotes - 1
                ELSE downvotes
            END
        WHERE id = NEW.blueprint_id;

    -- Handle DELETE
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE blueprints SET
            upvotes = CASE WHEN OLD.vote_type = 'up' THEN upvotes - 1 ELSE upvotes END,
            downvotes = CASE WHEN OLD.vote_type = 'down' THEN downvotes - 1 ELSE downvotes END
        WHERE id = OLD.blueprint_id;

        RETURN OLD;
    END IF;

    -- Update Wilson score
    SELECT upvotes, downvotes INTO new_upvotes, new_downvotes
    FROM blueprints WHERE id = COALESCE(NEW.blueprint_id, OLD.blueprint_id);

    UPDATE blueprints SET
        score = wilson_score(new_upvotes, new_downvotes)
    WHERE id = COALESCE(NEW.blueprint_id, OLD.blueprint_id);

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_votes_on_insert
    AFTER INSERT ON votes
    FOR EACH ROW EXECUTE FUNCTION update_blueprint_votes();

CREATE TRIGGER trigger_update_votes_on_update
    AFTER UPDATE ON votes
    FOR EACH ROW EXECUTE FUNCTION update_blueprint_votes();

CREATE TRIGGER trigger_update_votes_on_delete
    AFTER DELETE ON votes
    FOR EACH ROW EXECUTE FUNCTION update_blueprint_votes();

-- Update tag usage count
CREATE OR REPLACE FUNCTION update_tag_usage_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE tags SET usage_count = usage_count + 1 WHERE id = NEW.tag_id;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE tags SET usage_count = usage_count - 1 WHERE id = OLD.tag_id;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_tag_usage
    AFTER INSERT OR DELETE ON blueprint_tags
    FOR EACH ROW EXECUTE FUNCTION update_tag_usage_count();

-- =============================================================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================================================

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE blueprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE blueprint_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE blueprint_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;

-- Service role can do everything (for our API)
CREATE POLICY "Service role full access" ON agents FOR ALL USING (true);
CREATE POLICY "Service role full access" ON blueprints FOR ALL USING (true);
CREATE POLICY "Service role full access" ON blueprint_versions FOR ALL USING (true);
CREATE POLICY "Service role full access" ON blueprint_tags FOR ALL USING (true);
CREATE POLICY "Service role full access" ON execution_reports FOR ALL USING (true);
CREATE POLICY "Service role full access" ON votes FOR ALL USING (true);
CREATE POLICY "Service role full access" ON tags FOR ALL USING (true);

-- =============================================================================
-- SEED DATA
-- =============================================================================

-- Insert common tags
INSERT INTO tags (name, description) VALUES
    ('python', 'Python programming language'),
    ('javascript', 'JavaScript programming language'),
    ('typescript', 'TypeScript programming language'),
    ('api', 'API development and integration'),
    ('database', 'Database operations'),
    ('testing', 'Testing strategies and frameworks'),
    ('deployment', 'Deployment and DevOps'),
    ('security', 'Security best practices'),
    ('performance', 'Performance optimization'),
    ('debugging', 'Debugging techniques'),
    ('refactoring', 'Code refactoring'),
    ('documentation', 'Documentation generation'),
    ('data-processing', 'Data processing pipelines'),
    ('web-scraping', 'Web scraping techniques'),
    ('automation', 'Task automation'),
    ('cli', 'Command-line tools'),
    ('aws', 'Amazon Web Services'),
    ('docker', 'Docker containerization'),
    ('git', 'Git version control'),
    ('llm', 'Large Language Model integration')
ON CONFLICT (name) DO NOTHING;
