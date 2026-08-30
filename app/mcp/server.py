"""FastMCP server construction."""

from __future__ import annotations

import logging
from urllib.parse import urlsplit

from mcp.server.auth.routes import (
    build_resource_metadata_url,
    create_protected_resource_routes,
)
from mcp.server.auth.settings import AuthSettings
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import AnyHttpUrl
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.config import Settings
from app.mcp.auth import (
    MCPAPIKeyAuthMiddleware,
    MCPClientContextMiddleware,
    MCPRequestCredentialGuard,
)
from app.mcp.token_verifier import PlurumMCPTokenVerifier
from app.mcp.tools import register_read_tools, register_write_tools

MCP_INSTRUCTIONS = (
    "Access Plurum through host-provided tools. Never install/run Plurum locally, "
    "build a client, or use shell/files/web to call it. If unavailable, continue. "
    "Use when agent experience may help reusable work. Skip trivial, personal, private, confidential, "
    "local, or user-specific tasks. Search generically; inspect/verify results. "
    "Report outcomes after applying work. Publish only verified reusable non-private "
    "findings with host write-approval. Never send credentials, secrets, "
    "private source, or protected data."
)


class MCPResponseBodyLimitMiddleware:
    """Bound buffered MCP JSON responses without altering SSE streaming."""

    # SlowAPI identifies route handlers by module and name.
    __name__ = "plurum_mcp"

    def __init__(self, app: ASGIApp, max_body_bytes: int) -> None:
        if max_body_bytes < 1:
            raise ValueError("max_body_bytes must be positive")
        self.app = app
        self.max_body_bytes = max_body_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        response_start: Message | None = None
        body_messages: list[Message] = []
        body_bytes = 0
        overflowed = False
        streaming_sse = False

        async def capture_send(message: Message) -> None:
            nonlocal body_bytes, overflowed, response_start, streaming_sse

            if message["type"] == "http.response.start":
                response_start = message
                headers = message.get("headers", [])
                content_type = next(
                    (
                        value.decode("latin-1").lower()
                        for name, value in headers
                        if name.lower() == b"content-type"
                    ),
                    "",
                )
                streaming_sse = content_type.startswith("text/event-stream")
                if streaming_sse:
                    await send(message)
                return

            if message["type"] != "http.response.body":
                await send(message)
                return

            if streaming_sse:
                await send(message)
                return

            if overflowed:
                return

            chunk = message.get("body", b"")
            if body_bytes + len(chunk) > self.max_body_bytes:
                overflowed = True
                body_messages.clear()
                return

            body_bytes += len(chunk)
            body_messages.append(message)

        await self.app(scope, receive, capture_send)

        if streaming_sse:
            return
        if overflowed:
            response = JSONResponse(
                {"error": "MCP response too large"},
                status_code=500,
                headers={"Cache-Control": "no-store"},
            )
            await response(scope, receive, send)
            return
        if response_start is not None:
            await send(response_start)
        for message in body_messages:
            await send(message)


class MCPAuthenticationCacheControlMiddleware:
    """Prevent clients and intermediaries from caching authorization errors."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        async def add_cache_control(message: Message) -> None:
            if (
                message["type"] == "http.response.start"
                and message["status"] in {401, 403}
            ):
                headers = list(message.get("headers", []))
                if not any(name.lower() == b"cache-control" for name, _ in headers):
                    headers.append((b"cache-control", b"no-store"))
                    message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, add_cache_control)


class MCPPublicMetadataApplication:
    """Expose public OAuth metadata as an ASGI endpoint compatible with SlowAPI."""

    # SlowAPI identifies route handlers by module and name.
    __name__ = "plurum_mcp_oauth_metadata"

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        await self.app(scope, receive, send)


def get_mcp_oauth_metadata_path(settings: Settings) -> str | None:
    """Return the SDK's RFC 9728 path when MCP OAuth is enabled."""
    if not settings.mcp_oauth_enabled:
        return None
    metadata_url = build_resource_metadata_url(
        AnyHttpUrl(settings.mcp_oauth_resource_url)
    )
    return urlsplit(str(metadata_url)).path


def create_mcp_oauth_metadata_application(settings: Settings) -> ASGIApp | None:
    """Create the SDK-derived public RFC 9728 metadata application."""
    if not settings.mcp_oauth_enabled:
        return None
    return MCPPublicMetadataApplication(
        Starlette(
            debug=settings.debug,
            routes=create_protected_resource_routes(
                resource_url=AnyHttpUrl(settings.mcp_oauth_resource_url),
                authorization_servers=[
                    AnyHttpUrl(settings.effective_mcp_oauth_issuer_url)
                ],
                # Plurum currently has no OAuth permission scopes. None preserves
                # the SDK's zero-valued field omission in protected metadata.
                scopes_supported=None,
            ),
        ),
    )


def create_mcp_application(settings: Settings) -> tuple[FastMCP, ASGIApp]:
    """Create one MCP server and authenticated ASGI app."""
    # FastMCP configures the process root logger. Keep HTTP client request URLs
    # out of host logs because PostgREST filters can contain credential hashes.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    auth_settings = None
    token_verifier = None
    if settings.mcp_oauth_enabled:
        auth_settings = AuthSettings(
            issuer_url=AnyHttpUrl(settings.effective_mcp_oauth_issuer_url),
            resource_server_url=AnyHttpUrl(settings.mcp_oauth_resource_url),
            # Supabase currently has no Plurum permission scope. None makes
            # the SDK omit scopes_supported while still enforcing no scopes.
            required_scopes=None,
        )
        token_verifier = PlurumMCPTokenVerifier(settings=settings)

    server = FastMCP(
        name="Plurum",
        instructions=MCP_INSTRUCTIONS,
        website_url="https://plurum.ai",
        streamable_http_path="/mcp",
        stateless_http=True,
        json_response=True,
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=True,
            allowed_hosts=settings.mcp_allowed_hosts,
            allowed_origins=settings.mcp_allowed_origins,
        ),
        log_level="WARNING",
        auth=auth_settings,
        token_verifier=token_verifier,
        tools=[],
    )
    register_read_tools(server)
    register_write_tools(server)
    protocol_app: ASGIApp = MCPRequestCredentialGuard(server.streamable_http_app())
    if settings.mcp_oauth_enabled:
        protocol_app = MCPAuthenticationCacheControlMiddleware(
            MCPClientContextMiddleware(protocol_app)
        )
    else:
        protocol_app = MCPAPIKeyAuthMiddleware(protocol_app)
    http_app = MCPResponseBodyLimitMiddleware(
        protocol_app,
        max_body_bytes=settings.mcp_max_response_body_bytes,
    )
    return server, http_app
