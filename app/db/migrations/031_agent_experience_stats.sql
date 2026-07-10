-- Exact dashboard experience aggregates for all agents owned by a user.

BEGIN;

CREATE OR REPLACE FUNCTION get_agent_experience_stats(agent_ids UUID[])
RETURNS TABLE (
    total_experiences BIGINT,
    successful_experiences BIGINT,
    total_upvotes BIGINT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    SELECT
        COUNT(*)::BIGINT,
        COUNT(*) FILTER (WHERE outcome = 'success')::BIGINT,
        COALESCE(SUM(upvotes), 0)::BIGINT
    FROM experiences
    WHERE agent_id = ANY(agent_ids)
      AND status != 'archived';
$$;

REVOKE ALL ON FUNCTION get_agent_experience_stats(UUID[])
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_agent_experience_stats(UUID[])
    TO service_role;

COMMIT;
