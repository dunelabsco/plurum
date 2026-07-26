"""API-key authentication boundary for the hosted MCP application."""

from __future__ import annotations

import contextvars
import json
import logging
from dataclasses import dataclass
from typing import Any

import anyio
from mcp.types import INVALID_PARAMS
from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.content_security import reject_api_keys
from app.core.exceptions import AuthenticationError
from app.core.exceptions import ValidationError as PlurumValidationError
from app.core.security import extract_bearer_token, validate_api_key

logger = logging.getLogger(__name__)

_KNOWN_CLIENTS = {"claude-code", "codex"}
_MAX_CLIENT_HEADER_CHARS = 64
_MAX_AUTHORIZATION_HEADER_CHARS = 512


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
    if value is None or len(value) > _MAX_CLIENT_HEADER_CHARS:
        return "unknown"
    client = (value or "").strip().lower()
    return client if client in _KNOWN_CLIENTS else "unknown"


def _safe_request_id(payload: Any) -> str | int | None:
    if not isinstance(payload, dict):
        return None
    request_id = payload.get("id")
    if isinstance(request_id, bool) or not isinstance(request_id, (str, int)):
        return None
    try:
        reject_api_keys(request_id, path="mcp_request.id")
    except PlurumValidationError:
        return None
    return request_id


def _parse_and_scan_body(body: bytes) -> tuple[Any, bool]:
    """Return parsed JSON when possible and whether it contains a credential."""
    text = body.decode("utf-8", errors="replace")
    try:
        reject_api_keys(text, path="mcp_request")
        raw_contains_credential = False
    except PlurumValidationError:
        raw_contains_credential = True

    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None, raw_contains_credential

    # Reserializing catches escaped credentials and credentials used as mapping
    # keys without reflecting the request in an error or log.
    try:
        reject_api_keys(
            json.dumps(payload, ensure_ascii=False),
            path="mcp_request",
        )
    except PlurumValidationError:
        return payload, True
    return payload, raw_contains_credential


async def _send_invalid_params(
    scope: Scope,
    receive: Receive,
    send: Send,
    request_id: str | int | None,
) -> None:
    response = JSONResponse(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {
                "code": INVALID_PARAMS,
                "message": "Invalid request parameters",
            },
        },
        status_code=200,
        headers={"Cache-Control": "no-store"},
    )
    await response(scope, receive, send)


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


class MCPRequestCredentialGuard:
    """Stop secret-bearing MCP bodies before SDK parsing or validation logs."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] != "POST":
            await self.app(scope, receive, send)
            return

        messages: list[Message] = []
        body_parts: list[bytes] = []
        body_complete = False
        while True:
            message = await receive()
            messages.append(message)
            if message["type"] == "http.request":
                body_parts.append(message.get("body", b""))
                if not message.get("more_body", False):
                    body_complete = True
                    break
            elif message["type"] == "http.disconnect":
                break

        if not body_complete:
            return

        payload, contains_credential = _parse_and_scan_body(b"".join(body_parts))
        if contains_credential:
            await _send_invalid_params(
                scope,
                receive,
                send,
                _safe_request_id(payload),
            )
            return

        message_index = 0

        async def replay_receive() -> Message:
            nonlocal message_index
            if message_index < len(messages):
                message = messages[message_index]
                message_index += 1
                return message
            return await receive()

        await self.app(scope, replay_receive, send)


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
        authorization = headers.get("authorization")
        if (
            authorization is not None
            and len(authorization) > _MAX_AUTHORIZATION_HEADER_CHARS
        ):
            await _send_error(scope, receive, send, 401)
            return
        try:
            api_key = extract_bearer_token(authorization)
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
