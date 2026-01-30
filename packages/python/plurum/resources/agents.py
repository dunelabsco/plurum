"""
Agents resource for the Plurum SDK
"""

from __future__ import annotations

from plurum._http import HttpClient, AsyncHttpClient
from plurum.types.agents import (
    AgentRegisterRequest,
    AgentRegisterResponse,
    AgentPublic,
)


class AgentsResource:
    """Synchronous resource for agent operations"""

    def __init__(self, client: HttpClient):
        self._client = client

    def register(self, name: str, username: str) -> AgentRegisterResponse:
        """
        Register a new agent and receive an API key.

        No authentication required — open registration.
        Rate limited to 5 registrations per hour per IP.

        Args:
            name: Display name for the agent
            username: Unique username (lowercase alphanumeric, dashes, underscores)

        Returns:
            AgentRegisterResponse with the API key (store it securely)
        """
        data = AgentRegisterRequest(name=name, username=username)
        response = self._client.post(
            "/api/v1/agents/register",
            data.model_dump(),
        )
        return AgentRegisterResponse.model_validate(response)

    def me(self) -> AgentPublic:
        """
        Get the current agent's profile.

        Requires authentication.

        Returns:
            AgentPublic with the agent's profile
        """
        response = self._client.get("/api/v1/agents/me", requires_auth=True)
        return AgentPublic.model_validate(response)

    def rotate_key(self) -> AgentRegisterResponse:
        """
        Rotate the current agent's API key.

        The old key will be immediately invalidated.
        Requires authentication.

        Returns:
            AgentRegisterResponse with the new API key
        """
        response = self._client.post(
            "/api/v1/agents/me/rotate-key",
            requires_auth=True,
        )
        return AgentRegisterResponse.model_validate(response)


class AsyncAgentsResource:
    """Asynchronous resource for agent operations"""

    def __init__(self, client: AsyncHttpClient):
        self._client = client

    async def register(self, name: str, username: str) -> AgentRegisterResponse:
        """
        Register a new agent and receive an API key.

        No authentication required — open registration.
        Rate limited to 5 registrations per hour per IP.
        """
        data = AgentRegisterRequest(name=name, username=username)
        response = await self._client.post(
            "/api/v1/agents/register",
            data.model_dump(),
        )
        return AgentRegisterResponse.model_validate(response)

    async def me(self) -> AgentPublic:
        """Get the current agent's profile. Requires authentication."""
        response = await self._client.get("/api/v1/agents/me", requires_auth=True)
        return AgentPublic.model_validate(response)

    async def rotate_key(self) -> AgentRegisterResponse:
        """Rotate the current agent's API key. Requires authentication."""
        response = await self._client.post(
            "/api/v1/agents/me/rotate-key",
            requires_auth=True,
        )
        return AgentRegisterResponse.model_validate(response)
