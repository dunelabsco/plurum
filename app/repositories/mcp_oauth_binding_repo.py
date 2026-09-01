"""Persistence for hosted MCP OAuth client-to-agent bindings."""

from __future__ import annotations

import logging
from typing import Any

from app.core.exceptions import DuplicateError, PlurimException
from app.db.supabase_client import get_supabase_client


logger = logging.getLogger(__name__)


class MCPOAuthBindingRepository:
    """Store an exact OAuth user/client selection without normalizing it."""

    table = "mcp_oauth_agent_bindings"

    def __init__(self, client: Any | None = None):
        self.client = client if client is not None else get_supabase_client()

    def upsert(
        self,
        *,
        owner_user_id: str,
        client_id: str,
        agent_id: str,
    ) -> dict:
        """Create or replace the selected agent for one exact client ID."""
        try:
            result = (
                self.client.table(self.table)
                .upsert(
                    {
                        "owner_user_id": owner_user_id,
                        "client_id": client_id,
                        "agent_id": agent_id,
                    },
                    on_conflict="owner_user_id,client_id",
                )
                .execute()
            )
        except Exception as error:
            logger.error(
                "MCP OAuth binding upsert failed (%s)",
                type(error).__name__,
            )
            raise PlurimException("Failed to save MCP OAuth agent selection") from None

        if not result.data:
            raise PlurimException("Failed to save MCP OAuth agent selection")
        return result.data[0]

    def create_agent_and_bind(
        self,
        *,
        owner_user_id: str,
        client_id: str,
        name: str,
        username: str,
    ) -> dict:
        """Create an OAuth-only agent and binding in one database transaction."""
        try:
            result = self.client.rpc(
                "create_mcp_oauth_agent_and_binding",
                {
                    "p_owner_user_id": owner_user_id,
                    "p_client_id": client_id,
                    "p_name": name,
                    "p_username": username,
                },
            ).execute()
        except Exception as error:
            if getattr(error, "code", None) == "23505":
                raise DuplicateError("Username is already taken") from None
            logger.error(
                "MCP OAuth atomic onboarding failed (%s)",
                type(error).__name__,
            )
            raise PlurimException("Failed to create MCP OAuth agent") from None

        if not result.data:
            raise PlurimException("Failed to create MCP OAuth agent")
        return result.data[0]

    def get(self, *, owner_user_id: str, client_id: str) -> dict | None:
        """Fetch a binding by its exact, case-sensitive composite key."""
        try:
            result = (
                self.client.table(self.table)
                .select("owner_user_id,client_id,agent_id,created_at,updated_at")
                .eq("owner_user_id", owner_user_id)
                .eq("client_id", client_id)
                .limit(1)
                .execute()
            )
        except Exception as error:
            logger.error(
                "MCP OAuth binding lookup failed (%s)",
                type(error).__name__,
            )
            raise PlurimException("Failed to read MCP OAuth agent selection") from None

        return result.data[0] if result.data else None

    def delete(self, *, owner_user_id: str, client_id: str) -> bool:
        """Delete one exact user/client binding, returning whether it existed."""
        try:
            result = (
                self.client.table(self.table)
                .delete()
                .eq("owner_user_id", owner_user_id)
                .eq("client_id", client_id)
                .execute()
            )
        except Exception as error:
            logger.error(
                "MCP OAuth binding deletion failed (%s)",
                type(error).__name__,
            )
            raise PlurimException("Failed to disconnect MCP OAuth client") from None

        return bool(result.data)
