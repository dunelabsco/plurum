-- Atomic OAuth-only agent creation and MCP client binding.
--
-- The consent handler must not report a failed connection after creating an
-- unbound agent. This service-role-only RPC performs both writes in one
-- PostgreSQL transaction; any validation, insert, or binding failure rolls the
-- entire function call back.

BEGIN;

CREATE OR REPLACE FUNCTION public.create_mcp_oauth_agent_and_binding(
    p_owner_user_id UUID,
    p_client_id TEXT,
    p_name TEXT,
    p_username TEXT
)
RETURNS SETOF public.agents
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    created_agent public.agents%ROWTYPE;
    normalized_username TEXT;
BEGIN
    normalized_username := LOWER(p_username);

    IF p_owner_user_id IS NULL
       OR p_client_id IS NULL
       OR p_name IS NULL
       OR p_username IS NULL
       OR OCTET_LENGTH(p_client_id) NOT BETWEEN 1 AND 2048
       OR CHAR_LENGTH(p_name) NOT BETWEEN 1 AND 255
       OR BTRIM(p_name) = ''
       OR CHAR_LENGTH(normalized_username) NOT BETWEEN 3 AND 50
       OR normalized_username !~ '^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$' THEN
        RAISE EXCEPTION USING
            ERRCODE = '22023',
            MESSAGE = 'Invalid MCP OAuth onboarding input';
    END IF;

    INSERT INTO public.agents (
        name,
        username,
        api_key_hash,
        api_key_prefix,
        owner_user_id
    )
    VALUES (
        p_name,
        normalized_username,
        NULL,
        NULL,
        p_owner_user_id
    )
    RETURNING * INTO created_agent;

    INSERT INTO public.mcp_oauth_agent_bindings (
        owner_user_id,
        client_id,
        agent_id
    )
    VALUES (
        p_owner_user_id,
        p_client_id,
        created_agent.id
    )
    ON CONFLICT (owner_user_id, client_id) DO UPDATE
    SET agent_id = EXCLUDED.agent_id,
        updated_at = NOW();

    RETURN NEXT created_agent;
END;
$$;

REVOKE ALL
    ON FUNCTION public.create_mcp_oauth_agent_and_binding(UUID, TEXT, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated, supabase_auth_admin;
GRANT EXECUTE
    ON FUNCTION public.create_mcp_oauth_agent_and_binding(UUID, TEXT, TEXT, TEXT)
    TO service_role;

COMMENT ON FUNCTION public.create_mcp_oauth_agent_and_binding(UUID, TEXT, TEXT, TEXT) IS
    'Creates one OAuth-only owned agent and its exact MCP client binding atomically.';

COMMIT;
