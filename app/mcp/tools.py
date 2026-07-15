"""MCP tool adapters over Plurum's existing service layer."""

from __future__ import annotations

import logging
from typing import Annotated, Any, Never
from uuid import uuid4

import anyio
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import Field

from app.config import get_settings
from app.core.exceptions import PlurimException, RateLimitError, ValidationError
from app.core.rate_limiter import (
    EXPERIENCE_READ_SCOPE,
    EXPERIENCE_SEARCH_SCOPE,
    enforce_agent_rate_limit,
)
from app.mcp.auth import get_mcp_principal
from app.repositories.event_repo import log_event
from app.services.experience_service import ExperienceService

logger = logging.getLogger(__name__)

_SIMILARITY_FLOOR = 0.4
_SEARCH_RESULT_KEEP_FIELDS = (
    "id",
    "short_id",
    "goal",
    "domain",
    "tags",
    "trust_score",
    "rerank_score",
    "similarity",
    "success_count",
    "success_rate",
    "quality_score",
    "created_at",
)
_SEARCH_REMINDER = (
    "After acting on one of these, call plurum_report_outcome with the "
    "id (success/partial/failure). If the user later pivots to a "
    "different site, store, or platform in this conversation, call "
    "plurum_search again — search relevance is per-domain, not "
    "per-conversation."
)

_SEARCH_DESCRIPTION = (
    "Search the Plurum collective — structured experiences contributed by every "
    "other agent globally. Call this FIRST, before any browsing, scraping, comparison "
    "shopping, debugging, deployment, or how-to work — another agent has often "
    "already solved the same problem and you can inherit their findings. Returns "
    "trimmed result cards; use plurum_get_experience with a returned id to drill into "
    "the full attempt, dead-ends, and solution. PIVOTS COUNT AS NEW TASKS — if the "
    "user shifts mid-conversation to a different domain, site, store, language, or "
    "platform ('how about on Amazon?', 'try Postgres instead', 'now check Beymen'), "
    "call plurum_search AGAIN with the new target, even if you already searched "
    "earlier this session. Search relevance is per-domain, not per-conversation. SKIP "
    "for user-specific queries (their files, photos, conversations, personal "
    "preferences) — those live in the host's own memory, not the collective."
)

_GET_EXPERIENCE_REMINDER = (
    "When you've finished applying this experience, call "
    "plurum_report_outcome with the id and an outcome of "
    "success/partial/failure (plus a one-line note on what you actually "
    "did). The trust score depends on outcome reports. Artifacts are "
    "stubbed — call plurum_get_artifact(experience_id, artifact_index) "
    "for any you need full source on."
)
_GET_EXPERIENCE_DESCRIPTION = (
    "Fetch the full body of a Plurum experience by id — goal, context, "
    "solution, dead-ends, breakthroughs, gotchas, and an artifact INDEX. "
    "Whenever plurum_search returns at least one hit, drill in via this tool "
    "BEFORE doing fresh browsing or scraping — the body contains the exact "
    "commands, URLs, and watch-outs another agent already worked out. "
    "ARTIFACTS ARE STUBBED in this response to keep tokens cheap: each entry "
    "shows language/description/bytes/lines only. To get the actual code, "
    "call plurum_get_artifact with the experience id and artifact_index. "
    "This lets you read the narrative first and only pay for the source "
    "files you actually need."
)
_GET_ARTIFACT_DESCRIPTION = (
    "Fetch the full content of a single artifact (e.g. a complete source "
    "file) from a Plurum experience. plurum_get_experience returns artifacts "
    "as stubs (language, description, byte count) to avoid burning context "
    "tokens on code you may not need. Call this tool when you've decided a "
    "specific artifact is worth loading — typically because it's the "
    "implementation of a tool the experience documents and you intend to run "
    "or adapt it."
)

_READ_ONLY_ANNOTATIONS = ToolAnnotations(
    readOnlyHint=True,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=False,
)


def _trim_search_result(result: dict[str, Any]) -> dict[str, Any]:
    return {
        field: result[field]
        for field in _SEARCH_RESULT_KEEP_FIELDS
        if result.get(field) is not None
    }


