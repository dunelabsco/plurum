-- Semantic Search Function for Plurum
-- Run this after 001_initial_schema.sql

-- =============================================================================
-- SEMANTIC SEARCH FUNCTION
-- =============================================================================

-- Drop existing function if it exists
DROP FUNCTION IF EXISTS search_blueprints;

-- Create the semantic search function
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
    slug text,
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
    tags text[]
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        b.id,
        b.slug::text,
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
        ) AS tags
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

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION search_blueprints TO authenticated;
GRANT EXECUTE ON FUNCTION search_blueprints TO service_role;

-- =============================================================================
-- HELPER FUNCTIONS
-- =============================================================================

-- Function to get blueprint with tags
CREATE OR REPLACE FUNCTION get_blueprint_with_tags(blueprint_slug text)
RETURNS TABLE (
    id uuid,
    slug text,
    current_version_id uuid,
    created_by_agent_id uuid,
    execution_count int,
    success_count int,
    failure_count int,
    success_rate numeric,
    upvotes int,
    downvotes int,
    score numeric,
    status text,
    is_public boolean,
    created_at timestamptz,
    updated_at timestamptz,
    tags text[]
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        b.id,
        b.slug::text,
        b.current_version_id,
        b.created_by_agent_id,
        b.execution_count,
        b.success_count,
        b.failure_count,
        b.success_rate,
        b.upvotes,
        b.downvotes,
        b.score,
        b.status::text,
        b.is_public,
        b.created_at,
        b.updated_at,
        COALESCE(
            (
                SELECT array_agg(t.name)
                FROM blueprint_tags bt
                JOIN tags t ON t.id = bt.tag_id
                WHERE bt.blueprint_id = b.id
            ),
            ARRAY[]::text[]
        ) AS tags
    FROM blueprints b
    WHERE b.slug = blueprint_slug;
END;
$$;

GRANT EXECUTE ON FUNCTION get_blueprint_with_tags TO authenticated;
GRANT EXECUTE ON FUNCTION get_blueprint_with_tags TO service_role;
