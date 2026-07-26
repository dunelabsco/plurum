"""Focused operational safeguards for the hosted MCP adapter."""

from __future__ import annotations

import logging
from types import SimpleNamespace
from uuid import UUID

import pytest
from limits import parse
from mcp.server.fastmcp.exceptions import ToolError

from app.core.exceptions import RateLimitError
from app.core.rate_limiter import enforce_mcp_rate_limit, limiter
from app.mcp.auth import MCPPrincipal
from app.repositories import event_repo


@pytest.fixture(autouse=True)
def _reset_rate_limit_storage():
    """Keep process-local limiter state deterministic across these tests."""
    limiter.reset()
    yield
    limiter.reset()


def test_mcp_rate_limit_is_separate_from_rest_and_other_agents():
    one_per_minute = "1/minute"
    rest_limit = parse(one_per_minute)

    # Model an already-consumed REST route bucket for the same authenticated
    # agent. MCP must use its own namespace rather than this REST key/scope.
    assert limiter.limiter.hit(
        rest_limit,
        "agent:stage-four-agent-a",
        "rest-search",
    )

    enforce_mcp_rate_limit(
        agent_id="stage-four-agent-a",
        rate_limit=one_per_minute,
    )
    with pytest.raises(RateLimitError) as agent_a_error:
        enforce_mcp_rate_limit(
            agent_id="stage-four-agent-a",
            rate_limit=one_per_minute,
        )

    # Exhausting A's MCP bucket must not consume B's.
    enforce_mcp_rate_limit(
        agent_id="stage-four-agent-b",
        rate_limit=one_per_minute,
    )

    retry_after = agent_a_error.value.details["retry_after"]
    assert 1 <= retry_after <= 24 * 60 * 60


@pytest.mark.asyncio
async def test_mcp_rate_limit_error_is_retryable_and_secret_free(
    monkeypatch,
    caplog,
):
    from app.mcp import tools

    private_marker = "agent-private-rate-marker"

    monkeypatch.setattr(
        tools,
        "get_mcp_principal",
        lambda: MCPPrincipal(
            agent_id=private_marker,
            client="codex",
        ),
    )

    def reject_call(**_kwargs):
        raise RateLimitError(retry_after=17)

    class UnexpectedExperienceService:
        def search(self, **_kwargs):
            raise AssertionError("rate-limited call reached the service")

    monkeypatch.setattr(tools, "enforce_mcp_rate_limit", reject_call)
    monkeypatch.setattr(tools, "ExperienceService", UnexpectedExperienceService)
    caplog.set_level(logging.ERROR)

    with pytest.raises(ToolError) as exc_info:
        await tools.plurum_search(query="bounded retry behavior")

    rendered = str(exc_info.value)
    assert rendered == "Rate limit exceeded; retry after 17 seconds."
    assert private_marker not in rendered
    assert private_marker not in caplog.text


def test_event_logger_settings_failure_is_best_effort_and_secret_free(
    monkeypatch,
    caplog,
):
    secret = "plrm_live_event_settings_secret_123456789"
    caplog.set_level(logging.DEBUG, logger=event_repo.__name__)
    monkeypatch.setattr(
        event_repo,
        "get_settings",
        lambda: (_ for _ in ()).throw(RuntimeError(f"provider included {secret}")),
    )

    event_repo.log_event("search", agent_id="synthetic-agent")

    assert "RuntimeError" in caplog.text
    assert secret not in caplog.text


def test_event_logger_insert_failure_is_best_effort_and_secret_free(
    monkeypatch,
    caplog,
):
    secret = "plrm_live_event_provider_secret_123456789"
    caplog.set_level(logging.DEBUG, logger=event_repo.__name__)
    monkeypatch.setattr(
        event_repo,
        "get_settings",
        lambda: SimpleNamespace(events_enabled=True),
    )
    monkeypatch.setattr(
        event_repo,
        "get_supabase_client",
        lambda: (_ for _ in ()).throw(RuntimeError(f"provider included {secret}")),
    )

    event_repo.log_event(
        "search",
        agent_id="synthetic-agent",
        metadata={"channel": "mcp", "client": "codex"},
    )

    assert "RuntimeError" in caplog.text
    assert secret not in caplog.text