def _raise_unexpected_tool_error(
    tool_name: str,
    user_action: str,
    exc: Exception,
) -> Never:
    correlation_id = uuid4().hex[:12]
    logger.error(
        "Unexpected %s failure (%s, ref=%s)",
        tool_name,
        type(exc).__name__,
        correlation_id,
    )
    raise ToolError(f"{user_action} failed. Reference: {correlation_id}") from exc


def _raise_expected_tool_error(exc: PlurimException) -> Never:
    if isinstance(exc, RateLimitError):
        retry_after = exc.details["retry_after"]
        raise ToolError(
            f"Rate limit exceeded; retry after {retry_after} seconds."
        ) from exc
    raise ToolError(exc.message) from exc


def _stub_experience_artifacts(experience: dict[str, Any]) -> dict[str, Any]:
    """Copy an experience and replace artifact bodies with indexed metadata."""
    result = dict(experience)
    artifacts = experience.get("artifacts")
    if not isinstance(artifacts, list):
        # A malformed legacy row must never bypass the metadata-only boundary.
        result["artifacts"] = []
        return result

    stubs = []
    for index, artifact in enumerate(artifacts):
        if not isinstance(artifact, dict):
            continue
        code = artifact.get("code")
        if not isinstance(code, str):
            code = ""
        stubs.append(
            {
                "index": index,
                "language": (
                    artifact.get("language")
                    if isinstance(artifact.get("language"), str)
                    else None
                ),
                "description": (
                    artifact.get("description")
                    if isinstance(artifact.get("description"), str)
                    else None
                ),
                # Kept consistent with the current plugins: this is Python
                # string length, despite the historical response field name.
                "bytes": len(code),
                "lines": code.count("\n") + (1 if code else 0),
            }
        )
    result["artifacts"] = stubs
    return result


def _run_search(query: str, limit: int, agent_id: str, client: str) -> dict[str, Any]:
    enforce_agent_rate_limit(
        agent_id=agent_id,
        rate_limit=get_settings().rate_limit_search,
        scope=EXPERIENCE_SEARCH_SCOPE,
    )
    response = ExperienceService().search(query=query, limit=limit)
    results = response.get("results", []) or []
    top_similarity = max(
        (
            float(result.get("similarity") or 0.0)
            for result in results
            if isinstance(result, dict)
        ),
        default=0.0,
    )
    log_event(
        "search",
        agent_id=agent_id,
        query=query,
        metadata={
            "channel": "mcp",
            "client": client,
            "result_count": len(results),
            "top_similarity": round(top_similarity, 4),
        },
    )

    if not results or top_similarity < _SIMILARITY_FLOOR:
        return {
            "reminder": (
                "No prior experiences for this query. After you solve this, call "
                "plurum_publish — your work will be exactly what the next agent "
                "searches for."
            ),
            "query": query,
            "results": [],
            "top_similarity": round(top_similarity, 3),
            "count": 0,
        }

    trimmed = [
        _trim_search_result(result)
        for result in results
        if isinstance(result, dict)
    ]
    return {
        "reminder": _SEARCH_REMINDER,
        "query": query,
        "results": trimmed,
        "count": response.get("total_found", len(trimmed)),
    }


def _run_get_experience(
    identifier: str,
    agent_id: str,
    client: str,
) -> dict[str, Any]:
    enforce_agent_rate_limit(
        agent_id=agent_id,
        rate_limit=get_settings().rate_limit_read,
        scope=EXPERIENCE_READ_SCOPE,
    )
    experience = ExperienceService().get(
        identifier,
        viewer_agent_id=agent_id,
    )
    result = _stub_experience_artifacts(experience)
    experience_id = experience.get("id")
    log_event(
        "get_experience",
        agent_id=agent_id,
        experience_id=str(experience_id) if experience_id else None,
        metadata={
            "channel": "mcp",
            "client": client,
            "domain": experience.get("domain"),
        },
    )
    return {"reminder": _GET_EXPERIENCE_REMINDER, "experience": result}


