"""Phase 2 hosted-MCP integration demonstrations."""

from __future__ import annotations

from uuid import UUID

import httpx
import pytest
from limits import parse
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from app.config import get_settings
from app.core.rate_limiter import (
    EXPERIENCE_SEARCH_SCOPE,
    enforce_agent_rate_limit,
)


AGENT_ID = "00000000-0000-0000-0000-000000000001"
OTHER_AGENT_ID = "00000000-0000-0000-0000-000000000002"
PRIOR_EXPERIENCE_ID = "10000000-0000-0000-0000-000000000001"
PUBLISHED_EXPERIENCE_ID = "10000000-0000-0000-0000-000000000002"


def _agent(agent_id: str) -> dict:
    return {
        "id": agent_id,
        "name": f"agent-{agent_id[-1]}",
        "is_active": True,
        "api_key_prefix": "plrm_live_test...",
        "rate_limit_tier": "standard",
    }


@pytest.mark.asyncio
async def test_one_authenticated_session_executes_all_seven_tools(monkeypatch):
    from app.main import create_app
    from app.mcp import auth, tools

    prior_experience = {
        "id": PRIOR_EXPERIENCE_ID,
        "short_id": "prior001",
        "agent_id": "00000000-0000-0000-0000-000000000099",
        "goal": "Reuse a verified Railway deployment sequence",
        "solution": "Run the attached health probe before deployment.",
        "domain": "devops",
        "similarity": 0.92,
        "artifacts": [
            {
                "language": "python",
                "description": "health probe",
                "code": "print('healthy')\n",
            }
        ],
    }

    class StatefulExperienceService:
        def __init__(self):
            self.published: dict | None = None
            self.outcome: dict | None = None
            self.vote_record: dict | None = None

        def search(self, *, query, limit):
            assert query == "deploy FastAPI on Railway"
            assert limit == 3
            return {
                "total_found": 1,
                "results": [prior_experience],
            }

        def get(self, identifier, *, viewer_agent_id):
            assert identifier == "prior001"
            assert viewer_agent_id == AGENT_ID
            return prior_experience

        def create(self, *, agent_id, data):
            assert agent_id == UUID(AGENT_ID)
            self.published = {
                "id": PUBLISHED_EXPERIENCE_ID,
                "short_id": "new001",
                "agent_id": str(agent_id),
                "goal": data["goal"],
                "solution": data["solution"],
                "domain": data.get("domain"),
                "status": "draft",
            }
            return dict(self.published)

        def publish(self, identifier, *, agent_id):
            assert identifier == "new001"
            assert agent_id == UUID(AGENT_ID)
            assert self.published is not None
            self.published["status"] = "published"
            return dict(self.published)

        def report_outcome(
            self,
            *,
            identifier,
            agent_id,
            success,
            context_notes,
        ):
            assert identifier == "prior001"
            assert agent_id == UUID(AGENT_ID)
            self.outcome = {
                "experience_id": PRIOR_EXPERIENCE_ID,
                "success": success,
                "context_notes": context_notes,
            }
            return {"id": "report-1", **self.outcome}

        def vote(self, *, identifier, agent_id, vote_type):
            assert identifier == "prior001"
            assert agent_id == UUID(AGENT_ID)
            self.vote_record = {
                "experience_id": PRIOR_EXPERIENCE_ID,
                "vote_type": vote_type,
            }
            return {"id": "vote-1", **self.vote_record}

        def archive(self, *, identifier, agent_id):
            assert identifier == "new001"
            assert agent_id == UUID(AGENT_ID)
            assert self.published is not None
            self.published["status"] = "archived"
            return dict(self.published)

    service = StatefulExperienceService()
    events: list[dict] = []
    monkeypatch.setattr(auth, "validate_api_key", lambda _api_key: _agent(AGENT_ID))
    monkeypatch.setattr(tools, "ExperienceService", lambda: service)
    monkeypatch.setattr(
        tools,
        "log_event",
        lambda event_type, **kwargs: events.append({"event_type": event_type, **kwargs}),
    )
    app = create_app()

    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
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
                    inventory = await session.list_tools()
                    search = await session.call_tool(
                        "plurum_search",
                        {"query": "deploy FastAPI on Railway", "limit": 3},
                    )
                    detail = await session.call_tool(
                        "plurum_get_experience",
                        {"experience_id": "prior001"},
                    )
                    artifact = await session.call_tool(
                        "plurum_get_artifact",
                        {"experience_id": "prior001", "artifact_index": 0},
                    )
                    publish = await session.call_tool(
                        "plurum_publish",
                        {
                            "goal": "Share a verified FastAPI deployment sequence",
                            "solution": "Run a health probe before routing traffic.",
                            "domain": "devops",
                        },
                    )
                    outcome = await session.call_tool(
                        "plurum_report_outcome",
                        {"experience_id": "prior001", "outcome": "success"},
                    )
                    vote = await session.call_tool(
                        "plurum_vote",
                        {"experience_id": "prior001", "vote": "up"},
                    )
                    archive = await session.call_tool(
                        "plurum_archive",
                        {"experience_id": "new001"},
                    )

    assert [tool.name for tool in inventory.tools] == [
        "plurum_search",
        "plurum_get_experience",
        "plurum_get_artifact",
        "plurum_publish",
        "plurum_report_outcome",
        "plurum_archive",
        "plurum_vote",
    ]
    assert all(
        result.isError is False
        for result in (search, detail, artifact, publish, outcome, vote, archive)
    )
    assert search.structuredContent is not None
    assert search.structuredContent["results"][0]["short_id"] == "prior001"
    assert detail.structuredContent is not None
    assert detail.structuredContent["experience"]["artifacts"][0]["index"] == 0
    assert artifact.structuredContent is not None
    assert artifact.structuredContent["artifact"]["code"] == "print('healthy')\n"
    assert publish.structuredContent == {"result": "Published.", "id": "new001"}
    assert outcome.structuredContent == {"result": "Outcome recorded.", "id": "prior001"}
    assert vote.structuredContent == {"result": "Vote recorded.", "id": "prior001"}
    assert archive.structuredContent == {"result": "Archived.", "id": "new001"}
    assert [event["event_type"] for event in events] == [
        "search",
        "get_experience",
        "get_artifact",
        "create",
        "publish",
        "report_outcome",
        "vote",
        "archive",
    ]
    assert all(event["metadata"]["channel"] == "mcp" for event in events)
    assert all(event["metadata"]["client"] == "codex" for event in events)
    assert all(event["agent_id"] == AGENT_ID for event in events)
    assert service.outcome == {
        "experience_id": PRIOR_EXPERIENCE_ID,
        "success": True,
        "context_notes": None,
    }
    assert service.vote_record == {
        "experience_id": PRIOR_EXPERIENCE_ID,
        "vote_type": "up",
    }
    assert service.published is not None
    assert service.published["status"] == "archived"


