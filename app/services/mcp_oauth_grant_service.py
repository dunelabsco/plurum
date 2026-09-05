"""User-scoped Supabase grants and recoverable MCP disconnects."""

from __future__ import annotations

from contextlib import nullcontext
import json
import logging
import re

import httpx

from app.config import Settings, get_settings
from app.core.content_security import reject_api_keys
from app.core.exceptions import AuthenticationError, PlurimException, ValidationError
from app.models.mcp_oauth import MCPOAuthConnection, MCPOAuthDisconnectResult
from app.repositories.agent_repo import AgentRepository
from app.repositories.mcp_oauth_binding_repo import MCPOAuthBindingRepository
from app.services.mcp_oauth_binding_service import (
    _optional_uuid,
    _validate_client_id,
    _validate_uuid,
)

logger = logging.getLogger(__name__)
_PROVIDER_FAILURE = "OAuth provider is temporarily unavailable"


class SupabaseOAuthGrants:
    """Use the user-grant wire contract exposed by supabase-js 2.94.1."""

    def __init__(self, *, settings: Settings | None = None, client: httpx.Client | None = None):
        self.settings = settings or get_settings()
        self.client = client

    def list_grants(self, user_token: str) -> dict[str, str | None]:
        payload = self._request("GET", user_token)
        if not isinstance(payload, list):
            raise PlurimException(_PROVIDER_FAILURE, status_code=503)
        grants = {}
        try:
            for item in payload:
                client = item["client"]
                client_id = _validate_client_id(client["id"])
                if client_id in grants or (user_token and user_token in client_id):
                    raise ValueError("Duplicate grant")
                name = client.get("name")
                if not isinstance(name, str) or not name or len(name.encode("utf-8")) > 512:
                    name = None
                if name:
                    try:
                        reject_api_keys(name)
                    except ValidationError:
                        name = None
                    if name and (
                        any(ord(c) < 0x20 or ord(c) == 0x7F for c in name)
                        or (user_token and user_token in name)
                        or re.search(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", name)
                    ):
                        name = None
                grants[client_id] = name
        except Exception:
            raise PlurimException(_PROVIDER_FAILURE, status_code=503) from None
        return grants

    def revoke_grant(self, user_token: str, client_id: str) -> None:
        self._request("DELETE", user_token, client_id=client_id)

    def _request(self, method: str, user_token: str, *, client_id: str | None = None):
        # The installed Python SDK has no user-grant API. Match the official
        # OpenAPI and JS SDK; never set a session on the shared service client.
        url = f"{self.settings.supabase_url.rstrip('/')}/auth/v1/user/oauth/grants"
        headers = {"Authorization": f"Bearer {user_token}", "apikey": self.settings.supabase_key}
        context = nullcontext(self.client) if self.client is not None else httpx.Client()
        try:
            with context as client:
                with client.stream(
                    method,
                    url,
                    headers=headers,
                    params={"client_id": client_id} if client_id is not None else None,
                    timeout=5,
                    follow_redirects=False,
                ) as response:
                    if response.status_code == 401:
                        raise AuthenticationError("Sign in again to manage connections")
                    if method == "DELETE" and response.status_code == 204:
                        return None
                    if method != "GET" or response.status_code != 200:
                        raise PlurimException(_PROVIDER_FAILURE, status_code=503)
                    body = bytearray()
                    for chunk in response.iter_bytes():
                        body.extend(chunk)
                        if len(body) > 1024 * 1024:
                            raise PlurimException(_PROVIDER_FAILURE, status_code=503)
                    return json.loads(body)
        except PlurimException:
            raise
        except Exception as error:
            logger.warning("MCP OAuth provider request failed (%s)", type(error).__name__)
            raise PlurimException(_PROVIDER_FAILURE, status_code=503) from None


class MCPOAuthGrantService:
    def __init__(self, *, bindings=None, agents=None, provider=None):
        self.bindings = bindings if bindings is not None else MCPOAuthBindingRepository()
        self.agents = agents if agents is not None else AgentRepository()
        self.provider = provider if provider is not None else SupabaseOAuthGrants()

    def list_connections(self, *, owner_user_id: str, user_token: str) -> list[MCPOAuthConnection]:
        owner = _validate_uuid(owner_user_id)
        bindings = self.bindings.list_by_owner(owner)
        grants = self.provider.list_grants(user_token)
        agents = {
            str(a["id"]): a
            for a in self.agents.list_by_owner(owner)
            if str(a.get("owner_user_id")) == owner
        }
        by_client = {b["client_id"]: b for b in bindings if str(b.get("owner_user_id")) == owner}
        connections = []
        for client_id in sorted(set(grants) | set(by_client)):
            binding = by_client.get(client_id)
            if binding and binding["state"] == "revoked" and client_id not in grants:
                continue
            agent = agents.get(str(binding["agent_id"])) if binding else None
            if binding and binding["state"] in ("revoking", "revoked"):
                state = "revocation_pending"
            elif client_id in grants and agent and agent.get("is_active") is True:
                state = "connected"
            else:
                state = "unbound"
            connections.append(
                MCPOAuthConnection(
                    client_id=client_id,
                    client_name=grants.get(client_id),
                    grant_id=binding["grant_id"] if binding else None,
                    state=state,
                    agent_id=agent["id"] if agent else None,
                    agent_name=agent.get("name") if agent else None,
                    agent_username=agent.get("username") if agent else None,
                    agent_active=bool(agent and agent.get("is_active") is True),
                )
            )
        return connections

    def disconnect(
        self, *, owner_user_id: str, client_id: str, expected_grant_id: str | None, user_token: str
    ) -> MCPOAuthDisconnectResult:
        owner = _validate_uuid(owner_user_id)
        client = _validate_client_id(client_id)
        if user_token and user_token in client:
            raise ValidationError("Invalid OAuth connection request")
        expected = _optional_uuid(expected_grant_id)
        binding = self.bindings.get(owner_user_id=owner, client_id=client)
        if (
            binding is None
            and expected is None
            and client not in self.provider.list_grants(user_token)
        ):
            return MCPOAuthDisconnectResult(state="disconnected")

        # Commit the denial before making any provider mutation. A later
        # database failure can then leave only a blocked, retryable connection.
        attempt = self.bindings.begin_revocation(
            owner_user_id=owner,
            client_id=client,
            expected_grant_id=expected,
        )
        pending = MCPOAuthDisconnectResult(state="revocation_pending")
        if not isinstance(attempt, dict) or not isinstance(attempt.get("claimed"), bool):
            raise PlurimException("Disconnect could not be confirmed", status_code=503)
        if attempt["claimed"] is False:
            return pending
        attempt_id = _validate_uuid(attempt.get("attempt_id"))
        succeeded = False
        try:
            # Supabase DELETE returns 404 for an already-revoked grant. A
            # successful listing is the evidence for that idempotent case;
            # never interpret a generic 404/timeout as successful revocation.
            if client in self.provider.list_grants(user_token):
                self.provider.revoke_grant(user_token, client)
            succeeded = client not in self.provider.list_grants(user_token)
        except Exception as error:
            logger.warning("MCP OAuth revocation pending (%s)", type(error).__name__)
        try:
            finished = self.bindings.finish_revocation(
                owner_user_id=owner,
                client_id=client,
                attempt_id=attempt_id,
                succeeded=succeeded,
            )
        except Exception as error:
            logger.warning("MCP OAuth revocation completion pending (%s)", type(error).__name__)
            return pending
        if succeeded and finished:
            return MCPOAuthDisconnectResult(state="disconnected")
        return pending
