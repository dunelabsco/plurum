"""Hosted MCP transport and authentication tests."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from unittest.mock import MagicMock

import anyio
import httpx
import pytest
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.types import LATEST_PROTOCOL_VERSION
from starlette.responses import JSONResponse

from app.core.security import hash_api_key
from app.main import create_app
from app.mcp.auth import MCPAPIKeyAuthMiddleware, get_mcp_principal

_INITIALIZE_REQUEST = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": LATEST_PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": {"name": "plurum-stage-one-tests", "version": "1.0"},
    },
}
_MCP_ACCEPT = "application/json, text/event-stream"
_TOOL_NAMES = [
    "plurum_search",
    "plurum_get_experience",
    "plurum_get_artifact",
    "plurum_publish",
    "plurum_report_outcome",
    "plurum_archive",
    "plurum_vote",
]


def _active_agent(agent_id: str = "agent-stage-one") -> dict:
    return {"id": agent_id, "is_active": True}


@asynccontextmanager
async def _mcp_session(application, api_key: str):
    transport = httpx.ASGITransport(app=application)
    async with application.router.lifespan_context(application):
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
            headers={"Authorization": f"Bearer {api_key}"},
            follow_redirects=False,
        ) as http_client:
            async with streamable_http_client(
                "http://testserver/mcp",
                http_client=http_client,
            ) as (read_stream, write_stream, _):
                async with ClientSession(read_stream, write_stream) as session:
                    initialization = await session.initialize()
                    yield session, initialization


async def _post_initialize(application, authorization: str | None = None):
    headers = {"Accept": _MCP_ACCEPT}
    if authorization is not None:
        headers["Authorization"] = authorization

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://testserver",
        follow_redirects=False,
    ) as client:
        return await client.post("/mcp", json=_INITIALIZE_REQUEST, headers=headers)


@pytest.mark.asyncio
async def test_valid_key_initializes_with_instructions_and_tools(mock_supabase):
    raw_key = "plrm_live_stage_one_valid_key"
    agent = _active_agent()
    agents_table = mock_supabase.table.return_value
    agents_table.select.return_value.eq.return_value.execute.return_value = MagicMock(
        data=[agent]
    )
    agents_table.update.return_value.eq.return_value.execute.return_value = MagicMock(
        data=[agent]
    )

    application = create_app()
    with anyio.fail_after(5):
        async with _mcp_session(application, raw_key) as (session, initialization):
            assert initialization.serverInfo.name == "Plurum"
            instructions = (initialization.instructions or "")[:512].lower()
            assert "search" in instructions
            assert "inspect" in instructions
            assert "report outcomes" in instructions
            assert "publish only verified" in instructions
            assert "write-approval" in instructions
            assert "never send" in instructions
            assert "secret" in instructions
            assert "private" in instructions
            assert [
                tool.name for tool in (await session.list_tools()).tools
            ] == _TOOL_NAMES

    lookup_calls = agents_table.select.return_value.eq.call_args_list
    assert lookup_calls
    assert all(
        call.args == ("api_key_hash", hash_api_key(raw_key))
        for call in lookup_calls
    )
    update_calls = agents_table.update.return_value.eq.call_args_list
    assert update_calls
    assert all(call.args == ("id", agent["id"]) for call in update_calls)


@pytest.mark.asyncio
async def test_fresh_app_instances_start_and_close_independently(monkeypatch):
    monkeypatch.setattr(
        "app.mcp.auth.validate_api_key",
        lambda _api_key: _active_agent(),
    )

    for _ in range(2):
        application = create_app()
        with anyio.fail_after(5):
            async with _mcp_session(application, "plrm_live_lifecycle") as (
                session,
                _initialization,
            ):
                assert [
                    tool.name for tool in (await session.list_tools()).tools
                ] == _TOOL_NAMES


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "authorization",
    [
        None,
        "Basic raw-secret",
        "Bearer",
        "Bearer first second",
        "Token raw-secret",
    ],
)
async def test_missing_or_malformed_bearer_is_generic_and_skips_lookup(
    monkeypatch,
    authorization,
):
    def unexpected_lookup(_api_key):
        raise AssertionError("malformed authentication reached the key store")

    monkeypatch.setattr("app.mcp.auth.validate_api_key", unexpected_lookup)

    response = await _post_initialize(create_app(), authorization)

    assert response.status_code == 401
    assert response.json() == {"error": "Invalid or missing API key"}
    assert response.headers["www-authenticate"] == 'Bearer realm="plurum"'
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "raw-secret" not in response.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "stored_agents",
    [
        [],
        [{"id": "inactive-agent", "is_active": False}],
    ],
)
async def test_invalid_or_inactive_key_returns_same_generic_401(
    mock_supabase,
    stored_agents,
):
    raw_key = "plrm_live_invalid_or_inactive"
    agents_table = mock_supabase.table.return_value
    agents_table.select.return_value.eq.return_value.execute.return_value = MagicMock(
        data=stored_agents
    )

    response = await _post_initialize(
        create_app(),
        f"Bearer {raw_key}",
    )

    assert response.status_code == 401
    assert response.json() == {"error": "Invalid or missing API key"}
    assert raw_key not in response.text
    agents_table.update.assert_not_called()


@pytest.mark.asyncio
async def test_wrong_api_key_prefix_is_rejected_before_store_lookup(mock_supabase):
    raw_key = "not_a_plurum_key"

    response = await _post_initialize(
        create_app(),
        f"Bearer {raw_key}",
    )

    assert response.status_code == 401
    assert response.json() == {"error": "Invalid or missing API key"}
    assert raw_key not in response.text
    mock_supabase.table.assert_not_called()


@pytest.mark.asyncio
async def test_key_store_failure_is_sanitized_in_response_and_logs(monkeypatch, caplog):
    raw_key = "plrm_live_must_not_appear"

    def unavailable(api_key):
        raise RuntimeError(f"store failure while checking {api_key}")

    monkeypatch.setattr("app.mcp.auth.validate_api_key", unavailable)
    caplog.set_level(logging.ERROR, logger="app.mcp.auth")

    response = await _post_initialize(
        create_app(),
        f"Bearer {raw_key}",
    )

    assert response.status_code == 503
    assert response.json() == {"error": "Authentication service unavailable"}
    assert raw_key not in response.text
    assert raw_key not in caplog.text
    assert "RuntimeError" in caplog.text


@pytest.mark.asyncio
async def test_mcp_mount_preserves_rest_and_does_not_capture_unrelated_paths(monkeypatch):
    monkeypatch.setattr(
        "app.mcp.auth.validate_api_key",
        lambda _api_key: _active_agent(),
    )
    application = create_app()

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://testserver",
        follow_redirects=False,
    ) as client:
        health = await client.get("/health")
        missing = await client.get("/definitely-not-mcp")
        duplicate = await client.post(
            "/mcp/mcp",
            json=_INITIALIZE_REQUEST,
            headers={
                "Accept": _MCP_ACCEPT,
                "Authorization": "Bearer plrm_live_path",
            },
        )

    assert health.status_code == 200
    assert health.json()["status"] == "healthy"
    assert missing.status_code == 404
    assert missing.json() == {"detail": "Not Found"}
    assert duplicate.status_code == 404


@pytest.mark.asyncio
async def test_sdk_rejects_untrusted_host_and_origin(monkeypatch):
    monkeypatch.setattr(
        "app.mcp.auth.validate_api_key",
        lambda _api_key: _active_agent(),
    )
    application = create_app()
    request_headers = {
        "Accept": _MCP_ACCEPT,
        "Authorization": "Bearer plrm_live_transport",
    }

    async with application.router.lifespan_context(application):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url="http://untrusted.example",
        ) as untrusted_host_client:
            host_response = await untrusted_host_client.post(
                "/mcp",
                json=_INITIALIZE_REQUEST,
                headers=request_headers,
            )

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url="http://testserver",
        ) as untrusted_origin_client:
            origin_response = await untrusted_origin_client.post(
                "/mcp",
                json=_INITIALIZE_REQUEST,
                headers={**request_headers, "Origin": "https://untrusted.example"},
            )

    assert host_response.status_code == 421
    assert "plrm_live_transport" not in host_response.text
    assert origin_response.status_code == 403
    assert "plrm_live_transport" not in origin_response.text


@pytest.mark.asyncio
async def test_request_limit_wraps_mcp_before_key_lookup(monkeypatch):
    raw_key = "plrm_live_oversized"

    def unexpected_lookup(_api_key):
        raise AssertionError("oversized request reached authentication")

    monkeypatch.setattr("app.mcp.auth.validate_api_key", unexpected_lookup)
    application = create_app()

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://testserver",
    ) as client:
        response = await client.post(
            "/mcp",
            content=b"{}",
            headers={
                "Authorization": f"Bearer {raw_key}",
                "Content-Type": "application/json",
                "Content-Length": str(5 * 1024 * 1024 + 1),
            },
        )

    assert response.status_code == 413
    assert response.json() == {"detail": "Request body too large"}
    assert raw_key not in response.text


@pytest.mark.asyncio
async def test_concurrent_requests_keep_principals_isolated(monkeypatch):
    ready = anyio.Event()
    lock = anyio.Lock()
    arrivals = 0

    def validate(api_key):
        return _active_agent(api_key.removeprefix("plrm_live_"))

    monkeypatch.setattr("app.mcp.auth.validate_api_key", validate)

    async def principal_probe(scope, receive, send):
        nonlocal arrivals
        before = get_mcp_principal()
        async with lock:
            arrivals += 1
            if arrivals == 2:
                ready.set()
        await ready.wait()
        after = get_mcp_principal()
        response = JSONResponse(
            {
                "before": before.agent_id,
                "after": after.agent_id,
                "client": after.client,
            }
        )
        await response(scope, receive, send)

    middleware = MCPAPIKeyAuthMiddleware(principal_probe)
    results = {}

    with anyio.fail_after(5):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=middleware),
            base_url="http://testserver",
        ) as client:

            async def call(name, channel):
                response = await client.get(
                    "/",
                    headers={
                        "Authorization": f"Bearer plrm_live_{name}",
                        "X-Plurum-Client": channel,
                    },
                )
                results[name] = response.json()

            async with anyio.create_task_group() as task_group:
                task_group.start_soon(call, "alpha", "codex")
                task_group.start_soon(call, "beta", "untrusted-client-name")

    assert results == {
        "alpha": {"before": "alpha", "after": "alpha", "client": "codex"},
        "beta": {"before": "beta", "after": "beta", "client": "unknown"},
    }
    assert get_mcp_principal(required=False) is None


@pytest.mark.asyncio
async def test_principal_is_reset_when_downstream_fails(monkeypatch):
    monkeypatch.setattr(
        "app.mcp.auth.validate_api_key",
        lambda _api_key: _active_agent(),
    )

    async def fail_downstream(_scope, _receive, _send):
        assert get_mcp_principal() is not None
        raise RuntimeError("downstream failed")

    middleware = MCPAPIKeyAuthMiddleware(fail_downstream)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=middleware),
        base_url="http://testserver",
    ) as client:
        with pytest.raises(RuntimeError, match="downstream failed"):
            await client.get(
                "/",
                headers={"Authorization": "Bearer plrm_live_failure"},
            )

    assert get_mcp_principal(required=False) is None
