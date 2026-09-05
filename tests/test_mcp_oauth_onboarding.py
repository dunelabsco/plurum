"""Focused route coverage for hosted MCP OAuth agent onboarding."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from unittest.mock import patch
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.core.exceptions import AuthorizationError
from app.core.security import get_current_user
from app.main import create_app
from app.models.mcp_oauth import MCPOAuthBoundAgent


OWNER_ID = "11111111-1111-4111-8111-111111111111"
AGENT_ID = UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
CLIENT_ID = "codex-client-A"


def _settings(*, oauth_enabled: bool) -> Settings:
    return Settings(
        environment="development",
        supabase_url="https://project.supabase.co",
        supabase_db_url="postgresql://localhost/test",
        supabase_key="test-key",
        openai_api_key="test-key",
        mcp_enabled=False,
        mcp_oauth_enabled=oauth_enabled,
    )


@contextmanager
def _client(
    *,
    oauth_enabled: bool,
    authenticated: bool = False,
) -> Iterator[TestClient]:
    with patch(
        "app.main.get_settings",
        return_value=_settings(oauth_enabled=oauth_enabled),
    ):
        application = create_app()

    if authenticated:
        application.dependency_overrides[get_current_user] = lambda: {"id": OWNER_ID}

    with TestClient(application) as test_client:
        yield test_client


def _agent(*, api_key_prefix: str | None = "plrm_live_existing...") -> MCPOAuthBoundAgent:
    return MCPOAuthBoundAgent(
        grant_id="cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        id=AGENT_ID,
        name="Codex",
        username="codex-agent",
        api_key_prefix=api_key_prefix,
        is_active=True,
        rate_limit_tier="standard",
        subscription_tier="free",
        credits_balance=0,
        publisher_domain=None,
        created_at=datetime(2026, 8, 30, tzinfo=timezone.utc),
        last_active_at=None,
    )


def _agent_row(*, api_key_prefix: str | None = "plrm_live_existing...") -> dict:
    return _agent(api_key_prefix=api_key_prefix).model_dump()


@pytest.mark.parametrize(
    ("path", "payload"),
    [
        (
            "/api/v1/mcp/oauth/bind",
            {"client_id": CLIENT_ID, "expected_grant_id": None, "agent_id": str(AGENT_ID)},
        ),
        (
            "/api/v1/mcp/oauth/create-and-bind",
            {
                "client_id": CLIENT_ID,
                "expected_grant_id": None,
                "name": "Codex",
                "username": "codex-agent",
            },
        ),
    ],
)
def test_oauth_onboarding_routes_are_absent_while_flag_is_disabled(path, payload):
    with (
        patch("app.api.v1.mcp_oauth.MCPOAuthBindingService") as binding_service,
        _client(oauth_enabled=False) as client,
    ):
        response = client.post(path, json=payload)

    assert response.status_code == 404
    binding_service.assert_not_called()


@pytest.mark.parametrize(
    ("path", "payload", "headers"),
    [
        (
            "/api/v1/mcp/oauth/bind",
            {"client_id": CLIENT_ID, "expected_grant_id": None, "agent_id": str(AGENT_ID)},
            {},
        ),
        (
            "/api/v1/mcp/oauth/create-and-bind",
            {
                "client_id": CLIENT_ID,
                "expected_grant_id": None,
                "name": "Codex",
                "username": "codex-agent",
            },
            {"Authorization": "Bearer plrm_live_not-a-web-session"},
        ),
    ],
)
def test_oauth_onboarding_requires_an_ordinary_web_user(path, payload, headers):
    with _client(oauth_enabled=True) as client:
        response = client.post(path, headers=headers, json=payload)

    assert response.status_code == 401


def test_bind_delegates_exact_user_client_and_agent_ownership_checks():
    public_agent = _agent()
    with (
        patch("app.api.v1.mcp_oauth.MCPOAuthBindingService") as binding_type,
        _client(oauth_enabled=True, authenticated=True) as client,
    ):
        binding_type.return_value.bind.return_value = public_agent

        response = client.post(
            "/api/v1/mcp/oauth/bind",
            json={"client_id": CLIENT_ID, "expected_grant_id": None, "agent_id": str(AGENT_ID)},
        )

    assert response.status_code == 200
    binding_type.return_value.bind.assert_called_once_with(
        owner_user_id=OWNER_ID, client_id=CLIENT_ID, agent_id=AGENT_ID, expected_grant_id=None
    )
    assert "client_id" not in response.json()
    assert "owner_user_id" not in response.json()
    assert "api_key_hash" not in response.json()
    assert "api_key" not in response.json()


def test_bind_propagates_the_binding_services_generic_ownership_rejection():
    with (
        patch("app.api.v1.mcp_oauth.MCPOAuthBindingService") as binding_type,
        _client(oauth_enabled=True, authenticated=True) as client,
    ):
        binding_type.return_value.bind.side_effect = AuthorizationError(
            "The selected agent cannot be used for MCP OAuth"
        )

        response = client.post(
            "/api/v1/mcp/oauth/bind",
            json={"client_id": CLIENT_ID, "expected_grant_id": None, "agent_id": str(AGENT_ID)},
        )

    assert response.status_code == 403
    assert response.json()["error"] == ("The selected agent cannot be used for MCP OAuth")


def test_create_and_bind_delegates_one_atomic_operation_and_logs_registration():
    public_agent = _agent_row(api_key_prefix=None)

    with (
        patch("app.api.v1.mcp_oauth.MCPOAuthBindingService") as binding_type,
        patch("app.api.v1.mcp_oauth.log_event") as log_event,
        _client(oauth_enabled=True, authenticated=True) as client,
    ):
        binding_type.return_value.create_agent_and_bind.return_value = public_agent

        response = client.post(
            "/api/v1/mcp/oauth/create-and-bind",
            json={
                "client_id": CLIENT_ID,
                "expected_grant_id": None,
                "name": "Codex",
                "username": "codex-agent",
            },
        )

    assert response.status_code == 201
    binding_type.return_value.create_agent_and_bind.assert_called_once_with(
        owner_user_id=OWNER_ID,
        client_id=CLIENT_ID,
        name="Codex",
        username="codex-agent",
        expected_grant_id=None,
    )
    log_event.assert_called_once_with(
        "register",
        agent_id=str(AGENT_ID),
        metadata={"flow": "mcp_oauth"},
    )
    assert response.json()["api_key_prefix"] is None
    assert "api_key" not in response.json()
    assert "api_key_hash" not in response.json()
    assert "client_id" not in response.json()
    assert "owner_user_id" not in response.json()


@pytest.mark.parametrize(
    ("path", "payload"),
    [
        (
            "/api/v1/mcp/oauth/bind",
            {
                "client_id": CLIENT_ID,
                "expected_grant_id": None,
                "agent_id": str(AGENT_ID),
                "owner_user_id": OWNER_ID,
            },
        ),
        (
            "/api/v1/mcp/oauth/create-and-bind",
            {
                "client_id": CLIENT_ID,
                "expected_grant_id": None,
                "name": "Codex",
                "username": "codex-agent",
                "resource": "https://attacker.example/mcp",
            },
        ),
    ],
)
def test_oauth_onboarding_models_forbid_untrusted_identity_fields(path, payload):
    with (
        patch("app.api.v1.mcp_oauth.MCPOAuthBindingService") as binding_type,
        _client(oauth_enabled=True, authenticated=True) as client,
    ):
        response = client.post(path, json=payload)

    assert response.status_code == 422
    binding_type.assert_not_called()
