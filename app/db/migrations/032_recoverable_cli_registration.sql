-- Recoverable, client-keyed registration for the Plurum CLI.
--
-- The existing open registration endpoint remains unchanged. CLI registration
-- stores an immutable idempotency record in the same transaction as the agent,
-- so retrying a request after a lost response can only return the original
-- agent.

BEGIN;

CREATE TABLE agent_registration_requests (
    registration_request_id UUID PRIMARY KEY,
    protocol_version SMALLINT NOT NULL,
    agent_id UUID NOT NULL UNIQUE REFERENCES agents(id) ON DELETE RESTRICT,
    agent_name VARCHAR(255) NOT NULL,
    username VARCHAR(50) NOT NULL,
    api_key_hash CHAR(64) NOT NULL UNIQUE,
    api_key_prefix VARCHAR(20) NOT NULL,
    payload_hash CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT agent_registration_requests_protocol_v1
        CHECK (protocol_version = 1),
    CONSTRAINT agent_registration_requests_request_id_v4
        CHECK (
            registration_request_id::TEXT ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        ),
    CONSTRAINT agent_registration_requests_username_format
        CHECK (
            char_length(username) BETWEEN 3 AND 50
            AND username ~ '^[a-z0-9]([a-z0-9_-]*[a-z0-9])$'
            AND username !~ 'plrm_live_[A-Za-z0-9_-]{10,}'
        ),
    CONSTRAINT agent_registration_requests_name_secret_free
        CHECK (agent_name !~ 'plrm_live_[A-Za-z0-9_-]{10,}'),
    CONSTRAINT agent_registration_requests_key_hash_format
        CHECK (api_key_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT agent_registration_requests_key_prefix_format
        CHECK (
            api_key_prefix ~ '^plrm_live_[A-Za-z0-9_-]{6}[.]{3}$'
        ),
    CONSTRAINT agent_registration_requests_payload_hash_format
        CHECK (payload_hash ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE agent_registration_requests IS
    'Immutable idempotency records for secret-free CLI agent registration.';
COMMENT ON COLUMN agent_registration_requests.api_key_prefix IS
    'Untrusted display-only metadata; authentication uses only api_key_hash.';

ALTER TABLE agent_registration_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can read and insert agent registration requests"
    ON agent_registration_requests
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

REVOKE ALL ON TABLE agent_registration_requests
    FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE agent_registration_requests TO service_role;

CREATE OR REPLACE FUNCTION reject_agent_registration_request_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
    RAISE EXCEPTION 'agent registration requests are immutable'
        USING ERRCODE = '55000';
END;
$$;

REVOKE ALL ON FUNCTION reject_agent_registration_request_mutation()
    FROM PUBLIC, anon, authenticated;

CREATE TRIGGER agent_registration_requests_are_immutable
    BEFORE UPDATE OR DELETE ON agent_registration_requests
    FOR EACH ROW
    EXECUTE FUNCTION reject_agent_registration_request_mutation();

CREATE OR REPLACE FUNCTION register_cli_agent(
    p_protocol_version SMALLINT,
    p_registration_request_id UUID,
    p_name TEXT,
    p_username TEXT,
    p_api_key_hash TEXT,
    p_api_key_prefix TEXT
)
RETURNS TABLE (
    disposition TEXT,
    agent_id UUID
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_agent_id UUID;
    v_constraint_name TEXT;
    v_existing public.agent_registration_requests%ROWTYPE;
    v_payload_material TEXT;
    v_payload_hash TEXT;
BEGIN
    -- Validate again at the transaction boundary. Direct RPC access is limited
    -- to service_role, but the database must still reject malformed writes.
    IF p_protocol_version IS DISTINCT FROM 1
       OR p_registration_request_id IS NULL
       OR p_registration_request_id::TEXT !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR p_name IS NULL
       OR char_length(p_name) NOT BETWEEN 1 AND 255
       OR p_name ~ 'plrm_live_[A-Za-z0-9_-]{10,}'
       OR p_username IS NULL
       OR char_length(p_username) NOT BETWEEN 3 AND 50
       OR p_username !~ '^[a-z0-9]([a-z0-9_-]*[a-z0-9])$'
       OR p_username ~ 'plrm_live_[A-Za-z0-9_-]{10,}'
       OR p_api_key_hash IS NULL
       OR p_api_key_hash !~ '^[0-9a-f]{64}$'
       OR p_api_key_prefix IS NULL
       OR p_api_key_prefix !~ '^plrm_live_[A-Za-z0-9_-]{6}[.]{3}$'
    THEN
        RETURN QUERY SELECT 'invalid_request'::TEXT, NULL::UUID;
        RETURN;
    END IF;

    -- Length framing prevents ambiguous concatenations. The request UUID and
    -- protocol version are included so the digest binds the complete request.
    v_payload_material :=
        'plurum.ai/cli-registration/payload/v1|'
        || octet_length(p_protocol_version::TEXT)::TEXT || ':'
        || p_protocol_version::TEXT
        || octet_length(p_registration_request_id::TEXT)::TEXT || ':'
        || p_registration_request_id::TEXT
        || octet_length(p_name)::TEXT || ':' || p_name
        || octet_length(p_username)::TEXT || ':' || p_username
        || octet_length(p_api_key_hash)::TEXT || ':' || p_api_key_hash
        || octet_length(p_api_key_prefix)::TEXT || ':' || p_api_key_prefix;
    v_payload_hash := encode(
        sha256(convert_to(v_payload_material, 'UTF8')),
        'hex'
    );

    -- Serialize retries for this request ID before inspecting or inserting.
    PERFORM pg_advisory_xact_lock(
        hashtextextended(
            'plurum.ai/cli-registration/request/'
            || p_registration_request_id::TEXT,
            0
        )
    );

    SELECT *
    INTO v_existing
    FROM public.agent_registration_requests
    WHERE registration_request_id = p_registration_request_id;

    IF FOUND THEN
        IF v_existing.protocol_version = p_protocol_version
           AND v_existing.agent_name = p_name
           AND v_existing.username = p_username
           AND v_existing.api_key_hash = p_api_key_hash
           AND v_existing.api_key_prefix = p_api_key_prefix
           AND v_existing.payload_hash = v_payload_hash
        THEN
            RETURN QUERY
                SELECT 'replayed'::TEXT, v_existing.agent_id;
        ELSE
            RETURN QUERY
                SELECT 'idempotency_conflict'::TEXT, NULL::UUID;
        END IF;
        RETURN;
    END IF;

    -- This exception block is a PostgreSQL subtransaction. If either insert
    -- conflicts, the new agent and idempotency row are both rolled back.
    BEGIN
        INSERT INTO public.agents (
            name,
            username,
            api_key_hash,
            api_key_prefix
        )
        VALUES (
            p_name,
            p_username,
            p_api_key_hash,
            p_api_key_prefix
        )
        RETURNING id INTO v_agent_id;

        INSERT INTO public.agent_registration_requests (
            registration_request_id,
            protocol_version,
            agent_id,
            agent_name,
            username,
            api_key_hash,
            api_key_prefix,
            payload_hash
        )
        VALUES (
            p_registration_request_id,
            p_protocol_version,
            v_agent_id,
            p_name,
            p_username,
            p_api_key_hash,
            p_api_key_prefix,
            v_payload_hash
        );
    EXCEPTION
        WHEN unique_violation THEN
            GET STACKED DIAGNOSTICS
                v_constraint_name = CONSTRAINT_NAME;

            IF v_constraint_name = 'idx_agents_username_unique' THEN
                RETURN QUERY
                    SELECT 'username_unavailable'::TEXT, NULL::UUID;
            ELSIF v_constraint_name IN (
                'agents_api_key_hash_key',
                'agent_registration_requests_api_key_hash_key'
            ) THEN
                RETURN QUERY
                    SELECT 'credential_conflict'::TEXT, NULL::UUID;
            ELSIF v_constraint_name = 'agent_registration_requests_pkey' THEN
                RETURN QUERY
                    SELECT 'idempotency_conflict'::TEXT, NULL::UUID;
            ELSE
                RETURN QUERY
                    SELECT 'registration_conflict'::TEXT, NULL::UUID;
            END IF;
            RETURN;
    END;

    RETURN QUERY SELECT 'created'::TEXT, v_agent_id;
END;
$$;

REVOKE ALL ON FUNCTION register_cli_agent(
    SMALLINT,
    UUID,
    TEXT,
    TEXT,
    TEXT,
    TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION register_cli_agent(
    SMALLINT,
    UUID,
    TEXT,
    TEXT,
    TEXT,
    TEXT
) TO service_role;

COMMIT;
