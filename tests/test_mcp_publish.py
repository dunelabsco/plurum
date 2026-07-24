"""Hosted MCP publish behavior and safety tests."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from unittest.mock import MagicMock
from uuid import UUID

import httpx
import pytest
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from app.core.exceptions import PlurimException, RateLimitError


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
async def test_publish_creates_and_publishes_once_with_normalized_input(monkeypatch):
    from app.main import create_app
    from app.mcp import auth, tools
    from app.core.rate_limiter import (
        EXPERIENCE_CREATE_SCOPE,
        EXPERIENCE_PUBLISH_SCOPE,
    )

    calls: list[tuple] = []
    rate_calls: list[dict] = []

    class StubExperienceService:
        def create(self, agent_id, data):
            assert len(rate_calls) == 2
            calls.append(("create", agent_id, data))
            return {
                "id": EXPERIENCE_ID,
                "short_id": "pub12345",
                "domain": data.get("domain"),
                "status": "draft",
            }

        def publish(self, identifier, agent_id):
            calls.append(("publish", identifier, agent_id))
            return {"id": EXPERIENCE_ID, "short_id": identifier, "status": "published"}

    events: list[dict] = []
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
            "plurum_publish",
            {
                "goal": "  Deploy FastAPI safely with Railway  ",
                "context": "  Python 3.11 runtime  ",
                "solution": "  Use a health check and one Uvicorn worker.  ",
                "dead_ends": ["  Multiple workers lost local counters  ", "   "],
                "gotchas": ["  Railway restarts reset memory limits  "],
                "tags": ["  fastapi  ", "railway", ""],
                "domain": "  devops  ",
                "artifacts": [
                    {
                        "language": "  python  ",
                        "code": "print('ready')\n",
                        "description": "  health probe  ",
                    },
                    {"language": " ", "code": "ignored"},
                ],
            },
        )

    assert result.isError is False
    assert result.structuredContent == {"result": "Published.", "id": "pub12345"}
    assert rate_calls == [
        {
            "agent_id": AGENT_ID,
            "rate_limit": tools.get_settings().rate_limit_experience_write,
            "scope": EXPERIENCE_CREATE_SCOPE,
        },
        {
            "agent_id": AGENT_ID,
            "rate_limit": tools.get_settings().rate_limit_experience_write,
            "scope": EXPERIENCE_PUBLISH_SCOPE,
        },
    ]
    assert [call[0] for call in calls] == ["create", "publish"]
    _, create_agent_id, data = calls[0]
    assert create_agent_id == UUID(AGENT_ID)
    assert data["goal"] == "Deploy FastAPI safely with Railway"
    assert data["solution"] == "Use a health check and one Uvicorn worker."
    assert data["context"] == "  Python 3.11 runtime  "
    assert data["dead_ends"] == [
        {"what": "  Multiple workers lost local counters  ", "why": ""}
    ]
    assert data["gotchas"] == [
        {"warning": "  Railway restarts reset memory limits  ", "context": None}
    ]
    assert data["tags"] == ["  fastapi  ", "railway"]
    assert data["domain"] == "devops"
    assert data["artifacts"] == [
        {
            "language": "python",
            "code": "print('ready')\n",
            "description": "health probe",
        }
    ]
    assert calls[1] == ("publish", "pub12345", UUID(AGENT_ID))
    assert events == [
        {
            "event_type": "create",
            "agent_id": AGENT_ID,
            "experience_id": EXPERIENCE_ID,
            "metadata": {
                "channel": "mcp",
                "client": "claude-code",
                "domain": "devops",
            },
        },
        {
            "event_type": "publish",
            "agent_id": AGENT_ID,
            "experience_id": EXPERIENCE_ID,
            "metadata": {"channel": "mcp", "client": "claude-code"},
        },
    ]


@pytest.mark.asyncio
async def test_publish_rejects_nested_api_key_before_embedding_or_database(monkeypatch):
    from app.main import create_app
    from app.mcp import auth, tools
    from app.services.experience_service import ExperienceService

    secret = "plrm_live_publish_secret_123456789"
    service = ExperienceService.__new__(ExperienceService)
    service.embedding = MagicMock()
    service.repo = MagicMock()
    events: list[dict] = []

    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", lambda: service)
    monkeypatch.setattr(
        tools,
        "log_event",
        lambda event_type, **kwargs: events.append({"event_type": event_type, **kwargs}),
    )
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool(
            "plurum_publish",
            {
                "goal": "Prevent credentials from entering shared experiences",
                "solution": "Use recursive content scanning before embeddings.",
                "artifacts": [{"language": "env", "code": f"TOKEN={secret}"}],
            },
        )

    rendered = _render_tool_text(result)
    assert result.isError is True
    assert "Potential API key detected" in rendered
    assert secret not in rendered
    service.embedding.generate_reasoning_embedding.assert_not_called()
    service.repo.create.assert_not_called()
    assert events == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "arguments",
    [
        {
            "context": "plrm_live_malformed_secret_123456789",
        },
        {
            "goal": {"secret": "plrm_live_malformed_secret_123456789"},
            "solution": "Reject malformed values inside the handler boundary.",
        },
        {
            "goal": "Reject secret-bearing extra artifact values safely",
            "solution": "Scan raw nested input before strict schema validation.",
            "artifacts": [
                {
                    "language": "python",
                    "code": "print('safe')",
                    "secret": "plrm_live_malformed_secret_123456789",
                }
            ],
        },
        {
            "goal": "Sanitize arbitrary artifact field names safely",
            "solution": "Reflect only schema-owned paths in validation errors.",
            "artifacts": [
                {
                    "language": "python",
                    "code": "print('safe')",
                    "plrm_live_malformed_secret_123456789": "not a key",
                }
            ],
        },
    ],
    ids=[
        "missing-required-fields",
        "malformed-goal",
        "artifact-extra-value",
        "artifact-extra-name",
    ],
)
async def test_publish_malformed_input_never_echoes_credentials(
    monkeypatch,
    caplog,
    arguments,
):
    from app.main import create_app
    from app.mcp import auth, tools

    secret = "plrm_live_malformed_secret_123456789"
    service_factory = MagicMock(
        side_effect=AssertionError("invalid input must not reach service work")
    )
    limiter = MagicMock()
    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", service_factory)
    monkeypatch.setattr(tools, "enforce_agent_rate_limit", limiter)
    caplog.set_level(logging.ERROR)
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool("plurum_publish", arguments)

    rendered = _render_tool_text(result)
    assert result.isError is True
    assert secret not in rendered
    assert secret not in caplog.text
    service_factory.assert_not_called()
    limiter.assert_not_called()


@pytest.mark.asyncio
async def test_publish_failure_preserves_draft_id_without_retrying(monkeypatch, caplog):
    from app.main import create_app
    from app.mcp import auth, tools

    secret = "provider-publish-secret"
    create_calls = 0
    publish_calls = 0

    class FailingPublishService:
        def create(self, agent_id, data):
            nonlocal create_calls
            create_calls += 1
            return {"id": EXPERIENCE_ID, "short_id": "draft123", "domain": "devops"}

        def publish(self, identifier, agent_id):
            nonlocal publish_calls
            publish_calls += 1
            raise RuntimeError(f"provider response included {secret}")

    events: list[dict] = []
    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", FailingPublishService)
    monkeypatch.setattr(
        tools,
        "log_event",
        lambda event_type, **kwargs: events.append({"event_type": event_type, **kwargs}),
    )
    caplog.set_level(logging.ERROR)
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool(
            "plurum_publish",
            {
                "goal": "Retain a recoverable draft after publish failure",
                "solution": "Return its identifier and prohibit blind recreation.",
            },
        )

    rendered = _render_tool_text(result)
    assert result.isError is True
    assert "draft123" in rendered
    assert "could not be confirmed" in rendered
    assert "Do NOT re-call plurum_publish" in rendered
    assert "Reference:" in rendered
    assert secret not in rendered
    assert secret not in caplog.text
    assert create_calls == 1
    assert publish_calls == 1
    assert [event["event_type"] for event in events] == ["create"]


@pytest.mark.asyncio
async def test_expected_publish_failure_keeps_safe_reason_and_draft_id(monkeypatch):
    from app.core.exceptions import ValidationError
    from app.main import create_app
    from app.mcp import auth, tools

    class RejectedPublishService:
        def create(self, agent_id, data):
            return {"id": EXPERIENCE_ID, "short_id": "draftsafe", "domain": None}

        def publish(self, identifier, agent_id):
            raise ValidationError("Stored draft failed credential validation")

    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", RejectedPublishService)
    monkeypatch.setattr(tools, "log_event", lambda *_args, **_kwargs: None)
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool(
            "plurum_publish",
            {
                "goal": "Preserve a safe expected publication error",
                "solution": "Return the draft identifier without recreating it.",
            },
        )

    rendered = _render_tool_text(result)
    assert result.isError is True
    assert "draftsafe" in rendered
    assert "Stored draft failed credential validation" in rendered
    assert "Do NOT re-call plurum_publish" in rendered
    assert "Reference:" not in rendered


@pytest.mark.asyncio
async def test_publish_falls_back_to_full_id_when_short_id_is_missing(monkeypatch):
    from app.main import create_app
    from app.mcp import auth, tools

    published_identifiers: list[str] = []

    class FullIdentifierService:
        def create(self, agent_id, data):
            return {"id": EXPERIENCE_ID, "status": "draft", "domain": None}

        def publish(self, identifier, agent_id):
            published_identifiers.append(identifier)
            return {"id": EXPERIENCE_ID, "status": "published"}

    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", FullIdentifierService)
    monkeypatch.setattr(tools, "log_event", lambda *_args, **_kwargs: None)
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool(
            "plurum_publish",
            {
                "goal": "Fall back to a full experience identifier",
                "solution": "Use the UUID when a short identifier is unavailable.",
            },
        )

    assert result.isError is False
    assert result.structuredContent == {"result": "Published.", "id": EXPERIENCE_ID}
    assert published_identifiers == [EXPERIENCE_ID]


@pytest.mark.asyncio
async def test_publish_scope_limit_stops_before_draft_creation(monkeypatch):
    from app.core.rate_limiter import EXPERIENCE_PUBLISH_SCOPE
    from app.main import create_app
    from app.mcp import auth, tools

    service_factory = MagicMock(
        side_effect=AssertionError("both write quotas must be reserved before creation")
    )

    def enforce_limit(*, scope, **_kwargs):
        if scope == EXPERIENCE_PUBLISH_SCOPE:
            raise RateLimitError(retry_after=19)

    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", service_factory)
    monkeypatch.setattr(tools, "enforce_agent_rate_limit", enforce_limit)
    monkeypatch.setattr(tools, "log_event", lambda *_args, **_kwargs: None)
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool(
            "plurum_publish",
            {
                "goal": "Handle a publish-stage rate limit safely",
                "solution": "Return the existing draft instead of creating another.",
            },
        )

    rendered = _render_tool_text(result)
    assert result.isError is True
    assert "Rate limit exceeded; retry after 19 seconds." in rendered
    assert "draft" not in rendered.lower()
    service_factory.assert_not_called()


@pytest.mark.asyncio
async def test_create_scope_limit_stops_before_service_work(monkeypatch):
    from app.main import create_app
    from app.mcp import auth, tools

    class UnexpectedExperienceService:
        def create(self, agent_id, data):
            raise AssertionError("create limit must stop paid embedding work")

    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(
        tools,
        "enforce_agent_rate_limit",
        lambda **_kwargs: (_ for _ in ()).throw(RateLimitError(retry_after=7)),
    )
    monkeypatch.setattr(tools, "ExperienceService", UnexpectedExperienceService)
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool(
            "plurum_publish",
            {
                "goal": "Stop publish before paid work when limited",
                "solution": "Enforce the create operation bucket first.",
            },
        )

    assert result.isError is True
    assert "Rate limit exceeded; retry after 7 seconds." in _render_tool_text(result)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure_type",
    [RuntimeError, PlurimException],
    ids=["runtime", "plurum"],
)
async def test_publish_ambiguous_create_failure_is_redacted_and_never_publishes(
    monkeypatch,
    caplog,
    failure_type,
):
    from app.main import create_app
    from app.mcp import auth, tools

    secret = "provider-create-secret"
    publish_called = False
    create_failure = failure_type(f"create provider included {secret}")

    class FailingCreateService:
        def create(self, agent_id, data):
            raise create_failure

        def publish(self, identifier, agent_id):
            nonlocal publish_called
            publish_called = True

    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", FailingCreateService)
    caplog.set_level(logging.ERROR)
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool(
            "plurum_publish",
            {
                "goal": "Redact unexpected embedding provider failures",
                "solution": "Return only a correlation reference.",
            },
        )

    rendered = _render_tool_text(result)
    assert result.isError is True
    assert "draft creation may have succeeded" in rendered
    assert "Do NOT re-call plurum_publish automatically" in rendered
    assert "Reference:" in rendered
    assert secret not in rendered
    assert secret not in caplog.text
    assert publish_called is False


@pytest.mark.asyncio
async def test_publish_prewrite_service_validation_remains_actionable(monkeypatch):
    from app.core.exceptions import ValidationError
    from app.main import create_app
    from app.mcp import auth, tools

    publish_called = False

    class RejectedCreateService:
        def create(self, agent_id, data):
            raise ValidationError("Experience content was rejected before storage")

        def publish(self, identifier, agent_id):
            nonlocal publish_called
            publish_called = True

    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", RejectedCreateService)
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool(
            "plurum_publish",
            {
                "goal": "Keep deterministic prewrite validation actionable",
                "solution": "Return the safe validation reason without claiming a draft.",
            },
        )

    rendered = _render_tool_text(result)
    assert result.isError is True
    assert "Experience content was rejected before storage" in rendered
    assert "draft creation may have succeeded" not in rendered
    assert publish_called is False


@pytest.mark.asyncio
async def test_publish_missing_created_identifier_warns_against_duplicate(monkeypatch):
    from app.main import create_app
    from app.mcp import auth, tools

    class MissingIdentifierService:
        def create(self, agent_id, data):
            return {"status": "draft", "domain": None}

        def publish(self, identifier, agent_id):
            raise AssertionError("a draft without an identifier cannot be published")

    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", MissingIdentifierService)
    monkeypatch.setattr(tools, "log_event", lambda *_args, **_kwargs: None)
    app = create_app()

    async with _mcp_session(app) as session:
        result = await session.call_tool(
            "plurum_publish",
            {
                "goal": "Handle a malformed draft response without duplication",
                "solution": "Stop safely when the service returns no identifier.",
            },
        )

    rendered = _render_tool_text(result)
    assert result.isError is True
    assert "created a draft but returned no identifier" in rendered
    assert "Do NOT re-call plurum_publish" in rendered


@pytest.mark.asyncio
async def test_publish_validates_required_content_and_backend_bounds(monkeypatch):
    from app.main import create_app
    from app.mcp import auth, tools

    class UnexpectedExperienceService:
        def create(self, agent_id, data):
            raise AssertionError("invalid publish input must not reach the service")

    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", UnexpectedExperienceService)
    app = create_app()

    async with _mcp_session(app) as session:
        blank = await session.call_tool(
            "plurum_publish",
            {"goal": "   ", "solution": "   "},
        )
        short_goal = await session.call_tool(
            "plurum_publish",
            {"goal": "too short", "solution": "A concrete working solution."},
        )
        long_domain = await session.call_tool(
            "plurum_publish",
            {
                "goal": "Validate bounded publish input before service work",
                "solution": "Use the backend ExperienceCreate model.",
                "domain": "x" * 101,
            },
        )

    assert blank.isError is True
    assert "requires both 'goal' and 'solution'" in _render_tool_text(blank)
    assert short_goal.isError is True
    assert "Invalid publish input" in _render_tool_text(short_goal)
    assert long_domain.isError is True
    assert "Invalid publish input" in _render_tool_text(long_domain)
