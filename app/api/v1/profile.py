"""Profile endpoint — fast aggregate for prompt hydration.

Combines a user's top memories + (optionally) the most relevant collective
experiences in a single call. Target latency: well under 500ms without cache,
and we can add Redis caching later if needed.

This is the Plurum equivalent of Supermemory's ~50ms `profile()` — the
single call an agent makes at the start of a conversation to get "everything
useful to know about this user right now."
"""

from __future__ import annotations

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query

from app.core.security import CurrentAgent
from app.services.memory_service import MemoryService

router = APIRouter(prefix="/profile", tags=["Profile"])


@router.get(
    "",
    summary="Fast user profile",
    description="""
    Return a user's top personal memories + (optional) matching collective experiences.

    Use this at the start of a conversation for cheap context hydration.
    Without `query`: returns only memories, recency-ordered.
    With `query`: also returns the top-N collective experiences matching the query.
    """,
)
async def get_profile(
    agent: CurrentAgent,
    user_id: str = Query(..., description="UUID of the target user"),
    query: Optional[str] = Query(None, description="Task context — if provided, also returns top matching experiences"),
    memory_limit: int = Query(10, ge=1, le=50),
    experience_limit: int = Query(5, ge=0, le=20),
):
    try:
        resolved = UUID(user_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="user_id must be a UUID")

    service = MemoryService()
    return service.profile(
        user_id=resolved,
        query=query,
        memory_limit=memory_limit,
        experience_limit=experience_limit,
    )
