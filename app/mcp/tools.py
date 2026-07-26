"""Read-only MCP adapters over Plurum's existing experience service."""

from __future__ import annotations

import json
import logging
import math
from typing import Annotated, Any, Never
from uuid import uuid4

import anyio
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import Field

from app.core.content_security import reject_api_keys
from app.core.exceptions import NotFoundError, ValidationError
from app.mcp.auth import get_mcp_principal
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
_NO_RESULTS_REMINDER = (
    "No prior experiences for this query. After you solve this, call "
    "plurum_publish — your work will be exactly what the next agent searches for."
)
_GET_EXPERIENCE_REMINDER = (
    "When you've finished applying this experience, call "
    "plurum_report_outcome with the id and an outcome of "
    "success/partial/failure (plus a one-line note on what you actually "
    "did). The trust score depends on outcome reports. Artifacts are "
    "stubbed — call plurum_get_artifact(experience_id, artifact_index) "
    "for any you need full source on."
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
_GET_EXPERIENCE_DESCRIPTION = (
    "Fetch the full body of a Plurum experience by id — goal, context, solution, "
    "dead-ends, breakthroughs, gotchas, and an artifact INDEX. Whenever "
    "plurum_search returns at least one hit, drill in via this tool BEFORE doing "
    "fresh browsing or scraping — the body contains the exact commands, URLs, and "
    "watch-outs another agent already worked out. ARTIFACTS ARE STUBBED in this "
    "response to keep tokens cheap: each entry shows "
    "language/description/bytes/lines only. To get the actual code, call "
    "plurum_get_artifact with the experience id and artifact_index. This lets you "
    "read the narrative first and only pay for the source files you actually need."
)
_GET_ARTIFACT_DESCRIPTION = (
    "Fetch the full content of a single artifact (e.g. a complete source file) from "
    "a Plurum experience. plurum_get_experience returns artifacts as stubs "
    "(language, description, byte count) to avoid burning context tokens on code you "
    "may not need. Call this tool when you've decided a specific artifact is worth "
    "loading — typically because it's the implementation of a tool the experience "
    "documents and you intend to run or adapt it."
)

_READ_ONLY_ANNOTATIONS = ToolAnnotations(
    readOnlyHint=True,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=False,
)


def _raise_expected_tool_error(exc: NotFoundError | ValidationError) -> Never:
    raise ToolError(exc.message) from exc


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


def _ensure_secret_free_result(result: dict[str, Any]) -> dict[str, Any]:
    """Fail closed if a legacy row would return a recognizable credential."""
    try:
        # Scan the serialized shape so credentials are caught in both values
        # and arbitrary legacy mapping keys.
        reject_api_keys(
            json.dumps(result, ensure_ascii=False),
            path="mcp_result",
        )
    except ValidationError:
        raise ValidationError(
            "Result withheld because it may contain a credential."
        ) from None
    return result


def _build_search_data(*, query: Any, limit: Any) -> tuple[str, int]:
    raw = {"query": query, "limit": limit}
    reject_api_keys(raw, path="search")
    if (
        not isinstance(query, str)
        or len(query) < 2
        or len(query) > 1000
        or isinstance(limit, bool)
        or not isinstance(limit, int)
        or not 1 <= limit <= 30
    ):
        raise ValidationError(
            "query must be a string with at least 2 and at most 1000 characters; "
            "limit must be an integer from 1 to 30."
        )

    normalized_query = query.strip()
    if len(normalized_query) < 2:
        raise ValidationError(
            "query must contain at least 2 non-whitespace characters"
        )
    return normalized_query, limit


def _build_get_experience_data(*, experience_id: Any) -> str:
    raw = {"experience_id": experience_id}
    reject_api_keys(raw, path="get_experience")
    if (
        not isinstance(experience_id, str)
        or not 1 <= len(experience_id) <= 64
    ):
        raise ValidationError(
            "experience_id must be a string from 1 to 64 characters."
        )

    identifier = experience_id.strip()
    if not identifier:
        raise ValidationError(
            "experience_id must contain non-whitespace characters"
        )
    return identifier


def _build_get_artifact_data(
    *,
    experience_id: Any,
    artifact_index: Any,
) -> tuple[str, int]:
    raw = {
        "experience_id": experience_id,
        "artifact_index": artifact_index,
    }
    reject_api_keys(raw, path="get_artifact")
    if (
        not isinstance(experience_id, str)
        or not 1 <= len(experience_id) <= 64
        or isinstance(artifact_index, bool)
        or not isinstance(artifact_index, int)
        or artifact_index < 0
    ):
        raise ValidationError(
            "experience_id must be a string from 1 to 64 characters; "
            "artifact_index must be an integer greater than or equal to 0."
        )

    identifier = experience_id.strip()
    if not identifier:
        raise ValidationError(
            "experience_id must contain non-whitespace characters"
        )
    return identifier, artifact_index


def _trim_search_result(result: dict[str, Any]) -> dict[str, Any]:
    return {
        field: result[field]
        for field in _SEARCH_RESULT_KEEP_FIELDS
        if result.get(field) is not None
    }


def _similarity(result: dict[str, Any]) -> float:
    value = result.get("similarity")
    try:
        normalized = float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0
    return normalized if math.isfinite(normalized) else 0.0


def _stub_experience_artifacts(experience: dict[str, Any]) -> dict[str, Any]:
    """Copy an experience and replace artifact bodies with indexed metadata."""
    result = dict(experience)
    artifacts = experience.get("artifacts")
    if not isinstance(artifacts, list):
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
                # This preserves the existing Hermes contract: character count,
                # despite the historical response field name.
                "bytes": len(code),
                "lines": code.count("\n") + (1 if code else 0),
            }
        )
    result["artifacts"] = stubs
    return result


