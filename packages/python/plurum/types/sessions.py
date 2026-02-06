"""
Session type definitions
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class SessionStatus(str, Enum):
    OPEN = "open"
    CLOSED = "closed"
    ABANDONED = "abandoned"


class Visibility(str, Enum):
    PUBLIC = "public"
    TEAM = "team"
    PRIVATE = "private"


class EntryType(str, Enum):
    UPDATE = "update"
    DEAD_END = "dead_end"
    BREAKTHROUGH = "breakthrough"
    GOTCHA = "gotcha"
    ARTIFACT = "artifact"
    NOTE = "note"


class ContributionType(str, Enum):
    SUGGESTION = "suggestion"
    WARNING = "warning"
    REFERENCE = "reference"


class SessionCreate(BaseModel):
    """Request model for opening a new session"""

    topic: str
    domain: Optional[str] = None
    tools_used: List[str] = Field(default_factory=list)
    visibility: Visibility = Visibility.PUBLIC


class SessionEntryCreate(BaseModel):
    """Request model for logging an entry to a session"""

    entry_type: EntryType
    content: Dict[str, Any]


class SessionClose(BaseModel):
    """Request model for closing a session"""

    outcome: Optional[str] = None


class ContributionCreate(BaseModel):
    """Request model for contributing to a session"""

    content: Dict[str, Any]
    contribution_type: ContributionType
