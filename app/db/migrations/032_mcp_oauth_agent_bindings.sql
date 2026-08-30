-- Agent bindings and access-token audience enforcement for hosted MCP OAuth.
--
-- Supabase Auth owns OAuth clients, authorization codes, access tokens, and
-- refresh tokens. Plurum stores only the selected agent for each exact
-- (user, OAuth client) pair. The hook is created here but must be enabled
-- separately in Authentication > Hooks after canary validation.

BEGIN;

-- OAuth-only agents do not need an API key. A key can be issued later without
-- creating a second agent identity.
ALTER TABLE public.agents
    ALTER COLUMN api_key_hash DROP NOT NULL,
    ALTER COLUMN api_key_prefix DROP NOT NULL;

-- A credential is either fully present or fully absent. Partial rows would
-- make authentication, dashboard display, and release behavior disagree.
ALTER TABLE public.agents
    ADD CONSTRAINT agents_api_key_fields_paired
    CHECK ((api_key_hash IS NULL) = (api_key_prefix IS NULL));

CREATE TABLE public.mcp_oauth_agent_bindings (
    owner_user_id UUID NOT NULL,
    client_id TEXT COLLATE "C" NOT NULL,
    agent_id UUID NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT mcp_oauth_agent_bindings_pkey
        PRIMARY KEY (owner_user_id, client_id),
    CONSTRAINT mcp_oauth_agent_bindings_client_id_length
        CHECK (OCTET_LENGTH(client_id) BETWEEN 1 AND 2048)
);

CREATE INDEX idx_mcp_oauth_agent_bindings_agent_id
    ON public.mcp_oauth_agent_bindings(agent_id);

CREATE TRIGGER trigger_mcp_oauth_agent_bindings_updated_at
    BEFORE UPDATE ON public.mcp_oauth_agent_bindings
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.mcp_oauth_agent_bindings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.mcp_oauth_agent_bindings
    FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
    ON TABLE public.mcp_oauth_agent_bindings TO service_role;

CREATE POLICY "Service role full access"
    ON public.mcp_oauth_agent_bindings
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

-- Supabase Auth invokes SQL hooks as supabase_auth_admin. Give that internal
-- role only the read permission needed for the binding lookup. Browser-facing
-- roles remain fully revoked, and application writes stay service-role-only.
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
GRANT SELECT ON TABLE public.mcp_oauth_agent_bindings TO supabase_auth_admin;

CREATE POLICY "Auth hook can read MCP OAuth bindings"
    ON public.mcp_oauth_agent_bindings
    FOR SELECT TO supabase_auth_admin
    USING (true);

-- Preserve the complete claims object. An ordinary Supabase session has no
-- client_id and its claims are returned logically unchanged. An OAuth
-- token is issued for the MCP audience only when its exact, case-sensitive
-- client_id is bound to the event user. Missing or malformed OAuth identity
-- data returns a hook error, causing token issuance/refresh to fail closed.
CREATE OR REPLACE FUNCTION public.plurum_mcp_custom_access_token_hook(event JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
    claims JSONB;
    oauth_client_id TEXT;
    event_user_id UUID;
    binding_exists BOOLEAN;
BEGIN
    claims := event->'claims';

    IF JSONB_TYPEOF(claims) IS DISTINCT FROM 'object' THEN
        RETURN JSONB_BUILD_OBJECT(
            'error', JSONB_BUILD_OBJECT(
                'http_code', 403,
                'message', 'OAuth token binding could not be verified'
            )
        );
    END IF;

    -- Non-OAuth Supabase sessions do not carry an OAuth client identifier.
    -- Avoid PostgreSQL's JSONB `?` operator here because Supabase documents a
    -- SQL Editor placeholder conflict for hook definitions that contain it.
    IF claims->'client_id' IS NULL THEN
        RETURN JSONB_BUILD_OBJECT('claims', claims);
    END IF;

    IF JSONB_TYPEOF(claims->'client_id') IS DISTINCT FROM 'string'
       OR JSONB_TYPEOF(event->'user_id') IS DISTINCT FROM 'string'
       OR JSONB_TYPEOF(claims->'sub') IS DISTINCT FROM 'string'
       OR COALESCE(
            JSONB_TYPEOF(claims->'aud') NOT IN ('string', 'array'),
            true
       ) THEN
        RETURN JSONB_BUILD_OBJECT(
            'error', JSONB_BUILD_OBJECT(
                'http_code', 403,
                'message', 'OAuth token binding could not be verified'
            )
        );
    END IF;

    oauth_client_id := claims->>'client_id';

    IF OCTET_LENGTH(oauth_client_id) NOT BETWEEN 1 AND 2048 THEN
        RETURN JSONB_BUILD_OBJECT(
            'error', JSONB_BUILD_OBJECT(
                'http_code', 403,
                'message', 'OAuth token binding could not be verified'
            )
        );
    END IF;

    BEGIN
        event_user_id := (event->>'user_id')::UUID;
    EXCEPTION
        WHEN invalid_text_representation THEN
            RETURN JSONB_BUILD_OBJECT(
                'error', JSONB_BUILD_OBJECT(
                    'http_code', 403,
                    'message', 'OAuth token binding could not be verified'
                )
            );
    END;

    IF claims->>'sub' IS DISTINCT FROM event_user_id::TEXT THEN
        RETURN JSONB_BUILD_OBJECT(
            'error', JSONB_BUILD_OBJECT(
                'http_code', 403,
                'message', 'OAuth token binding could not be verified'
            )
        );
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM public.mcp_oauth_agent_bindings AS binding
        WHERE binding.owner_user_id = event_user_id
          AND binding.client_id = oauth_client_id COLLATE "C"
    )
    INTO binding_exists;

    IF NOT binding_exists THEN
        RETURN JSONB_BUILD_OBJECT(
            'error', JSONB_BUILD_OBJECT(
                'http_code', 403,
                'message', 'OAuth token binding could not be verified'
            )
        );
    END IF;

    RETURN JSONB_BUILD_OBJECT(
        'claims',
        JSONB_SET(
            claims,
            '{aud}',
            TO_JSONB('https://mcp.plurum.ai/mcp'::TEXT),
            false
        )
    );
END;
$$;

REVOKE EXECUTE
    ON FUNCTION public.plurum_mcp_custom_access_token_hook(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE
    ON FUNCTION public.plurum_mcp_custom_access_token_hook(JSONB)
    TO supabase_auth_admin;

COMMENT ON TABLE public.mcp_oauth_agent_bindings IS
    'Exact Supabase OAuth client-to-agent selection for the hosted Plurum MCP server.';
COMMENT ON FUNCTION public.plurum_mcp_custom_access_token_hook(JSONB) IS
    'Sets the hosted MCP audience only for an exact user/client agent binding. Enable explicitly in Supabase Auth after canary validation.';

COMMIT;
