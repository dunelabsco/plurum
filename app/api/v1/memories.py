"""Memory API endpoints — personal memory layer.

Authentication: agent API key. The agent passes a `user_id` (UUID) to scope
memories per user. Agents are responsible for consistent user_id namespacing
across their sessions (e.g., hashing a Telegram user id into a UUID5).
"""

from __future__ import annotations

from typing import Optional
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, Query, status

from app.core.security import CurrentAgent
from app.models.memory import (
    MemoryCreate,
    MemoryExtract,
    MemorySearchRequest,
)
from app.services.memory_service import MemoryService

router = APIRouter(prefix="/memories", tags=["Memories"])


# -----------------------------------------------------------------------
# Helper: resolve or synthesize user_id from query param / header fallback
# -----------------------------------------------------------------------

def _resolve_user_id(user_id: Optional[str]) -> UUID:
    """Parse a user_id string or return the agent-scoped fallback."""
    if not user_id:
        raise HTTPException(
            status_code=400,
            detail="user_id query parameter is required (pass your platform user UUID)",
        )
    try:
        return UUID(user_id)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"user_id must be a UUID, got: {user_id!r}")


# -----------------------------------------------------------------------
# Write endpoints
# -----------------------------------------------------------------------

@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    summary="Create memory",
    description="""
    Explicitly store a durable fact about a user.
    Use for things the user has stated (preferences, identity, corrections).
    For automatic extraction from a conversation turn, use `/memories/extract`.
    """,
)
async def create_memory(
    data: MemoryCreate,
    agent: CurrentAgent,
    user_id: str = Query(..., description="UUID of the target user"),
):
    resolved = _resolve_user_id(user_id)
    service = MemoryService()
    return service.create(
        user_id=resolved,
        data=data.model_dump(),
        agent_id=UUID(agent["id"]),
    )


@router.post(
    "/extract",
    status_code=status.HTTP_201_CREATED,
    summary="Extract memories from a turn",
    description="""
    Run LLM-based fact extraction over a user/assistant turn pair and store
    durable memories. Returns the list of extracted memories (may be empty).

    Non-blocking for the caller: one OpenAI call + batch insert.
    """,
)
async def extract_memories(
    data: MemoryExtract,
    agent: CurrentAgent,
    user_id: str = Query(..., description="UUID of the target user"),
):
    resolved = _resolve_user_id(user_id)
    service = MemoryService()
    extracted = service.extract_from_turn(
        user_id=resolved,
        user_content=data.user_content,
        assistant_content=data.assistant_content,
        agent_id=UUID(agent["id"]),
        session_id=data.session_id,
        metadata=data.metadata,
        session_date=data.session_date,
        session_history=data.messages,
    )
    return {"extracted": extracted, "count": len(extracted)}


# -----------------------------------------------------------------------
# Read endpoints
# -----------------------------------------------------------------------

@router.post(
    "/search",
    summary="Search memories",
    description="""
    Hybrid vector + keyword search over a user's memories.
    Scoped to the provided `user_id` — memories from other users are never returned.
    """,
)
async def search_memories(
    data: MemorySearchRequest,
    agent: CurrentAgent,
    user_id: str = Query(..., description="UUID of the target user"),
):
    resolved = _resolve_user_id(user_id)
    service = MemoryService()
    return service.search(
        user_id=resolved,
        query=data.query,
        memory_type=data.memory_type.value if data.memory_type else None,
        limit=data.limit,
    )


@router.get(
    "",
    summary="List memories",
    description="Browse a user's memories (no query, recency-ordered).",
)
async def list_memories(
    agent: CurrentAgent,
    user_id: str = Query(..., description="UUID of the target user"),
    memory_type: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    resolved = _resolve_user_id(user_id)
    service = MemoryService()
    return service.list_memories(
        user_id=resolved,
        memory_type=memory_type,
        limit=limit,
        offset=offset,
    )


@router.get(
    "/{identifier}",
    summary="Get memory detail",
)
async def get_memory(
    identifier: str,
    agent: CurrentAgent,
    user_id: str = Query(..., description="UUID of the owning user"),
):
    resolved = _resolve_user_id(user_id)
    service = MemoryService()
    return service.get(identifier, resolved)


@router.delete(
    "/{identifier}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete memory",
    description="Soft delete by default (marks inactive). Use `?hard=true` to permanently remove.",
)
async def delete_memory(
    identifier: str,
    agent: CurrentAgent,
    user_id: str = Query(..., description="UUID of the owning user"),
    hard: bool = Query(False),
):
    resolved = _resolve_user_id(user_id)
    service = MemoryService()
    service.delete(identifier, resolved, hard=hard)
    return None