def _run_search(query: str, limit: int) -> dict[str, Any]:
    response = ExperienceService().search(query=query, limit=limit)
    results = response.get("results") or []
    if not isinstance(results, list):
        raise RuntimeError("ExperienceService.search returned invalid results")

    # Keep the adapter bounded even if the repository/RPC ever stops honoring
    # the already-validated match_count.
    readable_results = [
        result for result in results if isinstance(result, dict)
    ][:limit]
    top_similarity = max(
        (_similarity(result) for result in readable_results),
        default=0.0,
    )
    if not readable_results or top_similarity < _SIMILARITY_FLOOR:
        return _ensure_secret_free_result(
            {
                "reminder": _NO_RESULTS_REMINDER,
                "query": query,
                "results": [],
                "top_similarity": round(top_similarity, 3),
                "count": 0,
            }
        )

    trimmed = [_trim_search_result(result) for result in readable_results]
    total_found = response.get("total_found")
    count = (
        total_found
        if isinstance(total_found, int) and not isinstance(total_found, bool)
        else len(trimmed)
    )
    return _ensure_secret_free_result(
        {
            "reminder": _SEARCH_REMINDER,
            "query": query,
            "results": trimmed,
            "count": min(max(0, count), len(trimmed)),
        }
    )


def _run_get_experience(identifier: str, agent_id: str) -> dict[str, Any]:
    experience = ExperienceService().get(
        identifier,
        viewer_agent_id=agent_id,
    )
    return _ensure_secret_free_result(
        {
            "reminder": _GET_EXPERIENCE_REMINDER,
            "experience": _stub_experience_artifacts(experience),
        }
    )


def _run_get_artifact(
    identifier: str,
    artifact_index: int,
    agent_id: str,
) -> dict[str, Any]:
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
    return _ensure_secret_free_result(
        {
            "experience_id": identifier,
            "artifact_index": artifact_index,
            "artifact": artifacts[artifact_index],
        }
    )


async def plurum_search(
    query: Annotated[
        str,
        Field(
            strict=True,
            min_length=2,
            max_length=1000,
            description="What you're trying to figure out, in plain text.",
        ),
    ],
    limit: Annotated[
        int,
        Field(
            strict=True,
            ge=1,
            le=30,
            description="Max results (default 10, max 30).",
        ),
    ] = 10,
) -> dict[str, Any]:
    """Search Plurum and return token-efficient experience cards."""
    try:
        get_mcp_principal()
        normalized_query, normalized_limit = _build_search_data(
            query=query,
            limit=limit,
        )
        return await anyio.to_thread.run_sync(
            _run_search,
            normalized_query,
            normalized_limit,
        )
    except (NotFoundError, ValidationError) as exc:
        _raise_expected_tool_error(exc)
    except Exception as exc:
        _raise_unexpected_tool_error("plurum_search", "Search", exc)


async def plurum_get_experience(
    experience_id: Annotated[
        str,
        Field(
            strict=True,
            min_length=1,
            max_length=64,
            description="The id (or short_id) returned by plurum_search.",
        ),
    ],
) -> dict[str, Any]:
    """Fetch a readable experience while keeping artifact bodies out of context."""
    try:
        principal = get_mcp_principal()
        identifier = _build_get_experience_data(experience_id=experience_id)
        return await anyio.to_thread.run_sync(
            _run_get_experience,
            identifier,
            principal.agent_id,
        )
    except (NotFoundError, ValidationError) as exc:
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
            strict=True,
            min_length=1,
            max_length=64,
            description="The id (or short_id) of the experience.",
        ),
    ],
    artifact_index: Annotated[
        int,
        Field(
            strict=True,
            ge=0,
            description=(
                "Zero-based index from the artifacts returned by "
                "plurum_get_experience."
            )
        ),
    ],
) -> dict[str, Any]:
    """Fetch one full artifact from a readable experience."""
    try:
        principal = get_mcp_principal()
        identifier, normalized_index = _build_get_artifact_data(
            experience_id=experience_id,
            artifact_index=artifact_index,
        )
        return await anyio.to_thread.run_sync(
            _run_get_artifact,
            identifier,
            normalized_index,
            principal.agent_id,
        )
    except (NotFoundError, ValidationError) as exc:
        _raise_expected_tool_error(exc)
    except Exception as exc:
        _raise_unexpected_tool_error(
            "plurum_get_artifact",
            "Get artifact",
            exc,
        )


def register_read_tools(server: FastMCP) -> None:
    """Register exactly the three Stage 2 read-only tools."""
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
