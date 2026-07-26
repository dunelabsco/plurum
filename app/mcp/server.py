"""FastMCP server construction."""

from __future__ import annotations

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.config import Settings
from app.mcp.auth import MCPAPIKeyAuthMiddleware, MCPRequestCredentialGuard
from app.mcp.tools import register_read_tools, register_write_tools

MCP_INSTRUCTIONS = (
    "Search Plurum before substantial fresh research or implementation. "
    "Inspect a relevant experience before applying it; fetch artifacts only when needed. "
    "Report outcomes after using prior work. Publish only reusable, non-private knowledge. "
    "Never publish credentials, secrets, private user data, or proprietary/private source "
    "code without authorization."
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
    register_read_tools(server)
    register_write_tools(server)
    http_app = MCPResponseBodyLimitMiddleware(
        MCPAPIKeyAuthMiddleware(
            MCPRequestCredentialGuard(server.streamable_http_app())
        ),
        max_body_bytes=settings.mcp_max_response_body_bytes,
    )
    return server, http_app
