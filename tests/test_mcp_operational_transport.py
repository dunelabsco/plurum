"""Operational safeguards at the hosted MCP transport boundary."""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from unittest.mock import MagicMock

import anyio
import httpx
import pytest
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import LATEST_PROTOCOL_VERSION
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Scope

from app.config import get_settings
from app.core.request_limits import RequestBodyLimitMiddleware
from app.mcp.auth import (
    MCPAPIKeyAuthMiddleware,
    MCPRequestCredentialGuard,
    get_mcp_principal,
)
from app.mcp.server import MCPResponseBodyLimitMiddleware


def _scope(
    *,
    method: str = "GET",
    path: str = "/",
    headers: list[tuple[bytes, bytes]] | None = None,
) -> Scope:
    return {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.4"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": headers or [],
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
    }


async def _invoke_asgi(
    application: ASGIApp,
    scope: Scope,
    incoming: list[Message] | None = None,
) -> list[Message]:
    messages = iter(incoming or [{"type": "http.request", "body": b"", "more_body": False}])
    sent: list[Message] = []

    async def receive() -> Message:
        try:
            return next(messages)
        except StopIteration:
            await anyio.sleep_forever()
            raise AssertionError("unreachable")

    async def send(message: Message) -> None:
        sent.append(message)

    await application(scope, receive, send)
    return sent


def _response(sent: list[Message]) -> tuple[int, dict[bytes, bytes], bytes]:
    start = next(message for message in sent if message["type"] == "http.response.start")
    body = b"".join(
        message.get("body", b"") for message in sent if message["type"] == "http.response.body"
    )
    return start["status"], dict(start.get("headers", [])), body


def _chunked_response_app(
    chunks: list[bytes],
    *,
    content_type: bytes = b"application/json",
) -> ASGIApp:
    async def application(_scope, _receive, send) -> None:
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"content-type", content_type)],
            }
        )
        for index, chunk in enumerate(chunks):
            await send(
                {
                    "type": "http.response.body",
                    "body": chunk,
                    "more_body": index < len(chunks) - 1,
                }
            )

    return application


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("chunks", "limit"),
    [
        ([b"abc"], 4),
        ([b"abcd"], 4),
        ([b"ab", b"cd"], 4),
    ],
)
async def test_response_limit_allows_bodies_below_or_equal_to_cap(chunks, limit):
    middleware = MCPResponseBodyLimitMiddleware(
        _chunked_response_app(chunks),
        max_body_bytes=limit,
    )

    sent = await _invoke_asgi(middleware, _scope())

    status, headers, body = _response(sent)
    assert status == 200
    assert headers[b"content-type"] == b"application/json"
    assert body == b"".join(chunks)


@pytest.mark.asyncio
async def test_response_limit_replaces_chunked_overflow_without_leaking_body(
    caplog,
):
    secret = b"plrm_live_response_secret_123456789"
    middleware = MCPResponseBodyLimitMiddleware(
        _chunked_response_app([b'{"value":"', secret, b'"}']),
        max_body_bytes=16,
    )

    sent = await _invoke_asgi(middleware, _scope())

    status, headers, body = _response(sent)
    assert status == 500
    assert json.loads(body) == {"error": "MCP response too large"}
    assert headers[b"cache-control"] == b"no-store"
    assert secret not in body
    assert secret.decode() not in caplog.text


@pytest.mark.asyncio
async def test_response_limit_passes_sse_through_without_aggregate_cap():
    chunks = [b"event: message\n", b"data: " + (b"x" * 64) + b"\n\n"]
    middleware = MCPResponseBodyLimitMiddleware(
        _chunked_response_app(chunks, content_type=b"text/event-stream"),
        max_body_bytes=8,
    )

    sent = await _invoke_asgi(middleware, _scope())

    status, headers, body = _response(sent)
    assert status == 200
    assert headers[b"content-type"] == b"text/event-stream"
    assert body == b"".join(chunks)


@pytest.mark.asyncio
async def test_response_limit_keeps_concurrent_request_state_isolated():
    ready = anyio.Event()
    lock = anyio.Lock()
    arrivals = 0

    async def concurrent_app(scope, _receive, send):
        nonlocal arrivals
        async with lock:
            arrivals += 1
            if arrivals == 2:
                ready.set()
        await ready.wait()
        payload = b"ok" if scope["path"] == "/small" else b"too-large"
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"content-type", b"application/json")],
            }
        )
        await anyio.sleep(0)
        await send(
            {
                "type": "http.response.body",
                "body": payload,
                "more_body": False,
            }
        )

    middleware = MCPResponseBodyLimitMiddleware(
        concurrent_app,
        max_body_bytes=4,
    )
    results: dict[str, tuple[int, dict[bytes, bytes], bytes]] = {}

    async def call(path: str) -> None:
        results[path] = _response(await _invoke_asgi(middleware, _scope(path=path)))

    async with anyio.create_task_group() as task_group:
        task_group.start_soon(call, "/small")
        task_group.start_soon(call, "/large")

    assert results["/small"][0] == 200
    assert results["/small"][2] == b"ok"
    assert results["/large"][0] == 500
    assert json.loads(results["/large"][2]) == {"error": "MCP response too large"}


