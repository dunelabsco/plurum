"""Static contract checks for the MCP OAuth database migration.

The test suite does not connect to a live Supabase project. These assertions
keep the security-critical SQL contract reviewable and catch accidental drift
before the migration is applied in a canary environment.
"""

from pathlib import Path
import re


MIGRATIONS = Path(__file__).parents[1] / "app" / "db" / "migrations"
MIGRATION = MIGRATIONS / "032_mcp_oauth_agent_bindings.sql"
ATOMIC_MIGRATION = MIGRATIONS / "033_mcp_oauth_atomic_onboarding.sql"


def _sql() -> str:
    return re.sub(r"\s+", " ", MIGRATION.read_text(encoding="utf-8")).strip()


def _atomic_sql() -> str:
    return re.sub(r"\s+", " ", ATOMIC_MIGRATION.read_text(encoding="utf-8")).strip()


def test_mcp_oauth_migration_follows_031() -> None:
    numbered = sorted(path.name for path in MIGRATIONS.glob("[0-9][0-9][0-9]_*.sql"))

    assert "031_agent_experience_stats.sql" in numbered
    assert MIGRATION.name in numbered
    assert numbered.index(MIGRATION.name) == numbered.index(
        "031_agent_experience_stats.sql"
    ) + 1


def test_oauth_only_agents_and_binding_table_contract() -> None:
    sql = _sql()

    assert "ALTER COLUMN api_key_hash DROP NOT NULL" in sql
    assert "ALTER COLUMN api_key_prefix DROP NOT NULL" in sql
    assert "CONSTRAINT agents_api_key_fields_paired" in sql
    assert "CHECK ((api_key_hash IS NULL) = (api_key_prefix IS NULL))" in sql
    assert 'client_id TEXT COLLATE "C" NOT NULL' in sql
    assert "PRIMARY KEY (owner_user_id, client_id)" in sql
    assert "REFERENCES public.agents(id) ON DELETE CASCADE" in sql
    assert "CHECK (OCTET_LENGTH(client_id) BETWEEN 1 AND 2048)" in sql
    assert "idx_mcp_oauth_agent_bindings_agent_id" in sql
    assert "trigger_mcp_oauth_agent_bindings_updated_at" in sql
    assert "EXECUTE FUNCTION public.update_updated_at()" in sql


def test_binding_table_is_closed_to_client_roles() -> None:
    sql = _sql()

    assert (
        "ALTER TABLE public.mcp_oauth_agent_bindings ENABLE ROW LEVEL SECURITY"
        in sql
    )
    assert re.search(
        r"REVOKE ALL ON TABLE public\.mcp_oauth_agent_bindings "
        r"FROM PUBLIC, anon, authenticated",
        sql,
    )
    assert re.search(
        r"GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "
        r"public\.mcp_oauth_agent_bindings TO service_role",
        sql,
    )
    assert re.search(
        r'CREATE POLICY "Service role full access" '
        r"ON public\.mcp_oauth_agent_bindings FOR ALL TO service_role "
        r"USING \(true\) WITH CHECK \(true\)",
        sql,
    )
    assert re.search(
        r"GRANT SELECT ON TABLE public\.mcp_oauth_agent_bindings "
        r"TO supabase_auth_admin",
        sql,
    )
    assert re.search(
        r'CREATE POLICY "Auth hook can read MCP OAuth bindings" '
        r"ON public\.mcp_oauth_agent_bindings FOR SELECT TO "
        r"supabase_auth_admin USING \(true\)",
        sql,
    )


def test_access_token_hook_preserves_claims_and_requires_exact_binding() -> None:
    sql = _sql()

    assert "IF claims->'client_id' IS NULL THEN" in sql
    assert "RETURN JSONB_BUILD_OBJECT('claims', claims)" in sql
    assert "claims ? 'client_id'" not in sql
    assert "claims->>'sub' IS DISTINCT FROM event_user_id::TEXT" in sql
    assert "binding.owner_user_id = event_user_id" in sql
    assert 'binding.client_id = oauth_client_id COLLATE "C"' in sql
    assert "IF NOT binding_exists THEN" in sql
    assert "'{aud}'" in sql
    assert "TO_JSONB('https://mcp.plurum.ai/mcp'::TEXT)" in sql
    assert "JSONB_BUILD_OBJECT( 'claims', JSONB_SET( claims," in sql


