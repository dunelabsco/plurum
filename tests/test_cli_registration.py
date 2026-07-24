"""Recoverable CLI registration tests.

All database and network boundaries in this module are mocked.
"""

from __future__ import annotations

from hashlib import sha256
from pathlib import Path
from unittest.mock import MagicMock, patch
from uuid import UUID

import pytest

from app.core.exceptions import PlurimException
from app.models.agent import (
    AgentCliRegisterRequest,
    AgentCliRegisterResponse,
    AgentRegisterResponse,
)
from app.repositories.agent_repo import AgentRepository
from app.services.agent_service import AgentService


REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000"
AGENT_ID = "00000000-0000-4000-8000-000000000001"
API_KEY = f"plrm_live_{'A' * 43}"
API_KEY_HASH = sha256(API_KEY.encode()).hexdigest()
API_KEY_PREFIX = f"{API_KEY[:16]}..."


def request_body(**overrides):
    return {
        "protocol_version": 1,
        "registration_request_id": REQUEST_ID,
        "name": "Codex",
        "username": "codex-42",
        "api_key_hash": API_KEY_HASH,
        "api_key_prefix": API_KEY_PREFIX,
        **overrides,
    }


def registration_result(disposition: str = "created") -> AgentCliRegisterResponse:
    return AgentCliRegisterResponse(
        agent_id=UUID(AGENT_ID),
        disposition=disposition,
    )


@pytest.mark.parametrize("disposition", ["created", "replayed"])
def test_cli_registration_success_is_minimal_and_never_cached(
    client,
    disposition,
):
    with (
        patch.object(
            AgentService,
            "register_cli",
            return_value=registration_result(disposition),
        ) as register,
        patch("app.api.v1.agents.log_event") as event,
    ):
        response = client.post(
            "/api/v1/agents/register/cli",
            json=request_body(),
        )

    assert response.status_code == 200
    assert response.json() == {
        "agent_id": AGENT_ID,
        "disposition": disposition,
    }
    assert response.headers["cache-control"] == "no-store"
    assert API_KEY not in response.text
    submitted = register.call_args.args[0]
    assert isinstance(submitted, AgentCliRegisterRequest)
    assert not hasattr(submitted, "api_key")
    if disposition == "created":
        event.assert_called_once_with(
            "register",
            agent_id=AGENT_ID,
            metadata={"flow": "cli"},
        )
    else:
        event.assert_not_called()


@pytest.mark.parametrize(
    ("body", "content_type"),
    [
        ({**request_body(), "api_key": API_KEY}, "application/json"),
        (request_body(api_key_hash=API_KEY), "application/json"),
        (request_body(api_key_hash="A" * 64), "application/json"),
        (request_body(api_key_prefix="plrm_live_too-short..."), "application/json"),
        (request_body(registration_request_id="not-a-uuid"), "application/json"),
        (
            request_body(registration_request_id=REQUEST_ID.upper()),
            "application/json",
        ),
        (
            request_body(
                registration_request_id="123e4567-e89b-12d3-a456-426614174000"
            ),
            "application/json",
        ),
        (request_body(protocol_version=True), "application/json"),
        (request_body(protocol_version=1.0), "application/json"),
        (request_body(name="Codex\nreflected"), "application/json"),
        (request_body(name=API_KEY), "application/json"),
        (
            request_body(name="plrm_live_AAAAA\u200dAAAAAAAAAA"),
            "application/json",
        ),
        (request_body(username="UPPERCASE"), "application/json"),
        (
            request_body(username=f"plrm_live_{'a' * 20}"),
            "application/json",
        ),
        ([], "application/json"),
        (request_body(), "text/plain"),
    ],
)
def test_invalid_cli_registration_is_fixed_and_does_not_reflect_input(
    client,
    body,
    content_type,
):
    with patch.object(AgentService, "register_cli") as register:
        response = client.post(
            "/api/v1/agents/register/cli",
            json=body,
            headers={"content-type": content_type},
        )

    assert response.status_code == 422
    assert response.json() == {"error": "invalid_registration_request"}
    assert response.headers["cache-control"] == "no-store"
    assert API_KEY not in response.text
    assert API_KEY_HASH not in response.text
    register.assert_not_called()


def test_duplicate_json_fields_are_rejected_without_reflection(client):
    duplicate_body = (
        '{"protocol_version":1,'
        f'"registration_request_id":"{REQUEST_ID}",'
        '"name":"Codex","name":"plrm_live_AAAAAAAAAAAAAAAAAAAA",'
        '"username":"codex-42",'
        f'"api_key_hash":"{API_KEY_HASH}",'
        f'"api_key_prefix":"{API_KEY_PREFIX}"'
        "}"
    )
    with patch.object(AgentService, "register_cli") as register:
        response = client.post(
            "/api/v1/agents/register/cli",
            content=duplicate_body,
            headers={"content-type": "application/json"},
        )

    assert response.status_code == 422
    assert response.json() == {"error": "invalid_registration_request"}
    assert "plrm_live_" not in response.text
    register.assert_not_called()


