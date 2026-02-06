"""Experience-related Pydantic models."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from uuid import UUID

from pydantic import BaseModel, Field

from app.models.session import Visibility


class ExperienceStatus(str, Enum):
    """Experience lifecycle status."""

    DRAFT = "draft"
    PUBLISHED = "published"
    VERIFIED = "verified"
    ARCHIVED = "archived"


class CompressionMode(str, Enum):
    """How to format an experience for context injection."""

    SUMMARY = "summary"              # One-paragraph distillation
    CHECKLIST = "checklist"          # Do/don't/watch bullet lists
    DECISION_TREE = "decision_tree"  # If/then structure
    FULL = "full"                    # Complete reasoning dump


# ---------------------------------------------------------------------------
# Structured reasoning types
# ---------------------------------------------------------------------------

class DeadEnd(BaseModel):
    """Something that was tried and didn't work."""

    what: str = Field(..., description="What was attempted")
    why: str = Field(..., description="Why it didn't work")


class Breakthrough(BaseModel):
    """A key insight or discovery."""

    insight: str = Field(..., description="The insight")
    detail: str = Field(..., description="Detailed explanation")
    importance: str = Field("medium", pattern=r"^(high|medium|low)$")


class Gotcha(BaseModel):
    """An edge case or warning to watch out for."""

    warning: str = Field(..., description="What to watch out for")
    context: str | None = Field(None, description="When/where this applies")


class Artifact(BaseModel):
    """Code or configuration that came out of the experience."""

    language: str = Field(..., min_length=1, max_length=50)
    code: str
    description: str | None = None


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class ExperienceCreate(BaseModel):
    """Model for creating a new experience."""

    goal: str = Field(..., min_length=10, max_length=2000, description="What you were trying to do")
    domain: str | None = Field(None, max_length=100)
    tools_used: list[str] = Field(default_factory=list)
    dead_ends: list[DeadEnd] = Field(default_factory=list)
    breakthroughs: list[Breakthrough] = Field(default_factory=list)
    gotchas: list[Gotcha] = Field(default_factory=list)
    context: str | None = Field(None, description="Free-form additional reasoning")
    artifacts: list[Artifact] = Field(default_factory=list)
    visibility: Visibility = Visibility.PUBLIC
    outcome: str | None = Field(None, pattern=r"^(success|partial|failure)$")


class ExperienceAcquire(BaseModel):
    """Request to acquire an experience in a specific compression format."""

    mode: CompressionMode = CompressionMode.FULL


class ExperienceSearchRequest(BaseModel):
    """Request model for searching experiences."""

    query: str = Field(..., min_length=2, max_length=1000, description="Natural language query")
    domain: str | None = Field(None, description="Filter by domain")
    tools: list[str] = Field(default_factory=list, description="Filter by tools used")
    min_quality: float = Field(0.0, ge=0.0, le=1.0, description="Minimum quality score")
    limit: int = Field(10, ge=1, le=50, description="Maximum results")
    include_archived: bool = Field(False, description="Include archived experiences")


class OutcomeReportCreate(BaseModel):
    """Report the outcome of applying an experience."""

    success: bool
    execution_time_ms: int | None = None
    error_message: str | None = None
    context_notes: str | None = None
    env_fingerprint: dict | None = None


class ExperienceVoteCreate(BaseModel):
    """Vote on an experience."""

    vote_type: str = Field(..., pattern=r"^(up|down)$")


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------

class ExperienceSummary(BaseModel):
    """Summary experience model for list/search responses."""

    id: UUID
    short_id: str
    goal: str
    domain: str | None
    tools_used: list[str]
    status: ExperienceStatus
    visibility: Visibility
    outcome: str | None
    success_rate: float
    quality_score: float
    upvotes: int
    downvotes: int
    total_reports: int
    agent_id: UUID
    created_at: datetime

    class Config:
        from_attributes = True


class ExperienceDetail(ExperienceSummary):
    """Full experience model with all reasoning content."""

    dead_ends: list[DeadEnd] = Field(default_factory=list)
    breakthroughs: list[Breakthrough] = Field(default_factory=list)
    gotchas: list[Gotcha] = Field(default_factory=list)
    context: str | None = None
    artifacts: list[Artifact] = Field(default_factory=list)
    session_id: UUID | None = None
    success_count: int = 0
    failure_count: int = 0
    updated_at: datetime | None = None

    class Config:
        from_attributes = True


class ExperienceAcquireResponse(BaseModel):
    """Response when acquiring an experience - formatted for context injection."""

    experience_id: UUID
    short_id: str
    mode: CompressionMode
    content: dict  # Structured differently per mode


class ExperienceSearchResult(BaseModel):
    """A single search result with relevance info."""

    experience: ExperienceSummary
    similarity: float = Field(0.0, ge=0.0, le=1.0)
    keyword_rank: float = Field(0.0, ge=0.0)
    combined_score: float = Field(0.0, ge=0.0)
    match_reasons: list[str] = Field(default_factory=list)


class ExperienceSearchResponse(BaseModel):
    """Response model for experience search."""

    query: str
    results: list[ExperienceSearchResult]
    total_found: int


class ExperienceListResponse(BaseModel):
    """Paginated experience list response."""

    items: list[ExperienceSummary]
    total: int
    limit: int
    offset: int
    has_more: bool
