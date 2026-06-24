-- Migration 021: Entity retrieval arm + multiplicative rerank
--
-- Phase 2 + 3 of retrieval upgrade. Replaces the 2-way RRF search with a
-- 3-way RRF (vector + keyword + entity) followed by a multiplicative
-- post-fusion rerank that applies soft boosts for recency, temporal match,
-- and importance.
--
-- Inspired by Mem0's spread-attenuated entity boost and Hindsight's
-- multiplicative reranking. Neither is copied verbatim.

DROP FUNCTION IF EXISTS search_memories(UUID, TEXT, vector(1536), INT, TEXT, FLOAT, FLOAT);

CREATE OR REPLACE FUNCTION search_memories(
    p_user_id UUID,
    query_text TEXT,
    query_embedding vector(1536),
    match_count INT DEFAULT 10,
    memory_type_filter TEXT DEFAULT NULL,
    query_entities TEXT[] DEFAULT NULL,                      -- NEW: entity arm input
    vector_weight FLOAT DEFAULT 0.4,                         -- was 0.5 (make room for entity)
    keyword_weight FLOAT DEFAULT 0.3,                        -- was 0.5
    entity_weight FLOAT DEFAULT 0.3                          -- NEW
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
    entity_match FLOAT,                                      -- NEW
    combined_score FLOAT,
    reranked_score FLOAT                                     -- NEW: post-rerank
)
LANGUAGE plpgsql AS $$
DECLARE
    k CONSTANT INT := 60;
    -- Multiplicative rerank signal strengths (each boost caps at ±strength)
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
        LIMIT match_count * 4                                -- over-fetch 4× (was 3×)
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
    -- ENTITY ARM: memories that share entities with the query, with spread
    -- attenuation. Popular entities (linked to many memories for this user)
    -- contribute a diluted boost so they don't flood results.
    entity_results AS (
        SELECT
            m.id AS mem_id,
            -- Count how many query entities this memory matches (raw signal)
            (
                SELECT COUNT(DISTINCT qe)::FLOAT
                FROM UNNEST(query_entities) qe
                WHERE EXISTS (
                    SELECT 1
                    FROM JSONB_ARRAY_ELEMENTS_TEXT(
                        COALESCE(m.metadata->'entities', '[]'::jsonb)
                    ) me
                    WHERE LOWER(me) = LOWER(qe)
                )
            ) AS matches,
            -- Spread-attenuated magnitude: memories with many linked entities
            -- get less weight per match
            (
                SELECT
                    CASE
                        WHEN JSONB_ARRAY_LENGTH(COALESCE(m.metadata->'entities', '[]'::jsonb)) = 0 THEN 0
                        ELSE 0.5 / (1.0 + 0.001 * POWER(
                            JSONB_ARRAY_LENGTH(m.metadata->'entities') - 1, 2
                        ))
                    END
            ) AS spread,
            ROW_NUMBER() OVER (
                ORDER BY (
                    SELECT COUNT(DISTINCT qe)::FLOAT
                    FROM UNNEST(query_entities) qe
                    WHERE EXISTS (
                        SELECT 1
                        FROM JSONB_ARRAY_ELEMENTS_TEXT(
                            COALESCE(m.metadata->'entities', '[]'::jsonb)
                        ) me
                        WHERE LOWER(me) = LOWER(qe)
                    )
                ) DESC
            ) AS e_rank
        FROM memories m
        WHERE query_entities IS NOT NULL
          AND array_length(query_entities, 1) > 0
          AND m.user_id = p_user_id
          AND m.is_active = true
          AND (memory_type_filter IS NULL OR m.memory_type = memory_type_filter)
          AND (m.expires_at IS NULL OR m.expires_at > NOW())
          AND m.metadata ? 'entities'
          AND EXISTS (
              SELECT 1
              FROM JSONB_ARRAY_ELEMENTS_TEXT(m.metadata->'entities') me
              WHERE LOWER(me) = ANY(SELECT LOWER(qe) FROM UNNEST(query_entities) qe)
          )
        ORDER BY e_rank
        LIMIT match_count * 4
    ),
    rrf_combined AS (
        SELECT
            COALESCE(v.mem_id, kw.mem_id, er.mem_id) AS mem_id,
            COALESCE(v.sim, 0)::FLOAT AS sim,
            COALESCE(kw.kw_rank, 0)::FLOAT AS kw_rank,
            COALESCE(er.matches * er.spread, 0)::FLOAT AS ent_match,
            (
                vector_weight  * COALESCE(1.0 / (k + v.v_rank), 0) +
                keyword_weight * COALESCE(1.0 / (k + kw.k_rank), 0) +
                entity_weight  * COALESCE(1.0 / (k + er.e_rank), 0)
            )::FLOAT AS rrf_score
        FROM vector_results v
        FULL OUTER JOIN keyword_results kw ON v.mem_id = kw.mem_id
        FULL OUTER JOIN entity_results er ON COALESCE(v.mem_id, kw.mem_id) = er.mem_id
    ),
    -- Multiplicative rerank: each factor is neutral at 0.5 → multiplier 1.0
    -- so absent signals don't penalize memories.
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
                    -- Recency: 1.0 if today, 0.0 if 365 days old, linear in between
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
    ORDER BY r.rerank DESC                                   -- sort by reranked score now
    LIMIT match_count;
END;
$$;