@pytest.mark.parametrize(
    "error",
    [
        "idempotency_conflict",
        "username_unavailable",
        "credential_conflict",
    ],
)
def test_deterministic_cli_registration_conflicts_have_exact_wire_shape(
    client,
    error,
):
    failure = PlurimException(
        "must not appear",
        status_code=409,
        details={"code": error, "reflected": API_KEY},
    )
    with patch.object(AgentService, "register_cli", side_effect=failure):
        response = client.post(
            "/api/v1/agents/register/cli",
            json=request_body(),
        )

    assert response.status_code == 409
    assert response.json() == {"error": error}
    assert response.headers["cache-control"] == "no-store"
    assert API_KEY not in response.text


@pytest.mark.parametrize(
    "failure",
    [
        RuntimeError(f"database reflected {API_KEY}"),
        PlurimException(
            f"database reflected {API_KEY}",
            status_code=500,
            details={"code": "unexpected", "secret": API_KEY},
        ),
    ],
)
def test_unknown_cli_registration_failure_is_fixed_and_retryable(client, failure):
    with patch.object(AgentService, "register_cli", side_effect=failure):
        response = client.post(
            "/api/v1/agents/register/cli",
            json=request_body(),
        )

    assert response.status_code == 503
    assert response.json() == {"error": "registration_unavailable"}
    assert response.headers["cache-control"] == "no-store"
    assert API_KEY not in response.text


def rpc_result(disposition: str, agent_id: str | None):
    return MagicMock(
        data=[{"disposition": disposition, "agent_id": agent_id}]
    )


@pytest.mark.parametrize("disposition", ["created", "replayed"])
def test_repository_calls_one_rpc_without_the_raw_key(
    mock_supabase,
    disposition,
):
    mock_supabase.rpc.return_value.execute.return_value = rpc_result(
        disposition,
        AGENT_ID,
    )
    repository = AgentRepository()

    result = repository.register_cli(
        protocol_version=1,
        registration_request_id=UUID(REQUEST_ID),
        name="Codex",
        username="codex-42",
        api_key_hash=API_KEY_HASH,
        api_key_prefix=API_KEY_PREFIX,
    )

    assert result == {
        "disposition": disposition,
        "agent_id": UUID(AGENT_ID),
    }
    mock_supabase.rpc.assert_called_once_with(
        "register_cli_agent",
        {
            "p_protocol_version": 1,
            "p_registration_request_id": REQUEST_ID,
            "p_name": "Codex",
            "p_username": "codex-42",
            "p_api_key_hash": API_KEY_HASH,
            "p_api_key_prefix": API_KEY_PREFIX,
        },
    )
    assert API_KEY not in repr(mock_supabase.rpc.call_args)


@pytest.mark.parametrize(
    "disposition",
    [
        "idempotency_conflict",
        "username_unavailable",
        "credential_conflict",
    ],
)
def test_repository_preserves_closed_conflict_dispositions(
    mock_supabase,
    disposition,
):
    mock_supabase.rpc.return_value.execute.return_value = rpc_result(
        disposition,
        None,
    )

    result = AgentRepository().register_cli(
        protocol_version=1,
        registration_request_id=UUID(REQUEST_ID),
        name="Codex",
        username="codex-42",
        api_key_hash=API_KEY_HASH,
        api_key_prefix=API_KEY_PREFIX,
    )

    assert result == {"disposition": disposition, "agent_id": None}


@pytest.mark.parametrize(
    "data",
    [
        None,
        [],
        [{}, {}],
        [{"disposition": "created", "agent_id": None}],
        [{"disposition": "unknown", "agent_id": AGENT_ID}],
        [
            {
                "disposition": "created",
                "agent_id": AGENT_ID,
                "extra": API_KEY,
            }
        ],
    ],
)
def test_repository_rejects_malformed_rpc_results_with_fixed_error(
    mock_supabase,
    data,
):
    mock_supabase.rpc.return_value.execute.return_value = MagicMock(data=data)

    with pytest.raises(PlurimException) as exc_info:
        AgentRepository().register_cli(
            protocol_version=1,
            registration_request_id=UUID(REQUEST_ID),
            name="Codex",
            username="codex-42",
            api_key_hash=API_KEY_HASH,
            api_key_prefix=API_KEY_PREFIX,
        )

    assert exc_info.value.status_code == 503
    assert exc_info.value.details == {"code": "registration_unavailable"}
    assert API_KEY not in exc_info.value.message


def test_repository_redacts_rpc_adapter_failure(mock_supabase):
    mock_supabase.rpc.side_effect = RuntimeError(f"reflected {API_KEY}")

    with pytest.raises(PlurimException) as exc_info:
        AgentRepository().register_cli(
            protocol_version=1,
            registration_request_id=UUID(REQUEST_ID),
            name="Codex",
            username="codex-42",
            api_key_hash=API_KEY_HASH,
            api_key_prefix=API_KEY_PREFIX,
        )

    assert exc_info.value.status_code == 503
    assert exc_info.value.details == {"code": "registration_unavailable"}
    assert API_KEY not in str(exc_info.value)


