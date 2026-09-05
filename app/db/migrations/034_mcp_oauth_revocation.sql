-- Persistent disconnect state and authorization generations. Apply only with
-- the separately approved OAuth rollout; creating this file enables nothing.
BEGIN;

ALTER TABLE public.mcp_oauth_agent_bindings
    ALTER COLUMN agent_id DROP NOT NULL,
    DROP CONSTRAINT mcp_oauth_agent_bindings_agent_id_fkey,
    ADD CONSTRAINT mcp_oauth_agent_bindings_agent_id_fkey
        FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE SET NULL,
    ADD COLUMN grant_id UUID NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN state TEXT NOT NULL DEFAULT 'active'
        CHECK (state IN ('active', 'revoking', 'revoked')),
    ADD COLUMN revoked_grant_id UUID,
    ADD COLUMN revocation_attempt_id UUID,
    ADD COLUMN revocation_attempt_at TIMESTAMPTZ;

-- All writers take the same transaction lock, including when no row exists.
CREATE FUNCTION public.bind_mcp_oauth_agent(
    p_owner_user_id UUID, p_client_id TEXT, p_agent_id UUID,
    p_expected_grant_id UUID
)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    binding public.mcp_oauth_agent_bindings%ROWTYPE;
    selected_agent public.agents%ROWTYPE;
BEGIN
    IF p_owner_user_id IS NULL OR p_client_id IS NULL
       OR OCTET_LENGTH(p_client_id) NOT BETWEEN 1 AND 2048 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid OAuth connection';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_owner_user_id::TEXT || ':' || p_client_id, 0)
    );
    SELECT * INTO binding FROM public.mcp_oauth_agent_bindings
        WHERE owner_user_id = p_owner_user_id AND client_id = p_client_id COLLATE "C"
        FOR UPDATE;
    IF binding.grant_id IS DISTINCT FROM p_expected_grant_id
       OR binding.state = 'revoking'
       OR (binding.state = 'active' AND binding.agent_id IS DISTINCT FROM p_agent_id) THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'OAuth connection changed';
    END IF;
    SELECT * INTO selected_agent FROM public.agents
        WHERE id = p_agent_id AND owner_user_id = p_owner_user_id AND is_active
        FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'OAuth agent unavailable';
    END IF;
    INSERT INTO public.mcp_oauth_agent_bindings (
        owner_user_id, client_id, agent_id, grant_id, state
    ) VALUES (
        p_owner_user_id, p_client_id, p_agent_id, gen_random_uuid(), 'active'
    ) ON CONFLICT (owner_user_id, client_id) DO UPDATE SET
        agent_id = EXCLUDED.agent_id,
        grant_id = CASE WHEN mcp_oauth_agent_bindings.state = 'active'
            THEN mcp_oauth_agent_bindings.grant_id ELSE EXCLUDED.grant_id END,
        state = 'active', revoked_grant_id = NULL,
        revocation_attempt_id = NULL, revocation_attempt_at = NULL
    RETURNING * INTO binding;
    RETURN JSONB_BUILD_OBJECT('agent', TO_JSONB(selected_agent), 'grant_id', binding.grant_id);
END;
$$;

-- Replace the old entry point so it cannot bypass the generation check.
DROP FUNCTION public.create_mcp_oauth_agent_and_binding(UUID, TEXT, TEXT, TEXT);
CREATE FUNCTION public.create_mcp_oauth_agent_and_binding(
    p_owner_user_id UUID, p_client_id TEXT, p_name TEXT, p_username TEXT,
    p_expected_grant_id UUID
)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    created_id UUID;
BEGIN
    IF p_name IS NULL OR p_username IS NULL OR BTRIM(p_name) = ''
       OR CHAR_LENGTH(p_name) NOT BETWEEN 1 AND 255
       OR CHAR_LENGTH(p_username) NOT BETWEEN 3 AND 50
       OR p_username !~ '^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid OAuth agent';
    END IF;
    INSERT INTO public.agents (name, username, api_key_hash, api_key_prefix, owner_user_id)
        VALUES (p_name, p_username, NULL, NULL, p_owner_user_id)
        RETURNING id INTO created_id;
    RETURN public.bind_mcp_oauth_agent(
        p_owner_user_id, p_client_id, created_id, p_expected_grant_id
    );
END;
$$;

CREATE FUNCTION public.begin_mcp_oauth_revocation(
    p_owner_user_id UUID, p_client_id TEXT, p_expected_grant_id UUID
)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    binding public.mcp_oauth_agent_bindings%ROWTYPE;
    attempt_id UUID := gen_random_uuid();