@pytest.mark.parametrize(
    ("event_type", "allowed_metadata", "expected_extra"),
    [
        (
            "search",
            {"result_count": 2, "top_similarity": 0.91},
            {"result_count": 2, "top_similarity": 0.91},
        ),
        ("get_experience", {}, {}),
        ("get_artifact", {"artifact_index": 1}, {"artifact_index": 1}),
        ("create", {}, {}),
        ("publish", {}, {}),
        ("report_outcome", {"success": False}, {"success": False}),
        ("archive", {}, {}),
        ("vote", {"vote_type": "down"}, {"vote_type": "down"}),
    ],
)
def test_mcp_events_keep_only_fixed_operational_metadata(
    monkeypatch,
    event_type,
    allowed_metadata,
    expected_extra,
):
    from app.mcp import tools

    raw_content = "private-query-goal-solution-note-domain-source"
    experience_id = "10000000-0000-0000-0000-000000000001"
    captured = []
    monkeypatch.setattr(
        tools,
        "log_event",
        lambda event_type, **kwargs: captured.append(
            {"event_type": event_type, **kwargs}
        ),
    )

    tools._log_mcp_event(
        event_type,
        agent_id="synthetic-agent",
        client="codex",
        experience_id=experience_id,
        metadata={
            "query": raw_content,
            "goal": raw_content,
            "solution": raw_content,
            "note": raw_content,
            "domain": raw_content,
            "code": raw_content,
            **allowed_metadata,
        },
    )

    assert captured == [
        {
            "event_type": event_type,
            "agent_id": "synthetic-agent",
            "experience_id": experience_id,
            "metadata": {
                "channel": "mcp",
                "client": "codex",
                **expected_extra,
            },
        }
    ]
    assert "query" not in captured[0]
    assert raw_content not in repr(captured)


def test_mcp_event_helper_normalizes_client_and_ignores_unknown_events(
    monkeypatch,
):
    from app.mcp import tools

    captured = []
    monkeypatch.setattr(
        tools,
        "log_event",
        lambda event_type, **kwargs: captured.append(
            {"event_type": event_type, **kwargs}
        ),
    )

    tools._log_mcp_event(
        "search",
        agent_id="synthetic-agent",
        client="untrusted-client-content",
        metadata={"result_count": 0, "top_similarity": 0.0},
    )
    tools._log_mcp_event(
        "not-a-plurum-event",
        agent_id="synthetic-agent",
        client="codex",
        metadata={"result_count": 99},
    )

    assert len(captured) == 1
    assert captured[0]["metadata"] == {
        "channel": "mcp",
        "client": "unknown",
        "result_count": 0,
        "top_similarity": 0.0,
    }


def test_mcp_event_helper_rejects_content_in_typed_fields(monkeypatch):
    from app.mcp import tools

    private_content = "private-query-in-an-operational-field"
    captured = []
    monkeypatch.setattr(
        tools,
        "log_event",
        lambda event_type, **kwargs: captured.append(
            {"event_type": event_type, **kwargs}
        ),
    )

    tools._log_mcp_event(
        "search",
        agent_id="synthetic-agent",
        client="codex",
        experience_id=private_content,
        metadata={
            "result_count": private_content,
            "top_similarity": float("inf"),
        },
    )

    assert captured[0]["experience_id"] is None
    assert captured[0]["metadata"] == {
        "channel": "mcp",
        "client": "codex",
    }
    assert private_content not in repr(captured)


