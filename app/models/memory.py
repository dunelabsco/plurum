"""Memory-related Pydantic models.

Memories are the PERSONAL layer — user-scoped facts, preferences, observations.
Distinct from experiences (the COLLECTIVE layer — shared structured reasoning).
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Enums / literals
# ---------------------------------------------------------------------------

class MemoryType(str, Enum):
    """What kind of memory this is."""

    FACT = "fact"                 # Objective statement ("User lives in SF")
    PREFERENCE = "preference"     # User preference ("prefers Python over JS")
    OBSERVATION = "observation"   # Agent's observation about the user
    NOTE = "note"                 # Freeform note


class Importance(str, Enum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class MemoryCreate(BaseModel):
    """Explicitly create a memory (user-conscious storage)."""

    content: str = Field(..., min_length=1, max_length=2000)
    memory_type: MemoryType = MemoryType.FACT
    importance: Importance = Importance.MEDIUM
    metadata: dict = Field(default_factory=dict)
    expires_at: Optional[datetime] = Field(None, description="Auto-forget after this time")


class MemoryExtract(BaseModel):
    """Extract memories from a conversation turn (LLM-based)."""

    user_content: str = Field(..., min_length=1)
    assistant_content: str = Field(..., min_length=1)
    session_id: Optional[UUID] = None
    session_date: Optional[str] = Field(
        None,
        description="Timestamp of the session/turn (ISO format or natural language). "
                    "Lets the LLM anchor relative times like 'last week' to an absolute date.",
    )
    metadata: dict = Field(default_factory=dict)


class MemorySearchRequest(BaseModel):
    """Search user's own memories."""

    query: str = Field(..., min_length=1, max_length=1000)
    memory_type: Optional[MemoryType] = None
    limit: int = Field(10, ge=1, le=50)


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------

class MemorySummary(BaseModel):
    """A single memory summary."""

    id: UUID
    short_id: str
    content: str
    memory_type: MemoryType
    importance: Importance
    metadata: dict
    agent_id: Optional[UUID] = None
    session_id: Optional[UUID] = None
    created_at: datetime

    class Config:
        from_attributes = True


class MemoryDetail(MemorySummary):
    """Full memory with source turn context."""

    source_user: Optional[str] = None
    source_assistant: Optional[str] = None
    expires_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    is_active: bool = True

    class Config:
        from_attributes = True


class MemorySearchResult(BaseModel):
    """A single result with relevance signals."""

    memory: MemorySummary
    similarity: float = Field(0.0, ge=0.0, le=1.0)
    keyword_rank: float = Field(0.0, ge=0.0)
    combined_score: float = Field(0.0, ge=0.0)


class MemorySearchResponse(BaseModel):
    query: str
    results: list[MemorySearchResult]
    total_found: int


class MemoryListResponse(BaseModel):
    items: list[MemorySummary]
    total: int
    limit: int
    offset: int
    has_more: bool


class MemoryExtractResponse(BaseModel):
    """What the extractor stored."""

    extracted: list[MemorySummary]
    count: int


# ---------------------------------------------------------------------------
# Profile response
# ---------------------------------------------------------------------------

class ProfileResponse(BaseModel):
    """
    Fast aggregate for prompt hydration.

    Combines user's top memories + top relevant collective experiences
    in a single call. Target latency ~100ms.
    """

    user_id: UUID
    memories: list[MemorySummary]           # user's personal memories
    experiences: list[dict]                 # relevant collective experiences (raw dicts)
    memory_count: int
    generated_at: datetime