BEGIN
    IF p_owner_user_id IS NULL OR p_client_id IS NULL
       OR OCTET_LENGTH(p_client_id) NOT BETWEEN 1 AND 2048 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid OAuth connection';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_owner_user_id::TEXT || ':' || p_client_id, 0)
    );
    SELECT * INTO binding FROM public.mcp_oauth_agent_bindings
        WHERE owner_user_id = p_owner_user_id AND client_id = p_client_id COLLATE "C"
        FOR UPDATE;
    IF NOT FOUND THEN
        IF p_expected_grant_id IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'OAuth connection changed';
        END IF;
        INSERT INTO public.mcp_oauth_agent_bindings (
            owner_user_id, client_id, agent_id, state, revocation_attempt_id,
            revocation_attempt_at
        ) VALUES (p_owner_user_id, p_client_id, NULL, 'revoking', attempt_id, NOW());
    ELSE
        IF binding.grant_id IS DISTINCT FROM p_expected_grant_id
           AND NOT (binding.state IN ('revoking', 'revoked')
               AND binding.revoked_grant_id IS NOT DISTINCT FROM p_expected_grant_id) THEN
            RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'OAuth connection changed';
        END IF;
        -- A crashed worker can be retried; access stays blocked throughout.
        IF binding.state = 'revoking' AND binding.revocation_attempt_id IS NOT NULL
           AND binding.revocation_attempt_at > NOW() - INTERVAL '30 seconds' THEN
            RETURN JSONB_BUILD_OBJECT('claimed', false);
        END IF;
        UPDATE public.mcp_oauth_agent_bindings SET
            revoked_grant_id = CASE WHEN state = 'active' THEN grant_id ELSE revoked_grant_id END,
            grant_id = CASE WHEN state = 'active' THEN gen_random_uuid() ELSE grant_id END,
            state = 'revoking', revocation_attempt_id = attempt_id,
            revocation_attempt_at = NOW()
            WHERE owner_user_id = p_owner_user_id AND client_id = p_client_id COLLATE "C";
    END IF;
    RETURN JSONB_BUILD_OBJECT('claimed', true, 'attempt_id', attempt_id);
END;
$$;

CREATE FUNCTION public.finish_mcp_oauth_revocation(
    p_owner_user_id UUID, p_client_id TEXT, p_attempt_id UUID, p_succeeded BOOLEAN
)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_owner_user_id::TEXT || ':' || p_client_id, 0)
    );
    UPDATE public.mcp_oauth_agent_bindings SET
        state = CASE WHEN p_succeeded THEN 'revoked' ELSE 'revoking' END,
        agent_id = CASE WHEN p_succeeded THEN NULL ELSE agent_id END,
        revocation_attempt_id = NULL, revocation_attempt_at = NULL
        WHERE owner_user_id = p_owner_user_id AND client_id = p_client_id COLLATE "C"
          AND state = 'revoking' AND revocation_attempt_id = p_attempt_id;
    RETURN FOUND;
END;
$$;

-- Keep ordinary dashboard tokens unchanged and bind OAuth tokens to one
-- authorization generation. A reconnect must never revive an older token.
CREATE OR REPLACE FUNCTION public.plurum_mcp_custom_access_token_hook(event JSONB)
RETURNS JSONB LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
    claims JSONB := event->'claims';
    selected_grant_id UUID;
    event_user_id UUID;
BEGIN
    IF JSONB_TYPEOF(claims) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'OAuth binding unavailable';
    END IF;
    IF claims->'client_id' IS NULL THEN
        RETURN JSONB_BUILD_OBJECT('claims', claims);
    END IF;
    IF JSONB_TYPEOF(claims->'client_id') IS DISTINCT FROM 'string'
       OR JSONB_TYPEOF(event->'user_id') IS DISTINCT FROM 'string'
       OR JSONB_TYPEOF(claims->'sub') IS DISTINCT FROM 'string'
       OR COALESCE(JSONB_TYPEOF(claims->'aud') NOT IN ('string', 'array'), true)
       OR OCTET_LENGTH(claims->>'client_id') NOT BETWEEN 1 AND 2048 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'OAuth binding unavailable';
    END IF;
    event_user_id := (event->>'user_id')::UUID;
    IF claims->>'sub' IS DISTINCT FROM event_user_id::TEXT THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'OAuth binding unavailable';
    END IF;
    SELECT grant_id INTO selected_grant_id FROM public.mcp_oauth_agent_bindings
        WHERE owner_user_id = event_user_id AND client_id = (claims->>'client_id') COLLATE "C"
          AND state = 'active' AND agent_id IS NOT NULL;
    IF selected_grant_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'OAuth binding unavailable';
    END IF;
    claims := JSONB_SET(claims, '{aud}', TO_JSONB('https://mcp.plurum.ai/mcp'::TEXT), false);
    claims := JSONB_SET(claims, '{plurum_grant_id}', TO_JSONB(selected_grant_id::TEXT), true);
    RETURN JSONB_BUILD_OBJECT('claims', claims);
EXCEPTION WHEN OTHERS THEN
    RETURN JSONB_BUILD_OBJECT('error', JSONB_BUILD_OBJECT(
        'http_code', 403, 'message', 'OAuth token binding could not be verified'
    ));
END;
$$;

REVOKE ALL ON FUNCTION public.bind_mcp_oauth_agent(UUID, TEXT, UUID, UUID)
    FROM PUBLIC, anon, authenticated, supabase_auth_admin;
REVOKE ALL ON FUNCTION public.create_mcp_oauth_agent_and_binding(UUID, TEXT, TEXT, TEXT, UUID)
    FROM PUBLIC, anon, authenticated, supabase_auth_admin;
REVOKE ALL ON FUNCTION public.begin_mcp_oauth_revocation(UUID, TEXT, UUID)
    FROM PUBLIC, anon, authenticated, supabase_auth_admin;
REVOKE ALL ON FUNCTION public.finish_mcp_oauth_revocation(UUID, TEXT, UUID, BOOLEAN)
    FROM PUBLIC, anon, authenticated, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.bind_mcp_oauth_agent(UUID, TEXT, UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_mcp_oauth_agent_and_binding(UUID, TEXT, TEXT, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_mcp_oauth_revocation(UUID, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_mcp_oauth_revocation(UUID, TEXT, UUID, BOOLEAN) TO service_role;
REVOKE EXECUTE ON FUNCTION public.plurum_mcp_custom_access_token_hook(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.plurum_mcp_custom_access_token_hook(JSONB) TO supabase_auth_admin;

COMMIT;