def test_successful_runners_use_existing_limits_and_emit_content_free_events(
    monkeypatch,
):
    from app.mcp import tools

    expected_agent_id = "00000000-0000-0000-0000-000000000001"
    prior_id = "10000000-0000-0000-0000-000000000001"
    created_id = "10000000-0000-0000-0000-000000000002"
    raw_content = "private-query-goal-solution-note-domain-source"
    policies = SimpleNamespace(
        rate_limit_search="11/minute",
        rate_limit_read="12/minute",
        rate_limit_experience_write="13/hour",
        rate_limit_feedback="14/hour",
    )
    rate_calls = []
    events = []

    class StubExperienceService:
        def search(self, **_kwargs):
            return {
                "total_found": 1,
                "results": [
                    {
                        "id": prior_id,
                        "short_id": "prior01",
                        "goal": raw_content,
                        "similarity": 0.91,
                    }
                ],
            }

        def get(self, _identifier, *, viewer_agent_id):
            return {
                "id": prior_id,
                "short_id": "prior01",
                "goal": raw_content,
                "domain": raw_content,
                "artifacts": [
                    {
                        "language": "python",
                        "description": raw_content,
                        "code": raw_content,
                    }
                ],
            }

        def create(self, *, agent_id, data):
            return {"id": created_id, "short_id": "created01"}

        def publish(self, identifier, *, agent_id):
            return {"id": created_id, "short_id": identifier}

        def report_outcome(
            self,
            _identifier,
            *,
            agent_id,
            success,
            context_notes,
        ):
            return {"experience_id": prior_id}

        def archive(self, _identifier, *, agent_id):
            return {"id": created_id}

        def vote(self, _identifier, *, agent_id, vote_type):
            return {"experience_id": prior_id}

    monkeypatch.setattr(tools, "get_settings", lambda: policies)
    monkeypatch.setattr(tools, "ExperienceService", StubExperienceService)
    monkeypatch.setattr(
        tools,
        "enforce_mcp_rate_limit",
        lambda **kwargs: rate_calls.append(kwargs),
    )
    monkeypatch.setattr(
        tools,
        "log_event",
        lambda event_type, **kwargs: events.append(
            {"event_type": event_type, **kwargs}
        ),
    )

    tools._run_search(raw_content, 1, expected_agent_id, "codex")
    tools._run_get_experience("prior01", expected_agent_id, "codex")
    tools._run_get_artifact("prior01", 0, expected_agent_id, "codex")
    tools._run_publish(
        {
            "goal": raw_content,
            "solution": raw_content,
            "domain": raw_content,
        },
        expected_agent_id,
        "codex",
    )
    tools._run_report_outcome(
        "prior01",
        False,
        raw_content,
        expected_agent_id,
        "codex",
    )
    tools._run_archive("created01", expected_agent_id, "codex")
    tools._run_vote("prior01", "down", expected_agent_id, "codex")

    assert {call["agent_id"] for call in rate_calls} == {expected_agent_id}
    assert [call["rate_limit"] for call in rate_calls] == [
        policies.rate_limit_search,
        policies.rate_limit_read,
        policies.rate_limit_read,
        policies.rate_limit_experience_write,
        policies.rate_limit_feedback,
        policies.rate_limit_experience_write,
        policies.rate_limit_feedback,
    ]
    assert [event["event_type"] for event in events] == [
        "search",
        "get_experience",
        "get_artifact",
        "create",
        "publish",
        "report_outcome",
        "archive",
        "vote",
    ]
    assert [event.get("experience_id") for event in events] == [
        None,
        prior_id,
        prior_id,
        created_id,
        created_id,
        prior_id,
        created_id,
        prior_id,
    ]
    assert [event["metadata"] for event in events] == [
        {
            "channel": "mcp",
            "client": "codex",
            "result_count": 1,
            "top_similarity": 0.91,
        },
        {"channel": "mcp", "client": "codex"},
        {"channel": "mcp", "client": "codex", "artifact_index": 0},
        {"channel": "mcp", "client": "codex"},
        {"channel": "mcp", "client": "codex"},
        {"channel": "mcp", "client": "codex", "success": False},
        {"channel": "mcp", "client": "codex"},
        {"channel": "mcp", "client": "codex", "vote_type": "down"},
    ]
    assert all("query" not in event for event in events)
    assert raw_content not in repr(events)


def test_mcp_event_helper_swallows_unexpected_logger_failure(
    monkeypatch,
    caplog,
):
    from app.mcp import tools

    secret = "plrm_live_mcp_event_secret_123456789"

    def fail_log_event(*_args, **_kwargs):
        raise RuntimeError(f"provider included {secret}")

    monkeypatch.setattr(tools, "log_event", fail_log_event)
    monkeypatch.setattr(
        tools,
        "enforce_mcp_rate_limit",
        lambda **_kwargs: None,
    )

    class StubExperienceService:
        def search(self, **_kwargs):
            return {"results": [], "total_found": 0}

    monkeypatch.setattr(tools, "ExperienceService", StubExperienceService)
    caplog.set_level(logging.DEBUG, logger=tools.__name__)

    result = tools._run_search(
        "safe event failure",
        1,
        "synthetic-agent",
        client="codex",
    )

    assert result["count"] == 0
    assert "RuntimeError" in caplog.text
    assert secret not in caplog.text


def test_event_ids_accept_only_canonical_uuids():
    from app.mcp import tools

    canonical = UUID("10000000-0000-0000-0000-000000000001")
    assert tools._canonical_uuid({"id": canonical}, "id") == str(canonical)
    assert tools._canonical_uuid(
        {"id": "not-a-uuid", "experience_id": str(canonical)},
        "id",
        "experience_id",
    ) == str(canonical)
    assert tools._canonical_uuid(
        {"id": "private-short-id-or-content"},
        "id",
    ) is None
