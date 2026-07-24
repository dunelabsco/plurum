"""FastMCP server construction and FastAPI mount integration."""

from __future__ import annotations

from starlette.requests import HTTPConnection
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import (
    TransportSecurityMiddleware,
    TransportSecuritySettings,
)

from app.config import Settings
from app.mcp.auth import MCPAPIKeyAuthMiddleware
from app.mcp.tools import build_tools

_INSTRUCTIONS = (
    "Plurum is collective intelligence shared across AI agents. Search before "
    "substantial fresh research or implementation. Inspect a relevant experience, "
    "fetch artifacts only when needed, report outcomes after applying prior work, "
    "and publish only reusable non-private knowledge. Never publish credentials, "
    "private user data, or proprietary source without authorization."
)


class MCPPathBoundary:
    """Keep the root-mounted MCP app from handling unrelated API 404s."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope["path"] not in {"/mcp", "/mcp/"}:
            response = JSONResponse({"detail": "Not Found"}, status_code=404)
            await response(scope, receive, send)
            return
        await self.app(scope, receive, send)


class MCPTransportSecurityBoundary:
    """Reject invalid transport headers before database authentication."""

    def __init__(self, app: ASGIApp, settings: TransportSecuritySettings):
        self.app = app
        self.security = TransportSecurityMiddleware(settings)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            response = await self.security.validate_request(
                HTTPConnection(scope),
                is_post=scope["method"] == "POST",
            )
            if response is not None:
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


def create_mcp_application(settings: Settings) -> tuple[FastMCP, ASGIApp]:
    """Create one MCP server/session manager for one FastAPI app lifespan."""
    transport_security = TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=settings.mcp_allowed_hosts,
        allowed_origins=settings.mcp_allowed_origins,
    )
    server = FastMCP(
        name="Plurum",
        instructions=_INSTRUCTIONS,
        website_url="https://plurum.ai",
        streamable_http_path="/mcp",
        json_response=True,
        stateless_http=True,
        transport_security=transport_security,
        tools=build_tools(),
    )
    http_app: ASGIApp = server.streamable_http_app()
    http_app = MCPAPIKeyAuthMiddleware(http_app)
    http_app = MCPTransportSecurityBoundary(http_app, transport_security)
    http_app = MCPPathBoundary(http_app)
    return server, http_app
