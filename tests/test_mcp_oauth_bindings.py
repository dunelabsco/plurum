"""Focused tests for MCP OAuth binding persistence and business rules."""

from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import UUID

import pytest
from pydantic import ValidationError as PydanticValidationError

from app.config import Settings
from app.core.exceptions import (
    AuthorizationError,
    DuplicateError,
    NotFoundError,
    PlurimException,
    ValidationError,
)
from app.repositories.agent_repo import AgentRepository
from app.repositories.mcp_oauth_binding_repo import MCPOAuthBindingRepository
from app.services.mcp_oauth_binding_service import MCPOAuthBindingService


OWNER_ID = "11111111-1111-4111-8111-111111111111"
OTHER_OWNER_ID = "22222222-2222-4222-8222-222222222222"
AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
GRANT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
CLIENT_ID = "https://codex.example/register/Client-A"


def _settings(**overrides) -> Settings:
    values = {
        "supabase_url": "https://project.supabase.co",
        "supabase_db_url": "postgresql://localhost/test",
        "supabase_key": "test-key",
        "openai_api_key": "test-key",
    }
    values.update(overrides)
    return Settings(**values)


def _agent(*, owner_user_id: str = OWNER_ID, is_active: bool = True) -> dict:
    return {
        "id": AGENT_ID,
        "owner_user_id": owner_user_id,
        "is_active": is_active,
    }


def _service(*, binding_repo=None, agent_repo=None) -> MCPOAuthBindingService:
    return MCPOAuthBindingService(
        binding_repo=(
            binding_repo if binding_repo is not None else MagicMock(spec=MCPOAuthBindingRepository)
        ),
        agent_repo=(agent_repo if agent_repo is not None else MagicMock(spec=AgentRepository)),
    )


def test_oauth_settings_are_disabled_and_canonical_by_default():
    settings = _settings()

    assert settings.mcp_oauth_enabled is False
    assert settings.mcp_oauth_resource_url == "https://mcp.plurum.ai/mcp"
    assert settings.mcp_oauth_audience == "https://mcp.plurum.ai/mcp"
    assert settings.effective_mcp_oauth_issuer_url == ("https://project.supabase.co/auth/v1")
    assert settings.mcp_oauth_max_bearer_token_bytes == 8 * 1024


def test_explicit_oauth_issuer_is_preserved_exactly():
    issuer = "https://auth.example.test/oauth/"
    settings = _settings(mcp_oauth_issuer_url=issuer)

    assert settings.effective_mcp_oauth_issuer_url == issuer


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("mcp_oauth_resource_url", "http://mcp.example.test/mcp"),
        ("mcp_oauth_resource_url", "https://user@mcp.example.test/mcp"),
        ("mcp_oauth_resource_url", "https://mcp.example.test/mcp?tenant=1"),
        ("mcp_oauth_resource_url", "https://mcp.example.test:invalid/mcp"),
        ("mcp_oauth_resource_url", "https://mcp.example.test:/mcp"),
        ("mcp_oauth_resource_url", "https://mcp.example.test\\evil/mcp"),
        ("mcp_oauth_issuer_url", "https://auth.example.test/#fragment"),
    ],
)
def test_oauth_settings_reject_ambiguous_or_insecure_endpoints(field, value):
    with pytest.raises(PydanticValidationError):
        _settings(**{field: value})


def test_oauth_settings_allow_loopback_http_only_in_development():
    settings = _settings(
        environment="development",
        supabase_url="http://127.0.0.1:54321",
        mcp_oauth_resource_url="http://localhost:8000/mcp",
    )

    assert settings.effective_mcp_oauth_issuer_url == ("http://127.0.0.1:54321/auth/v1")


def test_repository_upsert_preserves_the_exact_opaque_client_id():
    client = MagicMock()
    client.rpc.return_value.execute.return_value = SimpleNamespace(
        data={"agent": _agent(), "grant_id": GRANT_ID}
    )
    repository = MCPOAuthBindingRepository(client=client)
    result = repository.upsert(
        owner_user_id=OWNER_ID, client_id=CLIENT_ID, agent_id=AGENT_ID, expected_grant_id=None
    )
    client.rpc.assert_called_once_with(
        "bind_mcp_oauth_agent",
        {
            "p_owner_user_id": OWNER_ID,
            "p_client_id": CLIENT_ID,
            "p_agent_id": AGENT_ID,
            "p_expected_grant_id": None,
        },
    )
    assert result == {**_agent(), "grant_id": GRANT_ID}


