"""Hosted MCP read-tool contract, privacy, and safety tests."""

from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager
from unittest.mock import MagicMock

import httpx
import pytest
from mcp import ClientSession, McpError
from mcp.client.streamable_http import streamable_http_client

from app.core.exceptions import NotFoundError

AGENT_ID = "00000000-0000-0000-0000-000000000001"
OTHER_AGENT_ID = "00000000-0000-0000-0000-000000000002"
EXPERIENCE_ID = "10000000-0000-0000-0000-000000000001"
READ_TOOL_NAMES = [
    "plurum_search",
    "plurum_get_experience",
    "plurum_get_artifact",
]


def _agent(agent_id: str = AGENT_ID) -> dict:
    return {"id": agent_id, "is_active": True}


@asynccontextmanager
async def _mcp_session(application, api_key: str = "plrm_live_synthetic_valid"):
    async with application.router.lifespan_context(application):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url="http://testserver",
            headers={
                "Authorization": f"Bearer {api_key}",
                "X-Plurum-Client": "codex",
            },
            follow_redirects=False,
        ) as http_client:
            async with streamable_http_client(
                "http://testserver/mcp",
                http_client=http_client,
            ) as (read_stream, write_stream, _):
                async with ClientSession(read_stream, write_stream) as session:
                    await session.initialize()
                    yield session


def _tool_text(result) -> str:
    return " ".join(
        block.text for block in result.content if hasattr(block, "text")
    )


def _row(
    *,
    identifier: str,
    owner: str,
    visibility: str = "public",
    status: str = "published",
) -> dict:
    return {
        "id": f"10000000-0000-0000-0000-{identifier[-12:]:0>12}",
        "short_id": identifier,
        "agent_id": owner,
        "goal": f"Goal for {identifier}",
        "domain": "testing",
        "status": status,
        "visibility": visibility,
        "solution": f"Solution for {identifier}",
        "artifacts": [
            {
                "language": "python",
                "description": f"Artifact for {identifier}",
                "code": "print('safe synthetic fixture')\n",
            }
        ],
    }


@pytest.mark.asyncio
async def test_inventory_keeps_three_bounded_read_tools(monkeypatch):
    from app.main import create_app
    from app.mcp import auth

    monkeypatch.setattr(auth, "validate_api_key", lambda _key: _agent())

    async with _mcp_session(create_app()) as session:
        inventory = await session.list_tools()

    read_tools = inventory.tools[:3]
    assert [tool.name for tool in read_tools] == READ_TOOL_NAMES
    by_name = {tool.name: tool for tool in inventory.tools}
    for tool in read_tools:
        assert tool.annotations is not None
        assert tool.annotations.readOnlyHint is True
        assert tool.annotations.destructiveHint is False
        assert tool.annotations.idempotentHint is True
        assert tool.annotations.openWorldHint is False
        assert tool.outputSchema is not None
        assert tool.outputSchema["type"] == "object"

    search_schema = by_name["plurum_search"].inputSchema
    assert search_schema["required"] == ["query"]
    assert search_schema["properties"]["query"]["minLength"] == 2
    assert search_schema["properties"]["query"]["maxLength"] == 1000
    assert search_schema["properties"]["limit"] == {
        "default": 10,
        "description": "Max results (default 10, max 30).",
        "maximum": 30,
        "minimum": 1,
        "title": "Limit",
        "type": "integer",
    }

    detail_schema = by_name["plurum_get_experience"].inputSchema
    assert detail_schema["required"] == ["experience_id"]
    assert detail_schema["properties"]["experience_id"]["minLength"] == 1
    assert detail_schema["properties"]["experience_id"]["maxLength"] == 64

    artifact_schema = by_name["plurum_get_artifact"].inputSchema
    assert set(artifact_schema["required"]) == {"experience_id", "artifact_index"}
    assert artifact_schema["properties"]["experience_id"]["maxLength"] == 64
    assert artifact_schema["properties"]["artifact_index"]["minimum"] == 0


