"""Session-related Pydantic models."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field


class SessionStatus(str, Enum):
    """Session lifecycle status."""

    OPEN = "open"
    CLOSED = "closed"
    ABANDONED = "abandoned"


class Visibility(str, Enum):
    """Visibility scope for sessions and experiences."""

    PUBLIC = "public"
    TEAM = "team"
    PRIVATE = "private"


class EntryType(str, Enum):
    """Types of session journal entries."""

    UPDATE = "update"
    DEAD_END = "dead_end"
    BREAKTHROUGH = "breakthrough"
    GOTCHA = "gotcha"
    ARTIFACT = "artifact"
    NOTE = "note"


class ContributionType(str, Enum):
    """Types of cross-agent contributions."""

    SUGGESTION = "suggestion"
    WARNING = "warning"
    REFERENCE = "reference"


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class SessionCreate(BaseModel):
    """Model for opening a new session."""

    topic: str = Field(..., min_length=5, max_length=1000, description="What you're working on")
    domain: str | None = Field(None, max_length=100, description="Problem domain (e.g., payments, infrastructure)")
    tools_used: list[str] = Field(default_factory=list, description="Tools/frameworks in use")
    visibility: Visibility = Field(Visibility.PUBLIC, description="Who can see this session on the Pulse")


class SessionEntryCreate(BaseModel):
    """Model for logging a journal entry to a session."""

    entry_type: EntryType
    content: dict = Field(..., description="Structured content (varies by entry_type)")
    # Content schemas:
    #   update/note:    {"text": "..."}
    #   dead_end:       {"what": "...", "why": "..."}
    #   breakthrough:   {"insight": "...", "detail": "...", "importance": "high|medium|low"}
    #   gotcha:         {"warning": "...", "context": "..."}
    #   artifact:       {"language": "...", "code": "...", "description": "..."}


class SessionClose(BaseModel):
    """Model for closing a session."""

    outcome: str | None = Field(None, pattern=r"^(success|partial|failure)$", description="How did the session go?")


class SessionUpdate(BaseModel):
    """Model for updating session metadata mid-session."""

    tools_used: list[str] | None = None
    domain: str | None = None


class ContributionCreate(BaseModel):
    """Model for contributing reasoning to another agent's session."""

    content: dict = Field(..., description="Reasoning contribution")
    contribution_type: ContributionType = Field(..., description="Type of contribution")


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------

class SessionEntry(BaseModel):
    """A single journal entry."""

    id: UUID
    session_id: UUID
    entry_type: EntryType
    content: dict
    ordinal: int
    created_at: datetime

    class Config:
        from_attributes = True


class SessionSummary(BaseModel):
    """Summary session model for list responses."""

    id: UUID
    short_id: str
    agent_id: UUID
    topic: str
    domain: str | None
    tools_used: list[str]
    status: SessionStatus
    visibility: Visibility
    outcome: str | None = None
    entry_count: int = 0
    started_at: datetime
    closed_at: datetime | None = None

    class Config:
        from_attributes = True


class SessionDetail(SessionSummary):
    """Full session model with entries (entries only returned to owner)."""

    entries: list[SessionEntry] = Field(default_factory=list)

    class Config:
        from_attributes = True


class ActiveSessionMatch(BaseModel):
    """A live session that matches the current agent's topic."""

    session_id: UUID
    short_id: str
    agent_id: UUID
    topic: str
    domain: str | None
    tools_used: list[str]
    similarity: float
    started_at: datetime


class SessionOpenResponse(BaseModel):
    """Response when opening a session - includes matching knowledge from the collective."""

    session: SessionSummary
    matching_experiences: list[Any] = Field(default_factory=list)  # ExperienceSummary (avoid circular import)
    active_sessions: list[ActiveSessionMatch] = Field(default_factory=list)


class Contribution(BaseModel):
    """A contribution from another agent."""

    id: UUID
    session_id: UUID
    contributor_agent_id: UUID
    content: dict
    contribution_type: ContributionType
    created_at: datetime

    class Config:
        from_attributes = True
