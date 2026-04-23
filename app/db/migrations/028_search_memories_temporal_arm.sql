-- Migration 028: 4-way retrieval — add a temporal arm
--
-- Phase 4b of mem0/hindsight parity. Previous search_memories was 3-way
-- (vector + keyword + entity). Hindsight's retrieval stack adds a fourth
-- arm that treats the query's implied time window as a first-class signal
-- — memories whose `event_date_start/end` or `mentioned_at` intersect
-- the window get boosted via RRF.
--
-- The caller parses the query upstream (MemoryService._analyze_query
-- does this with a single gpt-4o-mini call) and passes the window as
-- two ISO-date strings. If the query has no temporal reference they are
-- NULL and the arm is a no-op.
--
-- Match logic:
--   A memory intersects [ts, te] if ANY of the following:
--     - event_date_start <= te AND event_date_end >= ts      (event window overlap)
--     - event_date_start <= te AND event_date_start >= ts    (single-date event inside window)
--     - mentioned_at     BETWEEN ts AND te                   (mentioned inside window)
--
-- Ranking inside the arm:
--   We score by "distance from window midpoint" so memories actually INSIDE
--   the window outrank those that just overlap at the edges. Ties break on
--   event_date_start ASC (earliest event first — stable ordering).

DROP FUNCTION IF EXISTS search_memories(UUID, TEXT, vector(1536), INT, TEXT, UUID[], FLOAT[], FLOAT, FLOAT, FLOAT);

CREATE OR REPLACE FUNCTION search_memories(
    p_user_id UUID,
    query_text TEXT,
    query_embedding vector(1536),
    match_count INT DEFAULT 10,
    memory_type_filter TEXT DEFAULT NULL,
    entity_mem_ids UUID[] DEFAULT NULL,
    entity_mem_scores FLOAT[] DEFAULT NULL,
    temporal_start TIMESTAMPTZ DEFAULT NULL,
    temporal_end TIMESTAMPTZ DEFAULT NULL,
    vector_weight FLOAT DEFAULT 0.35,
    keyword_weight FLOAT DEFAULT 0.25,
    entity_weight FLOAT DEFAULT 0.20,
    temporal_weight FLOAT DEFAULT 0.20
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
    mentioned_at TIMESTAMPTZ,
    source_user TEXT,
    source_assistant TEXT,
    similarity FLOAT,
    keyword_rank FLOAT,
    entity_match FLOAT,
    temporal_match FLOAT,
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
    temporal_midpoint    TIMESTAMPTZ;
BEGIN
    SELECT midpoint, steepness
    INTO   bm25_midpoint, bm25_steepness
    FROM   bm25_sigmoid_params(query_text);

    -- Midpoint of the temporal window, used to rank intersecting memories
    -- by how central they are to the window (closer midpoint = stronger).
    IF temporal_start IS NOT NULL AND temporal_end IS NOT NULL THEN
        temporal_midpoint := temporal_start + (temporal_end - temporal_start) / 2;
    END IF;

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
    -- TEMPORAL ARM (Phase 4b): memories whose event or mention falls inside
    -- the query's implied time window. We score each hit by how close its
    -- event midpoint is to the window midpoint — memories wholly inside
    -- the window rank above those that only overlap at the edges.
    temporal_candidates AS (
        SELECT
            m.id AS mem_id,
            -- Pick the most event-like anchor we have: prefer event_date_start,
            -- fall back to mentioned_at, then created_at.
            COALESCE(m.event_date_start, m.mentioned_at, m.created_at) AS anchor
        FROM memories m
        WHERE temporal_start IS NOT NULL
          AND temporal_end IS NOT NULL
          AND m.user_id = p_user_id
          AND m.is_active = true
          AND (memory_type_filter IS NULL OR m.memory_type = memory_type_filter)
          AND (m.expires_at IS NULL OR m.expires_at > NOW())
          AND (
              (m.event_date_start IS NOT NULL
                   AND m.event_date_start <= temporal_end
                   AND COALESCE(m.event_date_end, m.event_date_start) >= temporal_start)
              OR
              (m.mentioned_at IS NOT NULL
                   AND m.mentioned_at BETWEEN temporal_start AND temporal_end)
          )
    ),
    temporal_results AS (
        SELECT
            tc.mem_id,
            -- Inverse distance — 1.0 when anchor equals midpoint,
            -- 0.0 when anchor equals a window edge, negative never used
            -- because anchors outside the window are filtered upstream.
            GREATEST(
                0.0,
                1.0 - ABS(EXTRACT(EPOCH FROM (tc.anchor - temporal_midpoint)))
                    / NULLIF(EXTRACT(EPOCH FROM (temporal_end - temporal_start)) / 2.0, 0)
            )::FLOAT AS t_score,
            ROW_NUMBER() OVER (
                ORDER BY ABS(EXTRACT(EPOCH FROM (tc.anchor - temporal_midpoint))) ASC
            ) AS t_rank
        FROM temporal_candidates tc
        LIMIT match_count * 4
    ),
    rrf_combined AS (
        SELECT
            COALESCE(v.mem_id, kw.mem_id, er.mem_id, tr.mem_id) AS mem_id,
            COALESCE(v.sim,       0)::FLOAT AS sim,
            COALESCE(kw.bm25_norm, 0)::FLOAT AS kw_rank,
            COALESCE(er.ent_score, 0)::FLOAT AS ent_match,
            COALESCE(tr.t_score,   0)::FLOAT AS t_match,
            (
                vector_weight   * COALESCE(1.0 / (k + v.v_rank),  0) +
                keyword_weight  * COALESCE(1.0 / (k + kw.k_rank), 0) +
                entity_weight   * COALESCE(1.0 / (k + er.e_rank), 0) +
                temporal_weight * COALESCE(1.0 / (k + tr.t_rank), 0)
            )::FLOAT AS rrf_score
        FROM vector_results v
        FULL OUTER JOIN keyword_results kw ON v.mem_id = kw.mem_id
        FULL OUTER JOIN entity_results  er ON COALESCE(v.mem_id, kw.mem_id) = er.mem_id
        FULL OUTER JOIN temporal_results tr ON COALESCE(v.mem_id, kw.mem_id, er.mem_id) = tr.mem_id
    ),
    reranked AS (
        SELECT
            c.mem_id,
            c.sim,
            c.kw_rank,
            c.ent_match,
            c.t_match,
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
        m.event_date_start, m.event_date_end, m.mentioned_at,
        m.source_user, m.source_assistant,
        r.sim       AS similarity,
        r.kw_rank   AS keyword_rank,
        r.ent_match AS entity_match,
        r.t_match   AS temporal_match,
        r.rrf_score AS combined_score,
        r.rerank    AS reranked_score
    FROM reranked r
    JOIN memories m ON m.id = r.mem_id
    ORDER BY r.rerank DESC
    LIMIT match_count;
END;
$$;
