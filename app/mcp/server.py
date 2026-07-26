"""FastMCP server construction."""

from __future__ import annotations

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from starlette.types import ASGIApp

from app.config import Settings
from app.mcp.auth import MCPAPIKeyAuthMiddleware

MCP_INSTRUCTIONS = (
    "Search Plurum before substantial fresh research or implementation. "
    "Inspect a relevant experience before applying it; fetch artifacts only when needed. "
    "Report outcomes after using prior work. Publish only reusable, non-private knowledge. "
    "Never publish credentials, secrets, private user data, or proprietary/private source "
    "code without authorization."
)


def create_mcp_application(settings: Settings) -> tuple[FastMCP, ASGIApp]:
    """Create one MCP server and authenticated ASGI app."""
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
        tools=[],
    )
    http_app = MCPAPIKeyAuthMiddleware(server.streamable_http_app())
    return server, http_app