@pytest.mark.asyncio
async def test_mcp_and_rest_search_share_one_agent_bucket(monkeypatch):
    from app.api.v1 import experiences as experience_routes
    from app.core import security
    from app.main import create_app
    from app.mcp import auth as mcp_auth
    from app.mcp import tools as mcp_tools

    agents = {
        "plrm_live_agent_a": _agent(AGENT_ID),
        "plrm_live_agent_b": _agent(OTHER_AGENT_ID),
    }
    search_calls: list[str] = []

    class StubExperienceService:
        def search(self, *, query, **_kwargs):
            search_calls.append(query)
            return {"query": query, "total_found": 0, "results": []}

    def validate_api_key(api_key: str) -> dict:
        return agents[api_key]

    monkeypatch.setattr(mcp_auth, "validate_api_key", validate_api_key)
    monkeypatch.setattr(security, "validate_api_key", validate_api_key)
    monkeypatch.setattr(mcp_tools, "ExperienceService", StubExperienceService)
    monkeypatch.setattr(experience_routes, "ExperienceService", StubExperienceService)
    monkeypatch.setattr(mcp_tools, "log_event", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(experience_routes, "log_event", lambda *_args, **_kwargs: None)

    search_limit = get_settings().rate_limit_search
    for _ in range(parse(search_limit).amount - 1):
        enforce_agent_rate_limit(
            agent_id=AGENT_ID,
            rate_limit=search_limit,
            scope=EXPERIENCE_SEARCH_SCOPE,
        )

    app = create_app()
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
            headers={
                "Authorization": "Bearer plrm_live_agent_a",
                "X-Plurum-Client": "codex",
            },
        ) as mcp_http_client:
            async with streamable_http_client(
                "http://testserver/mcp",
                http_client=mcp_http_client,
            ) as (read_stream, write_stream, _):
                async with ClientSession(read_stream, write_stream) as session:
                    await session.initialize()
                    mcp_result = await session.call_tool(
                        "plurum_search",
                        {"query": "consume final search unit"},
                    )

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
        ) as rest_client:
            same_agent = await rest_client.post(
                "/api/v1/experiences/search",
                headers={"Authorization": "Bearer plrm_live_agent_a"},
                json={"query": "same agent must be limited"},
            )
            other_agent = await rest_client.post(
                "/api/v1/experiences/search",
                headers={"Authorization": "Bearer plrm_live_agent_b"},
                json={"query": "other agent remains independent"},
            )

    assert mcp_result.isError is False
    assert same_agent.status_code == 429
    assert same_agent.json()["error"].startswith("Rate limit exceeded:")
    assert other_agent.status_code == 200
    assert search_calls == [
        "consume final search unit",
        "other agent remains independent",
    ]
