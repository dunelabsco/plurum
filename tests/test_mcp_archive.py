"""Hosted MCP archive behavior and safety tests."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from unittest.mock import MagicMock, call
from uuid import UUID

import httpx
import pytest
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from app.core.exceptions import (
    AuthorizationError,
    NotFoundError,
    PlurimException,
    RateLimitError,
)


AGENT_ID = "00000000-0000-0000-0000-000000000013"
OTHER_AGENT_ID = "00000000-0000-0000-0000-000000000099"
EXPERIENCE_ID = "10000000-0000-0000-0000-000000000013"
SECRET = "plrm_live_archive_secret_123456789"


def _agent() -> dict:
    return {
        "id": AGENT_ID,
        "name": "archive-agent",
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
async def test_archive_maps_plugin_contract_and_logs_safe_event(monkeypatch):
    from app.core.rate_limiter import EXPERIENCE_ARCHIVE_SCOPE
    from app.main import create_app
    from app.mcp import auth, tools

    rate_calls: list[dict] = []
    service_calls: list[dict] = []
    events: list[dict] = []

    class StubExperienceService:
        def __init__(self):
            assert len(rate_calls) == 1

        def archive(self, **kwargs):
            service_calls.append(kwargs)
            return {
                "id": EXPERIENCE_ID,
                "short_id": "archive1",
                "status": "archived",
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

    async with _mcp_session(app) as session:
        result = await session.call_tool(
            "plurum_archive",
            {"experience_id": "  archive1  "},
        )

    assert result.isError is False
    assert result.structuredContent == {
        "result": "Archived.",
        "id": "archive1",
    }
    assert rate_calls == [
        {
            "agent_id": AGENT_ID,
            "rate_limit": tools.get_settings().rate_limit_experience_write,
            "scope": EXPERIENCE_ARCHIVE_SCOPE,
        }
    ]
    assert service_calls == [
        {
            "identifier": "archive1",
            "agent_id": UUID(AGENT_ID),
        }
    ]
    assert events == [
        {
            "event_type": "archive",
            "agent_id": AGENT_ID,
            "experience_id": EXPERIENCE_ID,
            "metadata": {"channel": "mcp", "client": "codex"},
        }
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "arguments",
    [
        {},
        {"experience_id": "   "},
        {"experience_id": 42},
        {"experience_id": "x" * 65},
    ],
    ids=["missing", "blank", "bad-type", "long-id"],
)
async def test_archive_rejects_invalid_input_before_work(monkeypatch, arguments):
    from app.main import create_app
    from app.mcp import auth, tools

    service_factory = MagicMock(
        side_effect=AssertionError("invalid input must not reach service work")
    )
    limiter = MagicMock()
    event_logger = MagicMock()
    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", service_factory)
    monkeypatch.setattr(tools, "enforce_agent_rate_limit", limiter)
    monkeypatch.setattr(tools, "log_event", event_logger)
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool("plurum_archive", arguments)

    assert result.isError is True
    assert "Missing required parameter: experience_id" in _render_tool_text(result)
    service_factory.assert_not_called()
    limiter.assert_not_called()
    event_logger.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "arguments",
    [
        {"experience_id": SECRET},
        {"experience_id": {"secret": SECRET}},
        {"experience_id": {SECRET: "archive1"}},
    ],
    ids=["value", "nested-value", "secret-field-name"],
)
async def test_archive_malformed_input_never_echoes_credentials(
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
    event_logger = MagicMock()
    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", service_factory)
    monkeypatch.setattr(tools, "enforce_agent_rate_limit", limiter)
    monkeypatch.setattr(tools, "log_event", event_logger)
    caplog.set_level(logging.ERROR)
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool("plurum_archive", arguments)

    rendered = _render_tool_text(result)
    assert result.isError is True
    assert SECRET not in rendered
    assert SECRET not in caplog.text
    service_factory.assert_not_called()
    limiter.assert_not_called()
    event_logger.assert_not_called()


@pytest.mark.asyncio
async def test_archive_rate_limit_stops_before_service_work(monkeypatch):
    from app.main import create_app
    from app.mcp import auth, tools

    service_factory = MagicMock(
        side_effect=AssertionError("rate limit must stop service work")
    )
    event_logger = MagicMock()
    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", service_factory)
    monkeypatch.setattr(
        tools,
        "enforce_agent_rate_limit",
        lambda **_kwargs: (_ for _ in ()).throw(RateLimitError(retry_after=17)),
    )
    monkeypatch.setattr(tools, "log_event", event_logger)
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool(
            "plurum_archive",
            {"experience_id": "archive1"},
        )

    assert result.isError is True
    assert "Rate limit exceeded; retry after 17 seconds." in _render_tool_text(result)
    service_factory.assert_not_called()
    event_logger.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("failure", "expected_message"),
    [
        (AuthorizationError("You don't own this experience"), "You don't own this experience"),
        (NotFoundError("Experience", "private1"), "Experience not found: private1"),
    ],
    ids=["public-non-owner", "hidden-or-missing"],
)
async def test_archive_preserves_expected_service_errors_without_event(
    monkeypatch,
    failure,
    expected_message,
):
    from app.main import create_app
    from app.mcp import auth, tools

    class RejectingExperienceService:
        def archive(self, **_kwargs):
            raise failure

    event_logger = MagicMock()
    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", RejectingExperienceService)
    monkeypatch.setattr(tools, "log_event", event_logger)
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool(
            "plurum_archive",
            {"experience_id": "private1"},
        )

    assert result.isError is True
    assert expected_message in _render_tool_text(result)
    event_logger.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure_type",
    [RuntimeError, PlurimException],
    ids=["runtime", "plurum"],
)
async def test_archive_ambiguous_failure_is_redacted_and_retryable(
    monkeypatch,
    caplog,
    failure_type,
):
    from app.main import create_app
    from app.mcp import auth, tools

    class FailingExperienceService:
        def archive(self, **_kwargs):
            raise failure_type(f"provider included {SECRET}")

    event_logger = MagicMock()
    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", FailingExperienceService)
    monkeypatch.setattr(tools, "log_event", event_logger)
    caplog.set_level(logging.ERROR)
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool(
            "plurum_archive",
            {"experience_id": "archive1"},
        )

    rendered = _render_tool_text(result)
    assert result.isError is True
    assert "Archive could not be confirmed" in rendered
    assert "Re-calling plurum_archive with the same values is safe" in rendered
    assert "Reference:" in rendered
    assert SECRET not in rendered
    assert SECRET not in caplog.text
    event_logger.assert_not_called()


def test_service_archive_owner_transition_and_replay_are_idempotent():
    from app.services.experience_service import ExperienceService

    agent_id = UUID(AGENT_ID)
    draft = {
        "id": EXPERIENCE_ID,
        "short_id": "archive1",
        "agent_id": AGENT_ID,
        "status": "draft",
        "visibility": "private",
    }
    archived = {**draft, "status": "archived"}
    service = ExperienceService.__new__(ExperienceService)
    service.repo = MagicMock()
    service.repo.get_by_identifier.side_effect = [draft, archived]
    service.repo.update.return_value = archived

    first = service.archive("archive1", agent_id)
    replay = service.archive("archive1", agent_id)

    assert first["status"] == "archived"
    assert replay["status"] == "archived"
    assert service.repo.update.call_args_list == [
        call(UUID(EXPERIENCE_ID), {"status": "archived"})
    ]


@pytest.mark.parametrize(
    ("visibility", "status", "error_type"),
    [
        ("public", "published", AuthorizationError),
        ("private", "published", NotFoundError),
        ("public", "draft", NotFoundError),
        ("public", "archived", NotFoundError),
    ],
    ids=["public", "private", "draft", "archived"],
)
def test_service_archive_only_reveals_public_records_to_non_owners(
    visibility,
    status,
    error_type,
):
    from app.services.experience_service import ExperienceService

    service = ExperienceService.__new__(ExperienceService)
    service.repo = MagicMock()
    service.repo.get_by_identifier.return_value = {
        "id": EXPERIENCE_ID,
        "short_id": "archive1",
        "agent_id": OTHER_AGENT_ID,
        "status": status,
        "visibility": visibility,
    }

    with pytest.raises(error_type):
        service.archive("archive1", UUID(AGENT_ID))

    service.repo.update.assert_not_called()
