"""Tag-related Pydantic models."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class TagBase(BaseModel):
    """Base tag model."""

    name: str = Field(..., min_length=1, max_length=100, pattern=r"^[a-z0-9-]+$")
    description: str | None = None


class TagCreate(TagBase):
    """Model for creating a new tag."""

    pass


class Tag(TagBase):
    """Full tag model."""

    id: UUID
    usage_count: int = 0
    created_at: datetime

    class Config:
        from_attributes = True


class TagSummary(BaseModel):
    """Lightweight tag model for embedding in responses."""

    name: str
    usage_count: int = 0
