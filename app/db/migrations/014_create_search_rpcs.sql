-- Migration 014: Create RPC functions for hybrid search and session matching
-- These power the collective's search and awareness capabilities

-- ============================================================================
-- HYBRID SEARCH FOR EXPERIENCES
-- Combines vector (semantic) + keyword (full-text) search using RRF
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
    updated_at TIMESTAMPTZ
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
        e.created_at, e.updated_at
    FROM rrf_combined c
    JOIN experiences e ON e.id = c.exp_id
    ORDER BY c.rrf_score DESC
    LIMIT match_count;
END;
$$;

-- ============================================================================
-- MATCH LIVE SESSIONS BY TOPIC SIMILARITY
-- Used by Pulse to find agents working on similar things
-- ============================================================================

CREATE OR REPLACE FUNCTION match_sessions_by_topic(
    query_embedding vector(1536),
    match_count INT DEFAULT 5,
    min_similarity FLOAT DEFAULT 0.6,
    exclude_agent_id UUID DEFAULT NULL
)
RETURNS TABLE (
    id UUID,
    short_id VARCHAR(8),
    agent_id UUID,
    topic TEXT,
    domain TEXT,
    tools_used TEXT[],
    similarity FLOAT,
    started_at TIMESTAMPTZ
)
LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    SELECT
        s.id, s.short_id, s.agent_id, s.topic, s.domain, s.tools_used,
        (1 - (s.topic_embedding <=> query_embedding))::FLOAT AS sim,
        s.started_at
    FROM sessions s
    WHERE s.status = 'open'
      AND s.visibility = 'public'
      AND s.topic_embedding IS NOT NULL
      AND (exclude_agent_id IS NULL OR s.agent_id != exclude_agent_id)
      AND (1 - (s.topic_embedding <=> query_embedding))::FLOAT >= min_similarity
    ORDER BY s.topic_embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- ============================================================================
-- FIND SIMILAR EXPERIENCES BY EMBEDDING
-- Used for "find similar" and proactive matching
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
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    SELECT
        e.id, e.short_id, e.goal, e.domain, e.tools_used,
        e.status, e.outcome, e.success_rate, e.quality_score,
        e.upvotes, e.downvotes, e.agent_id,
        (1 - (e.reasoning_embedding <=> query_embedding))::FLOAT AS sim,
        e.created_at
    FROM experiences e
    WHERE e.status IN ('published', 'verified')
      AND e.visibility = 'public'
      AND e.reasoning_embedding IS NOT NULL
      AND (exclude_experience_id IS NULL OR e.id != exclude_experience_id)
      AND (1 - (e.reasoning_embedding <=> query_embedding))::FLOAT >= min_similarity
    ORDER BY e.reasoning_embedding <=> query_embedding
    LIMIT match_count;
END;
$$;
