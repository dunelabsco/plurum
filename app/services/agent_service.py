"""Agent service for business logic."""

from __future__ import annotations

from typing import Optional
from uuid import UUID

from app.repositories.agent_repo import AgentRepository
from app.core.security import generate_api_key, hash_api_key, get_api_key_prefix
from app.core.exceptions import DuplicateError, AuthorizationError
from app.models.agent import AgentCreate, AgentUpdate, AgentPublic, AgentRegisterResponse


class AgentService:
    """Service for agent-related business logic."""

    def __init__(self):
        self.repo = AgentRepository()

    def register(
        self,
        data: AgentCreate,
        owner_user_id: Optional[str] = None,
    ) -> AgentRegisterResponse:
        """
        Register a new agent and return API key.

        Args:
            data: Agent creation data
            owner_user_id: UUID of the Supabase user who owns this agent
        """
        # Check username uniqueness
        username = data.username.lower()
        if self.repo.is_username_taken(username):
            raise DuplicateError(f"Username '{username}' is already taken")

        # Generate API key
        api_key = generate_api_key()
        api_key_hash = hash_api_key(api_key)
        api_key_prefix = get_api_key_prefix(api_key)

        # Create agent
        agent = self.repo.create(
            name=data.name,
            username=username,
            api_key_hash=api_key_hash,
            api_key_prefix=api_key_prefix,
            owner_user_id=owner_user_id,
        )

        return AgentRegisterResponse(
            id=agent["id"],
            name=agent["name"],
            api_key=api_key,
            api_key_prefix=api_key_prefix,
        )

    def get_profile(self, agent_id: UUID) -> AgentPublic:
        """Get an agent's public profile."""
        agent = self.repo.get_by_id(agent_id)
        return AgentPublic(
            id=agent["id"],
            name=agent["name"],
            username=agent.get("username"),
            api_key_prefix=agent["api_key_prefix"],
            is_active=agent["is_active"],
            rate_limit_tier=agent["rate_limit_tier"],
            subscription_tier=agent["subscription_tier"],
            credits_balance=agent["credits_balance"],
            publisher_domain=agent.get("publisher_domain"),
            created_at=agent["created_at"],
            last_active_at=agent.get("last_active_at"),
        )

    def list_by_owner(self, owner_user_id: str) -> list[AgentPublic]:
        """List all agents owned by a user."""
        agents = self.repo.list_by_owner(owner_user_id)
        return [
            AgentPublic(
                id=agent["id"],
                name=agent["name"],
                username=agent.get("username"),
                api_key_prefix=agent["api_key_prefix"],
                is_active=agent["is_active"],
                rate_limit_tier=agent["rate_limit_tier"],
                subscription_tier=agent.get("subscription_tier", "free"),
                credits_balance=agent.get("credits_balance", 0),
                publisher_domain=agent.get("publisher_domain"),
                created_at=agent["created_at"],
                last_active_at=agent.get("last_active_at"),
            )
            for agent in agents
        ]

    def update(
        self,
        agent_id: UUID,
        data: AgentUpdate,
        owner_user_id: str,
    ) -> AgentPublic:
        """Update an agent's profile."""
        # Verify ownership
        agent = self.repo.get_by_id(agent_id)
        if agent.get("owner_user_id") != owner_user_id:
            raise AuthorizationError("You can only update your own agents")

        update_data = {}

        if data.name is not None:
            update_data["name"] = data.name

        if data.username is not None:
            username = data.username.lower()
            # Check uniqueness (excluding current agent)
            if self.repo.is_username_taken(username, exclude_agent_id=agent_id):
                raise DuplicateError(f"Username '{username}' is already taken")
            update_data["username"] = username

        if update_data:
            self.repo.update(agent_id, update_data)

        return self.get_profile(agent_id)

    def rotate_api_key(self, agent_id: UUID) -> AgentRegisterResponse:
        """Rotate an agent's API key."""
        agent = self.repo.get_by_id(agent_id)

        # Generate new API key
        api_key = generate_api_key()
        api_key_hash = hash_api_key(api_key)
        api_key_prefix = get_api_key_prefix(api_key)

        # Update agent
        self.repo.update_api_key(
            agent_id=agent_id,
            new_api_key_hash=api_key_hash,
            new_api_key_prefix=api_key_prefix,
        )

        return AgentRegisterResponse(
            id=agent["id"],
            name=agent["name"],
            api_key=api_key,
            api_key_prefix=api_key_prefix,
            message="API key rotated successfully. Old key is now invalid.",
        )

    def deactivate(self, agent_id: UUID) -> None:
        """Deactivate an agent."""
        self.repo.deactivate(agent_id)
