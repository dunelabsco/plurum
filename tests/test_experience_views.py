"""Stable public experience response contract tests."""

from app.models.experience_views import (
    experience_detail,
    experience_list_item,
    experience_search_result,
)


def full_row() -> dict:
    return {
        "id": "00000000-0000-0000-0000-000000000100",
        "short_id": "Ab3xKp9z",
        "session_id": None,
        "agent_id": "00000000-0000-0000-0000-000000000001",
        "goal": "Deploy FastAPI to Railway",
        "domain": "deployment",
        "tools_used": ["railway", "docker"],
        "dead_ends": [{"what": "Wrong health path", "why": "Failed checks"}],
        "breakthroughs": [{"insight": "Add /health", "detail": "Return 200"}],
        "gotchas": [{"warning": "Use the injected PORT"}],
        "context": "Python 3.11",
        "artifacts": [{"language": "dockerfile", "code": "FROM python:3.11"}],
        "status": "published",
        "visibility": "public",
        "outcome": "success",
        "success_count": 12,
        "failure_count": 1,
        "total_reports": 13,
        "success_rate": 0.92,
        "upvotes": 18,
        "downvotes": 1,
        "quality_score": 0.81,
        "reasoning_embedding": [0.1] * 1536,
        "search_vector": "'deploy':1 'railway':2",
        "created_at": "2026-07-01T14:22:00Z",
        "updated_at": "2026-07-09T11:18:00Z",
        "attempts_json": [],
        "solution": "Use a dedicated health endpoint",
        "tags": ["fastapi", "railway"],
        "confidence": 0.9,
        "context_structured": {"environment": "Railway"},
        "future_internal_column": "must not escape",
    }


def test_detail_preserves_full_content_but_excludes_internal_fields():
    result = experience_detail(full_row())

    assert result["solution"] == "Use a dedicated health endpoint"
    assert result["artifacts"][0]["code"] == "FROM python:3.11"
    assert "reasoning_embedding" not in result
    assert "search_vector" not in result
    assert "future_internal_column" not in result


def test_list_item_is_a_lightweight_summary():
    result = experience_list_item(full_row())

    assert result["goal"] == "Deploy FastAPI to Railway"
    assert result["quality_score"] == 0.81
    assert "solution" not in result
    assert "artifacts" not in result
    assert "reasoning_embedding" not in result


def test_search_preserves_historical_clawhub_selection_fields():
    row = full_row() | {
        "trust_score": 0.81,
        "similarity": 0.89,
        "keyword_rank": 0.31,
        "combined_score": 0.027,
        "rerank_score": 1.4,
    }

    result = experience_search_result(row)

    historical_fields = {
        "id",
        "short_id",
        "goal",
        "quality_score",
        "trust_score",
        "success_rate",
        "similarity",
        "total_reports",
        "confidence",
        "tags",
    }
    assert historical_fields <= result.keys()
    assert "solution" not in result
    assert "artifacts" not in result
    assert "reasoning_embedding" not in result
