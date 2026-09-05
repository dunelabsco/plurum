"""Persistence for hosted MCP OAuth client-to-agent bindings."""

from __future__ import annotations

import logging
from typing import Any

from app.core.exceptions import AuthorizationError, DuplicateError, PlurimException
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
        expected_grant_id: str | None,
    ) -> dict:
        """Bind atomically without overwriting a disconnect or another consent."""
        return self._bound_agent(
            self._rpc(
                "bind_mcp_oauth_agent",
                {
                    "p_owner_user_id": owner_user_id,
                    "p_client_id": client_id,
                    "p_agent_id": agent_id,
                    "p_expected_grant_id": expected_grant_id,
                },
            )
        )

    def create_agent_and_bind(
        self,
        *,
        owner_user_id: str,
        client_id: str,
        name: str,
        username: str,
        expected_grant_id: str | None,
    ) -> dict:
        """Create an OAuth-only agent and binding in one database transaction."""
        return self._bound_agent(
            self._rpc(
                "create_mcp_oauth_agent_and_binding",
                {
                    "p_owner_user_id": owner_user_id,
                    "p_client_id": client_id,
                    "p_name": name,
                    "p_username": username,
                    "p_expected_grant_id": expected_grant_id,
                },
            )
        )

    def get(self, *, owner_user_id: str, client_id: str) -> dict | None:
        """Fetch a binding by its exact, case-sensitive composite key."""
        try:
            result = (
                self.client.table(self.table)
                .select("owner_user_id,client_id,agent_id,grant_id,state,created_at,updated_at")
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

    def list_by_owner(self, owner_user_id: str) -> list[dict]:
        """Read only this user's connections, including unfinished revocations."""
        try:
            rows = []
            while True:
                page = (
                    self.client.table(self.table)
                    .select("owner_user_id,client_id,agent_id,grant_id,state")
                    .eq("owner_user_id", owner_user_id)
                    .order("client_id")
                    .range(len(rows), len(rows) + 199)
                    .execute()
                ).data
                rows.extend(page)
                if len(page) < 200:
                    return rows
        except Exception as error:
            logger.error("MCP OAuth connection listing failed (%s)", type(error).__name__)
            raise PlurimException("Failed to read MCP OAuth connections") from None

    def begin_revocation(
        self, *, owner_user_id: str, client_id: str, expected_grant_id: str | None
    ) -> dict:
        return self._rpc(
            "begin_mcp_oauth_revocation",
            {
                "p_owner_user_id": owner_user_id,
                "p_client_id": client_id,
                "p_expected_grant_id": expected_grant_id,
            },
        )

    def finish_revocation(
        self, *, owner_user_id: str, client_id: str, attempt_id: str, succeeded: bool
    ) -> bool:
        return (
            self._rpc(
                "finish_mcp_oauth_revocation",
                {
                    "p_owner_user_id": owner_user_id,
                    "p_client_id": client_id,
                    "p_attempt_id": attempt_id,
                    "p_succeeded": succeeded,
                },
            )
            is True
        )

    def _rpc(self, name: str, parameters: dict) -> Any:
        try:
            return self.client.rpc(name, parameters).execute().data
        except Exception as error:
            if getattr(error, "code", None) == "40001":
                raise PlurimException(
                    "Connection changed; reload and try again", status_code=409
                ) from None
            if getattr(error, "code", None) == "42501":
                raise AuthorizationError("The selected OAuth agent is unavailable") from None
            if getattr(error, "code", None) == "23505":
                raise DuplicateError("Username is already taken") from None
            logger.error("MCP OAuth operation failed (%s)", type(error).__name__)
            raise PlurimException("MCP OAuth connection operation failed") from None

    @staticmethod
    def _bound_agent(result: Any) -> dict:
        if (
            not isinstance(result, dict)
            or not isinstance(result.get("agent"), dict)
            or not result.get("grant_id")
        ):
            raise PlurimException("Failed to save MCP OAuth agent selection")
        return {**result["agent"], "grant_id": result["grant_id"]}
