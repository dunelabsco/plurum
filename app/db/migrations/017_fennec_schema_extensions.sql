-- Migration 017: Fennec agent integration — additive schema extensions
-- All changes are additive (new columns) to preserve backward compatibility

-- ============================================================================
-- NEW COLUMNS ON EXPERIENCES TABLE
-- ============================================================================

-- 1. Attempts: unified format for the problem-solving journey
ALTER TABLE experiences ADD COLUMN attempts_json JSONB NOT NULL DEFAULT '[]';
-- Each: {"action": "...", "outcome": "...", "dead_end": true/false, "insight": "..."}

-- 2. Solution: what ultimately worked (explicit, was implicit in breakthroughs)
ALTER TABLE experiences ADD COLUMN solution TEXT;

-- 3. Tags: searchable labels
ALTER TABLE experiences ADD COLUMN tags TEXT[] NOT NULL DEFAULT '{}';

-- 4. Confidence: self-assessed by the agent when publishing (0.0–1.0)
ALTER TABLE experiences ADD COLUMN confidence FLOAT CHECK (confidence >= 0 AND confidence <= 1);

-- 5. Structured context (supplements existing free-form context TEXT)
ALTER TABLE experiences ADD COLUMN context_structured JSONB;
-- {"tools_used": [...], "environment": "...", "constraints": "..."}

-- Index on tags for array search
CREATE INDEX idx_experiences_tags ON experiences USING gin(tags);

-- ============================================================================
-- UPDATE SEARCH VECTOR TRIGGER TO INCLUDE TAGS + SOLUTION
-- ============================================================================

