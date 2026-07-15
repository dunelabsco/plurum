"""Tests for the hosted MCP transport and API-key boundary."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

import anyio
import httpx
import pytest
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from starlette.responses import JSONResponse

from app.core.exceptions import AuthenticationError, RateLimitError


def _agent(agent_id: str, name: str = "test-agent") -> dict:
    return {
        "id": agent_id,
        "name": name,
        "is_active": True,
        "api_key_prefix": "plrm_live_test...",
        "rate_limit_tier": "standard",
    }


@asynccontextmanager
async def _mcp_session(app, api_key: str = "plrm_live_valid"):
    headers = {
        "Authorization": f"Bearer {api_key}",
        "X-Plurum-Client": "codex",
    }
    transport = httpx.ASGITransport(app=app)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
            headers=headers,
        ) as http_client:
            async with streamable_http_client(
                "http://testserver/mcp",
                http_client=http_client,
            ) as (read_stream, write_stream, _):
                async with ClientSession(read_stream, write_stream) as session:
                    await session.initialize()
                    yield session


@pytest.mark.asyncio
async def test_mcp_requires_bearer_token():
    from app.main import create_app

    app = create_app()
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
        ) as client:
            response = await client.post("/mcp", json={})

    assert response.status_code == 401
    assert response.json() == {"error": "Invalid or missing API key"}
    assert response.headers["www-authenticate"] == 'Bearer realm="plurum"'
    assert response.headers["x-content-type-options"] == "nosniff"


@pytest.mark.asyncio
@pytest.mark.parametrize("error_message", ["Invalid API key", "API key has been deactivated"])
async def test_mcp_rejects_invalid_bearer_token(monkeypatch, error_message):
    from app.main import create_app
    from app.mcp import auth

    def reject(_api_key: str) -> dict:
        raise AuthenticationError(error_message)

    monkeypatch.setattr(auth, "validate_api_key", reject)
    app = create_app()

    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
            headers={"Authorization": "Bearer plrm_live_invalid"},
        ) as client:
            response = await client.post("/mcp", json={})

    assert response.status_code == 401
    assert response.json() == {"error": "Invalid or missing API key"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "authorization",
    ["Basic plrm_live_secret", "Bearer", "Bearer one two"],
)
async def test_mcp_rejects_malformed_authorization_without_key_lookup(
    monkeypatch,
    authorization,
):
    from app.main import create_app
    from app.mcp import auth

    def unexpected_lookup(_api_key: str) -> dict:
        raise AssertionError("malformed headers must fail before key lookup")

    monkeypatch.setattr(auth, "validate_api_key", unexpected_lookup)
    app = create_app()

    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
            headers={"Authorization": authorization},
        ) as client:
            response = await client.post("/mcp", json={})

    assert response.status_code == 401
    assert response.json() == {"error": "Invalid or missing API key"}
    assert "plrm_live_secret" not in response.text


@pytest.mark.asyncio
async def test_mcp_auth_store_failure_is_sanitized(monkeypatch, caplog):
    from app.main import create_app
    from app.mcp import auth

    api_key = "plrm_live_must_not_appear"

    def fail(candidate: str) -> dict:
        raise RuntimeError(f"database failed while checking {candidate}")

    monkeypatch.setattr(auth, "validate_api_key", fail)
    caplog.set_level(logging.ERROR)
    app = create_app()

    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
            headers={"Authorization": f"Bearer {api_key}"},
        ) as client:
            response = await client.post("/mcp", json={})

    assert response.status_code == 503
    assert response.json() == {"error": "Authentication service unavailable"}
    assert api_key not in response.text
    assert api_key not in caplog.text


@pytest.mark.asyncio
async def test_mcp_initializes_and_lists_read_tools(monkeypatch):
    from app.main import create_app
    from app.mcp import auth
    from plugins.hermes.tools import (
        GET_ARTIFACT_SCHEMA,
        GET_EXPERIENCE_SCHEMA,
        SEARCH_SCHEMA,
    )

    monkeypatch.setattr(
        auth,
        "validate_api_key",
        lambda _api_key: _agent("00000000-0000-0000-0000-000000000001"),
    )
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.list_tools()

    assert [tool.name for tool in result.tools] == [
        "plurum_search",
        "plurum_get_experience",
        "plurum_get_artifact",
    ]
    for tool in result.tools:
        assert tool.annotations is not None
        assert tool.annotations.readOnlyHint is True
        assert tool.annotations.destructiveHint is False
        assert tool.annotations.idempotentHint is True
        assert tool.annotations.openWorldHint is False

    tools_by_name = {tool.name: tool for tool in result.tools}
    search_tool = tools_by_name["plurum_search"]
    assert search_tool.title == "Search Plurum experiences"
    assert search_tool.description == SEARCH_SCHEMA["description"].replace(
        "Hermes' own memory",
        "the host's own memory",
    )
    search_schema = search_tool.inputSchema
    assert search_schema["properties"]["query"]["minLength"] == 2
    assert search_schema["properties"]["query"]["maxLength"] == 1000

    experience_tool = tools_by_name["plurum_get_experience"]
    assert experience_tool.title == "Get Plurum experience"
    assert experience_tool.description == GET_EXPERIENCE_SCHEMA["description"]
    assert set(experience_tool.inputSchema["properties"]) == {"experience_id"}
    assert experience_tool.inputSchema["required"] == ["experience_id"]
    assert experience_tool.inputSchema["properties"]["experience_id"]["type"] == "string"
    assert experience_tool.inputSchema["properties"]["experience_id"]["maxLength"] == 64

    artifact_tool = tools_by_name["plurum_get_artifact"]
    assert artifact_tool.title == "Get Plurum artifact"
    assert artifact_tool.description == GET_ARTIFACT_SCHEMA["description"]
    assert set(artifact_tool.inputSchema["properties"]) == {
        "experience_id",
        "artifact_index",
    }
    assert set(artifact_tool.inputSchema["required"]) == {
        "experience_id",
        "artifact_index",
    }
    assert artifact_tool.inputSchema["properties"]["artifact_index"]["type"] == "integer"
    assert artifact_tool.inputSchema["properties"]["artifact_index"]["minimum"] == 0
    assert artifact_tool.inputSchema["properties"]["experience_id"]["maxLength"] == 64


@pytest.mark.asyncio
async def test_mcp_search_returns_trimmed_structured_results(monkeypatch):
    from app.main import create_app
    from app.mcp import auth, tools
    from plugins.hermes.tools import _SEARCH_REMINDER

    monkeypatch.setattr(
        auth,
        "validate_api_key",
        lambda _api_key: _agent("00000000-0000-0000-0000-000000000001"),
    )

    class StubExperienceService:
        def search(self, **_kwargs):
            return {
                "total_found": 1,
                "results": [
                    {
                        "id": "exp-1",
                        "short_id": "abc123",
                        "goal": "Deploy a FastAPI service",
                        "similarity": 0.91,
                        "trust_score": 0.8,
                        "solution": "heavy field that search must omit",
                    }
                ],
            }

    events: list[dict] = []
    monkeypatch.setattr(tools, "ExperienceService", StubExperienceService)
    monkeypatch.setattr(
        tools,
        "log_event",
        lambda event_type, **kwargs: events.append({"event_type": event_type, **kwargs}),
    )
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool(
            "plurum_search",
            {"query": "deploy fastapi", "limit": 5},
        )

    assert result.isError is False
    assert result.structuredContent is not None
    assert result.structuredContent["reminder"] == _SEARCH_REMINDER
    assert result.structuredContent["count"] == 1
    assert result.structuredContent["results"] == [
        {
            "id": "exp-1",
            "short_id": "abc123",
            "goal": "Deploy a FastAPI service",
            "trust_score": 0.8,
            "similarity": 0.91,
        }
    ]
    assert events == [
        {
            "event_type": "search",
            "agent_id": "00000000-0000-0000-0000-000000000001",
            "query": "deploy fastapi",
            "metadata": {
                "channel": "mcp",
                "client": "codex",
                "result_count": 1,
                "top_similarity": 0.91,
            },
        }
    ]


@pytest.mark.asyncio
async def test_mcp_search_preserves_no_result_publish_reminder(monkeypatch):
    from app.main import create_app
    from app.mcp import auth, tools

    monkeypatch.setattr(
        auth,
        "validate_api_key",
        lambda _api_key: _agent("00000000-0000-0000-0000-000000000001"),
    )

    class StubExperienceService:
        def search(self, **_kwargs):
            return {
                "total_found": 1,
                "results": [{"id": "irrelevant", "similarity": 0.39}],
            }

    monkeypatch.setattr(tools, "ExperienceService", StubExperienceService)
    monkeypatch.setattr(tools, "log_event", lambda *_args, **_kwargs: None)
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool(
            "plurum_search",
            {"query": "unseen deployment issue"},
        )

    assert result.isError is False
    assert result.structuredContent == {
        "reminder": (
            "No prior experiences for this query. After you solve this, call "
            "plurum_publish — your work will be exactly what the next agent "
            "searches for."
        ),
        "query": "unseen deployment issue",
        "results": [],
        "top_similarity": 0.39,
        "count": 0,
    }


@pytest.mark.asyncio
async def test_mcp_search_rejects_normalized_short_and_oversized_queries(monkeypatch):
    from app.main import create_app
    from app.mcp import auth, tools

    monkeypatch.setattr(
        auth,
        "validate_api_key",
        lambda _api_key: _agent("00000000-0000-0000-0000-000000000001"),
    )

    class UnexpectedExperienceService:
        def search(self, **_kwargs):
            raise AssertionError("invalid queries must not run embeddings")

    monkeypatch.setattr(tools, "ExperienceService", UnexpectedExperienceService)
    app = create_app()

    async with _mcp_session(app) as session:
        normalized_short = await session.call_tool(
            "plurum_search",
            {"query": "a "},
        )
        oversized = await session.call_tool(
            "plurum_search",
            {"query": "x" * 1001},
        )

    short_text = " ".join(
        block.text for block in normalized_short.content if hasattr(block, "text")
    )
    oversized_text = " ".join(
        block.text for block in oversized.content if hasattr(block, "text")
    )
    assert normalized_short.isError is True
    assert "at least 2 non-whitespace characters" in short_text
    assert oversized.isError is True
    assert "at most 1000 characters" in oversized_text


@pytest.mark.asyncio
async def test_mcp_search_redacts_unexpected_service_errors(monkeypatch, caplog):
    from app.main import create_app
    from app.mcp import auth, tools

    secret = "plrm_live_service_error_secret"
    monkeypatch.setattr(
        auth,
        "validate_api_key",
        lambda _api_key: _agent("00000000-0000-0000-0000-000000000001"),
    )

    class FailingExperienceService:
        def search(self, **_kwargs):
            raise RuntimeError(f"upstream accidentally included {secret}")

    monkeypatch.setattr(tools, "ExperienceService", FailingExperienceService)
    caplog.set_level(logging.ERROR)
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool("plurum_search", {"query": "redaction test"})

    rendered = " ".join(block.text for block in result.content if hasattr(block, "text"))
    assert result.isError is True
    assert "Search failed. Reference:" in rendered
    assert secret not in rendered
    assert secret not in caplog.text


@pytest.mark.asyncio
async def test_mcp_search_rate_limit_stops_before_service_call(monkeypatch):
    from app.main import create_app
    from app.mcp import auth, tools

    monkeypatch.setattr(
        auth,
        "validate_api_key",
        lambda _api_key: _agent("00000000-0000-0000-0000-000000000001"),
    )

    def reject_search(**_kwargs):
        raise RateLimitError(retry_after=17)

    class UnexpectedExperienceService:
        def search(self, **_kwargs):
            raise AssertionError("rate-limited searches must not run embeddings")

    monkeypatch.setattr(tools, "enforce_agent_rate_limit", reject_search)
    monkeypatch.setattr(tools, "ExperienceService", UnexpectedExperienceService)
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool(
            "plurum_search",
            {"query": "must be limited"},
        )

    rendered = " ".join(block.text for block in result.content if hasattr(block, "text"))
    assert result.isError is True
    assert "Rate limit exceeded; retry after 17 seconds." in rendered


@pytest.mark.asyncio
async def test_mcp_canonical_path_request_limit_and_transport_security(monkeypatch):
    from app.main import create_app
    from app.mcp import auth

    validated_keys: list[str] = []

    def validate(api_key: str) -> dict:
        validated_keys.append(api_key)
        return _agent("00000000-0000-0000-0000-000000000001")

    monkeypatch.setattr(auth, "validate_api_key", validate)
    app = create_app()
    headers = {
        "Authorization": "Bearer plrm_live_valid",
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
    }

    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
            headers=headers,
            follow_redirects=False,
        ) as client:
            trailing_slash = await client.post("/mcp/", json={})
            duplicated_path = await client.post("/mcp/mcp", json={})
            unknown_path = await client.get("/definitely-missing")
            invalid_method = await client.put("/mcp", json={})
            oversized = await client.post(
                "/mcp",
                content=b"x" * (5 * 1024 * 1024 + 1),
            )

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://untrusted.example",
            headers=headers,
        ) as untrusted_client:
            untrusted_host = await untrusted_client.post("/mcp", json={})

    assert trailing_slash.status_code == 307
    assert trailing_slash.headers["location"] == "http://testserver/mcp"
    assert duplicated_path.status_code == 404
    assert duplicated_path.json() == {"detail": "Not Found"}
    assert unknown_path.status_code == 404
    assert unknown_path.json() == {"detail": "Not Found"}
    assert invalid_method.status_code == 405
    assert oversized.status_code == 413
    assert oversized.json() == {"detail": "Request body too large"}
    assert untrusted_host.status_code == 421
    assert len(validated_keys) == 2


@pytest.mark.asyncio
async def test_mcp_get_sse_closes_cleanly_on_disconnect(monkeypatch, caplog):
    from app.main import create_app
    from app.mcp import auth

    monkeypatch.setattr(
        auth,
        "validate_api_key",
        lambda _api_key: _agent("00000000-0000-0000-0000-000000000001"),
    )
    app = create_app()
    received_once = False
    sent = []

    async def receive():
        nonlocal received_once
        if not received_once:
            received_once = True
            return {"type": "http.request", "body": b"", "more_body": False}
        return {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/mcp",
        "raw_path": b"/mcp",
        "query_string": b"",
        "root_path": "",
        "headers": [
            (b"host", b"testserver"),
            (b"accept", b"text/event-stream"),
            (b"authorization", b"Bearer plrm_live_valid"),
        ],
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
    }

    async with app.router.lifespan_context(app):
        with anyio.fail_after(1):
            await app(scope, receive, send)

    assert any(
        message["type"] == "http.response.start" and message["status"] == 200
        for message in sent
    )
    assert "Unexpected message received" not in caplog.text


@pytest.mark.asyncio
async def test_mcp_auth_context_isolated_between_concurrent_requests(monkeypatch):
    from app.mcp import auth

    agents = {
        "plrm_live_alpha": _agent("agent-alpha", "alpha"),
        "plrm_live_beta": _agent("agent-beta", "beta"),
    }
    monkeypatch.setattr(auth, "validate_api_key", lambda api_key: agents[api_key])

    async def show_principal(scope, receive, send):
        await anyio.sleep(0.01)
        principal = auth.get_mcp_principal()
        response = JSONResponse(
            {"agent_id": principal.agent["id"], "client": principal.client}
        )
        await response(scope, receive, send)

    app = auth.MCPAPIKeyAuthMiddleware(show_principal)

    async def request(api_key: str, client_name: str) -> dict:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
            headers={
                "Authorization": f"Bearer {api_key}",
                "X-Plurum-Client": client_name,
            },
        ) as client:
            response = await client.get("/")
            response.raise_for_status()
            return response.json()

    alpha, beta = await asyncio.gather(
        request("plrm_live_alpha", "claude-code"),
        request("plrm_live_beta", "codex"),
    )

    assert alpha == {"agent_id": "agent-alpha", "client": "claude-code"}
    assert beta == {"agent_id": "agent-beta", "client": "codex"}
    assert auth.get_mcp_principal(required=False) is None


@pytest.mark.asyncio
async def test_fastmcp_concurrent_searches_keep_separate_identities(monkeypatch):
    from app.main import create_app
    from app.mcp import auth, tools

    agents = {
        "plrm_live_alpha": _agent("agent-alpha", "alpha"),
        "plrm_live_beta": _agent("agent-beta", "beta"),
    }
    monkeypatch.setattr(auth, "validate_api_key", lambda api_key: agents[api_key])

    class StubExperienceService:
        def search(self, *, query, **_kwargs):
            return {
                "total_found": 1,
                "results": [
                    {
                        "id": f"experience-{query}",
                        "short_id": query,
                        "goal": query,
                        "similarity": 0.9,
                    }
                ],
            }

    events = []
    monkeypatch.setattr(tools, "ExperienceService", StubExperienceService)
    monkeypatch.setattr(
        tools,
        "log_event",
        lambda event_type, **kwargs: events.append({"event_type": event_type, **kwargs}),
    )
    app = create_app()

    async def call(api_key: str, client_name: str, query: str):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
            headers={
                "Authorization": f"Bearer {api_key}",
                "X-Plurum-Client": client_name,
            },
        ) as http_client:
            async with streamable_http_client(
                "http://testserver/mcp",
                http_client=http_client,
            ) as (read_stream, write_stream, _):
                async with ClientSession(read_stream, write_stream) as session:
                    await session.initialize()
                    result = await session.call_tool("plurum_search", {"query": query})
                    return result.structuredContent

    async with app.router.lifespan_context(app):
        alpha, beta = await asyncio.gather(
            call("plrm_live_alpha", "claude-code", "alpha-query"),
            call("plrm_live_beta", "codex", "beta-query"),
        )

    assert alpha is not None and alpha["results"][0]["short_id"] == "alpha-query"
    assert beta is not None and beta["results"][0]["short_id"] == "beta-query"
    assert sorted(
        (
            event["agent_id"],
            event["query"],
            event["metadata"]["client"],
        )
        for event in events
    ) == [
        ("agent-alpha", "alpha-query", "claude-code"),
        ("agent-beta", "beta-query", "codex"),
    ]
