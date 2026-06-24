-- Migration 026: Adaptive BM25 sigmoid normalization
--
-- Phase 3 of mem0 parity. Our RPC's keyword arm ranks memories by raw
-- ts_rank_cd, feeds that rank into RRF, and moves on. Raw ts_rank_cd is
-- unbounded and scales with query length — long queries dominate the
-- keyword arm, short queries barely register.
--
-- Mem0 normalizes BM25 through a logistic sigmoid with query-length-
-- adaptive midpoint and steepness:
--
--    num_terms ≤  3  →  midpoint 5.0,  steepness 0.7
--    num_terms ≤  6  →  midpoint 7.0,  steepness 0.6
--    num_terms ≤  9  →  midpoint 9.0,  steepness 0.5
--    num_terms ≤ 15  →  midpoint 10.0, steepness 0.5
--    num_terms >  15 →  midpoint 12.0, steepness 0.5
--
--    normalized = 1 / (1 + exp(-steepness * (raw - midpoint)))
--
-- We still feed the keyword arm's RANK into RRF (rank-based fusion is
-- robust), but we sort the keyword arm itself by the normalized score
-- so borderline matches rank consistently regardless of query length.
-- The output row's `keyword_rank` column now holds the sigmoid score
-- (0..1) instead of raw ts_rank_cd, which also makes debugging easier.
--
-- Helper function is declared IMMUTABLE so Postgres can inline / cache
-- the per-query parameters.

CREATE OR REPLACE FUNCTION bm25_sigmoid_params(query_text TEXT)
RETURNS TABLE (midpoint FLOAT, steepness FLOAT)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    num_terms INT;
BEGIN
    -- Match mem0's token count: simple whitespace split, bounded.
    -- Postgres regexp_split_to_array is fine for our query length.
    num_terms := COALESCE(
        array_length(
            regexp_split_to_array(btrim(query_text), '\s+'),
            1
        ),
        1
    );

    IF num_terms <= 3 THEN
        RETURN QUERY SELECT 5.0::FLOAT,  0.7::FLOAT;
    ELSIF num_terms <= 6 THEN
        RETURN QUERY SELECT 7.0::FLOAT,  0.6::FLOAT;
    ELSIF num_terms <= 9 THEN
        RETURN QUERY SELECT 9.0::FLOAT,  0.5::FLOAT;
    ELSIF num_terms <= 15 THEN
        RETURN QUERY SELECT 10.0::FLOAT, 0.5::FLOAT;
    ELSE
        RETURN QUERY SELECT 12.0::FLOAT, 0.5::FLOAT;
    END IF;
END;
$$;

-- Rebuild search_memories with sigmoid-normalized keyword arm. The rest
-- of the RPC (vector arm, entity arm from migration 025, RRF fusion,
-- multiplicative rerank) is byte-identical to migration 025.
DROP FUNCTION IF EXISTS search_memories(UUID, TEXT, vector(1536), INT, TEXT, UUID[], FLOAT[], FLOAT, FLOAT, FLOAT);

CREATE OR REPLACE FUNCTION search_memories(
    p_user_id UUID,
    query_text TEXT,
    query_embedding vector(1536),
    match_count INT DEFAULT 10,
    memory_type_filter TEXT DEFAULT NULL,
    entity_mem_ids UUID[] DEFAULT NULL,
    entity_mem_scores FLOAT[] DEFAULT NULL,
    vector_weight FLOAT DEFAULT 0.4,
    keyword_weight FLOAT DEFAULT 0.3,
    entity_weight FLOAT DEFAULT 0.3
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
    event_date_start TIMESTAMPTZ,
    event_date_end TIMESTAMPTZ,
    similarity FLOAT,
    keyword_rank FLOAT,
    entity_match FLOAT,
    combined_score FLOAT,
    reranked_score FLOAT
)
LANGUAGE plpgsql AS $$
DECLARE
    k                    CONSTANT INT   := 60;
    recency_strength     CONSTANT FLOAT := 0.15;
    importance_strength  CONSTANT FLOAT := 0.10;
    bm25_midpoint        FLOAT;
    bm25_steepness       FLOAT;
