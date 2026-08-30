"""Focused coverage for agents that initially authenticate through OAuth."""

from unittest.mock import MagicMock
from uuid import UUID

import pytest

from app.core.exceptions import DuplicateError, PlurimException
from app.models.agent import Agent, AgentCreate, AgentPublic
from app.repositories.agent_repo import AgentRepository
from app.services.agent_service import AgentService


AGENT_ID = UUID("00000000-0000-0000-0000-000000000001")
OWNER_ID = "00000000-0000-0000-0000-000000000099"


def oauth_agent_row(**overrides) -> dict:
    row = {
        "id": str(AGENT_ID),
        "name": "Codex",
        "username": "codex-agent",
        "api_key_hash": None,
        "api_key_prefix": None,
        "owner_user_id": OWNER_ID,
        "is_active": True,
        "rate_limit_tier": "standard",
        "subscription_tier": "free",
        "credits_balance": 0,
        "publisher_domain": None,
        "created_at": "2026-08-30T00:00:00Z",
        "updated_at": "2026-08-30T00:00:00Z",
        "last_active_at": None,
    }
    row.update(overrides)
    return row


def service_with_repo() -> tuple[AgentService, MagicMock]:
    service = AgentService.__new__(AgentService)
    repo = MagicMock(spec=AgentRepository)
    service.repo = repo
    return service, repo


def test_create_owned_oauth_agent_does_not_mint_or_store_an_api_key():
    service, repo = service_with_repo()
    repo.is_username_taken.return_value = False
    repo.create.return_value = oauth_agent_row()

    agent = service.create_owned_oauth_agent(
        AgentCreate(name="Codex", username="codex-agent"),
        OWNER_ID,
    )

    repo.create.assert_called_once_with(
        name="Codex",
        username="codex-agent",
        api_key_hash=None,
        api_key_prefix=None,
        owner_user_id=OWNER_ID,
    )
    assert agent.api_key_prefix is None


def test_create_owned_oauth_agent_preserves_username_uniqueness():
    service, repo = service_with_repo()
    repo.is_username_taken.return_value = True

    with pytest.raises(DuplicateError, match="already taken"):
        service.create_owned_oauth_agent(
            AgentCreate(name="Codex", username="codex-agent"),
            OWNER_ID,
        )

    repo.create.assert_not_called()


def test_agent_repository_can_insert_an_oauth_only_agent():
    repository = AgentRepository.__new__(AgentRepository)
    repository.table = "agents"
    repository.client = MagicMock()
    repository.client.table.return_value.insert.return_value.execute.return_value = MagicMock(
        data=[oauth_agent_row()]
    )

    created = repository.create(
        name="Codex",
        username="codex-agent",
        api_key_hash=None,
        api_key_prefix=None,
        owner_user_id=OWNER_ID,
    )

    repository.client.table.return_value.insert.assert_called_once_with(
        {
            "name": "Codex",
            "username": "codex-agent",
            "api_key_hash": None,
            "api_key_prefix": None,
            "owner_user_id": OWNER_ID,
        }
    )
    assert created["api_key_hash"] is None
    assert created["api_key_prefix"] is None


def test_profile_and_owner_list_serialize_missing_api_key_fields_as_null():
    service, repo = service_with_repo()
    row = oauth_agent_row()
    row.pop("api_key_hash")
    row.pop("api_key_prefix")
    repo.get_by_id.return_value = row
    repo.list_by_owner.return_value = [row]

    assert service.get_profile(AGENT_ID).api_key_prefix is None
    assert service.list_by_owner(OWNER_ID)[0].api_key_prefix is None


def test_nullable_api_key_fields_remain_required_in_api_schemas():
    public_schema = AgentPublic.model_json_schema()
    internal_schema = Agent.model_json_schema()

    assert "api_key_prefix" in public_schema["required"]
    assert "api_key_hash" in internal_schema["required"]
    assert "api_key_prefix" in internal_schema["required"]


def test_oauth_only_agent_must_create_a_key_before_release():
    service, repo = service_with_repo()
    repo.get_by_id.return_value = oauth_agent_row()

    with pytest.raises(PlurimException) as exc_info:
        service.release_agent(AGENT_ID, OWNER_ID)

    assert exc_info.value.status_code == 409
    assert exc_info.value.message == "Create an API key before releasing this agent"
    repo.release_agent.assert_not_called()


def test_rotating_an_oauth_only_agent_creates_its_first_api_key():
    service, repo = service_with_repo()
    repo.get_by_id.return_value = oauth_agent_row()

    result = service.rotate_api_key_as_owner(AGENT_ID, OWNER_ID)

    new_hash, new_prefix = repo.update_api_key.call_args.args[1:]
    assert new_hash
    assert new_prefix.startswith("plrm_live_")
    assert result["api_key"].startswith("plrm_live_")
    assert result["api_key_prefix"] == new_prefix
    assert result["message"].startswith("API key created successfully.")


def test_rotating_an_existing_key_keeps_rotation_wording():
    service, repo = service_with_repo()
    repo.get_by_id.return_value = oauth_agent_row(
        api_key_hash="existing-hash",
        api_key_prefix="plrm_live_existing...",
    )

    result = service.rotate_api_key_as_owner(AGENT_ID, OWNER_ID)

    assert result["message"].startswith("API key rotated successfully.")
