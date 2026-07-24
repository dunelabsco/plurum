"""API-key authentication boundary for the hosted MCP application."""

from __future__ import annotations

import contextvars
import logging
from dataclasses import dataclass
from typing import Any

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

    agent: dict[str, Any]
    client: str


_principal_var: contextvars.ContextVar[MCPPrincipal | None] = contextvars.ContextVar(
    "plurum_mcp_principal",
    default=None,
)


def get_mcp_principal(*, required: bool = True) -> MCPPrincipal | None:
    """Return the current MCP principal without relying on process-global state."""
    principal = _principal_var.get()
    if principal is None and required:
        raise RuntimeError("MCP tool called without an authenticated principal")
    return principal


def _normalize_client(value: str | None) -> str:
    client = (value or "").strip().lower()
    return client if client in _KNOWN_CLIENTS else "unknown"


async def _send_error(scope: Scope, receive: Receive, send: Send, status_code: int) -> None:
    message = (
        "Invalid or missing API key"
        if status_code == 401
        else "Authentication service unavailable"
    )
    headers = {"WWW-Authenticate": 'Bearer realm="plurum"'} if status_code == 401 else None
    response = JSONResponse({"error": message}, status_code=status_code, headers=headers)
    await response(scope, receive, send)


class MCPAPIKeyAuthMiddleware:
    """Authenticate every MCP HTTP request before protocol initialization."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        try:
            api_key = extract_bearer_token(headers.get("authorization"))
            agent = await anyio.to_thread.run_sync(validate_api_key, api_key)
        except AuthenticationError:
            await _send_error(scope, receive, send, 401)
            return
        except Exception as exc:  # database/network failure, never echo the key
            logger.error("MCP API-key validation failed (%s)", type(exc).__name__)
            await _send_error(scope, receive, send, 503)
            return

        principal = MCPPrincipal(
            agent=agent,
            client=_normalize_client(headers.get("x-plurum-client")),
        )
        token = _principal_var.set(principal)
        try:
            await self.app(scope, receive, send)
        finally:
            _principal_var.reset(token)