def test_access_token_hook_has_only_supabase_auth_execution_grant() -> None:
    sql = _sql()

    assert "SET search_path = ''" in sql
    assert re.search(
        r"REVOKE EXECUTE ON FUNCTION "
        r"public\.plurum_mcp_custom_access_token_hook\(JSONB\) "
        r"FROM PUBLIC, anon, authenticated, service_role",
        sql,
    )
    assert re.search(
        r"GRANT EXECUTE ON FUNCTION "
        r"public\.plurum_mcp_custom_access_token_hook\(JSONB\) "
        r"TO supabase_auth_admin",
        sql,
    )
    assert "'http_code', 403" in sql


def test_atomic_onboarding_migration_follows_032() -> None:
    numbered = sorted(path.name for path in MIGRATIONS.glob("[0-9][0-9][0-9]_*.sql"))

    assert ATOMIC_MIGRATION.name in numbered
    assert numbered.index(ATOMIC_MIGRATION.name) == numbered.index(MIGRATION.name) + 1


def test_atomic_onboarding_runs_in_a_transaction_and_returns_created_agent() -> None:
    sql = _atomic_sql()

    assert re.search(r"(?:^| )BEGIN; CREATE OR REPLACE FUNCTION", sql)
    assert sql.endswith("COMMIT;")
    assert re.search(
        r"CREATE OR REPLACE FUNCTION public\.create_mcp_oauth_agent_and_binding\( "
        r"p_owner_user_id UUID, p_client_id TEXT, p_name TEXT, p_username TEXT \) "
        r"RETURNS SETOF public\.agents",
        sql,
    )
    assert sql.index("INSERT INTO public.agents") < sql.index(
        "INSERT INTO public.mcp_oauth_agent_bindings"
    )
    assert "RETURN NEXT created_agent" in sql


def test_atomic_onboarding_validates_inputs_and_creates_oauth_only_agent() -> None:
    sql = _atomic_sql()

    assert "normalized_username := LOWER(p_username)" in sql
    assert "p_owner_user_id IS NULL" in sql
    assert "p_client_id IS NULL" in sql
    assert "p_name IS NULL" in sql
    assert "p_username IS NULL" in sql
    assert "OCTET_LENGTH(p_client_id) NOT BETWEEN 1 AND 2048" in sql
    assert "CHAR_LENGTH(p_name) NOT BETWEEN 1 AND 255" in sql
    assert "BTRIM(p_name) = ''" in sql
    assert "CHAR_LENGTH(normalized_username) NOT BETWEEN 3 AND 50" in sql
    assert "normalized_username !~ '^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$'" in sql
    assert "ERRCODE = '22023'" in sql
    assert re.search(
        r"INSERT INTO public\.agents \( name, username, api_key_hash, "
        r"api_key_prefix, owner_user_id \) VALUES \( p_name, "
        r"normalized_username, NULL, NULL, p_owner_user_id \)",
        sql,
    )


def test_atomic_onboarding_upserts_only_the_exact_user_client_binding() -> None:
    sql = _atomic_sql()

    assert re.search(
        r"INSERT INTO public\.mcp_oauth_agent_bindings \( owner_user_id, "
        r"client_id, agent_id \) VALUES \( p_owner_user_id, p_client_id, "
        r"created_agent\.id \)",
        sql,
    )
    assert "ON CONFLICT (owner_user_id, client_id) DO UPDATE" in sql
    assert "SET agent_id = EXCLUDED.agent_id, updated_at = NOW()" in sql


def test_atomic_onboarding_function_has_restricted_execution_context() -> None:
    sql = _atomic_sql()
    signature = "public.create_mcp_oauth_agent_and_binding(UUID, TEXT, TEXT, TEXT)"

    assert "LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = ''" in sql
    assert re.search(
        rf"REVOKE ALL ON FUNCTION {re.escape(signature)} "
        r"FROM PUBLIC, anon, authenticated, supabase_auth_admin",
        sql,
    )
    assert re.search(
        rf"GRANT EXECUTE ON FUNCTION {re.escape(signature)} TO service_role",
        sql,
    )
    assert not re.search(
        rf"GRANT EXECUTE ON FUNCTION {re.escape(signature)} "
        r"TO (?:PUBLIC|anon|authenticated|supabase_auth_admin)",
        sql,
    )