def test_repository_lookup_uses_both_exact_key_parts():
    client = MagicMock()
    query = client.table.return_value.select.return_value
    query.eq.return_value = query
    query.limit.return_value = query
    query.execute.return_value = SimpleNamespace(data=[])
    repository = MCPOAuthBindingRepository(client=client)

    assert repository.get(owner_user_id=OWNER_ID, client_id=CLIENT_ID) is None

    assert query.eq.call_args_list[0].args == ("owner_user_id", OWNER_ID)
    assert query.eq.call_args_list[1].args == ("client_id", CLIENT_ID)


def test_repository_create_agent_and_bind_uses_atomic_rpc_exactly():
    client = MagicMock()
    created_agent = _agent()
    client.rpc.return_value.execute.return_value = SimpleNamespace(
        data={"agent": created_agent, "grant_id": GRANT_ID}
    )
    repository = MCPOAuthBindingRepository(client=client)

    result = repository.create_agent_and_bind(
        owner_user_id=OWNER_ID,
        client_id=CLIENT_ID,
        name="Codex",
        username="codex-agent",
        expected_grant_id=None,
    )

    client.rpc.assert_called_once_with(
        "create_mcp_oauth_agent_and_binding",
        {
            "p_owner_user_id": OWNER_ID,
            "p_client_id": CLIENT_ID,
            "p_name": "Codex",
            "p_username": "codex-agent",
            "p_expected_grant_id": None,
        },
    )
    assert result == {**created_agent, "grant_id": GRANT_ID}


def test_repository_create_agent_and_bind_sanitizes_duplicate_failures(caplog):
    class DuplicateDatabaseError(RuntimeError):
        code = "23505"

    client = MagicMock()
    client.rpc.side_effect = DuplicateDatabaseError(f"duplicate {CLIENT_ID} codex-agent")
    repository = MCPOAuthBindingRepository(client=client)

    with pytest.raises(DuplicateError) as error:
        repository.create_agent_and_bind(
            owner_user_id=OWNER_ID,
            client_id=CLIENT_ID,
            name="Codex",
            username="codex-agent",
            expected_grant_id=None,
        )

    assert error.value.message == "Username is already taken"
    assert CLIENT_ID not in error.value.message
    assert "codex-agent" not in error.value.message
    assert CLIENT_ID not in caplog.text
    assert "codex-agent" not in caplog.text


def test_repository_create_agent_and_bind_sanitizes_generic_failures(caplog):
    client = MagicMock()
    client.rpc.side_effect = RuntimeError(f"failed {CLIENT_ID} codex-agent")
    repository = MCPOAuthBindingRepository(client=client)

    with pytest.raises(PlurimException) as error:
        repository.create_agent_and_bind(
            owner_user_id=OWNER_ID,
            client_id=CLIENT_ID,
            name="Codex",
            username="codex-agent",
            expected_grant_id=None,
        )

    assert error.value.message == "MCP OAuth connection operation failed"
    assert CLIENT_ID not in error.value.message
    assert "codex-agent" not in error.value.message
    assert "RuntimeError" in caplog.text
    assert CLIENT_ID not in caplog.text
    assert "codex-agent" not in caplog.text


def test_repository_create_agent_and_bind_rejects_empty_rpc_result():
    client = MagicMock()
    client.rpc.return_value.execute.return_value = SimpleNamespace(data=[])
    repository = MCPOAuthBindingRepository(client=client)

    with pytest.raises(PlurimException) as error:
        repository.create_agent_and_bind(
            owner_user_id=OWNER_ID,
            client_id=CLIENT_ID,
            name="Codex",
            username="codex-agent",
            expected_grant_id=None,
        )

    assert error.value.message == "Failed to save MCP OAuth agent selection"


def test_repository_errors_do_not_echo_identifiers(caplog):
    client = MagicMock()
    client.table.side_effect = RuntimeError(f"database rejected {CLIENT_ID}")
    repository = MCPOAuthBindingRepository(client=client)

    with pytest.raises(PlurimException) as error:
        repository.get(owner_user_id=OWNER_ID, client_id=CLIENT_ID)

    assert error.value.message == "Failed to read MCP OAuth agent selection"
    assert CLIENT_ID not in error.value.message
    assert CLIENT_ID not in caplog.text


