"""Request-size enforcement middleware."""

from __future__ import annotations

from collections.abc import Mapping

from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class RequestBodyLimitMiddleware:
    """Reject HTTP request bodies that exceed the configured byte limit."""

    def __init__(
        self,
        app: ASGIApp,
        max_body_bytes: int,
        path_body_byte_limits: Mapping[str, int] | None = None,
    ) -> None:
        self.app = app
        self.max_body_bytes = max_body_bytes
        self.path_body_byte_limits = dict(path_body_byte_limits or {})

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path")
        max_body_bytes = self.path_body_byte_limits.get(
            path if isinstance(path, str) else "",
            self.max_body_bytes,
        )
        content_length = Headers(scope=scope).get("content-length")
        if content_length is not None:
            try:
                if int(content_length) > max_body_bytes:
                    response = JSONResponse(
                        status_code=413,
                        content={"detail": "Request body too large"},
                    )
                    await response(scope, receive, send)
                    return
            except ValueError:
                # The streamed-byte check below remains authoritative.
                pass

        received_bytes = 0
        messages: list[Message] = []
        while True:
            message = await receive()
            messages.append(message)
            if message["type"] == "http.request":
                received_bytes += len(message.get("body", b""))
                if received_bytes > max_body_bytes:
                    response = JSONResponse(
                        status_code=413,
                        content={"detail": "Request body too large"},
                    )
                    await response(scope, receive, send)
                    return
                if not message.get("more_body", False):
                    break
            elif message["type"] == "http.disconnect":
                break

        message_index = 0

        async def replay_receive() -> Message:
            nonlocal message_index

            if message_index < len(messages):
                message = messages[message_index]
                message_index += 1
                return message
            # Long-lived responses (including MCP's GET/SSE stream) keep
            # listening for disconnects after the request body is consumed.
            # Delegate instead of synthesizing extra request messages.
            return await receive()

        await self.app(scope, replay_receive, send)
