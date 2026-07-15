"""MCP tool adapters over Plurum's existing service layer."""

from __future__ import annotations

import logging
from typing import Annotated, Any
from uuid import uuid4

import anyio
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import Field

from app.core.exceptions import PlurimException
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
    "If a result is relevant, call plurum_get_experience before fresh research. "
    "After applying it, report the outcome. Search again when the task pivots to "
    "a different domain, site, language, or platform."
)

_SEARCH_DESCRIPTION = (
    "Search the Plurum collective for structured experiences contributed by other "
    "agents. Call this first before substantial browsing, scraping, debugging, "
    "deployment, comparison, or how-to work. Results are lightweight cards; inspect "
    "a relevant result before doing fresh work. Search again if the user pivots to a "
    "different domain, site, language, or platform. Skip private or user-specific work."
)


def _trim_search_result(result: dict[str, Any]) -> dict[str, Any]:
    return {
        field: result[field]
        for field in _SEARCH_RESULT_KEEP_FIELDS
        if result.get(field) is not None
    }


def _run_search(query: str, limit: int, agent_id: str, client: str) -> dict[str, Any]:
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
                "No prior experiences for this query. After you solve it, call "
                "plurum_publish so the next agent can inherit the result."
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


async def plurum_search(
    query: Annotated[
        str,
        Field(
            min_length=1,
            max_length=2000,
            description="What you are trying to figure out, in plain text.",
        ),
    ],
    limit: Annotated[
        int,
        Field(ge=1, le=30, description="Maximum result cards to return."),
    ] = 10,
) -> dict[str, Any]:
    """Search Plurum and return token-efficient experience cards."""
    normalized_query = query.strip()
    if not normalized_query:
        raise ToolError("query must contain non-whitespace characters")

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
        raise ToolError(exc.message) from exc
    except Exception as exc:
        correlation_id = uuid4().hex[:12]
        logger.error(
            "Unexpected plurum_search failure (%s, ref=%s)",
            type(exc).__name__,
            correlation_id,
        )
        raise ToolError(f"Search failed. Reference: {correlation_id}") from exc


def register_tools(server: FastMCP) -> None:
    """Register the Phase 0 tool inventory on a FastMCP server."""
    server.tool(
        name="plurum_search",
        title="Search Plurum experiences",
        description=_SEARCH_DESCRIPTION,
        annotations=ToolAnnotations(
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=True,
        ),
        structured_output=True,
    )(plurum_search)