BEGIN
    SELECT midpoint, steepness
    INTO   bm25_midpoint, bm25_steepness
    FROM   bm25_sigmoid_params(query_text);

    RETURN QUERY
    WITH
    vector_results AS (
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
        LIMIT match_count * 4
    ),
    keyword_raw AS (
        SELECT
            m.id AS mem_id,
            ts_rank_cd(m.search_vector, websearch_to_tsquery('english', query_text))::FLOAT AS raw_bm25
        FROM memories m
        WHERE m.user_id = p_user_id
          AND m.is_active = true
          AND m.search_vector @@ websearch_to_tsquery('english', query_text)
          AND (memory_type_filter IS NULL OR m.memory_type = memory_type_filter)
          AND (m.expires_at IS NULL OR m.expires_at > NOW())
    ),
    keyword_results AS (
        SELECT
            mem_id,
            -- Sigmoid-normalized BM25 ∈ (0, 1). Rank still drives RRF,
            -- but the NORMALIZED score is more meaningful for debugging
            -- and is what we surface in the output row.
            (1.0 / (1.0 + exp(-bm25_steepness * (raw_bm25 - bm25_midpoint))))::FLOAT AS bm25_norm,
            ROW_NUMBER() OVER (
                ORDER BY (1.0 / (1.0 + exp(-bm25_steepness * (raw_bm25 - bm25_midpoint)))) DESC
            ) AS k_rank
        FROM keyword_raw
        ORDER BY bm25_norm DESC
        LIMIT match_count * 4
    ),
    entity_input AS (
        SELECT
            x.mem_id,
            x.ent_score
        FROM UNNEST(
            COALESCE(entity_mem_ids,    ARRAY[]::UUID[]),
            COALESCE(entity_mem_scores, ARRAY[]::FLOAT[])
        ) AS x(mem_id, ent_score)
        WHERE x.mem_id IS NOT NULL
    ),
    entity_results AS (
        SELECT
            ei.mem_id,
            ei.ent_score,
            ROW_NUMBER() OVER (ORDER BY ei.ent_score DESC) AS e_rank
        FROM entity_input ei
        JOIN memories m ON m.id = ei.mem_id
        WHERE m.user_id = p_user_id
          AND m.is_active = true
          AND (memory_type_filter IS NULL OR m.memory_type = memory_type_filter)
          AND (m.expires_at IS NULL OR m.expires_at > NOW())
    ),
    rrf_combined AS (
        SELECT
            COALESCE(v.mem_id, kw.mem_id, er.mem_id) AS mem_id,
            COALESCE(v.sim, 0)::FLOAT AS sim,
            COALESCE(kw.bm25_norm, 0)::FLOAT AS kw_rank,
            COALESCE(er.ent_score, 0)::FLOAT AS ent_match,
            (
                vector_weight  * COALESCE(1.0 / (k + v.v_rank),  0) +
                keyword_weight * COALESCE(1.0 / (k + kw.k_rank), 0) +
                entity_weight  * COALESCE(1.0 / (k + er.e_rank), 0)
            )::FLOAT AS rrf_score
        FROM vector_results v
        FULL OUTER JOIN keyword_results kw ON v.mem_id = kw.mem_id
        FULL OUTER JOIN entity_results er ON COALESCE(v.mem_id, kw.mem_id) = er.mem_id
    ),
    reranked AS (
        SELECT
            c.mem_id,
            c.sim,
            c.kw_rank,
            c.ent_match,
            c.rrf_score,
            (
                c.rrf_score
                * (1.0 + recency_strength * (
                    GREATEST(0.0, LEAST(1.0,
                        1.0 - EXTRACT(EPOCH FROM (NOW() - m.created_at)) / (365.0 * 86400.0)
                    )) - 0.5
                  ))
                * (1.0 + importance_strength * (
                    CASE m.importance
                        WHEN 'high'   THEN 1.0
                        WHEN 'medium' THEN 0.5
                        WHEN 'low'    THEN 0.0
                        ELSE                0.5
                    END - 0.5
                  ))
            )::FLOAT AS rerank
        FROM rrf_combined c
        JOIN memories m ON m.id = c.mem_id
    )
    SELECT
        m.id, m.short_id, m.content, m.memory_type, m.importance, m.metadata,
        m.agent_id, m.session_id, m.created_at,
        m.event_date_start, m.event_date_end,
        r.sim AS similarity,
        r.kw_rank AS keyword_rank,
        r.ent_match AS entity_match,
        r.rrf_score AS combined_score,
        r.rerank AS reranked_score
    FROM reranked r
    JOIN memories m ON m.id = r.mem_id
    ORDER BY r.rerank DESC
    LIMIT match_count;
END;
$$;