@pytest.mark.asyncio
async def test_search_matches_shared_plugin_contract_and_trims_heavy_fields(
    monkeypatch,
):
    from app.main import create_app
    from app.mcp import auth, tools

    calls: list[dict] = []

    class StubExperienceService:
        def search(self, **kwargs):
            calls.append(kwargs)
            return {
                "total_found": 1,
                "results": [
                    {
                        "id": EXPERIENCE_ID,
                        "short_id": "search01",
                        "goal": "Deploy a FastAPI service",
                        "domain": "devops",
                        "tags": ["fastapi"],
                        "trust_score": 0.8,
                        "similarity": 0.91,
                        "created_at": "2026-07-26T00:00:00Z",
                        "solution": "heavy field must stay out of search",
                        "context": "heavy context",
                        "artifacts": [{"code": "heavy source"}],
                    }
                ],
            }

    monkeypatch.setattr(auth, "validate_api_key", lambda _key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", StubExperienceService)

    async with _mcp_session(create_app()) as session:
        result = await session.call_tool(
            "plurum_search",
            {"query": "  deploy fastapi  ", "limit": 5},
        )

    assert result.isError is False
    assert result.structuredContent == {
        "reminder": (
            "If you apply one of these, report its outcome with "
            "plurum_report_outcome (success/partial/failure) through the host's "
            "normal write-approval flow. If the task later materially pivots to a "
            "different site, store, or platform, search again; relevance is per domain."
        ),
        "query": "deploy fastapi",
        "results": [
            {
                "id": EXPERIENCE_ID,
                "short_id": "search01",
                "goal": "Deploy a FastAPI service",
                "domain": "devops",
                "tags": ["fastapi"],
                "trust_score": 0.8,
                "similarity": 0.91,
                "created_at": "2026-07-26T00:00:00Z",
            }
        ],
        "count": 1,
    }
    assert json.loads(_tool_text(result)) == result.structuredContent
    assert calls == [{"query": "deploy fastapi", "limit": 5}]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("results", "expected_top"),
    [
        ([], 0.0),
        ([{"id": "low", "similarity": 0.3996}], 0.4),
    ],
)
async def test_search_uses_explicit_no_prior_experience_shape(
    monkeypatch,
    results,
    expected_top,
):
    from app.main import create_app
    from app.mcp import auth, tools

    class StubExperienceService:
        def search(self, **_kwargs):
            return {"total_found": len(results), "results": results}

    monkeypatch.setattr(auth, "validate_api_key", lambda _key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", StubExperienceService)

    async with _mcp_session(create_app()) as session:
        result = await session.call_tool(
            "plurum_search",
            {"query": "unseen synthetic issue"},
        )

    assert result.isError is False
    assert result.structuredContent == {
        "reminder": (
            "No relevant prior experiences were found. Continue the task normally. "
            "If the completed solution becomes verified, reusable, non-private "
            "knowledge, consider plurum_publish through the host's normal "
            "write-approval flow."
        ),
        "query": "unseen synthetic issue",
        "results": [],
        "top_similarity": expected_top,
        "count": 0,
    }


@pytest.mark.asyncio
async def test_search_response_stays_within_requested_limit(monkeypatch):
    from app.main import create_app
    from app.mcp import auth, tools

    class OverReturningExperienceService:
        def search(self, **_kwargs):
            results = [
                {
                    "id": f"experience-{index}",
                    "goal": f"Result {index}",
                    "similarity": 0.9,
                }
                for index in range(40)
            ]
            return {"total_found": len(results), "results": results}

    monkeypatch.setattr(auth, "validate_api_key", lambda _key: _agent())
    monkeypatch.setattr(
        tools,
        "ExperienceService",
        OverReturningExperienceService,
    )

    async with _mcp_session(create_app()) as session:
        result = await session.call_tool(
            "plurum_search",
            {"query": "bounded synthetic results", "limit": 3},
        )

    assert result.isError is False
    assert len(result.structuredContent["results"]) == 3
    assert result.structuredContent["count"] == 3


@pytest.mark.asyncio
async def test_detail_stubs_artifacts_and_artifact_fetch_returns_selected_source(
    monkeypatch,
):
    from app.main import create_app
    from app.mcp import auth, tools

    source = "print('café')\n"
    experience = {
        "id": EXPERIENCE_ID,
        "short_id": "read01",
        "goal": "Reuse a proven deployment script",
        "solution": "Run the attached script.",
        "dead_ends": [{"what": "manual setup", "why": "too brittle"}],
        "artifacts": [
            {
                "language": "python",
                "description": "deployment helper",
                "code": source,
            },
            "malformed legacy entry",
            {
                "language": "text",
                "description": {"source": "must not leak through metadata"},
                "code": "",
            },
        ],
    }
    calls: list[dict] = []
    malformed_source = "legacy source that must stay hidden"

    class StubExperienceService:
        def get(self, identifier, *, viewer_agent_id=None):
            calls.append(
                {"identifier": identifier, "viewer_agent_id": viewer_agent_id}
            )
            if identifier == "malformed":
                return {
                    "id": EXPERIENCE_ID,
                    "artifacts": {"code": malformed_source},
                }
            return experience

    monkeypatch.setattr(auth, "validate_api_key", lambda _key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", StubExperienceService)

    async with _mcp_session(create_app()) as session:
        detail_result = await session.call_tool(
            "plurum_get_experience",
            {"experience_id": "  read01  "},
        )
        artifact_result = await session.call_tool(
            "plurum_get_artifact",
            {"experience_id": " read01 ", "artifact_index": 0},
        )
        malformed_result = await session.call_tool(
            "plurum_get_experience",
            {"experience_id": "malformed"},
        )

    assert detail_result.isError is False
    detail = detail_result.structuredContent
    assert detail is not None
    assert detail["reminder"] == (
        "If you apply this experience, report its outcome with "
        "plurum_report_outcome (success/partial/failure plus a short factual "
        "note) through the host's normal write-approval flow. Artifacts are "
        "stubbed; call plurum_get_artifact(experience_id, artifact_index) only "
        "for source you need to inspect."
    )
    assert detail["experience"]["goal"] == experience["goal"]
    assert detail["experience"]["solution"] == experience["solution"]
    assert detail["experience"]["artifacts"] == [
        {
            "index": 0,
            "language": "python",
            "description": "deployment helper",
            "bytes": len(source),
            "lines": 2,
        },
        {
            "index": 2,
            "language": "text",
            "description": None,
            "bytes": 0,
            "lines": 0,
        },
    ]
    assert source not in json.dumps(detail)
    assert artifact_result.isError is False
    assert artifact_result.structuredContent == {
        "experience_id": "read01",
        "artifact_index": 0,
        "artifact": experience["artifacts"][0],
    }
    assert malformed_result.isError is False
    assert malformed_result.structuredContent["experience"]["artifacts"] == []
    assert malformed_source not in json.dumps(malformed_result.structuredContent)
    assert calls == [
        {"identifier": "read01", "viewer_agent_id": AGENT_ID},
        {"identifier": "read01", "viewer_agent_id": AGENT_ID},
        {"identifier": "malformed", "viewer_agent_id": AGENT_ID},
    ]


@pytest.mark.asyncio
async def test_real_service_enforces_public_owner_private_and_archived_reads(
    monkeypatch,
    mock_supabase,
):
    from app.main import create_app
    from app.mcp import auth
    from app.repositories.experience_repo import ExperienceRepository

    rows = {
        "public": _row(identifier="public", owner=OTHER_AGENT_ID),
        "private": _row(
            identifier="private",
            owner=AGENT_ID,
            visibility="private",
            status="draft",
        ),
        "archived": _row(
            identifier="archived",
            owner=AGENT_ID,
            status="archived",
        ),
    }

    def get_by_identifier(_repository, identifier):
        try:
            return rows[identifier]
        except KeyError:
            raise NotFoundError("Experience", identifier) from None

    monkeypatch.setattr(
        ExperienceRepository,
        "get_by_identifier",
        get_by_identifier,
    )
    monkeypatch.setattr(
        "app.services.experience_service.get_embedding_service",
        MagicMock,
    )
    keys = {
        "plrm_live_owner_synthetic": _agent(AGENT_ID),
        "plrm_live_other_synthetic": _agent(OTHER_AGENT_ID),
    }
    monkeypatch.setattr(auth, "validate_api_key", lambda key: keys[key])
    application = create_app()

    async with _mcp_session(
        application,
        "plrm_live_owner_synthetic",
    ) as owner_session:
        private = await owner_session.call_tool(
            "plurum_get_experience",
            {"experience_id": "private"},
        )
        private_artifact = await owner_session.call_tool(
            "plurum_get_artifact",
            {"experience_id": "private", "artifact_index": 0},
        )
        archived = await owner_session.call_tool(
            "plurum_get_experience",
            {"experience_id": "archived"},
        )

    application = create_app()
    async with _mcp_session(
        application,
        "plrm_live_other_synthetic",
    ) as other_session:
        public = await other_session.call_tool(
            "plurum_get_experience",
            {"experience_id": "public"},
        )
        hidden_private = await other_session.call_tool(
            "plurum_get_experience",
            {"experience_id": "private"},
        )
        hidden_artifact = await other_session.call_tool(
            "plurum_get_artifact",
            {"experience_id": "private", "artifact_index": 999},
        )
        hidden_archived = await other_session.call_tool(
            "plurum_get_experience",
            {"experience_id": "archived"},
        )

    assert private.isError is False
    assert private.structuredContent["experience"]["status"] == "draft"
    assert private_artifact.isError is False
    assert archived.isError is False
    assert archived.structuredContent["experience"]["status"] == "archived"
    assert public.isError is False
    assert public.structuredContent["experience"]["visibility"] == "public"
    assert hidden_private.isError is True
    assert "Experience not found: private" in _tool_text(hidden_private)
    assert hidden_artifact.isError is True
    assert "Experience not found: private" in _tool_text(hidden_artifact)
    assert "999" not in _tool_text(hidden_artifact)
    assert hidden_archived.isError is True
    assert "Experience not found: archived" in _tool_text(hidden_archived)


@pytest.mark.asyncio
async def test_private_and_missing_errors_are_indistinguishable(monkeypatch, mock_supabase):
    from app.main import create_app
    from app.mcp import auth
    from app.repositories.experience_repo import ExperienceRepository

    state = {
        "row": _row(
            identifier="masked",
            owner=AGENT_ID,
            visibility="private",
            status="draft",
        )
    }

    def get_by_identifier(_repository, identifier):
        if state["row"] is None:
            raise NotFoundError("Experience", identifier)
        return state["row"]

    monkeypatch.setattr(
        ExperienceRepository,
        "get_by_identifier",
        get_by_identifier,
    )
    monkeypatch.setattr(
        "app.services.experience_service.get_embedding_service",
        MagicMock,
    )
    monkeypatch.setattr(auth, "validate_api_key", lambda _key: _agent(OTHER_AGENT_ID))

    async with _mcp_session(create_app()) as session:
        private = await session.call_tool(
            "plurum_get_experience",
            {"experience_id": "masked"},
        )
        state["row"] = None
        missing = await session.call_tool(
            "plurum_get_experience",
            {"experience_id": "masked"},
        )

    assert private.isError is True
    assert missing.isError is True
    assert _tool_text(private) == _tool_text(missing)
    assert "Traceback" not in _tool_text(private)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("tool_name", "arguments", "expected"),
    [
        (
            "plurum_search",
            {"query": "a "},
            "at least 2 non-whitespace characters",
        ),
        (
            "plurum_search",
            {"query": "x" * 1001},
            "at most 1000 characters",
        ),
        (
            "plurum_search",
            {"query": "valid query", "limit": 0},
            "greater than or equal to 1",
        ),
        (
            "plurum_search",
            {"query": "valid query", "limit": "5"},
            "valid integer",
        ),
        (
            "plurum_get_experience",
            {"experience_id": "   "},
            "non-whitespace characters",
        ),
        (
            "plurum_get_experience",
            {"experience_id": "x" * 65},
            "at most 64 characters",
        ),
        (
            "plurum_get_artifact",
            {"experience_id": "read01", "artifact_index": -1},
            "greater than or equal to 0",
        ),
        (
            "plurum_get_artifact",
            {"experience_id": "read01", "artifact_index": 1.5},
            "valid integer",
        ),
    ],
)
async def test_invalid_boundaries_stop_before_service(
    monkeypatch,
    tool_name,
    arguments,
    expected,
):
    from app.main import create_app
    from app.mcp import auth, tools

    service_factory = MagicMock()
    monkeypatch.setattr(auth, "validate_api_key", lambda _key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", service_factory)

    async with _mcp_session(create_app()) as session:
        result = await session.call_tool(tool_name, arguments)

    assert result.isError is True
    assert expected in _tool_text(result)
    service_factory.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("tool_name", "arguments"),
    [
        ("plurum_search", {}),
        ("plurum_get_experience", {}),
        (
            "plurum_get_artifact",
            {"experience_id": "read01"},
        ),
    ],
)
async def test_missing_required_inputs_stop_before_service(
    monkeypatch,
    tool_name,
    arguments,
):
    from app.main import create_app
    from app.mcp import auth, tools

    service_factory = MagicMock()
    monkeypatch.setattr(auth, "validate_api_key", lambda _key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", service_factory)

    async with _mcp_session(create_app()) as session:
        result = await session.call_tool(tool_name, arguments)

    rendered = _tool_text(result)
    assert result.isError is True
    assert "Traceback" not in rendered
    assert "plrm_live_synthetic_valid" not in rendered
    service_factory.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("tool_name", "arguments"),
    [
        (
            "plurum_search",
            {"unexpected": "plrm_live_missing_field_secret_123456789"},
        ),
        (
            "plurum_search",
            {"limit": "plrm_live_missing_field_secret_123456789"},
        ),
        (
            "plurum_get_experience",
            {"unexpected": "plrm_live_missing_field_secret_123456789"},
        ),
        (
            "plurum_get_artifact",
            {
                "experience_id": "read01",
                "unexpected": "plrm_live_missing_field_secret_123456789",
            },
        ),
        (
            "plurum_get_artifact",
            {"artifact_index": "plrm_live_missing_field_secret_123456789"},
        ),
    ],
)
async def test_missing_fields_cannot_trigger_pre_handler_secret_echo(
    monkeypatch,
    caplog,
    tool_name,
    arguments,
):
    from app.main import create_app
    from app.mcp import auth, tools

    secret = "plrm_live_missing_field_secret_123456789"
    service_factory = MagicMock()
    monkeypatch.setattr(auth, "validate_api_key", lambda _key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", service_factory)
    caplog.set_level(logging.ERROR)

    async with _mcp_session(create_app()) as session:
        with pytest.raises(McpError) as captured:
            await session.call_tool(tool_name, arguments)

    rendered = str(captured.value)
    assert rendered == "Invalid request parameters"
    assert secret not in rendered
    assert secret not in caplog.text
    assert "Traceback" not in rendered
    service_factory.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("tool_name", "arguments"),
    [
        (
            "plurum_search",
            {"query": {"nested": "plrm_live_read_secret_123456789"}},
        ),
        (
            "plurum_get_experience",
            {"experience_id": "plrm_live_read_secret_123456789"},
        ),
        (
            "plurum_get_artifact",
            {
                "experience_id": "read01",
                "artifact_index": {"nested": "plrm_live_read_secret_123456789"},
            },
        ),
    ],
)
async def test_raw_arguments_are_scanned_before_validation_without_key_leak(
    monkeypatch,
    caplog,
    tool_name,
    arguments,
):
    from app.main import create_app
    from app.mcp import auth, tools

    secret = "plrm_live_read_secret_123456789"
    service_factory = MagicMock()
    monkeypatch.setattr(auth, "validate_api_key", lambda _key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", service_factory)
    caplog.set_level(logging.ERROR)

    async with _mcp_session(create_app()) as session:
        with pytest.raises(McpError) as captured:
            await session.call_tool(tool_name, arguments)

    rendered = str(captured.value)
    assert rendered == "Invalid request parameters"
    assert secret not in rendered
    assert secret not in caplog.text
    service_factory.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("request_id", "arguments", "escape_secret", "expected_id"),
    [
        (17, "plrm_live_protocol_secret_123456789", False, 17),
        (17, ["plrm_live_protocol_secret_123456789"], False, 17),
        (17, "plrm_live_protocol_secret_123456789", True, 17),
        (
            "plrm_live_protocol_secret_123456789",
            "malformed",
            False,
            None,
        ),
    ],
)
async def test_protocol_validation_cannot_log_secret_bearing_malformed_arguments(
    monkeypatch,
    caplog,
    request_id,
    arguments,
    escape_secret,
    expected_id,
):
    from app.main import create_app
    from app.mcp import auth, tools

    secret = "plrm_live_protocol_secret_123456789"
    service_factory = MagicMock()
    monkeypatch.setattr(auth, "validate_api_key", lambda _key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", service_factory)
    caplog.set_level(logging.DEBUG)
    application = create_app()
    payload = {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "tools/call",
        "params": {
            "name": "plurum_search",
            "arguments": arguments,
        },
    }
    body = json.dumps(payload)
    if escape_secret:
        body = body.replace(secret, secret.replace("_", "\\u005f"))

    async with application.router.lifespan_context(application):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url="http://testserver",
            follow_redirects=False,
        ) as client:
            response = await client.post(
                "/mcp",
                content=body,
                headers={
                    "Accept": "application/json, text/event-stream",
                    "Authorization": "Bearer plrm_live_synthetic_valid",
                    "Content-Type": "application/json",
                },
            )

    assert response.status_code == 200
    assert response.json() == {
        "jsonrpc": "2.0",
        "id": expected_id,
        "error": {
            "code": -32602,
            "message": "Invalid request parameters",
        },
    }
    assert response.headers["cache-control"] == "no-store"
    assert secret not in response.text
    assert secret not in caplog.text
    service_factory.assert_not_called()


@pytest.mark.asyncio
async def test_unexpected_failure_and_legacy_secret_result_are_withheld(
    monkeypatch,
    caplog,
):
    from app.main import create_app
    from app.mcp import auth, tools

    secret = "plrm_live_provider_secret_123456789"

    class FailingExperienceService:
        mode = "raise"

        def get(self, _identifier, *, viewer_agent_id=None):
            assert viewer_agent_id == AGENT_ID
            if self.mode == "raise":
                raise RuntimeError(f"provider included {secret}")
            return {
                "id": EXPERIENCE_ID,
                "goal": f"Legacy content with {secret}",
                "artifacts": [],
            }

    monkeypatch.setattr(auth, "validate_api_key", lambda _key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", FailingExperienceService)
    caplog.set_level(logging.ERROR, logger="app.mcp.tools")

    async with _mcp_session(create_app()) as session:
        unexpected = await session.call_tool(
            "plurum_get_experience",
            {"experience_id": "read01"},
        )
        FailingExperienceService.mode = "legacy"
        withheld = await session.call_tool(
            "plurum_get_experience",
            {"experience_id": "read01"},
        )

    assert unexpected.isError is True
    assert "Get experience failed. Reference:" in _tool_text(unexpected)
    assert "Traceback" not in _tool_text(unexpected)
    assert withheld.isError is True
    assert "Result withheld because it may contain a credential" in _tool_text(withheld)
    assert secret not in _tool_text(unexpected)
    assert secret not in _tool_text(withheld)
    assert secret not in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("artifacts", "index", "expected"),
    [
        ([], 0, "Experience read01 has no artifacts."),
        (
            [{"language": "text", "code": "one"}],
            1,
            "artifact_index 1 out of range (experience has 1 artifact(s)).",
        ),
    ],
)
async def test_artifact_not_found_errors_are_bounded_and_safe(
    monkeypatch,
    artifacts,
    index,
    expected,
):
    from app.main import create_app
    from app.mcp import auth, tools

    class StubExperienceService:
        def get(self, _identifier, *, viewer_agent_id=None):
            assert viewer_agent_id == AGENT_ID
            return {"id": EXPERIENCE_ID, "artifacts": artifacts}

    monkeypatch.setattr(auth, "validate_api_key", lambda _key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", StubExperienceService)

    async with _mcp_session(create_app()) as session:
        result = await session.call_tool(
            "plurum_get_artifact",
            {"experience_id": "read01", "artifact_index": index},
        )

    assert result.isError is True
    assert expected in _tool_text(result)
    assert "Traceback" not in _tool_text(result)
