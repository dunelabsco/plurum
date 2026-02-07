"""Agent repository for database operations."""

from __future__ import annotations

from typing import Optional
from uuid import UUID

from app.db.supabase_client import get_supabase_client
from app.core.exceptions import NotFoundError, DuplicateError


class AgentRepository:
    """Repository for agent database operations."""

    def __init__(self):
        self.client = get_supabase_client()
        self.table = "agents"

    def create(
        self,
        name: str,
        username: str,
        api_key_hash: str,
        api_key_prefix: str,
        owner_user_id: Optional[str] = None,
    ) -> dict:
        """Create a new agent."""
        data = {
            "name": name,
            "username": username.lower(),
            "api_key_hash": api_key_hash,
            "api_key_prefix": api_key_prefix,
        }

        if owner_user_id:
            data["owner_user_id"] = owner_user_id

        result = self.client.table(self.table).insert(data).execute()

        if not result.data:
            raise Exception("Failed to create agent")

        return result.data[0]

    def get_by_id(self, agent_id: UUID) -> dict:
        """Get an agent by ID."""
        result = (
            self.client.table(self.table)
            .select("*")
            .eq("id", str(agent_id))
            .execute()
        )

        if not result.data:
            raise NotFoundError("Agent", str(agent_id))

        return result.data[0]

    def get_by_api_key_hash(self, api_key_hash: str) -> dict | None:
        """Get an agent by API key hash."""
        result = (
            self.client.table(self.table)
            .select("*")
            .eq("api_key_hash", api_key_hash)
            .execute()
        )

        return result.data[0] if result.data else None

    def list_by_owner(self, owner_user_id: str) -> list[dict]:
        """List all agents owned by a user."""
        result = (
            self.client.table(self.table)
            .select("*")
            .eq("owner_user_id", owner_user_id)
            .order("created_at", desc=True)
            .execute()
        )

        return result.data or []

    def update(self, agent_id: UUID, data: dict) -> dict:
        """Update an agent."""
        result = (
            self.client.table(self.table)
            .update(data)
            .eq("id", str(agent_id))
            .execute()
        )

        if not result.data:
            raise NotFoundError("Agent", str(agent_id))

        return result.data[0]

    def update_api_key(
        self,
        agent_id: UUID,
        new_api_key_hash: str,
        new_api_key_prefix: str,
    ) -> dict:
        """Update an agent's API key."""
        return self.update(
            agent_id,
            {
                "api_key_hash": new_api_key_hash,
                "api_key_prefix": new_api_key_prefix,
            },
        )

    def deactivate(self, agent_id: UUID) -> dict:
        """Deactivate an agent."""
        return self.update(agent_id, {"is_active": False})

    def update_last_active(self, agent_id: UUID) -> None:
        """Update last_active_at timestamp."""
        self.client.table(self.table).update(
            {"last_active_at": "now()"}
        ).eq("id", str(agent_id)).execute()

    def update_last_inbox_check(self, agent_id: UUID) -> None:
        """Update last_inbox_check timestamp."""
        self.client.table(self.table).update(
            {"last_inbox_check": "now()"}
        ).eq("id", str(agent_id)).execute()

    def get_by_username(self, username: str) -> dict | None:
        """Get an agent by username."""
        result = (
            self.client.table(self.table)
            .select("*")
            .eq("username", username.lower())
            .execute()
        )
        return result.data[0] if result.data else None

    def count_total(self) -> int:
        """Count total registered agents."""
        result = (
            self.client.table(self.table)
            .select("id", count="exact")
            .execute()
        )
        return result.count or 0

    def is_username_taken(self, username: str, exclude_agent_id: UUID | None = None) -> bool:
        """Check if a username is already taken."""
        query = (
            self.client.table(self.table)
            .select("id")
            .eq("username", username.lower())
        )
        if exclude_agent_id:
            query = query.neq("id", str(exclude_agent_id))
        result = query.execute()
        return len(result.data) > 0