@pytest.mark.asyncio
async def test_disabled_mcp_skips_factory_and_returns_normal_404(monkeypatch):
    from app import main as main_module

    settings = get_settings().model_copy(update={"mcp_enabled": False})
    mcp_factory = MagicMock(side_effect=AssertionError("disabled MCP must not be constructed"))
    key_lookup = MagicMock(side_effect=AssertionError("disabled MCP must not authenticate"))
    monkeypatch.setattr(main_module, "get_settings", lambda: settings)
    monkeypatch.setattr(main_module, "create_mcp_application", mcp_factory)
    monkeypatch.setattr("app.mcp.auth.validate_api_key", key_lookup)

    application = main_module.create_app()
    async with application.router.lifespan_context(application):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url="http://testserver",
        ) as client:
            health = await client.get("/health")
            mcp = await client.post(
                "/mcp",
                headers={"Authorization": "Bearer plrm_live_disabled"},
                json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
            )

    assert health.status_code == 200
    assert health.json() == {
        "status": "healthy",
        "version": "0.2.0",
        "mcp": "disabled",
    }
    assert mcp.status_code == 404
    assert mcp.json() == {"detail": "Not Found"}
    mcp_factory.assert_not_called()
    key_lookup.assert_not_called()


@pytest.mark.asyncio
async def test_enabled_health_reports_ready_and_runs_mcp_lifespan(monkeypatch):
    from app import main as main_module

    lifecycle: list[str] = []

    class StubSessionManager:
        @asynccontextmanager
        async def run(self):
            lifecycle.append("started")
            try:
                yield
            finally:
                lifecycle.append("stopped")

    class StubServer:
        session_manager = StubSessionManager()

    async def stub_mcp_app(scope, receive, send):
        response = JSONResponse({"status": "stub"})
        await response(scope, receive, send)

    settings = get_settings().model_copy(update={"mcp_enabled": True})
    monkeypatch.setattr(main_module, "get_settings", lambda: settings)
    monkeypatch.setattr(
        main_module,
        "create_mcp_application",
        lambda _settings: (StubServer(), stub_mcp_app),
    )

    application = main_module.create_app()
    assert lifecycle == []
    async with application.router.lifespan_context(application):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url="http://testserver",
        ) as client:
            health = await client.get("/health")
        assert health.status_code == 200
        assert health.json()["mcp"] == "ready"
        assert lifecycle == ["started"]

    assert lifecycle == ["started", "stopped"]


@pytest.mark.asyncio
async def test_oversized_authorization_is_rejected_before_key_lookup(
    monkeypatch,
    caplog,
):
    from app.mcp import auth

    key_lookup = MagicMock()
    downstream = MagicMock(side_effect=AssertionError("oversized authorization reached MCP"))
    monkeypatch.setattr(auth, "validate_api_key", key_lookup)
    secret = "plrm_live_" + ("s" * 600)
    middleware = MCPAPIKeyAuthMiddleware(downstream)

    sent = await _invoke_asgi(
        middleware,
        _scope(
            headers=[
                (b"authorization", f"Bearer {secret}".encode()),
            ]
        ),
    )

    status, headers, body = _response(sent)
    assert status == 401
    assert json.loads(body) == {"error": "Invalid or missing API key"}
    assert headers[b"cache-control"] == b"no-store"
    assert secret.encode() not in body
    assert secret not in caplog.text
    key_lookup.assert_not_called()
    downstream.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("padding", "expected_client"),
    [
        (59, "codex"),
        (60, "unknown"),
    ],
)
async def test_client_header_length_is_bounded_before_normalization(
    monkeypatch,
    padding,
    expected_client,
):
    from app.mcp import auth

    monkeypatch.setattr(
        auth,
        "validate_api_key",
        lambda _api_key: {"id": "agent-client-bound", "is_active": True},
    )

    async def show_principal(scope, receive, send):
        principal = get_mcp_principal()
        response = JSONResponse({"client": principal.client})
        await response(scope, receive, send)

    # 5 characters for "codex" plus the parametrized trailing padding.
    client_header = ("codex" + (" " * padding)).encode()
    sent = await _invoke_asgi(
        MCPAPIKeyAuthMiddleware(show_principal),
        _scope(
            headers=[
                (b"authorization", b"Bearer plrm_live_client_bound"),
                (b"x-plurum-client", client_header),
            ]
        ),
    )

    status, _headers, body = _response(sent)
    assert status == 200
    assert json.loads(body) == {"client": expected_client}


