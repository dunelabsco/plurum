"""API-key authentication boundary for the hosted MCP application."""

from __future__ import annotations

import contextvars
import logging
from dataclasses import dataclass

import anyio
from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app.core.exceptions import AuthenticationError
from app.core.security import extract_bearer_token, validate_api_key

logger = logging.getLogger(__name__)

_KNOWN_CLIENTS = {"claude-code", "codex"}


@dataclass(frozen=True)
class MCPPrincipal:
    """Request-local Plurum identity and non-authoritative client channel."""

    agent_id: str
    client: str


_principal_var: contextvars.ContextVar[MCPPrincipal | None] = contextvars.ContextVar(
    "plurum_mcp_principal",
    default=None,
)


def get_mcp_principal(*, required: bool = True) -> MCPPrincipal | None:
    """Return the authenticated principal for the current MCP request."""
    principal = _principal_var.get()
    if principal is None and required:
        raise RuntimeError("MCP tool called without an authenticated principal")
    return principal


def _normalize_client(value: str | None) -> str:
    client = (value or "").strip().lower()
    return client if client in _KNOWN_CLIENTS else "unknown"


async def _send_error(scope: Scope, receive: Receive, send: Send, status_code: int) -> None:
    if status_code == 401:
        message = "Invalid or missing API key"
        headers = {
            "WWW-Authenticate": 'Bearer realm="plurum"',
            "Cache-Control": "no-store",
        }
    else:
        message = "Authentication service unavailable"
        headers = {"Cache-Control": "no-store"}

    response = JSONResponse({"error": message}, status_code=status_code, headers=headers)
    await response(scope, receive, send)


class MCPAPIKeyAuthMiddleware:
    """Authenticate every MCP HTTP request before protocol handling."""

    # SlowAPI identifies route handlers by module and name.
    __name__ = "plurum_mcp"

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        try:
            api_key = extract_bearer_token(headers.get("authorization"))
            agent = await anyio.to_thread.run_sync(validate_api_key, api_key)
            agent_id = str(agent["id"])
        except AuthenticationError:
            await _send_error(scope, receive, send, 401)
            return
        except Exception as exc:
            logger.error("MCP API-key validation failed (%s)", type(exc).__name__)
            await _send_error(scope, receive, send, 503)
            return

        principal = MCPPrincipal(
            agent_id=agent_id,
            client=_normalize_client(headers.get("x-plurum-client")),
        )
        token = _principal_var.set(principal)
        try:
            await self.app(scope, receive, send)
        finally:
            _principal_var.reset(token)