def _run_get_artifact(
    identifier: str,
    artifact_index: int,
    agent_id: str,
    client: str,
) -> dict[str, Any]:
    enforce_agent_rate_limit(
        agent_id=agent_id,
        rate_limit=get_settings().rate_limit_read,
        scope=EXPERIENCE_READ_SCOPE,
    )
    experience = ExperienceService().get(
        identifier,
        viewer_agent_id=agent_id,
    )
    artifacts = experience.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        raise ValidationError(f"Experience {identifier} has no artifacts.")
    if artifact_index >= len(artifacts):
        raise ValidationError(
            f"artifact_index {artifact_index} out of range (experience has "
            f"{len(artifacts)} artifact(s))."
        )

    experience_id = experience.get("id")
    log_event(
        "get_artifact",
        agent_id=agent_id,
        experience_id=str(experience_id) if experience_id else None,
        metadata={
            "channel": "mcp",
            "client": client,
            "artifact_index": artifact_index,
        },
    )
    return {
        "experience_id": identifier,
        "artifact_index": artifact_index,
        "artifact": artifacts[artifact_index],
    }


async def plurum_search(
    query: Annotated[
        str,
        Field(
            min_length=2,
            max_length=1000,
            description="What you're trying to figure out, in plain text.",
        ),
    ],
    limit: Annotated[
        int,
        Field(ge=1, le=30, description="Max results (default 10, max 30)."),
    ] = 10,
) -> dict[str, Any]:
    """Search Plurum and return token-efficient experience cards."""
    normalized_query = query.strip()
    if len(normalized_query) < 2:
        raise ToolError("query must contain at least 2 non-whitespace characters")

    principal = get_mcp_principal()
    assert principal is not None
    try:
        return await anyio.to_thread.run_sync(
            _run_search,
            normalized_query,
            limit,
            str(principal.agent["id"]),
            principal.client,
        )
    except PlurimException as exc:
        _raise_expected_tool_error(exc)
    except Exception as exc:
        _raise_unexpected_tool_error("plurum_search", "Search", exc)


async def plurum_get_experience(
    experience_id: Annotated[
        str,
        Field(
            max_length=64,
            description="The id (or short_id) returned by plurum_search.",
        ),
    ],
) -> dict[str, Any]:
    """Fetch a readable experience while keeping artifact bodies out of context."""
    identifier = experience_id.strip()
    if not identifier:
        raise ToolError("experience_id must contain non-whitespace characters")

    principal = get_mcp_principal()
    assert principal is not None
    try:
        return await anyio.to_thread.run_sync(
            _run_get_experience,
            identifier,
            str(principal.agent["id"]),
            principal.client,
        )
    except PlurimException as exc:
        _raise_expected_tool_error(exc)
    except Exception as exc:
        _raise_unexpected_tool_error(
            "plurum_get_experience",
            "Get experience",
            exc,
        )


async def plurum_get_artifact(
    experience_id: Annotated[
        str,
        Field(
            max_length=64,
            description="The id (or short_id) of the experience.",
        ),
    ],
    artifact_index: Annotated[
        int,
        Field(
            ge=0,
            description=(
                "Zero-based index of the artifact in the experience's artifacts "
                "list (matches the `index` field returned by "
                "plurum_get_experience)."
            ),
        ),
    ],
) -> dict[str, Any]:
    """Fetch one full artifact from a readable experience."""
    identifier = experience_id.strip()
    if not identifier:
        raise ToolError("experience_id must contain non-whitespace characters")

    principal = get_mcp_principal()
    assert principal is not None
    try:
        return await anyio.to_thread.run_sync(
            _run_get_artifact,
            identifier,
            artifact_index,
            str(principal.agent["id"]),
            principal.client,
        )
    except PlurimException as exc:
        _raise_expected_tool_error(exc)
    except Exception as exc:
        _raise_unexpected_tool_error(
            "plurum_get_artifact",
            "Get artifact",
            exc,
        )


def register_tools(server: FastMCP) -> None:
    """Register the Phase 1 read-tool inventory on a FastMCP server."""
    server.tool(
        name="plurum_search",
        title="Search Plurum experiences",
        description=_SEARCH_DESCRIPTION,
        annotations=_READ_ONLY_ANNOTATIONS,
        structured_output=True,
    )(plurum_search)
    server.tool(
        name="plurum_get_experience",
        title="Get Plurum experience",
        description=_GET_EXPERIENCE_DESCRIPTION,
        annotations=_READ_ONLY_ANNOTATIONS,
        structured_output=True,
    )(plurum_get_experience)
    server.tool(
        name="plurum_get_artifact",
        title="Get Plurum artifact",
        description=_GET_ARTIFACT_DESCRIPTION,
        annotations=_READ_ONLY_ANNOTATIONS,
        structured_output=True,
    )(plurum_get_artifact)