@pytest.mark.parametrize(
    "disposition",
    [
        "idempotency_conflict",
        "username_unavailable",
        "credential_conflict",
    ],
)
def test_service_maps_closed_conflict_without_reflecting_request(disposition):
    service = AgentService.__new__(AgentService)
    service.repo = MagicMock()
    service.repo.register_cli.return_value = {
        "disposition": disposition,
        "agent_id": None,
    }

    with pytest.raises(PlurimException) as exc_info:
        service.register_cli(AgentCliRegisterRequest.model_validate(request_body()))

    assert exc_info.value.status_code == 409
    assert exc_info.value.details == {"code": disposition}
    assert API_KEY_HASH not in str(exc_info.value)


@pytest.mark.parametrize("disposition", ["created", "replayed"])
def test_service_returns_minimal_success(disposition):
    service = AgentService.__new__(AgentService)
    service.repo = MagicMock()
    service.repo.register_cli.return_value = {
        "disposition": disposition,
        "agent_id": UUID(AGENT_ID),
    }

    result = service.register_cli(
        AgentCliRegisterRequest.model_validate(request_body())
    )

    assert result.model_dump(mode="json") == {
        "agent_id": AGENT_ID,
        "disposition": disposition,
    }
    service.repo.register_cli.assert_called_once_with(
        protocol_version=1,
        registration_request_id=UUID(REQUEST_ID),
        name="Codex",
        username="codex-42",
        api_key_hash=API_KEY_HASH,
        api_key_prefix=API_KEY_PREFIX,
    )


def test_legacy_open_registration_contract_remains_unchanged(client):
    legacy = AgentRegisterResponse(
        id=UUID(AGENT_ID),
        name="legacy-agent",
        api_key=API_KEY,
        api_key_prefix=API_KEY_PREFIX,
        message="API key created successfully. Store it securely - it cannot be retrieved later.",
    )
    with (
        patch.object(AgentService, "register", return_value=legacy),
        patch("app.api.v1.agents.log_event"),
    ):
        response = client.post(
            "/api/v1/agents/register",
            json={"name": "legacy-agent", "username": "legacy-agent"},
        )

    assert response.status_code == 201
    assert response.json()["api_key"] == API_KEY


def test_registration_routes_share_one_ip_quota(client):
    legacy = AgentRegisterResponse(
        id=UUID(AGENT_ID),
        name="legacy-agent",
        api_key=API_KEY,
        api_key_prefix=API_KEY_PREFIX,
        message="created",
    )
    with (
        patch.object(AgentService, "register", return_value=legacy),
        patch.object(
            AgentService,
            "register_cli",
            return_value=registration_result(),
        ),
        patch("app.api.v1.agents.log_event"),
    ):
        for _ in range(30):
            response = client.post(
                "/api/v1/agents/register",
                json={"name": "legacy-agent", "username": "legacy-agent"},
            )
            assert response.status_code == 201

        for _ in range(30):
            response = client.post(
                "/api/v1/agents/register/cli",
                json=request_body(),
            )
            assert response.status_code == 200

        response = client.post(
            "/api/v1/agents/register/cli",
            json=request_body(),
        )

    assert response.status_code == 429
    assert response.headers["cache-control"] == "no-store"


def test_malformed_cli_registration_consumes_the_shared_ip_quota(client):
    with patch.object(
        AgentService,
        "register_cli",
        return_value=registration_result(),
    ) as register:
        for _ in range(60):
            response = client.post(
                "/api/v1/agents/register/cli",
                content=b'{"protocol_version":',
                headers={"content-type": "application/json"},
            )
            assert response.status_code == 422

        response = client.post(
            "/api/v1/agents/register/cli",
            json=request_body(),
        )

    assert response.status_code == 429
    assert response.headers["cache-control"] == "no-store"
    register.assert_not_called()


def test_cli_registration_body_has_a_tighter_preparse_limit(client):
    with patch.object(AgentService, "register_cli") as register:
        response = client.post(
            "/api/v1/agents/register/cli",
            content=b"x" * 16_385,
            headers={"content-type": "application/json"},
        )

    assert response.status_code == 413
    assert response.headers["cache-control"] == "no-store"
    register.assert_not_called()


def test_migration_defines_atomic_immutable_service_only_registration():
    migration = (
        Path(__file__).parents[1]
        / "app/db/migrations/032_recoverable_cli_registration.sql"
    ).read_text()

    assert "CREATE TABLE agent_registration_requests" in migration
    assert "ON DELETE RESTRICT" in migration
    assert "agent_registration_requests_are_immutable" in migration
    assert "CREATE OR REPLACE FUNCTION register_cli_agent" in migration
    assert "pg_advisory_xact_lock" in migration
    assert "sha256(convert_to(v_payload_material, 'UTF8'))" in migration
    assert "INSERT INTO public.agents" in migration
    assert "INSERT INTO public.agent_registration_requests" in migration
    assert "SECURITY INVOKER" in migration
    assert "FROM PUBLIC, anon, authenticated" in migration
    assert "TO service_role" in migration
    assert "ALTER TABLE agents" not in migration
