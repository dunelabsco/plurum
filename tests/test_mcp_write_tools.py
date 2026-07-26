"""Hosted MCP write-tool contracts, ownership, and replay safety."""

from __future__ import annotations

import json
import logging
import threading
from contextlib import asynccontextmanager
from uuid import UUID

import anyio
import httpx
import pytest
from mcp import ClientSession, McpError
from mcp.client.streamable_http import streamable_http_client

from app.core.exceptions import NotFoundError, PlurimException
from app.services.experience_service import ExperienceService

AGENT_ID = "00000000-0000-0000-0000-000000000001"
OTHER_AGENT_ID = "00000000-0000-0000-0000-000000000002"
EXPERIENCE_ID = "10000000-0000-0000-0000-000000000001"
TOOL_NAMES = [
    "plurum_search",
    "plurum_get_experience",
    "plurum_get_artifact",
    "plurum_publish",
    "plurum_report_outcome",
    "plurum_archive",
    "plurum_vote",
]


def _agent(agent_id: str = AGENT_ID) -> dict:
    return {"id": agent_id, "is_active": True}


@asynccontextmanager
async def _mcp_session(application, api_key: str = "plrm_live_write_valid"):
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


@pytest.mark.asyncio
async def test_inventory_exposes_exactly_seven_tools_with_write_contracts(
    monkeypatch,
):
    from app.main import create_app
    from app.mcp import auth

    monkeypatch.setattr(auth, "validate_api_key", lambda _key: _agent())

    async with _mcp_session(create_app()) as session:
        inventory = await session.list_tools()

    assert [tool.name for tool in inventory.tools] == TOOL_NAMES
    assert not any(
        excluded in name
        for name in TOOL_NAMES
        for excluded in ("register", "session", "pulse", "setup")
    )
    by_name = {tool.name: tool for tool in inventory.tools}
    expected_annotations = {
        "plurum_publish": (False, False, False, False),
        "plurum_report_outcome": (False, False, True, False),
        "plurum_archive": (False, True, True, False),
        "plurum_vote": (False, False, True, False),
    }
    for name, expected in expected_annotations.items():
        annotations = by_name[name].annotations
        assert annotations is not None
        assert (
            annotations.readOnlyHint,
            annotations.destructiveHint,
            annotations.idempotentHint,
            annotations.openWorldHint,
        ) == expected
        assert by_name[name].outputSchema["type"] == "object"

    publish_schema = by_name["plurum_publish"].inputSchema
    assert publish_schema["required"] == ["goal", "solution"]
    assert publish_schema["properties"]["goal"]["minLength"] == 10
    assert publish_schema["properties"]["goal"]["maxLength"] == 2000
    assert "artifacts" in publish_schema["properties"]
    assert by_name["plurum_report_outcome"].inputSchema["properties"]["outcome"][
        "enum"
    ] == ["success", "partial", "failure"]
    assert by_name["plurum_vote"].inputSchema["properties"]["vote"]["enum"] == [
        "up",
        "down",
    ]