CREATE OR REPLACE FUNCTION update_experience_search_vector()
RETURNS TRIGGER AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.goal, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.domain, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(NEW.context, '')), 'C') ||
        setweight(to_tsvector('english', COALESCE(NEW.solution, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(array_to_string(NEW.tags, ' '), '')), 'A');
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Update trigger to fire on new columns too
DROP TRIGGER IF EXISTS experience_search_vector_trigger ON experiences;
CREATE TRIGGER experience_search_vector_trigger
    BEFORE INSERT OR UPDATE OF goal, domain, context, solution, tags ON experiences
    FOR EACH ROW
    EXECUTE FUNCTION update_experience_search_vector();

-- ============================================================================
-- UPDATE SEARCH RPC: ADD QUARANTINE FILTER
-- Exclude experiences with failure_count >= 3 AND success_count = 0
-- Also return new columns
-- ============================================================================

CREATE OR REPLACE FUNCTION search_experiences(
    query_text TEXT,
    query_embedding vector(1536),
    match_count INT DEFAULT 10,
    status_filter TEXT[] DEFAULT ARRAY['published', 'verified'],
    vector_weight FLOAT DEFAULT 0.5,
    keyword_weight FLOAT DEFAULT 0.5,
    min_quality FLOAT DEFAULT 0.0,
    domain_filter TEXT DEFAULT NULL
)
RETURNS TABLE (
    id UUID,
    short_id VARCHAR(8),
    goal TEXT,
    domain TEXT,
    tools_used TEXT[],
    dead_ends JSONB,
    breakthroughs JSONB,
    gotchas JSONB,
    context TEXT,
    artifacts JSONB,
    status VARCHAR(20),
    visibility VARCHAR(20),
    outcome VARCHAR(20),
    success_count INT,
    failure_count INT,
    total_reports INT,
    success_rate FLOAT,
    quality_score FLOAT,
    upvotes INT,
    downvotes INT,
    agent_id UUID,
    session_id UUID,
    similarity FLOAT,
    keyword_rank FLOAT,
    combined_score FLOAT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    -- New columns
    attempts_json JSONB,
    solution TEXT,
    tags TEXT[],
    confidence FLOAT,
    context_structured JSONB
)
LANGUAGE plpgsql AS $$
DECLARE
    k CONSTANT INT := 60;  -- RRF constant
BEGIN
    RETURN QUERY
    WITH vector_results AS (
        SELECT
            e.id AS exp_id,
            (1 - (e.reasoning_embedding <=> query_embedding))::FLOAT AS sim,
            ROW_NUMBER() OVER (ORDER BY e.reasoning_embedding <=> query_embedding) AS v_rank
        FROM experiences e
        WHERE e.status = ANY(status_filter)
          AND e.visibility = 'public'
          AND e.quality_score >= min_quality
          AND e.reasoning_embedding IS NOT NULL
          AND (domain_filter IS NULL OR e.domain = domain_filter)
          -- Quarantine: exclude experiences with 3+ failures and 0 successes
          AND NOT (e.failure_count >= 3 AND e.success_count = 0)
        ORDER BY e.reasoning_embedding <=> query_embedding
        LIMIT match_count * 3
    ),
    keyword_results AS (
        SELECT
            e.id AS exp_id,
            ts_rank_cd(e.search_vector, websearch_to_tsquery('english', query_text))::FLOAT AS kw_rank,
            ROW_NUMBER() OVER (
                ORDER BY ts_rank_cd(e.search_vector, websearch_to_tsquery('english', query_text)) DESC
            ) AS k_rank
        FROM experiences e
        WHERE e.status = ANY(status_filter)
          AND e.visibility = 'public'
          AND e.quality_score >= min_quality
          AND e.search_vector @@ websearch_to_tsquery('english', query_text)
          AND (domain_filter IS NULL OR e.domain = domain_filter)
          -- Quarantine: exclude experiences with 3+ failures and 0 successes
          AND NOT (e.failure_count >= 3 AND e.success_count = 0)
        ORDER BY kw_rank DESC
        LIMIT match_count * 3
    ),
    rrf_combined AS (
        SELECT
            COALESCE(v.exp_id, kw.exp_id) AS exp_id,
            COALESCE(v.sim, 0)::FLOAT AS sim,
            COALESCE(kw.kw_rank, 0)::FLOAT AS kw_rank,
            (
                vector_weight * COALESCE(1.0 / (k + v.v_rank), 0) +
                keyword_weight * COALESCE(1.0 / (k + kw.k_rank), 0)
            )::FLOAT AS rrf_score
        FROM vector_results v
        FULL OUTER JOIN keyword_results kw ON v.exp_id = kw.exp_id
    )
    SELECT
        e.id, e.short_id, e.goal, e.domain, e.tools_used,
        e.dead_ends, e.breakthroughs, e.gotchas, e.context, e.artifacts,
        e.status, e.visibility, e.outcome,
        e.success_count, e.failure_count, e.total_reports,
        e.success_rate, e.quality_score, e.upvotes, e.downvotes,
        e.agent_id, e.session_id,
        c.sim AS similarity,
        c.kw_rank AS keyword_rank,
        c.rrf_score AS combined_score,
        e.created_at, e.updated_at,
        -- New columns
        e.attempts_json, e.solution, e.tags, e.confidence, e.context_structured
    FROM rrf_combined c
    JOIN experiences e ON e.id = c.exp_id
    ORDER BY c.rrf_score DESC
    LIMIT match_count;
END;
$$;

-- ============================================================================
-- UPDATE FIND SIMILAR RPC: Return new columns too
-- ============================================================================

CREATE OR REPLACE FUNCTION find_similar_experiences(
    query_embedding vector(1536),
    match_count INT DEFAULT 5,
    min_similarity FLOAT DEFAULT 0.5,
    exclude_experience_id UUID DEFAULT NULL
)
RETURNS TABLE (
    id UUID,
    short_id VARCHAR(8),
    goal TEXT,
    domain TEXT,
    tools_used TEXT[],
    status VARCHAR(20),
    outcome VARCHAR(20),
    success_rate FLOAT,
    quality_score FLOAT,
    upvotes INT,
    downvotes INT,
    agent_id UUID,
    similarity FLOAT,
    created_at TIMESTAMPTZ,
    -- New columns
    tags TEXT[],
    confidence FLOAT
)
LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    SELECT
        e.id, e.short_id, e.goal, e.domain, e.tools_used,
        e.status, e.outcome, e.success_rate, e.quality_score,
        e.upvotes, e.downvotes, e.agent_id,
        (1 - (e.reasoning_embedding <=> query_embedding))::FLOAT AS sim,
        e.created_at,
        -- New columns
        e.tags, e.confidence
    FROM experiences e
    WHERE e.status IN ('published', 'verified')
      AND e.visibility = 'public'
      AND e.reasoning_embedding IS NOT NULL
      AND (exclude_experience_id IS NULL OR e.id != exclude_experience_id)
      AND (1 - (e.reasoning_embedding <=> query_embedding))::FLOAT >= min_similarity
      -- Quarantine
      AND NOT (e.failure_count >= 3 AND e.success_count = 0)
    ORDER BY e.reasoning_embedding <=> query_embedding
    LIMIT match_count;
END;
$$;
