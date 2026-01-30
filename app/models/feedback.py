"""Feedback-related Pydantic models."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field


class VoteType(str, Enum):
    """Vote type options."""

    UP = "up"
    DOWN = "down"


class EnvFingerprint(BaseModel):
    """Observed runtime environment."""

    os: Optional[str] = None
    os_version: Optional[str] = None
    runtime: Optional[str] = None
    runtime_version: Optional[str] = None
    arch: Optional[str] = None
    dependencies: Optional[dict[str, str]] = None


class ExecutionReportCreate(BaseModel):
    """Model for creating an execution report. version_id resolved if not provided."""

    blueprint_identifier: str = Field(..., description="Blueprint short_id (8 chars) or slug")
    version_id: str | None = Field(None, description="Specific version, or resolved to current if None")
    success: bool
    execution_time_ms: int | None = Field(None, ge=0)
    error_message: str | None = None
    context_notes: str | None = Field(None, description="Additional context about the execution")
    # New Trust Engine fields
    env_fingerprint: EnvFingerprint | None = None
    error_signature: str | None = Field(None, description="Normalized error pattern for grouping failures")
    cost_usd: float | None = Field(None, ge=0, description="Token/compute cost in USD")


class ExecutionReport(BaseModel):
    """Full execution report model."""

    id: UUID
    blueprint_id: UUID
    version_id: UUID
    agent_id: UUID
    success: bool
    execution_time_ms: int | None = None
    error_message: str | None = None
    context_notes: str | None = None
    created_at: datetime
    # New Trust Engine fields
    env_fingerprint: EnvFingerprint | None = None
    error_signature: str | None = None
    cost_usd: float | None = None

    class Config:
        from_attributes = True


class VoteCreate(BaseModel):
    """Model for creating or updating a vote."""

    blueprint_identifier: str = Field(..., description="Blueprint short_id (8 chars) or slug")
    vote_type: VoteType


class Vote(BaseModel):
    """Full vote model."""

    id: UUID
    blueprint_id: UUID
    agent_id: UUID
    vote_type: VoteType
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class QualityMetrics(BaseModel):
    """Quality metrics for a blueprint."""

    blueprint_identifier: str
    execution_count: int = 0
    success_count: int = 0
    failure_count: int = 0
    success_rate: float = 0.0
    upvotes: int = 0
    downvotes: int = 0
    score: float = Field(0.0, description="Wilson score for ranking")
    recent_executions: list[ExecutionReport] = Field(
        default_factory=list, description="Recent execution reports"
    )
