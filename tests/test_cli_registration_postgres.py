"""Disposable PostgreSQL integration coverage for CLI registration."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
import os
from pathlib import Path
import shutil
import subprocess
import time
from typing import Literal
from urllib.parse import unquote, urlsplit

import pytest


_DATABASE_NAME = "plurum_registration_test"
_DESTRUCTIVE_TEST_SENTINEL = "PLURUM_ALLOW_DESTRUCTIVE_POSTGRES_TEST"
_KNOWN_DISPOSITIONS = frozenset(
    {
        "created",
        "replayed",
        "idempotency_conflict",
        "username_unavailable",
        "credential_conflict",
        "registration_conflict",
        "invalid_request",
    }
)


def _postgres_environment() -> dict[str, str]:
    raw_url = os.environ.get("PLURUM_TEST_POSTGRES_URL")
    if raw_url is None:
        pytest.skip("disposable PostgreSQL integration is not configured")
    if os.environ.get(_DESTRUCTIVE_TEST_SENTINEL) != "1":
        pytest.fail(
            f"{_DESTRUCTIVE_TEST_SENTINEL}=1 is required for the disposable "
            "PostgreSQL integration"
        )
    parsed = urlsplit(raw_url)
    if (
        parsed.scheme not in {"postgres", "postgresql"}
        or parsed.hostname not in {"127.0.0.1", "::1", "localhost"}
        or parsed.path != f"/{_DATABASE_NAME}"
        or parsed.username != "postgres"
        or parsed.query
        or parsed.fragment
    ):
        pytest.fail("PLURUM_TEST_POSTGRES_URL must target the dedicated loopback database")
    executable = shutil.which("psql")
    if executable is None:
        pytest.fail("psql is required for the disposable PostgreSQL integration")

    environment = {
        "PATH": os.environ.get("PATH", ""),
        "LC_ALL": "C",
        "PGHOST": parsed.hostname,
        "PGPORT": str(parsed.port or 5432),
        "PGDATABASE": _DATABASE_NAME,
        "PGUSER": "postgres",
    }
    if parsed.password is not None:
        environment["PGPASSWORD"] = unquote(parsed.password)
    environment["PLURUM_TEST_PSQL"] = executable
    return environment


def _psql(
    environment: dict[str, str],
    sql: str,
    *,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    executable = environment["PLURUM_TEST_PSQL"]
    child_environment = {
        key: value
        for key, value in environment.items()
        if key != "PLURUM_TEST_PSQL"
    }
    result = subprocess.run(
        [
            executable,
            "--no-psqlrc",
            "--quiet",
            "--tuples-only",
            "--no-align",
            "--field-separator=|",
            "--set=ON_ERROR_STOP=1",
        ],
        input=sql,
        text=True,
        capture_output=True,
        check=False,
        timeout=15,
        env=child_environment,
    )
    if check and result.returncode != 0:
        pytest.fail(f"disposable PostgreSQL command failed: {result.stderr.strip()}")
    return result


def _setup_database(environment: dict[str, str]) -> None:
    existing_objects = _psql(
        environment,
        """
        SELECT COUNT(*)
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname NOT LIKE 'pg_%'
          AND namespace.nspname <> 'information_schema';
        """,
    ).stdout.strip()
    if existing_objects != "0":
        pytest.fail("disposable PostgreSQL database must be empty before reset")

    _psql(
        environment,
        """
        BEGIN;
        REVOKE ALL ON SCHEMA public FROM PUBLIC;

        DO $roles$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
                CREATE ROLE anon NOLOGIN;
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM pg_roles WHERE rolname = 'authenticated'
            ) THEN
                CREATE ROLE authenticated NOLOGIN;
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM pg_roles WHERE rolname = 'service_role'
            ) THEN
                CREATE ROLE service_role NOLOGIN;
            END IF;
        END
        $roles$;

        CREATE TYPE public.rate_limit_tier AS ENUM (
            'standard', 'premium', 'unlimited'
        );
        CREATE TYPE public.subscription_tier AS ENUM (
            'free', 'pro', 'enterprise'
        );
        CREATE TABLE public.agents (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name VARCHAR(255) NOT NULL,
            api_key_hash VARCHAR(64) NOT NULL UNIQUE,
            api_key_prefix VARCHAR(20) NOT NULL,
            is_active BOOLEAN DEFAULT TRUE,
            rate_limit_tier public.rate_limit_tier DEFAULT 'standard',
            subscription_tier public.subscription_tier DEFAULT 'free',
            credits_balance INTEGER DEFAULT 0,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            last_active_at TIMESTAMPTZ,
            username VARCHAR(50)
        );
        CREATE UNIQUE INDEX idx_agents_username_unique
            ON public.agents(username)
            WHERE username IS NOT NULL;
        GRANT USAGE ON SCHEMA public TO anon, authenticated;
        GRANT USAGE ON SCHEMA public TO service_role;
        GRANT USAGE ON TYPE public.rate_limit_tier TO service_role;
        GRANT USAGE ON TYPE public.subscription_tier TO service_role;
        GRANT SELECT, INSERT ON TABLE public.agents TO service_role;
        COMMIT;
        """,
    )
    migration = (
        Path(__file__).parents[1]
        / "app/db/migrations/032_recoverable_cli_registration.sql"
    ).read_text()
    _psql(environment, migration)


def _key(character: str) -> str:
    return f"plrm_live_{character * 43}"


def _hash(api_key: str) -> str:
    return sha256(api_key.encode()).hexdigest()


def _prefix(api_key: str) -> str:
    return f"{api_key[:16]}..."


def _call_sql(
    *,
    request_id: str,
    name: str,
    username: str,
    api_key: str,
    hold_seconds: float = 0,
    role: Literal["service_role", "anon", "authenticated"] = "service_role",
) -> str:
    call = (
        "SELECT disposition || '|' || COALESCE(agent_id::TEXT, '') "
        "FROM public.register_cli_agent("
        f"1, '{request_id}'::UUID, '{name}', '{username}', "
        f"'{_hash(api_key)}', '{_prefix(api_key)}'"
        ");"
    )
    if hold_seconds <= 0:
        return f"SET ROLE {role};\n{call}\n"
    return (
        f"SET ROLE {role};\n"
        "BEGIN;\n"
        f"{call}\n"
        f"SELECT pg_sleep({hold_seconds});\n"
        "COMMIT;\n"
    )


def _call(
    environment: dict[str, str],
    **parameters,
) -> tuple[str, str | None]:
    output = _psql(environment, _call_sql(**parameters)).stdout
    for line in output.splitlines():
        disposition, separator, agent_id = line.strip().partition("|")
        if separator and disposition in _KNOWN_DISPOSITIONS:
            return disposition, agent_id or None
    pytest.fail("disposable PostgreSQL function returned no closed disposition")


def _wait_for_advisory_lock(environment: dict[str, str]) -> None:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        output = _psql(
            environment,
            """
            SELECT COUNT(*)
            FROM pg_catalog.pg_locks
            WHERE locktype = 'advisory' AND granted;
            """,
        ).stdout.strip()
        if output.isdigit() and int(output) > 0:
            return
        time.sleep(0.02)
    pytest.fail("concurrent registration did not acquire its advisory lock")


def _concurrent_pair(
    environment: dict[str, str],
    first: dict[str, str],
    second: dict[str, str],
) -> tuple[tuple[str, str | None], tuple[str, str | None]]:
    with ThreadPoolExecutor(max_workers=2) as executor:
        first_future = executor.submit(
            _call,
            environment,
            **first,
            hold_seconds=1,
        )
        _wait_for_advisory_lock(environment)
        second_result = _call(environment, **second)
        first_result = first_future.result(timeout=10)
    return first_result, second_result


def test_recoverable_cli_registration_transaction_in_disposable_postgres():
    environment = _postgres_environment()
    _setup_database(environment)

    exact = {
        "request_id": "10000000-0000-4000-8000-000000000001",
        "name": "Codex",
        "username": "codex-exact",
        "api_key": _key("A"),
    }
    first, concurrent_replay = _concurrent_pair(environment, exact, exact)
    assert {first[0], concurrent_replay[0]} == {"created", "replayed"}
    assert first[1] == concurrent_replay[1]

    replay = _call(environment, **exact)
    assert replay == ("replayed", first[1])
    changed_payload = _call(
        environment,
        **{**exact, "name": "Changed"},
    )
    assert changed_payload == ("idempotency_conflict", None)

    username_first = {
        "request_id": "20000000-0000-4000-8000-000000000001",
        "name": "Codex One",
        "username": "shared-username",
        "api_key": _key("B"),
    }
    username_second = {
        "request_id": "20000000-0000-4000-8000-000000000002",
        "name": "Codex Two",
        "username": "shared-username",
        "api_key": _key("C"),
    }
    username_results = _concurrent_pair(
        environment,
        username_first,
        username_second,
    )
    assert {result[0] for result in username_results} == {
        "created",
        "username_unavailable",
    }
    assert all(
        agent_id is not None
        if disposition == "created"
        else agent_id is None
        for disposition, agent_id in username_results
    )

    hash_first = {
        "request_id": "30000000-0000-4000-8000-000000000001",
        "name": "Hash One",
        "username": "hash-one",
        "api_key": _key("D"),
    }
    hash_second = {
        "request_id": "30000000-0000-4000-8000-000000000002",
        "name": "Hash Two",
        "username": "hash-two",
        "api_key": _key("D"),
    }
    hash_results = _concurrent_pair(
        environment,
        hash_first,
        hash_second,
    )
    assert {result[0] for result in hash_results} == {
        "created",
        "credential_conflict",
    }
    assert all(
        agent_id is not None
        if disposition == "created"
        else agent_id is None
        for disposition, agent_id in hash_results
    )

    legacy_key = _key("E")
    _psql(
        environment,
        f"""
        INSERT INTO public.agents (
            name, username, api_key_hash, api_key_prefix
        ) VALUES (
            'Legacy', 'legacy-agent',
            '{_hash(legacy_key)}', '{_prefix(legacy_key)}'
        );
        """,
    )
    assert _call(
        environment,
        request_id="40000000-0000-4000-8000-000000000001",
        name="CLI",
        username="cli-collision",
        api_key=legacy_key,
    ) == ("credential_conflict", None)

    _psql(
        environment,
        f"""
        UPDATE public.agents
        SET api_key_hash = '{_hash(_key("F"))}',
            api_key_prefix = '{_prefix(_key("F"))}',
            is_active = FALSE
        WHERE id = '{first[1]}'::UUID;
        """,
    )
    assert _call(environment, **exact) == ("replayed", first[1])
    assert _call(
        environment,
        request_id="50000000-0000-4000-8000-000000000001",
        name="Historical Key",
        username="historical-key",
        api_key=exact["api_key"],
    ) == ("credential_conflict", None)

    immutable = _psql(
        environment,
        "\\set VERBOSITY verbose\n"
        "UPDATE public.agent_registration_requests "
        "SET username = 'mutated';",
        check=False,
    )
    assert immutable.returncode != 0
    assert "55000" in immutable.stderr

    restricted_delete = _psql(
        environment,
        "\\set VERBOSITY verbose\n"
        f"DELETE FROM public.agents WHERE id = '{first[1]}'::UUID;",
        check=False,
    )
    assert restricted_delete.returncode != 0
    assert "23503" in restricted_delete.stderr

    for role in ("anon", "authenticated"):
        denied_rpc = _psql(
            environment,
            "\\set VERBOSITY verbose\n" + _call_sql(**exact, role=role),
            check=False,
        )
        assert denied_rpc.returncode != 0
        assert "42501" in denied_rpc.stderr
        denied_table = _psql(
            environment,
            "\\set VERBOSITY verbose\n"
            f"SET ROLE {role}; "
            "SELECT * FROM public.agent_registration_requests;",
            check=False,
        )
        assert denied_table.returncode != 0
        assert "42501" in denied_table.stderr

    cardinality = _psql(
        environment,
        """
        SELECT
            (SELECT COUNT(*) FROM public.agents),
            (SELECT COUNT(*) FROM public.agent_registration_requests),
            (
                SELECT COUNT(*)
                FROM public.agent_registration_requests AS request
                JOIN public.agents AS agent ON agent.id = request.agent_id
            ),
            (
                SELECT COUNT(DISTINCT agent_id)
                FROM public.agent_registration_requests
            );
        """,
    ).stdout.strip()
    assert tuple(int(value) for value in cardinality.split("|")) == (4, 3, 3, 3)
