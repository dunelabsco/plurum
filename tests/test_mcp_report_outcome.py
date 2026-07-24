"""Hosted MCP outcome-report behavior and safety tests."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from unittest.mock import MagicMock, call
from uuid import UUID

import httpx
import pytest
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from app.core.exceptions import NotFoundError, PlurimException, RateLimitError


AGENT_ID = "00000000-0000-0000-0000-000000000011"
EXPERIENCE_ID = "10000000-0000-0000-0000-000000000011"
REPORT_ID = "20000000-0000-0000-0000-000000000011"
SECRET = "plrm_live_outcome_secret_123456789"
LONG_NOTE = "0123456789" * 60


def _agent() -> dict:
    return {
        "id": AGENT_ID,
        "name": "outcome-agent",
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
                "X-Plurum-Client": "codex",
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
@pytest.mark.parametrize(
    ("raw_outcome", "note", "expected_success", "expected_context_notes"),
    [
        (" SUCCESS ", None, True, None),
        (" PaRtIaL ", None, False, "outcome=partial"),
        (
            "failure",
            LONG_NOTE,
            False,
            f"outcome=failure | {LONG_NOTE[:500]}",
        ),
        ("success", "  worked with the documented flag  ", True, "  worked with the documented flag  "),
    ],
    ids=["success", "partial", "failure-long-note", "success-note"],
)
async def test_report_outcome_maps_plugin_contract_and_logs_safe_event(
    monkeypatch,
    raw_outcome,
    note,
    expected_success,
    expected_context_notes,
):
    from app.core.rate_limiter import EXPERIENCE_FEEDBACK_SCOPE
    from app.main import create_app
    from app.mcp import auth, tools

    rate_calls: list[dict] = []
    service_calls: list[dict] = []
    events: list[dict] = []

    class StubExperienceService:
        def __init__(self):
            assert len(rate_calls) == 1

        def report_outcome(self, **kwargs):
            service_calls.append(kwargs)
            return {
                "id": REPORT_ID,
                "experience_id": EXPERIENCE_ID,
                "success": kwargs["success"],
            }

    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", StubExperienceService)
    monkeypatch.setattr(
        tools,
        "enforce_agent_rate_limit",
        lambda **kwargs: rate_calls.append(kwargs),
    )
    monkeypatch.setattr(
        tools,
        "log_event",
        lambda event_type, **kwargs: events.append({"event_type": event_type, **kwargs}),
    )
    app = create_app()
    arguments = {
        "experience_id": "  outcome01  ",
        "outcome": raw_outcome,
    }
    if note is not None:
        arguments["note"] = note

    async with _mcp_session(app) as session:
        result = await session.call_tool("plurum_report_outcome", arguments)

    normalized_outcome = raw_outcome.strip().lower()
    assert result.isError is False
    assert result.structuredContent == {
        "result": "Outcome recorded.",
        "id": "outcome01",
    }
    assert rate_calls == [
        {
            "agent_id": AGENT_ID,
            "rate_limit": tools.get_settings().rate_limit_feedback,
            "scope": EXPERIENCE_FEEDBACK_SCOPE,
        }
    ]
    assert service_calls == [
        {
            "identifier": "outcome01",
            "agent_id": UUID(AGENT_ID),
            "success": expected_success,
            "context_notes": expected_context_notes,
        }
    ]
    assert events == [
        {
            "event_type": "report_outcome",
            "agent_id": AGENT_ID,
            "experience_id": EXPERIENCE_ID,
            "metadata": {
                "channel": "mcp",
                "client": "codex",
                "outcome": normalized_outcome,
                "success": expected_success,
            },
        }
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "arguments",
    [
        {},
        {"experience_id": "   ", "outcome": "success"},
        {"experience_id": "outcome01", "outcome": "unknown"},
        {"experience_id": "outcome01", "outcome": "success", "note": 42},
        {"experience_id": "x" * 65, "outcome": "success"},
    ],
    ids=["missing", "blank-id", "bad-outcome", "bad-note", "long-id"],
)
async def test_report_outcome_rejects_invalid_input_before_rate_or_service(
    monkeypatch,
    arguments,
):
    from app.main import create_app
    from app.mcp import auth, tools

    service_factory = MagicMock(
        side_effect=AssertionError("invalid input must not reach service work")
    )
    limiter = MagicMock()
    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", service_factory)
    monkeypatch.setattr(tools, "enforce_agent_rate_limit", limiter)
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool("plurum_report_outcome", arguments)

    assert result.isError is True
    assert (
        "Need experience_id and outcome in {success, partial, failure}."
        in _render_tool_text(result)
    )
    service_factory.assert_not_called()
    limiter.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "arguments",
    [
        {"note": SECRET},
        {
            "experience_id": "outcome01",
            "outcome": "success",
            "note": {"secret": SECRET},
        },
        {
            "experience_id": {"secret": SECRET},
            "outcome": "success",
        },
        {
            "experience_id": "outcome01",
            "outcome": SECRET,
        },
        {
            "experience_id": "outcome01",
            "outcome": "failure",
            "note": ("x" * 501) + SECRET,
        },
        {
            "experience_id": "outcome01",
            "outcome": "success",
            "note": {SECRET: "not a key"},
        },
    ],
    ids=[
        "missing-required",
        "malformed-note",
        "malformed-id",
        "outcome-value",
        "secret-after-truncation",
        "secret-field-name",
    ],
)
async def test_report_outcome_malformed_input_never_echoes_credentials(
    monkeypatch,
    caplog,
    arguments,
):
    from app.main import create_app
    from app.mcp import auth, tools

    service_factory = MagicMock(
        side_effect=AssertionError("secret-bearing input must not reach service work")
    )
    limiter = MagicMock()
    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", service_factory)
    monkeypatch.setattr(tools, "enforce_agent_rate_limit", limiter)
    caplog.set_level(logging.ERROR)
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool("plurum_report_outcome", arguments)

    rendered = _render_tool_text(result)
    assert result.isError is True
    assert SECRET not in rendered
    assert SECRET not in caplog.text
    service_factory.assert_not_called()
    limiter.assert_not_called()


@pytest.mark.asyncio
async def test_report_outcome_rate_limit_stops_before_service_work(monkeypatch):
    from app.main import create_app
    from app.mcp import auth, tools

    service_factory = MagicMock(
        side_effect=AssertionError("rate limit must stop service work")
    )
    events: list[dict] = []
    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", service_factory)
    monkeypatch.setattr(
        tools,
        "enforce_agent_rate_limit",
        lambda **_kwargs: (_ for _ in ()).throw(RateLimitError(retry_after=23)),
    )
    monkeypatch.setattr(
        tools,
        "log_event",
        lambda event_type, **kwargs: events.append({"event_type": event_type, **kwargs}),
    )
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool(
            "plurum_report_outcome",
            {"experience_id": "outcome01", "outcome": "partial"},
        )

    assert result.isError is True
    assert "Rate limit exceeded; retry after 23 seconds." in _render_tool_text(result)
    service_factory.assert_not_called()
    assert events == []


@pytest.mark.asyncio
async def test_report_outcome_preserves_private_not_found_without_event(monkeypatch):
    from app.main import create_app
    from app.mcp import auth, tools

    class HiddenExperienceService:
        def report_outcome(self, **_kwargs):
            raise NotFoundError("Experience", "private1")

    events: list[dict] = []
    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", HiddenExperienceService)
    monkeypatch.setattr(
        tools,
        "log_event",
        lambda event_type, **kwargs: events.append({"event_type": event_type, **kwargs}),
    )
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool(
            "plurum_report_outcome",
            {"experience_id": "private1", "outcome": "failure"},
        )

    assert result.isError is True
    assert "Experience not found: private1" in _render_tool_text(result)
    assert events == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure_type",
    [RuntimeError, PlurimException],
    ids=["runtime", "plurum"],
)
async def test_report_outcome_ambiguous_failure_is_redacted_and_retryable(
    monkeypatch,
    caplog,
    failure_type,
):
    from app.main import create_app
    from app.mcp import auth, tools

    class FailingExperienceService:
        def report_outcome(self, **_kwargs):
            raise failure_type(f"provider included {SECRET}")

    events: list[dict] = []
    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", FailingExperienceService)
    monkeypatch.setattr(
        tools,
        "log_event",
        lambda event_type, **kwargs: events.append({"event_type": event_type, **kwargs}),
    )
    caplog.set_level(logging.ERROR)
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool(
            "plurum_report_outcome",
            {"experience_id": "outcome01", "outcome": "success"},
        )

    rendered = _render_tool_text(result)
    assert result.isError is True
    assert "Outcome report could not be confirmed" in rendered
    assert "with the same values is safe" in rendered
    assert "Reference:" in rendered
    assert SECRET not in rendered
    assert SECRET not in caplog.text
    assert events == []


def test_service_rereport_clears_stale_optional_fields_and_recalculates():
    from app.services.experience_service import ExperienceService

    agent_id = UUID(AGENT_ID)
    service = ExperienceService.__new__(ExperienceService)
    service.repo = MagicMock()
    service.repo.get_by_identifier.return_value = {
        "id": EXPERIENCE_ID,
        "agent_id": "00000000-0000-0000-0000-000000000099",
        "status": "published",
        "visibility": "public",
    }
    service.repo.upsert_outcome_report.side_effect = lambda data: {
        "id": REPORT_ID,
        **data,
    }

    first = service.report_outcome(
        "outcome01",
        agent_id,
        success=False,
        execution_time_ms=900,
        error_message="old failure",
        context_notes="outcome=partial | old note",
        env_fingerprint={"runtime": "python"},
    )
    second = service.report_outcome(
        "outcome01",
        agent_id,
        success=True,
    )

    assert first["success"] is False
    assert second["success"] is True
    expected_common = {
        "experience_id": EXPERIENCE_ID,
        "agent_id": AGENT_ID,
    }
    assert service.repo.upsert_outcome_report.call_args_list == [
        call(
            {
                **expected_common,
                "success": False,
                "execution_time_ms": 900,
                "error_message": "old failure",
                "context_notes": "outcome=partial | old note",
                "env_fingerprint": {"runtime": "python"},
            }
        ),
        call(
            {
                **expected_common,
                "success": True,
                "execution_time_ms": None,
                "error_message": None,
                "context_notes": None,
                "env_fingerprint": None,
            }
        ),
    ]
    assert service.repo.update_quality_score.call_args_list == [
        call(UUID(EXPERIENCE_ID)),
        call(UUID(EXPERIENCE_ID)),
    ]
