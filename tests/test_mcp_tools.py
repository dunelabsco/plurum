"""Hosted MCP read-tool behavior and service-boundary tests."""

from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager

import httpx
import pytest
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from app.core.exceptions import NotFoundError, RateLimitError


AGENT_ID = "00000000-0000-0000-0000-000000000001"
EXPERIENCE_ID = "10000000-0000-0000-0000-000000000001"


def _agent() -> dict:
    return {
        "id": AGENT_ID,
        "name": "test-agent",
        "is_active": True,
        "api_key_prefix": "plrm_live_test...",
        "rate_limit_tier": "standard",
    }


@asynccontextmanager
async def _mcp_session(app):
    transport = httpx.ASGITransport(app=app)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
            headers={
                "Authorization": "Bearer plrm_live_valid",
                "X-Plurum-Client": "claude-code",
            },
        ) as http_client:
            async with streamable_http_client(
                "http://testserver/mcp",
                http_client=http_client,
            ) as (read_stream, write_stream, _):
                async with ClientSession(read_stream, write_stream) as session:
                    await session.initialize()
                    yield session


def _render_tool_text(result) -> str:
    return " ".join(block.text for block in result.content if hasattr(block, "text"))


@pytest.mark.asyncio
async def test_get_experience_stubs_artifacts_and_get_artifact_returns_full_body(
    monkeypatch,
):
    from app.main import create_app
    from app.mcp import auth, tools
    from plugins.hermes.tools import _GET_EXPERIENCE_REMINDER

    source = "print('café')\n"
    experience = {
        "id": EXPERIENCE_ID,
        "short_id": "read01",
        "goal": "Reuse a proven deployment script",
        "domain": "deployment",
        "context": "A constrained runtime",
        "solution": "Run the attached script.",
        "dead_ends": [{"what": "manual setup", "why": "too brittle"}],
        "artifacts": [
            {
                "language": "python",
                "description": "deployment helper",
                "code": source,
            },
            "legacy malformed entry",
            {"language": "text", "code": ""},
        ],
    }
    service_calls: list[dict] = []

    class StubExperienceService:
        def get(self, identifier, *, viewer_agent_id=None):
            service_calls.append(
                {"identifier": identifier, "viewer_agent_id": viewer_agent_id}
            )
            return experience

    events: list[dict] = []
    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", StubExperienceService)
    monkeypatch.setattr(
        tools,
        "log_event",
        lambda event_type, **kwargs: events.append({"event_type": event_type, **kwargs}),
    )
    app = create_app()

    async with _mcp_session(app) as session:
        detail_result = await session.call_tool(
            "plurum_get_experience",
            {"experience_id": "  read01  "},
        )
        artifact_result = await session.call_tool(
            "plurum_get_artifact",
            {"experience_id": " read01 ", "artifact_index": 0},
        )

    assert detail_result.isError is False
    detail = detail_result.structuredContent
    assert detail is not None
    assert detail["reminder"] == (
        _GET_EXPERIENCE_REMINDER
        + " Artifacts are stubbed — call plurum_get_artifact(experience_id, "
        "artifact_index) for any you need full source on."
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
    assert experience["artifacts"][0]["code"] == source
    assert service_calls == [
        {"identifier": "read01", "viewer_agent_id": AGENT_ID},
        {"identifier": "read01", "viewer_agent_id": AGENT_ID},
    ]
    assert events == [
        {
            "event_type": "get_experience",
            "agent_id": AGENT_ID,
            "experience_id": EXPERIENCE_ID,
            "metadata": {
                "channel": "mcp",
                "client": "claude-code",
                "domain": "deployment",
            },
        },
        {
            "event_type": "get_artifact",
            "agent_id": AGENT_ID,
            "experience_id": EXPERIENCE_ID,
            "metadata": {
                "channel": "mcp",
                "client": "claude-code",
                "artifact_index": 0,
            },
        },
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("identifier", "artifacts", "index", "expected"),
    [
        ("empty", [], 0, "Experience empty has no artifacts."),
        (
            "one",
            [{"language": "text", "code": "one"}],
            1,
            "artifact_index 1 out of range (experience has 1 artifact(s)).",
        ),
    ],
)
async def test_get_artifact_reports_missing_and_out_of_range_indexes(
    monkeypatch,
    identifier,
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

    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", StubExperienceService)
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool(
            "plurum_get_artifact",
            {"experience_id": identifier, "artifact_index": index},
        )

    assert result.isError is True
    assert expected in _render_tool_text(result)


@pytest.mark.asyncio
async def test_get_experience_preserves_masked_not_found_error(monkeypatch):
    from app.main import create_app
    from app.mcp import auth, tools

    class HiddenExperienceService:
        def get(self, identifier, *, viewer_agent_id=None):
            assert viewer_agent_id == AGENT_ID
            raise NotFoundError("Experience", identifier)

    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", HiddenExperienceService)
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool(
            "plurum_get_experience",
            {"experience_id": "private-draft"},
        )

    assert result.isError is True
    assert "Experience not found: private-draft" in _render_tool_text(result)


@pytest.mark.asyncio
async def test_get_experience_never_leaks_malformed_artifact_shapes(monkeypatch):
    from app.main import create_app
    from app.mcp import auth, tools

    secret = "source-that-must-stay-stubbed"
    experiences = {
        "object-artifacts": {
            "id": EXPERIENCE_ID,
            "artifacts": {"code": secret},
        },
        "nested-metadata": {
            "id": EXPERIENCE_ID,
            "artifacts": [
                {
                    "language": {"code": secret},
                    "description": {"code": secret},
                    "code": secret,
                }
            ],
        },
    }

    class MalformedExperienceService:
        def get(self, identifier, *, viewer_agent_id=None):
            assert viewer_agent_id == AGENT_ID
            return experiences[identifier]

    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", MalformedExperienceService)
    monkeypatch.setattr(tools, "log_event", lambda *_args, **_kwargs: None)
    app = create_app()

    async with _mcp_session(app) as session:
        object_result = await session.call_tool(
            "plurum_get_experience",
            {"experience_id": "object-artifacts"},
        )
        nested_result = await session.call_tool(
            "plurum_get_experience",
            {"experience_id": "nested-metadata"},
        )

    assert object_result.isError is False
    assert object_result.structuredContent is not None
    assert object_result.structuredContent["experience"]["artifacts"] == []
    assert nested_result.isError is False
    assert nested_result.structuredContent is not None
    assert nested_result.structuredContent["experience"]["artifacts"] == [
        {
            "index": 0,
            "language": None,
            "description": None,
            "bytes": 29,
            "lines": 1,
        }
    ]
    assert secret not in json.dumps(object_result.structuredContent)
    assert secret not in json.dumps(nested_result.structuredContent)


@pytest.mark.asyncio
async def test_get_artifact_redacts_unexpected_service_errors(monkeypatch, caplog):
    from app.main import create_app
    from app.mcp import auth, tools

    secret = "plrm_live_read_error_secret"

    class FailingExperienceService:
        def get(self, _identifier, *, viewer_agent_id=None):
            raise RuntimeError(f"provider included {secret}")

    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", FailingExperienceService)
    caplog.set_level(logging.ERROR)
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool(
            "plurum_get_artifact",
            {"experience_id": "read01", "artifact_index": 0},
        )

    rendered = _render_tool_text(result)
    assert result.isError is True
    assert "Get artifact failed. Reference:" in rendered
    assert secret not in rendered
    assert secret not in caplog.text


@pytest.mark.asyncio
async def test_mcp_read_rate_limit_stops_before_service_call(monkeypatch):
    from app.main import create_app
    from app.mcp import auth, tools

    class UnexpectedExperienceService:
        def get(self, _identifier, *, viewer_agent_id=None):
            raise AssertionError("rate-limited reads must not query storage")

    def reject_read(**_kwargs):
        raise RateLimitError(retry_after=23)

    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", UnexpectedExperienceService)
    monkeypatch.setattr(tools, "enforce_agent_rate_limit", reject_read)
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool(
            "plurum_get_experience",
            {"experience_id": "read01"},
        )

    assert result.isError is True
    assert "Rate limit exceeded; retry after 23 seconds." in _render_tool_text(result)


@pytest.mark.asyncio
async def test_read_tools_reject_whitespace_identifier_and_negative_index(monkeypatch):
    from app.main import create_app
    from app.mcp import auth

    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    app = create_app()

    async with _mcp_session(app) as session:
        blank = await session.call_tool(
            "plurum_get_experience",
            {"experience_id": "   "},
        )
        negative = await session.call_tool(
            "plurum_get_artifact",
            {"experience_id": "read01", "artifact_index": -1},
        )
        oversized = await session.call_tool(
            "plurum_get_experience",
            {"experience_id": "x" * 65},
        )

    assert blank.isError is True
    assert "experience_id must contain non-whitespace characters" in _render_tool_text(blank)
    assert negative.isError is True
    assert "greater than or equal to 0" in _render_tool_text(negative)
    assert oversized.isError is True
    assert "at most 64 characters" in _render_tool_text(oversized)
