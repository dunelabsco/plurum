"""Business rules for hosted MCP OAuth agent selection."""

from __future__ import annotations

import logging
from uuid import UUID
import re

from app.core.content_security import reject_api_keys
from app.core.exceptions import (
    AuthorizationError,
    NotFoundError,
    PlurimException,
    ValidationError,
)
from app.repositories.agent_repo import AgentRepository
from app.repositories.mcp_oauth_binding_repo import MCPOAuthBindingRepository


MCP_OAUTH_CLIENT_ID_MAX_BYTES = 2048
_INVALID_BINDING_INPUT = "Invalid MCP OAuth binding input"
_UNAVAILABLE_AGENT = "The selected agent cannot be used for MCP OAuth"
logger = logging.getLogger(__name__)


class MCPOAuthBindingService:
    """Bind an OAuth client to an owned agent and resolve it fail-closed."""

    def __init__(
        self,
        binding_repo: MCPOAuthBindingRepository | None = None,
        agent_repo: AgentRepository | None = None,
    ):
        self.binding_repo = (
            binding_repo if binding_repo is not None else MCPOAuthBindingRepository()
        )
        self.agent_repo = agent_repo if agent_repo is not None else AgentRepository()

    def bind(
        self,
        *,
        owner_user_id: str,
        client_id: str,
        agent_id: UUID | str,
        expected_grant_id: UUID | str | None,
    ) -> dict:
        """Select an active agent owned by the authenticated user."""
        owner_id = _validate_uuid(owner_user_id)
        selected_agent_id = _validate_uuid(agent_id)
        exact_client_id = _validate_client_id(client_id)

        agent = self._get_agent_or_none(selected_agent_id)
        if not _agent_is_available_to_owner(agent, owner_id):
            raise AuthorizationError(_UNAVAILABLE_AGENT)

        return self.binding_repo.upsert(
            owner_user_id=owner_id,
            client_id=exact_client_id,
            agent_id=selected_agent_id,
            expected_grant_id=_optional_uuid(expected_grant_id),
        )

    def create_agent_and_bind(
        self,
        *,
        owner_user_id: str,
        client_id: str,
        name: str,
        username: str,
        expected_grant_id: UUID | str | None,
    ) -> dict:
        """Atomically create an OAuth-only owned agent and select it."""
        return self.binding_repo.create_agent_and_bind(
            owner_user_id=_validate_uuid(owner_user_id),
            client_id=_validate_client_id(client_id),
            name=name,
            username=username.lower(),
            expected_grant_id=_optional_uuid(expected_grant_id),
        )

    def resolve_agent(
        self,
        *,
        owner_user_id: str,
        client_id: str,
        grant_id: str,
    ) -> dict | None:
        """Resolve and revalidate ownership and active state on every call."""
        owner_id = _validate_uuid(owner_user_id)
        exact_client_id = _validate_client_id(client_id)
        token_grant_id = _validate_uuid(grant_id)
        binding = self.binding_repo.get(
            owner_user_id=owner_id,
            client_id=exact_client_id,
        )
        if binding is None:
            return None

        # Treat malformed or mismatched stored data as unauthenticated. The
        # client identifier remains an opaque, exact, case-sensitive value.
        if (
            str(binding.get("owner_user_id")) != owner_id
            or binding.get("client_id") != exact_client_id
            or binding.get("state") != "active"
            or binding.get("grant_id") != token_grant_id
        ):
            return None

        try:
            bound_agent_id = _validate_uuid(binding.get("agent_id"))
        except ValidationError:
            return None

        agent = self._get_agent_or_none(bound_agent_id)
        if not _agent_is_available_to_owner(agent, owner_id):
            return None
        return agent

    def state(self, *, owner_user_id: str, client_id: str) -> dict:
        """Return the consent version without exposing any agent credentials."""
        binding = self.binding_repo.get(
            owner_user_id=_validate_uuid(owner_user_id),
            client_id=_validate_client_id(client_id),
        )
        return {
            "grant_id": binding["grant_id"] if binding else None,
            "state": binding["state"] if binding else None,
        }

    def _get_agent_or_none(self, agent_id: str) -> dict | None:
        try:
            return self.agent_repo.get_by_id(UUID(agent_id))
        except NotFoundError:
            return None
        except Exception as error:
            logger.error(
                "MCP OAuth agent verification failed (%s)",
                type(error).__name__,
            )
            raise PlurimException("Failed to verify MCP OAuth agent selection") from None


def _validate_uuid(value: UUID | str | object) -> str:
    """Return a canonical UUID without including rejected input in errors."""
    if isinstance(value, bool):
        raise ValidationError(_INVALID_BINDING_INPUT)
    try:
        return str(UUID(str(value)))
    except (AttributeError, TypeError, ValueError):
        raise ValidationError(_INVALID_BINDING_INPUT) from None


def _validate_client_id(value: object) -> str:
    """Validate byte length while preserving the opaque identifier exactly."""
    if (
        not isinstance(value, str)
        or not value
        or any(ord(c) < 0x20 or ord(c) == 0x7F for c in value)
    ):
        raise ValidationError(_INVALID_BINDING_INPUT)
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError:
        raise ValidationError(_INVALID_BINDING_INPUT) from None
    if len(encoded) > MCP_OAUTH_CLIENT_ID_MAX_BYTES:
        raise ValidationError(_INVALID_BINDING_INPUT)
    try:
        reject_api_keys(value)
    except ValidationError:
        raise ValidationError(_INVALID_BINDING_INPUT) from None
    if re.search(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", value):
        raise ValidationError(_INVALID_BINDING_INPUT)
    return value


def _optional_uuid(value: UUID | str | None) -> str | None:
    return _validate_uuid(value) if value is not None else None


def _agent_is_available_to_owner(agent: dict | None, owner_user_id: str) -> bool:
    if agent is None or agent.get("is_active") is not True:
        return False
    try:
        return str(UUID(str(agent.get("owner_user_id")))) == owner_user_id
    except (AttributeError, TypeError, ValueError):
        return False