@pytest.mark.asyncio
async def test_publish_normalizes_plugin_contract_and_binds_authenticated_agent(
    monkeypatch,
):
    from app.main import create_app
    from app.mcp import auth, tools

    instances = []

    class StubExperienceService:
        def __init__(self):
            self.calls = []
            instances.append(self)

        def create(self, *, agent_id, data):
            self.calls.append(("create", agent_id, data))
            return {"id": EXPERIENCE_ID, "short_id": "draft01"}

        def publish(self, identifier, *, agent_id):
            self.calls.append(("publish", identifier, agent_id))
            return {"id": EXPERIENCE_ID, "short_id": identifier}

    monkeypatch.setattr(auth, "validate_api_key", lambda _key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", StubExperienceService)
    source = "print('preserve exact source')\n"

    async with _mcp_session(create_app()) as session:
        result = await session.call_tool(
            "plurum_publish",
            {
                "goal": "  Publish a reusable deployment finding  ",
                "solution": "  Run the exact command shown here.  ",
                "context": " context stays untrimmed ",
                "dead_ends": ["first attempt", "   "],
                "gotchas": ["watch the region", ""],
                "tags": ["fastapi", " "],
                "domain": "  dev-tools  ",
                "artifacts": [
                    {
                        "language": " python ",
                        "code": source,
                        "description": " helper script ",
                    }
                ],
            },
        )

    assert result.isError is False
    assert result.structuredContent == {"result": "Published.", "id": "draft01"}
    assert source not in json.dumps(result.structuredContent)
    assert len(instances) == 1
    create_call, publish_call = instances[0].calls
    assert create_call[0:2] == ("create", UUID(AGENT_ID))
    data = create_call[2]
    assert data["goal"] == "Publish a reusable deployment finding"
    assert data["solution"] == "Run the exact command shown here."
    assert data["context"] == " context stays untrimmed "
    assert data["dead_ends"] == [{"what": "first attempt", "why": ""}]
    assert data["gotchas"] == [
        {"warning": "watch the region", "context": None}
    ]
    assert data["tags"] == ["fastapi"]
    assert data["domain"] == "dev-tools"
    assert data["artifacts"] == [
        {
            "language": "python",
            "code": source,
            "description": "helper script",
        }
    ]
    assert publish_call == ("publish", "draft01", UUID(AGENT_ID))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "arguments",
    [
        {"goal": "too short", "solution": "valid"},
        {"goal": "          ", "solution": "valid"},
        {
            "goal": "A sufficiently descriptive experience goal",
            "solution": "valid",
            "domain": "x" * 101,
        },
        {
            "goal": "A sufficiently descriptive experience goal",
            "solution": "valid",
            "artifacts": [{"language": "x" * 51, "code": "source"}],
        },
        {
            "goal": "A sufficiently descriptive experience goal",
            "solution": "valid",
            "artifacts": [{"language": "python", "code": ""}],
        },
    ],
)
async def test_invalid_publish_bounds_stop_before_service(monkeypatch, arguments):
    from app.main import create_app
    from app.mcp import auth, tools

    factory_calls = []

    def unexpected_service():
        factory_calls.append(True)
        raise AssertionError("invalid publish reached the service")

    monkeypatch.setattr(auth, "validate_api_key", lambda _key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", unexpected_service)

    async with _mcp_session(create_app()) as session:
        result = await session.call_tool("plurum_publish", arguments)

    assert result.isError is True
    assert "Traceback" not in _tool_text(result)
    assert factory_calls == []


@pytest.mark.asyncio
async def test_publish_rejects_nested_credentials_before_validation_or_service(
    monkeypatch,
    caplog,
):
    from app.main import create_app
    from app.mcp import auth, tools

    secret = "plrm_live_nested_publish_secret_123456789"
    factory_calls = []
    monkeypatch.setattr(auth, "validate_api_key", lambda _key: _agent())
    monkeypatch.setattr(
        tools,
        "ExperienceService",
        lambda: factory_calls.append(True),
    )
    caplog.set_level(logging.ERROR)

    async with _mcp_session(create_app()) as session:
        with pytest.raises(McpError) as captured:
            await session.call_tool(
                "plurum_publish",
                {
                    "goal": "A sufficiently descriptive experience goal",
                    "solution": "valid",
                    "artifacts": [{"language": "env", "code": secret}],
                },
            )

    assert str(captured.value) == "Invalid request parameters"
    assert secret not in str(captured.value)
    assert secret not in caplog.text
    assert factory_calls == []


@pytest.mark.asyncio
async def test_publish_failure_after_create_returns_safe_draft_without_retry(
    monkeypatch,
    caplog,
):
    from app.main import create_app
    from app.mcp import auth, tools

    secret = "plrm_live_provider_publish_secret_123456789"
    calls = []

    class FailingPublishService:
        def create(self, *, agent_id, data):
            calls.append(("create", agent_id, data["goal"]))
            return {"short_id": "known-draft"}

        def publish(self, identifier, *, agent_id):
            calls.append(("publish", identifier, agent_id))
            raise RuntimeError(f"provider response contained {secret}")

    monkeypatch.setattr(auth, "validate_api_key", lambda _key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", FailingPublishService)
    caplog.set_level(logging.ERROR)

    async with _mcp_session(create_app()) as session:
        result = await session.call_tool(
            "plurum_publish",
            {
                "goal": "A sufficiently descriptive experience goal",
                "solution": "A reusable solution",
            },
        )

    rendered = _tool_text(result)
    assert result.isError is True
    assert "draft id: known-draft" in rendered
    assert "Do NOT re-call plurum_publish" in rendered
    assert secret not in rendered
    assert secret not in caplog.text
    assert [call[0] for call in calls] == ["create", "publish"]


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["ambiguous-create", "missing-id"])
async def test_publish_uncertain_create_never_replays(monkeypatch, mode):
    from app.main import create_app
    from app.mcp import auth, tools

    calls = []

    class UncertainCreateService:
        def create(self, *, agent_id, data):
            calls.append((agent_id, data["goal"]))
            if mode == "ambiguous-create":
                raise RuntimeError("connection ended after an uncertain write")
            return {}

        def publish(self, *_args, **_kwargs):
            raise AssertionError("publish ran without a known draft")

    monkeypatch.setattr(auth, "validate_api_key", lambda _key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", UncertainCreateService)

    async with _mcp_session(create_app()) as session:
        result = await session.call_tool(
            "plurum_publish",
            {
                "goal": "A sufficiently descriptive experience goal",
                "solution": "A reusable solution",
            },
        )

    rendered = _tool_text(result)
    assert result.isError is True
    assert "Do NOT re-call plurum_publish" in rendered
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_outcome_mapping_note_cap_and_agent_binding(monkeypatch):
    from app.main import create_app
    from app.mcp import auth, tools

    calls = []

    class StubExperienceService:
        def report_outcome(self, identifier, **kwargs):
            calls.append((identifier, kwargs))
            return {}

    monkeypatch.setattr(auth, "validate_api_key", lambda _key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", StubExperienceService)
    long_note = "n" * 510

    async with _mcp_session(create_app()) as session:
        success = await session.call_tool(
            "plurum_report_outcome",
            {"experience_id": " exp-1 ", "outcome": "success"},
        )
        partial = await session.call_tool(
            "plurum_report_outcome",
            {
                "experience_id": "exp-1",
                "outcome": " PARTIAL ",
                "note": long_note,
            },
        )
        failure = await session.call_tool(
            "plurum_report_outcome",
            {
                "experience_id": "exp-1",
                "outcome": "failure",
                "note": "did not work",
            },
        )

    assert all(result.isError is False for result in (success, partial, failure))
    assert calls == [
        (
            "exp-1",
            {
                "agent_id": UUID(AGENT_ID),
                "success": True,
                "context_notes": None,
            },
        ),
        (
            "exp-1",
            {
                "agent_id": UUID(AGENT_ID),
                "success": False,
                "context_notes": f"outcome=partial | {'n' * 500}",
            },
        ),
        (
            "exp-1",
            {
                "agent_id": UUID(AGENT_ID),
                "success": False,
                "context_notes": "outcome=failure | did not work",
            },
        ),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("tool_name", "arguments"),
    [
        (
            "plurum_report_outcome",
            {"experience_id": "exp-1", "outcome": "unknown"},
        ),
        ("plurum_vote", {"experience_id": "exp-1", "vote": "sideways"}),
        ("plurum_archive", {"experience_id": "   "}),
    ],
)
async def test_invalid_write_values_stop_before_service(
    monkeypatch,
    tool_name,
    arguments,
):
    from app.main import create_app
    from app.mcp import auth, tools

    calls = []
    monkeypatch.setattr(auth, "validate_api_key", lambda _key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", lambda: calls.append(True))

    async with _mcp_session(create_app()) as session:
        result = await session.call_tool(tool_name, arguments)

    assert result.isError is True
    assert calls == []


@pytest.mark.asyncio
async def test_feedback_replays_converge_and_current_self_feedback_is_preserved(
    monkeypatch,
):
    from app.main import create_app
    from app.mcp import auth, tools

    class FeedbackRepository:
        def __init__(self):
            self.row = {
                "id": EXPERIENCE_ID,
                "short_id": "owned-draft",
                "agent_id": AGENT_ID,
                "visibility": "private",
                "status": "draft",
            }
            self.outcomes = {}
            self.votes = {}

        def get_by_identifier(self, _identifier):
            return self.row

        def upsert_outcome_report(self, data):
            key = (data["experience_id"], data["agent_id"])
            self.outcomes[key] = dict(data)
            return dict(data)

        def upsert_vote(self, experience_id, agent_id, vote_type):
            key = (str(experience_id), str(agent_id))
            self.votes[key] = vote_type
            return {"vote_type": vote_type}

        def update_quality_score(self, _experience_id):
            return None

    repository = FeedbackRepository()
    service = ExperienceService.__new__(ExperienceService)
    service.repo = repository
    monkeypatch.setattr(auth, "validate_api_key", lambda _key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", lambda: service)

    async with _mcp_session(create_app()) as session:
        for _ in range(2):
            outcome = await session.call_tool(
                "plurum_report_outcome",
                {"experience_id": "owned-draft", "outcome": "success"},
            )
            vote = await session.call_tool(
                "plurum_vote",
                {"experience_id": "owned-draft", "vote": "up"},
            )
            assert outcome.isError is False
            assert vote.isError is False
        flipped = await session.call_tool(
            "plurum_vote",
            {"experience_id": "owned-draft", "vote": "down"},
        )

    assert flipped.isError is False
    assert len(repository.outcomes) == 1
    assert next(iter(repository.outcomes.values()))["success"] is True
    assert len(repository.votes) == 1
    assert next(iter(repository.votes.values())) == "down"


@pytest.mark.asyncio
async def test_archive_is_owner_only_idempotent_and_hides_private_existence(
    monkeypatch,
):
    from app.main import create_app
    from app.mcp import auth, tools
    from app.services import experience_service

    rows = {
        "owned": {
            "id": "10000000-0000-0000-0000-000000000010",
            "short_id": "owned",
            "agent_id": AGENT_ID,
            "visibility": "public",
            "status": "published",
        },
        "already": {
            "id": "10000000-0000-0000-0000-000000000011",
            "short_id": "already",
            "agent_id": AGENT_ID,
            "visibility": "public",
            "status": "archived",
        },
        "hidden": {
            "id": "10000000-0000-0000-0000-000000000012",
            "short_id": "hidden",
            "agent_id": OTHER_AGENT_ID,
            "visibility": "private",
            "status": "draft",
        },
        "public-other": {
            "id": "10000000-0000-0000-0000-000000000013",
            "short_id": "public-other",
            "agent_id": OTHER_AGENT_ID,
            "visibility": "public",
            "status": "published",
        },
    }

    class ArchiveRepository:
        def __init__(self):
            self.updates = []
            self.feedback_writes = 0

        def get_by_identifier(self, identifier):
            try:
                return rows[identifier]
            except KeyError:
                raise NotFoundError("Experience", identifier) from None

        def update(self, experience_id, data):
            self.updates.append((experience_id, data))
            row = next(row for row in rows.values() if row["id"] == str(experience_id))
            row.update(data)
            return row

        def upsert_outcome_report(self, _data):
            self.feedback_writes += 1
            raise AssertionError("hidden outcome reached persistence")

        def upsert_vote(self, *_args):
            self.feedback_writes += 1
            raise AssertionError("hidden vote reached persistence")

    repository = ArchiveRepository()
    service = ExperienceService.__new__(ExperienceService)
    service.repo = repository
    monkeypatch.setattr(
        experience_service,
        "experience_detail",
        lambda row: dict(row),
    )
    monkeypatch.setattr(tools, "ExperienceService", lambda: service)
    monkeypatch.setattr(auth, "validate_api_key", lambda _key: _agent())

    async with _mcp_session(create_app()) as session:
        first = await session.call_tool(
            "plurum_archive",
            {"experience_id": "owned"},
        )
        second = await session.call_tool(
            "plurum_archive",
            {"experience_id": "owned"},
        )
        already = await session.call_tool(
            "plurum_archive",
            {"experience_id": "already"},
        )
        hidden = await session.call_tool(
            "plurum_archive",
            {"experience_id": "hidden"},
        )
        hidden_outcome = await session.call_tool(
            "plurum_report_outcome",
            {"experience_id": "hidden", "outcome": "success"},
        )
        hidden_vote = await session.call_tool(
            "plurum_vote",
            {"experience_id": "hidden", "vote": "up"},
        )
        missing = await session.call_tool(
            "plurum_archive",
            {"experience_id": "missing"},
        )
        public_other = await session.call_tool(
            "plurum_archive",
            {"experience_id": "public-other"},
        )

    assert all(result.isError is False for result in (first, second, already))
    assert len(repository.updates) == 1
    assert hidden.isError is True
    assert hidden_outcome.isError is True
    assert hidden_vote.isError is True
    assert missing.isError is True
    assert _tool_text(hidden).endswith("Experience not found: hidden")
    assert _tool_text(hidden_outcome).endswith("Experience not found: hidden")
    assert _tool_text(hidden_vote).endswith("Experience not found: hidden")
    assert _tool_text(missing).endswith("Experience not found: missing")
    assert _tool_text(hidden).replace("hidden", "record") == _tool_text(
        missing
    ).replace("missing", "record")
    assert repository.feedback_writes == 0
    assert public_other.isError is True
    assert "don't own this experience" in _tool_text(public_other)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("tool_name", "arguments"),
    [
        (
            "plurum_report_outcome",
            {"experience_id": "exp-1", "outcome": "success"},
        ),
        ("plurum_archive", {"experience_id": "exp-1"}),
        ("plurum_vote", {"experience_id": "exp-1", "vote": "up"}),
    ],
)
async def test_internal_write_failures_are_secret_free_and_safe_to_replay(
    monkeypatch,
    caplog,
    tool_name,
    arguments,
):
    from app.main import create_app
    from app.mcp import auth, tools

    secret = "plrm_live_internal_write_secret_123456789"

    class FailingService:
        def report_outcome(self, *_args, **_kwargs):
            raise PlurimException(f"internal outcome failure: {secret}")

        def archive(self, *_args, **_kwargs):
            raise PlurimException(f"internal archive failure: {secret}")

        def vote(self, *_args, **_kwargs):
            raise PlurimException(f"internal vote failure: {secret}")

    monkeypatch.setattr(auth, "validate_api_key", lambda _key: _agent())
    monkeypatch.setattr(tools, "ExperienceService", FailingService)
    caplog.set_level(logging.ERROR)

    async with _mcp_session(create_app()) as session:
        result = await session.call_tool(tool_name, arguments)

    rendered = _tool_text(result)
    assert result.isError is True
    assert "Retrying the same call is safe" in rendered
    assert "Reference:" in rendered
    assert secret not in rendered
    assert secret not in caplog.text


@pytest.mark.asyncio
async def test_concurrent_write_sessions_do_not_cross_agent_identity(monkeypatch):
    from app.main import create_app
    from app.mcp import auth, tools

    barrier = threading.Barrier(2)
    calls = []
    calls_lock = threading.Lock()

    class ConcurrentService:
        def vote(self, identifier, *, agent_id, vote_type):
            barrier.wait(timeout=5)
            with calls_lock:
                calls.append((identifier, str(agent_id), vote_type))
            return {}

    keys = {
        "plrm_live_concurrent_alpha": _agent(AGENT_ID),
        "plrm_live_concurrent_beta": _agent(OTHER_AGENT_ID),
    }
    monkeypatch.setattr(auth, "validate_api_key", lambda key: keys[key])
    monkeypatch.setattr(tools, "ExperienceService", ConcurrentService)
    applications = {
        "alpha": create_app(),
        "beta": create_app(),
    }

    async def vote(name, key, expected_id):
        async with _mcp_session(applications[name], key) as session:
            result = await session.call_tool(
                "plurum_vote",
                {"experience_id": name, "vote": "up"},
            )
        assert result.isError is False
        assert result.structuredContent["id"] == name
        assert expected_id in {call[1] for call in calls}

    with anyio.fail_after(10):
        async with anyio.create_task_group() as task_group:
            task_group.start_soon(
                vote,
                "alpha",
                "plrm_live_concurrent_alpha",
                AGENT_ID,
            )
            task_group.start_soon(
                vote,
                "beta",
                "plrm_live_concurrent_beta",
                OTHER_AGENT_ID,
            )

    assert sorted(calls) == [
        ("alpha", AGENT_ID, "up"),
        ("beta", OTHER_AGENT_ID, "up"),
    ]