def test_bind_upserts_only_an_active_agent_owned_by_the_user():
    binding_repo = MagicMock(spec=MCPOAuthBindingRepository)
    binding_repo.upsert.return_value = {**_agent(), "grant_id": GRANT_ID}
    agent_repo = MagicMock(spec=AgentRepository)
    selected_agent = _agent()
    agent_repo.get_by_id.return_value = selected_agent
    service = _service(binding_repo=binding_repo, agent_repo=agent_repo)

    result = service.bind(
        owner_user_id=OWNER_ID, client_id=CLIENT_ID, agent_id=AGENT_ID, expected_grant_id=None
    )

    agent_repo.get_by_id.assert_called_once_with(UUID(AGENT_ID))
    binding_repo.upsert.assert_called_once_with(
        owner_user_id=OWNER_ID, client_id=CLIENT_ID, agent_id=AGENT_ID, expected_grant_id=None
    )
    assert result == {**selected_agent, "grant_id": GRANT_ID}


def test_create_agent_and_bind_delegates_validated_values_to_atomic_repository():
    binding_repo = MagicMock(spec=MCPOAuthBindingRepository)
    created_agent = _agent()
    binding_repo.create_agent_and_bind.return_value = created_agent
    service = _service(binding_repo=binding_repo)

    result = service.create_agent_and_bind(
        owner_user_id=OWNER_ID,
        client_id=CLIENT_ID,
        name="Codex",
        username="Codex-Agent",
        expected_grant_id=None,
    )

    binding_repo.create_agent_and_bind.assert_called_once_with(
        owner_user_id=OWNER_ID,
        client_id=CLIENT_ID,
        name="Codex",
        username="codex-agent",
        expected_grant_id=None,
    )
    assert result is created_agent


@pytest.mark.parametrize(
    ("owner_user_id", "client_id"),
    [
        ("not-a-uuid", CLIENT_ID),
        (OWNER_ID, ""),
        (OWNER_ID, "a" * 2049),
    ],
)
def test_create_agent_and_bind_rejects_invalid_binding_input_before_rpc(owner_user_id, client_id):
    binding_repo = MagicMock(spec=MCPOAuthBindingRepository)
    service = _service(binding_repo=binding_repo)

    with pytest.raises(ValidationError):
        service.create_agent_and_bind(
            owner_user_id=owner_user_id,
            client_id=client_id,
            name="Codex",
            username="codex-agent",
            expected_grant_id=None,
        )

    binding_repo.create_agent_and_bind.assert_not_called()


@pytest.mark.parametrize(
    "agent",
    [
        _agent(owner_user_id=OTHER_OWNER_ID),
        _agent(is_active=False),
    ],
)
def test_bind_rejects_unavailable_agent_without_leaking_identifiers(agent):
    binding_repo = MagicMock(spec=MCPOAuthBindingRepository)
    agent_repo = MagicMock(spec=AgentRepository)
    agent_repo.get_by_id.return_value = agent
    service = _service(binding_repo=binding_repo, agent_repo=agent_repo)

    with pytest.raises(AuthorizationError) as error:
        service.bind(
            owner_user_id=OWNER_ID, client_id=CLIENT_ID, agent_id=AGENT_ID, expected_grant_id=None
        )

    assert error.value.message == "The selected agent cannot be used for MCP OAuth"
    assert AGENT_ID not in error.value.message
    assert CLIENT_ID not in error.value.message
    binding_repo.upsert.assert_not_called()


def test_bind_masks_a_missing_agent():
    agent_repo = MagicMock(spec=AgentRepository)
    agent_repo.get_by_id.side_effect = NotFoundError("Agent", AGENT_ID)
    service = _service(agent_repo=agent_repo)

    with pytest.raises(AuthorizationError) as error:
        service.bind(
            owner_user_id=OWNER_ID, client_id=CLIENT_ID, agent_id=AGENT_ID, expected_grant_id=None
        )

    assert AGENT_ID not in error.value.message


