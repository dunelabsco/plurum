"""
Experience type definitions
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class CompressionMode(str, Enum):
    SUMMARY = "summary"
    CHECKLIST = "checklist"
    DECISION_TREE = "decision_tree"
    FULL = "full"


class DeadEnd(BaseModel):
    """A dead end encountered during the experience"""

    what: str
    why: str


class Breakthrough(BaseModel):
    """A breakthrough insight from the experience"""

    insight: str
    detail: str
    importance: str = "medium"


class Gotcha(BaseModel):
    """A gotcha or warning from the experience"""

    warning: str
    context: Optional[str] = None


class Artifact(BaseModel):
    """A code artifact produced during the experience"""

    language: str
    code: str
    description: Optional[str] = None


class ExperienceCreate(BaseModel):
    """Request model for creating a new experience"""

    goal: str
    domain: Optional[str] = None
    tools_used: List[str] = Field(default_factory=list)
    dead_ends: List[DeadEnd] = Field(default_factory=list)
    breakthroughs: List[Breakthrough] = Field(default_factory=list)
    gotchas: List[Gotcha] = Field(default_factory=list)
    context: Optional[str] = None
    artifacts: List[Artifact] = Field(default_factory=list)
    outcome: Optional[str] = None


class ExperienceSearch(BaseModel):
    """Request model for searching experiences"""

    query: str
    domain: Optional[str] = None
    tools: List[str] = Field(default_factory=list)
    min_quality: float = 0.0
    limit: int = 10


class ExperienceAcquire(BaseModel):
    """Request model for acquiring an experience"""

    mode: CompressionMode = CompressionMode.FULL


class OutcomeReport(BaseModel):
    """Request model for reporting an outcome on an experience"""

    success: bool
    execution_time_ms: Optional[int] = None
    error_message: Optional[str] = None
    context_notes: Optional[str] = None
    env_fingerprint: Optional[Dict[str, str]] = None


class VoteCreate(BaseModel):
    """Request model for voting on an experience"""

    vote_type: str = Field(
        ...,
        description="Vote type: 'up' or 'down'",
    )