@pytest.mark.asyncio
async def test_streamed_mcp_request_over_global_cap_fails_before_authentication(
    monkeypatch,
    caplog,
):
    from app.main import create_app
    from app.mcp import auth

    key_lookup = MagicMock()
    monkeypatch.setattr(auth, "validate_api_key", key_lookup)
    raw_key = "plrm_live_streamed_oversized"
    application = create_app()

    async def oversized_chunks():
        chunk = b"x" * (1024 * 1024)
        for _ in range(6):
            yield chunk

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://testserver",
    ) as client:
        response = await client.post(
            "/mcp",
            content=oversized_chunks(),
            headers={
                "Authorization": f"Bearer {raw_key}",
                "Content-Type": "application/json",
            },
        )

    assert response.status_code == 413
    assert response.json() == {"detail": "Request body too large"}
    assert raw_key not in response.text
    assert raw_key not in caplog.text
    key_lookup.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "wrap",
    [
        lambda app: RequestBodyLimitMiddleware(app, max_body_bytes=1024),
        MCPRequestCredentialGuard,
    ],
)
async def test_incomplete_body_disconnect_stops_before_downstream(wrap):
    downstream_called = False

    async def downstream(_scope, _receive, _send):
        nonlocal downstream_called
        downstream_called = True

    incoming = [
        {"type": "http.request", "body": b"partial", "more_body": True},
        {"type": "http.disconnect"},
    ]

    with anyio.fail_after(1):
        sent = await _invoke_asgi(
            wrap(downstream),
            _scope(method="POST"),
            incoming,
        )

    assert not downstream_called
    assert sent == []


@pytest.mark.asyncio
async def test_mcp_get_sse_releases_transport_on_disconnect(monkeypatch, caplog):
    from app.main import create_app
    from app.mcp import auth

    monkeypatch.setattr(
        auth,
        "validate_api_key",
        lambda _api_key: {"id": "agent-sse", "is_active": True},
    )
    application = create_app()
    incoming = [
        {"type": "http.request", "body": b"", "more_body": False},
        {"type": "http.disconnect"},
    ]

    async with application.router.lifespan_context(application):
        with anyio.fail_after(2):
            sent = await _invoke_asgi(
                application,
                _scope(
                    method="GET",
                    path="/mcp",
                    headers=[
                        (b"host", b"testserver"),
                        (b"accept", b"text/event-stream"),
                        (b"authorization", b"Bearer plrm_live_sse"),
                    ],
                ),
                incoming,
            )

    assert any(
        message["type"] == "http.response.start" and message["status"] == 200 for message in sent
    )
    assert "Unexpected message received" not in caplog.text


@pytest.mark.asyncio
async def test_complete_post_body_disconnect_does_not_cancel_request():
    started = anyio.Event()
    finished = anyio.Event()
    cancelled = anyio.Event()
    server = FastMCP(
        "disconnect-probe",
        streamable_http_path="/mcp",
        stateless_http=True,
        json_response=True,
        transport_security=TransportSecuritySettings(
            allowed_hosts=["testserver"],
        ),
    )

    @server.tool()
    async def finish_once() -> dict[str, bool]:
        started.set()
        try:
            await anyio.sleep(0.02)
            finished.set()
            return {"finished": True}
        except BaseException:
            cancelled.set()
            raise

    application = server.streamable_http_app()
    request_body = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "finish_once", "arguments": {}},
        }
    ).encode()
    incoming = [
        {"type": "http.request", "body": request_body, "more_body": False},
        {"type": "http.disconnect"},
    ]

    async with application.router.lifespan_context(application):
        with anyio.fail_after(2):
            sent = await _invoke_asgi(
                application,
                _scope(
                    method="POST",
                    path="/mcp",
                    headers=[
                        (b"host", b"testserver"),
                        (b"accept", b"application/json"),
                        (b"content-type", b"application/json"),
                        (
                            b"mcp-protocol-version",
                            LATEST_PROTOCOL_VERSION.encode(),
                        ),
                    ],
                ),
                incoming,
            )

    status, _headers, body = _response(sent)
    assert started.is_set()
    assert finished.is_set()
    assert not cancelled.is_set()
    assert status == 200
    assert "error" not in json.loads(body)
