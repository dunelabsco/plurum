-- Migration 009: Add short_id to search_blueprints function
-- The search_blueprints function (used by find_similar) was missing short_id,
-- causing empty short_id values in similar blueprint results.

BEGIN;

CREATE OR REPLACE FUNCTION search_blueprints(
    query_embedding vector(1536),
    match_threshold float DEFAULT 0.3,
    match_count int DEFAULT 10,
    status_filter text[] DEFAULT ARRAY['published'],
    exclude_blueprint_id uuid DEFAULT NULL,
    exclude_agent_id uuid DEFAULT NULL
)
RETURNS TABLE (
    id uuid,
    short_id text,
    slug text,
    current_version_id uuid,
    title text,
    goal_description text,
    status text,
    is_public boolean,
    execution_count int,
    success_count int,
    failure_count int,
    success_rate numeric,
    upvotes int,
    downvotes int,
    score numeric,
    created_by_agent_id uuid,
    created_at timestamptz,
    updated_at timestamptz,
    similarity float,
    tags text[],
    verification_tier verification_tier,
    risk_score smallint,
    permissions_required text[],
    risk_flags text[],
    environment_constraints jsonb
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        b.id,
        b.short_id::text,
        b.slug::text,
        b.current_version_id,
        bv.title::text,
        bv.goal_description::text,
        b.status::text,
        b.is_public,
        b.execution_count,
        b.success_count,
        b.failure_count,
        b.success_rate,
        b.upvotes,
        b.downvotes,
        b.score,
        b.created_by_agent_id,
        b.created_at,
        b.updated_at,
        1 - (bv.embedding <=> query_embedding) AS similarity,
        COALESCE(
            (
                SELECT array_agg(t.name)
                FROM blueprint_tags bt
                JOIN tags t ON t.id = bt.tag_id
                WHERE bt.blueprint_id = b.id
            ),
            ARRAY[]::text[]
        ) AS tags,
        bv.verification_tier,
        bv.risk_score,
        bv.permissions_required,
        bv.risk_flags,
        bv.environment_constraints
    FROM blueprints b
    JOIN blueprint_versions bv ON bv.id = b.current_version_id
    WHERE
        b.status::text = ANY(status_filter)
        AND b.is_public = true
        AND bv.embedding IS NOT NULL
        AND (exclude_blueprint_id IS NULL OR b.id != exclude_blueprint_id)
        AND (exclude_agent_id IS NULL OR b.created_by_agent_id != exclude_agent_id)
        AND 1 - (bv.embedding <=> query_embedding) > match_threshold
    ORDER BY similarity DESC
    LIMIT match_count;
END;
$$;

GRANT EXECUTE ON FUNCTION search_blueprints TO authenticated;
GRANT EXECUTE ON FUNCTION search_blueprints TO service_role;

COMMIT;
