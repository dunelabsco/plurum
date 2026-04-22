-- Migration 025: Entity-store-backed search
--
-- Depends on migration 024 (entities table). Rewrites the entity arm of
-- `search_memories` so that cross-session entity identity is captured.
--
-- OLD behavior (migration 021):
--   Entity arm matched on LOWER(metadata->'entities') exact text. "Dr. Smith"
--   and "primary care physician" were unrelated rows even if the extractor
--   knew they were the same person.
--
-- NEW behavior:
--   The caller pre-resolves query entities against the `entities` table
--   (vector search, loose threshold) and passes in two parallel arrays:
--     - entity_mem_ids UUID[]     — memory ids that share an entity with the query
--     - entity_mem_scores FLOAT[] — spread-attenuated boost per memory id
--   The arm uses these directly instead of re-computing from JSONB.
--
-- The rest of the RPC (vector + keyword arms, RRF fusion, multiplicative
-- rerank) is unchanged. This keeps the retrieval shape stable — only the
-- entity arm source changes.

DROP FUNCTION IF EXISTS search_memories(UUID, TEXT, vector(1536), INT, TEXT, TEXT[], FLOAT, FLOAT, FLOAT);
DROP FUNCTION IF EXISTS search_memories(UUID, TEXT, vector(1536), INT, TEXT, FLOAT, FLOAT);

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
    k CONSTANT INT := 60;
    recency_strength     CONSTANT FLOAT := 0.15;
    importance_strength  CONSTANT FLOAT := 0.10;
BEGIN
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
        LIMIT match_count * 4
    ),
    -- ENTITY ARM (v2, table-backed):
    -- The caller supplies pre-aggregated (mem_id, score) pairs from the
    -- entities table. We rank them locally and use the rank in RRF.
    -- If no entity input is provided (NULL / empty arrays), the arm is a
    -- no-op and fusion just uses vector + keyword.
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
            COALESCE(kw.kw_rank, 0)::FLOAT AS kw_rank,
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
