"""OAuth-enabled hosted MCP transport integration tests.

These tests deliberately stub the SDK TokenVerifier boundary. Signature and
claim verification belongs to the verifier's focused unit tests; this module
locks down how a verified token is connected to FastMCP, discovery, and the
request-local Plurum principal without making network calls.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from threading import Barrier
from time import time
from typing import Awaitable, Callable

import anyio
import httpx
import pytest
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.server.auth.provider import AccessToken
from mcp.types import LATEST_PROTOCOL_VERSION

from app.config import get_settings


_RESOURCE = "https://mcp.plurum.ai/mcp"
_RESOURCE_METADATA = "https://mcp.plurum.ai/.well-known/oauth-protected-resource/mcp"
_ISSUER = "https://test.supabase.co/auth/v1"
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
_INITIALIZE_REQUEST = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": LATEST_PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": {"name": "plurum-oauth-transport-tests", "version": "1.0"},
    },
}

VerifyStub = Callable[[object, str], Awaitable[AccessToken | None]]


def _oauth_settings():
    """Return production-like settings with only hosted MCP OAuth enabled."""
    return get_settings().model_copy(
        update={
            "environment": "production",
            "debug": False,
            "mcp_enabled": True,
            "mcp_oauth_enabled": True,
            "mcp_oauth_resource_url": _RESOURCE,
            "mcp_oauth_issuer_url": _ISSUER,
            "mcp_oauth_max_bearer_token_bytes": 8 * 1024,
            "mcp_allowed_hosts": ["mcp.plurum.ai"],
            "mcp_allowed_origins": [],
            # Keep the ordinary REST CORS policy restrictive so the metadata
            # preflight assertion exercises its dedicated public CORS path.
            "allowed_origins": ["https://plurum.ai"],
        }
    )


def _oauth_application(monkeypatch: pytest.MonkeyPatch, verify: VerifyStub):
    """Create an OAuth-enabled app with a fully local verifier seam."""
    from app import main as main_module
    from app.mcp.token_verifier import PlurumMCPTokenVerifier

    monkeypatch.setattr(main_module, "get_settings", _oauth_settings)
    monkeypatch.setattr(PlurumMCPTokenVerifier, "verify_token", verify)
    return main_module.create_app()


def _verified_api_key(*, token: str, agent_id: str) -> AccessToken:
    return AccessToken(
        token=token,
        client_id=f"plurum-api-key:{agent_id}",
        scopes=[],
        expires_at=int(time()) + 3600,
        subject=agent_id,
        claims={
            "plurum_agent_id": agent_id,
            "auth_method": "api_key",
        },
    )


def _verified_oauth_token(
    *,
    token: str,
    agent_id: str,
    owner_user_id: str,
    client_id: str,
) -> AccessToken:
    return AccessToken(
        token=token,
        client_id=client_id,
        scopes=[],
        expires_at=int(time()) + 3600,
        resource=_RESOURCE,
        subject=owner_user_id,
        claims={
            "plurum_agent_id": agent_id,
            "auth_method": "oauth",
            "iss": _ISSUER,
        },
    )


async def _post_initialize(application, authorization: str | None = None):
    headers = {"Accept": _MCP_ACCEPT}
    if authorization is not None:
        headers["Authorization"] = authorization

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="https://mcp.plurum.ai",
        follow_redirects=False,
    ) as client:
        return await client.post("/mcp", json=_INITIALIZE_REQUEST, headers=headers)


@asynccontextmanager
async def _mcp_session(application, *, token: str, client_name: str):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="https://mcp.plurum.ai",
        headers={
            "Authorization": f"Bearer {token}",
            "X-Plurum-Client": client_name,
        },
        follow_redirects=False,
    ) as http_client:
        async with streamable_http_client(
            _RESOURCE,
            http_client=http_client,
        ) as (read_stream, write_stream, _):
            async with ClientSession(read_stream, write_stream) as session:
                initialization = await session.initialize()
                yield session, initialization


@pytest.mark.asyncio
async def test_oauth_metadata_is_exact_public_cached_and_cors_enabled(monkeypatch):
    verifier_calls: list[str] = []

    async def unexpected_verifier(_self, token: str) -> AccessToken | None:
        verifier_calls.append(token)
        raise AssertionError("public resource metadata reached the token verifier")

    application = _oauth_application(monkeypatch, unexpected_verifier)
    origin = "https://inspector.modelcontextprotocol.io"

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="https://mcp.plurum.ai",
        follow_redirects=False,
    ) as client:
        metadata = await client.get(
            "/.well-known/oauth-protected-resource/mcp",
            headers={
                "Authorization": "Bearer arbitrary-public-metadata-token",
                "Origin": origin,
                "MCP-Protocol-Version": LATEST_PROTOCOL_VERSION,
            },
        )
        preflight = await client.options(
            "/.well-known/oauth-protected-resource/mcp",
            headers={
                "Authorization": "Bearer another-arbitrary-metadata-token",
                "Origin": origin,
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "MCP-Protocol-Version",
            },
        )
        root_alias = await client.get("/.well-known/oauth-protected-resource")

    assert metadata.status_code == 200
    assert metadata.headers["content-type"].startswith("application/json")
    assert metadata.headers["cache-control"] == "public, max-age=3600"
    assert metadata.headers["access-control-allow-origin"] == "*"
    assert metadata.json() == {
        "resource": _RESOURCE,
        "authorization_servers": [_ISSUER],
        "bearer_methods_supported": ["header"],
    }

    assert preflight.status_code == 200
    assert preflight.headers["access-control-allow-origin"] == "*"
    assert "GET" in preflight.headers["access-control-allow-methods"]
    assert "mcp-protocol-version" in preflight.headers["access-control-allow-headers"].lower()

    assert root_alias.status_code == 404
    assert verifier_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "authorization",
    [
        None,
        "Basic private-value",
        "Bearer invalid-private-value",
        "Bearer " + ("x" * (8 * 1024 + 1)),
    ],
)
async def test_oauth_authentication_failures_return_generic_discovery_challenge(
    monkeypatch,
    authorization,
):
    async def reject_token(_self, _token: str) -> AccessToken | None:
        return None

    application = _oauth_application(monkeypatch, reject_token)
    response = await _post_initialize(application, authorization)

    assert response.status_code == 401
    assert response.json() == {
        "error": "invalid_token",
        "error_description": "Authentication required",
    }
    assert response.headers["www-authenticate"] == (
        'Bearer error="invalid_token", '
        'error_description="Authentication required", '
        f'resource_metadata="{_RESOURCE_METADATA}"'
    )
    assert response.headers["cache-control"] == "no-store"
    assert "private-value" not in response.text
    assert "private-value" not in response.headers["www-authenticate"]


@pytest.mark.asyncio
async def test_api_key_and_oauth_tokens_share_the_exact_surface_and_isolated_principals(
    monkeypatch,
):
    from app.mcp import tools as mcp_tools

    api_token = "plrm_live_transport_dual_api_key"
    oauth_token = "header.payload.signature"
    api_agent_id = "11111111-1111-4111-8111-111111111111"
    oauth_agent_id = "22222222-2222-4222-8222-222222222222"
    owner_user_id = "33333333-3333-4333-8333-333333333333"
    oauth_client_id = "codex-dynamic-client"
    verified = {
        api_token: _verified_api_key(token=api_token, agent_id=api_agent_id),
        oauth_token: _verified_oauth_token(
            token=oauth_token,
            agent_id=oauth_agent_id,
            owner_user_id=owner_user_id,
            client_id=oauth_client_id,
        ),
    }

    async def verify_token(_self, token: str) -> AccessToken | None:
        return verified.get(token)

    # Force both tool calls to overlap in worker threads. If either request's
    # auth/client ContextVar leaks into the other, the captured tuples expose it.
    overlap = Barrier(2, timeout=3)
    observed: list[tuple[str, str, str]] = []

    def capture_search(query: str, _limit: int, agent_id: str, client: str):
        overlap.wait()
        observed.append((query, agent_id, client))
        return {"query": query, "results": [], "count": 0}

    monkeypatch.setattr(mcp_tools, "_run_search", capture_search)
    application = _oauth_application(monkeypatch, verify_token)
    discovered_tools: dict[str, list[str]] = {}

    async def exercise(
        label: str,
        token: str,
        client_name: str,
    ) -> None:
        async with _mcp_session(
            application,
            token=token,
            client_name=client_name,
        ) as (session, initialization):
            assert initialization.serverInfo.name == "Plurum"
            discovered_tools[label] = [tool.name for tool in (await session.list_tools()).tools]
            result = await session.call_tool(
                "plurum_search",
                {"query": f"{label} retry guidance", "limit": 1},
            )
            assert result.isError is not True

    async with application.router.lifespan_context(application):
        with anyio.fail_after(8):
            async with anyio.create_task_group() as task_group:
                task_group.start_soon(
                    exercise,
                    "api-key",
                    api_token,
                    "claude-code",
                )
                task_group.start_soon(
                    exercise,
                    "oauth",
                    oauth_token,
                    "codex",
                )

    assert discovered_tools == {
        "api-key": _TOOL_NAMES,
        "oauth": _TOOL_NAMES,
    }
    assert sorted(observed) == [
        ("api-key retry guidance", api_agent_id, "claude-code"),
        ("oauth retry guidance", oauth_agent_id, "codex"),
    ]
