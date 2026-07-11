"""Stable public projections for experience API responses."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


EXPERIENCE_LIST_FIELDS = (
    "id",
    "short_id",
    "session_id",
    "agent_id",
    "goal",
    "domain",
    "tools_used",
    "status",
    "visibility",
    "outcome",
    "success_count",
    "failure_count",
    "total_reports",
    "success_rate",
    "upvotes",
    "downvotes",
    "quality_score",
    "created_at",
    "updated_at",
    "tags",
    "confidence",
)

# Preserve the union of selection fields documented by historical ClawHub
# experience skills (v0.2.0 onward) and used by the official plugins/web app.
EXPERIENCE_SEARCH_FIELDS = EXPERIENCE_LIST_FIELDS + (
    "trust_score",
    "similarity",
    "keyword_rank",
    "combined_score",
    "rerank_score",
)

EXPERIENCE_DETAIL_FIELDS = EXPERIENCE_LIST_FIELDS + (
    "dead_ends",
    "breakthroughs",
    "gotchas",
    "context",
    "artifacts",
    "attempts_json",
    "solution",
    "context_structured",
)

EXPERIENCE_LIST_SELECT = ",".join(EXPERIENCE_LIST_FIELDS)


def _project(row: Mapping[str, Any], fields: tuple[str, ...]) -> dict:
    return {field: row[field] for field in fields if field in row}


def experience_list_item(row: Mapping[str, Any]) -> dict:
    """Return the lightweight browse/dashboard representation."""
    return _project(row, EXPERIENCE_LIST_FIELDS)


def experience_search_result(row: Mapping[str, Any]) -> dict:
    """Return the historical search-card contract without full reasoning."""
    return _project(row, EXPERIENCE_SEARCH_FIELDS)


def experience_detail(row: Mapping[str, Any]) -> dict:
    """Return useful full content while excluding retrieval internals."""
    return _project(row, EXPERIENCE_DETAIL_FIELDS)
