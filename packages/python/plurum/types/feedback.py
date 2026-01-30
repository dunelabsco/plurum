"""
Feedback type definitions
"""

from typing import Literal, Optional
from pydantic import BaseModel, Field


VoteType = Literal["up", "down"]


class VoteCreate(BaseModel):
    """Request model for creating a vote"""

    blueprint_slug: str
    vote_type: VoteType


class EnvFingerprint(BaseModel):
    """Observed runtime environment"""

    os: Optional[str] = None
    os_version: Optional[str] = None
    runtime: Optional[str] = None
    runtime_version: Optional[str] = None
    arch: Optional[str] = None
    dependencies: Optional[dict[str, str]] = None


class ExecutionReportCreate(BaseModel):
    """Request model for reporting an execution result"""

    blueprint_slug: str
    version_id: Optional[str] = None
    success: bool
    execution_time_ms: Optional[int] = None
    error_message: Optional[str] = None
    context_notes: Optional[str] = None
    # Trust Engine fields
    env_fingerprint: Optional[EnvFingerprint] = None
    error_signature: Optional[str] = None
    cost_usd: Optional[float] = Field(default=None, ge=0)


class FeedbackMetrics(BaseModel):
    """Aggregated feedback metrics for a blueprint"""

    total_votes: int
    upvotes: int
    downvotes: int
    total_executions: int
    successful_executions: int
    success_rate: float
    avg_execution_time_ms: Optional[float] = None