def test_agent_repository_errors_are_sanitized(caplog):
    agent_repo = MagicMock(spec=AgentRepository)
    agent_repo.get_by_id.side_effect = RuntimeError(f"query failed for {AGENT_ID}")
    service = _service(agent_repo=agent_repo)

    with pytest.raises(PlurimException) as error:
        service.bind(
            owner_user_id=OWNER_ID, client_id=CLIENT_ID, agent_id=AGENT_ID, expected_grant_id=None
        )

    assert error.value.message == "Failed to verify MCP OAuth agent selection"
    assert AGENT_ID not in error.value.message
    assert AGENT_ID not in caplog.text


def test_resolve_revalidates_the_bound_agent_on_every_call():
    binding_repo = MagicMock(spec=MCPOAuthBindingRepository)
    binding_repo.get.return_value = {
        "owner_user_id": OWNER_ID,
        "client_id": CLIENT_ID,
        "agent_id": AGENT_ID,
        "grant_id": GRANT_ID,
        "state": "active",
    }
    agent_repo = MagicMock(spec=AgentRepository)
    agent_repo.get_by_id.side_effect = [
        _agent(),
        _agent(is_active=False),
    ]
    service = _service(binding_repo=binding_repo, agent_repo=agent_repo)

    assert (
        service.resolve_agent(owner_user_id=OWNER_ID, client_id=CLIENT_ID, grant_id=GRANT_ID)
        == _agent()
    )
    assert (
        service.resolve_agent(owner_user_id=OWNER_ID, client_id=CLIENT_ID, grant_id=GRANT_ID)
        is None
    )
    assert agent_repo.get_by_id.call_count == 2


def test_resolve_rejects_a_transferred_or_mismatched_binding():
    binding_repo = MagicMock(spec=MCPOAuthBindingRepository)
    agent_repo = MagicMock(spec=AgentRepository)
    service = _service(binding_repo=binding_repo, agent_repo=agent_repo)

    binding_repo.get.return_value = {
        "owner_user_id": OWNER_ID,
        "client_id": CLIENT_ID.swapcase(),
        "agent_id": AGENT_ID,
        "grant_id": GRANT_ID,
        "state": "active",
    }
    assert (
        service.resolve_agent(owner_user_id=OWNER_ID, client_id=CLIENT_ID, grant_id=GRANT_ID)
        is None
    )

    binding_repo.get.return_value = {
        "owner_user_id": OWNER_ID,
        "client_id": CLIENT_ID,
        "agent_id": AGENT_ID,
        "grant_id": GRANT_ID,
        "state": "active",
    }
    agent_repo.get_by_id.return_value = _agent(owner_user_id=OTHER_OWNER_ID)
    assert (
        service.resolve_agent(owner_user_id=OWNER_ID, client_id=CLIENT_ID, grant_id=GRANT_ID)
        is None
    )


@pytest.mark.parametrize(
    "client_id",
    ["", "contains\x00nul", "a" * 2049, chr(0xD800)],
)
def test_client_id_validation_is_bounded_and_sanitized(client_id):
    service = _service()

    with pytest.raises(ValidationError) as error:
        service.resolve_agent(owner_user_id=OWNER_ID, client_id=client_id, grant_id=GRANT_ID)

    assert error.value.message == "Invalid MCP OAuth binding input"
    if client_id:
        assert client_id not in error.value.message


def test_client_id_limit_is_measured_in_utf8_bytes_without_normalization():
    binding_repo = MagicMock(spec=MCPOAuthBindingRepository)
    binding_repo.get.return_value = None
    service = _service(binding_repo=binding_repo)
    exact_id = "é" * 1024

    assert (
        service.resolve_agent(owner_user_id=OWNER_ID, client_id=exact_id, grant_id=GRANT_ID) is None
    )
    binding_repo.get.assert_called_once_with(
        owner_user_id=OWNER_ID,
        client_id=exact_id,
    )


def test_binding_state_exposes_only_consent_generation_and_state():
    binding_repo = MagicMock(spec=MCPOAuthBindingRepository)
    binding_repo.get.return_value = {"grant_id": GRANT_ID, "state": "revoking", "secret": "private"}
    service = _service(binding_repo=binding_repo)
    assert service.state(owner_user_id=OWNER_ID, client_id=CLIENT_ID) == {
        "grant_id": GRANT_ID,
        "state": "revoking",
    }
    binding_repo.get.assert_called_once_with(owner_user_id=OWNER_ID, client_id=CLIENT_ID)
