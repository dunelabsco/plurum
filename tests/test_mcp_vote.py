"""Hosted MCP vote behavior and safety tests."""

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


AGENT_ID = "00000000-0000-0000-0000-000000000012"
EXPERIENCE_ID = "10000000-0000-0000-0000-000000000012"
VOTE_ID = "30000000-0000-0000-0000-000000000012"
SECRET = "plrm_live_vote_secret_123456789"


def _agent() -> dict:
    return {
        "id": AGENT_ID,
        "name": "vote-agent",
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
@pytest.mark.parametrize("raw_vote", [" UP ", " dOwN "])
async def test_vote_maps_plugin_contract_and_logs_safe_event(monkeypatch, raw_vote):
    from app.core.rate_limiter import EXPERIENCE_FEEDBACK_SCOPE
    from app.main import create_app
    from app.mcp import auth, tools

    rate_calls: list[dict] = []
    service_calls: list[dict] = []
    events: list[dict] = []

    class StubExperienceService:
        def __init__(self):
            assert len(rate_calls) == 1

        def vote(self, **kwargs):
            service_calls.append(kwargs)
            return {
                "id": VOTE_ID,
                "experience_id": EXPERIENCE_ID,
                "vote_type": kwargs["vote_type"],
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
            "plurum_vote",
            {"experience_id": "  vote01  ", "vote": raw_vote},
        )

    normalized_vote = raw_vote.strip().lower()
    assert result.isError is False
    assert result.structuredContent == {
        "result": "Vote recorded.",
        "id": "vote01",
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
            "identifier": "vote01",
            "agent_id": UUID(AGENT_ID),
            "vote_type": normalized_vote,
        }
    ]
    assert events == [
        {
            "event_type": "vote",
            "agent_id": AGENT_ID,
            "experience_id": EXPERIENCE_ID,
            "metadata": {
                "channel": "mcp",
                "client": "codex",
                "vote_type": normalized_vote,
            },
        }
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "arguments",
    [
        {},
        {"experience_id": "   ", "vote": "up"},
        {"experience_id": "vote01", "vote": "sideways"},
        {"experience_id": 42, "vote": "up"},
        {"experience_id": "vote01", "vote": 42},
        {"experience_id": "x" * 65, "vote": "up"},
    ],
    ids=["missing", "blank-id", "bad-vote", "bad-id-type", "bad-vote-type", "long-id"],
)
async def test_vote_rejects_invalid_input_before_work(monkeypatch, arguments):
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
        result = await session.call_tool("plurum_vote", arguments)

    assert result.isError is True
    assert "Need experience_id and vote in {up, down}." in _render_tool_text(result)
    service_factory.assert_not_called()
    limiter.assert_not_called()
    event_logger.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "arguments",
    [
        {"vote": SECRET},
        {"experience_id": SECRET, "vote": "up"},
        {"experience_id": {"secret": SECRET}, "vote": "up"},
        {"experience_id": "vote01", "vote": SECRET},
        {"experience_id": "vote01", "vote": {SECRET: "up"}},
    ],
    ids=["missing-id", "id-value", "nested-id", "vote-value", "secret-field-name"],
)
async def test_vote_malformed_input_never_echoes_credentials(
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
        result = await session.call_tool("plurum_vote", arguments)

    rendered = _render_tool_text(result)
    assert result.isError is True
    assert SECRET not in rendered
    assert SECRET not in caplog.text
    service_factory.assert_not_called()
    limiter.assert_not_called()
    event_logger.assert_not_called()


@pytest.mark.asyncio
async def test_vote_rate_limit_stops_before_service_work(monkeypatch):
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
        lambda **_kwargs: (_ for _ in ()).throw(RateLimitError(retry_after=19)),
    )
    monkeypatch.setattr(tools, "log_event", event_logger)
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool(
            "plurum_vote",
            {"experience_id": "vote01", "vote": "up"},
        )

    assert result.isError is True
    assert "Rate limit exceeded; retry after 19 seconds." in _render_tool_text(result)
    service_factory.assert_not_called()
    event_logger.assert_not_called()


@pytest.mark.asyncio
async def test_vote_preserves_private_not_found_without_event(monkeypatch):
    from app.main import create_app
    from app.mcp import auth, tools

    class HiddenExperienceService:
        def vote(self, **_kwargs):
            raise NotFoundError("Experience", "private1")

    event_logger = MagicMock()
    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", HiddenExperienceService)
    monkeypatch.setattr(tools, "log_event", event_logger)
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool(
            "plurum_vote",
            {"experience_id": "private1", "vote": "down"},
        )

    assert result.isError is True
    assert "Experience not found: private1" in _render_tool_text(result)
    event_logger.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure_type",
    [RuntimeError, PlurimException],
    ids=["runtime", "plurum"],
)
async def test_vote_ambiguous_failure_is_redacted_and_retryable(
    monkeypatch,
    caplog,
    failure_type,
):
    from app.main import create_app
    from app.mcp import auth, tools

    class FailingExperienceService:
        def vote(self, **_kwargs):
            raise failure_type(f"provider included {SECRET}")

    event_logger = MagicMock()
    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", FailingExperienceService)
    monkeypatch.setattr(tools, "log_event", event_logger)
    caplog.set_level(logging.ERROR)
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool(
            "plurum_vote",
            {"experience_id": "vote01", "vote": "up"},
        )

    rendered = _render_tool_text(result)
    assert result.isError is True
    assert "Vote could not be confirmed" in rendered
    assert "Re-calling plurum_vote with the same values is safe" in rendered
    assert "Reference:" in rendered
    assert SECRET not in rendered
    assert SECRET not in caplog.text
    event_logger.assert_not_called()


def test_service_vote_replay_and_flip_upsert_same_agent_experience_pair():
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
    service.repo.upsert_vote.side_effect = lambda experience_id, voter_id, vote_type: {
        "id": VOTE_ID,
        "experience_id": str(experience_id),
        "agent_id": str(voter_id),
        "vote_type": vote_type,
    }

    first = service.vote("vote01", agent_id, "up")
    replay = service.vote("vote01", agent_id, "up")
    flipped = service.vote("vote01", agent_id, "down")

    assert first["vote_type"] == "up"
    assert replay["vote_type"] == "up"
    assert flipped["vote_type"] == "down"
    assert service.repo.upsert_vote.call_args_list == [
        call(UUID(EXPERIENCE_ID), agent_id, "up"),
        call(UUID(EXPERIENCE_ID), agent_id, "up"),
        call(UUID(EXPERIENCE_ID), agent_id, "down"),
    ]
    assert service.repo.update_quality_score.call_args_list == [
        call(UUID(EXPERIENCE_ID)),
        call(UUID(EXPERIENCE_ID)),
        call(UUID(EXPERIENCE_ID)),
    ]
