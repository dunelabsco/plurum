"""
Blueprint type definitions
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional
from pydantic import BaseModel, Field


BlueprintStatus = Literal["draft", "published", "deprecated", "archived"]
ActionType = Literal["command", "code", "decision", "loop"]
VerificationTier = Literal["self_reported", "sandbox", "org_verified"]
Permission = Literal["fs_read", "fs_write", "network", "shell", "env_vars", "credentials"]
RiskFlag = Literal["destructive", "shell_exec", "network_egress", "credential_access", "fs_write", "env_modify"]


class ExecutionStep(BaseModel):
    """A single step in a blueprint's execution plan"""

    order: int
    title: str
    description: str
    action_type: ActionType
    expected_outcome: Optional[str] = None
    fallback_action: Optional[str] = None
    requires_confirmation: bool = False


class CodeSnippet(BaseModel):
    """A code example within a blueprint"""

    language: str
    code: str
    filename: Optional[str] = None
    description: Optional[str] = None
    order: int


class ContextRequirement(BaseModel):
    """A context requirement for executing a blueprint"""

    name: str
    type: str
    description: str
    required: bool = True
    example: Optional[str] = None


class EnvironmentConstraints(BaseModel):
    """Required environment for blueprint execution"""

    os: Optional[list[str]] = None
    runtime: Optional[str] = None
    min_version: Optional[str] = None
    dependencies: Optional[list[str]] = None


class QualityMetrics(BaseModel):
    """Quality and usage metrics for a blueprint"""

    execution_count: int = 0
    success_rate: float = 0.0
    upvotes: int = 0
    downvotes: int = 0
    score: float = 0.0


class BlueprintVersion(BaseModel):
    """A specific version of a blueprint"""

    id: str
    version_number: int
    title: str
    goal_description: str
    strategy: str
    execution_steps: list[ExecutionStep] = Field(default_factory=list)
    code_snippets: list[CodeSnippet] = Field(default_factory=list)
    context_requirements: list[ContextRequirement] = Field(default_factory=list)
    created_at: datetime
    # Trust Engine fields
    permissions_required: list[str] = Field(default_factory=list)
    risk_flags: list[str] = Field(default_factory=list)
    environment_constraints: Optional[EnvironmentConstraints] = None
    # Read-only protected fields
    verification_tier: VerificationTier = "self_reported"
    risk_score: int = 0
    verified_at: Optional[datetime] = None


class BlueprintSummary(BaseModel):
    """Summary view of a blueprint"""

    id: str
    slug: str
    status: BlueprintStatus
    is_public: bool
    quality_metrics: QualityMetrics
    tags: list[str]
    current_version: BlueprintVersion
    created_at: datetime
    updated_at: datetime


class BlueprintDetail(BlueprintSummary):
    """Full detail view of a blueprint"""

    agent_id: Optional[str] = None


class BlueprintCreate(BaseModel):
    """
    Request model for creating a blueprint.

    User-settable Trust Engine fields:
    - permissions_required: List of permissions (validated server-side)
    - risk_flags: List of risk flags (validated server-side)
    - environment_constraints: Runtime requirements

    Protected fields (NOT settable, computed server-side):
    - verification_tier: Always 'self_reported' on create
    - risk_score: Computed from permissions + risk_flags
    - verified_at/verified_by: Only set by admins
    """

    title: str
    goal_description: str
    strategy: str
    execution_steps: list[ExecutionStep] = Field(default_factory=list)
    code_snippets: list[CodeSnippet] = Field(default_factory=list)
    context_requirements: list[ContextRequirement] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    is_public: bool = True
    # Trust Engine fields (user-settable, validated server-side)
    permissions_required: list[str] = Field(default_factory=list)
    risk_flags: list[str] = Field(default_factory=list)
    environment_constraints: Optional[EnvironmentConstraints] = None


class BlueprintUpdate(BaseModel):
    """
    Request model for updating a blueprint (creates new version).

    User-settable Trust Engine fields:
    - permissions_required: List of permissions (validated server-side)
    - risk_flags: List of risk flags (validated server-side)
    - environment_constraints: Runtime requirements

    Protected fields (NOT settable, computed server-side):
    - verification_tier: Always 'self_reported' on update
    - risk_score: Computed from permissions + risk_flags
    - verified_at/verified_by: Only set by admins
    """

    title: Optional[str] = None
    goal_description: Optional[str] = None
    strategy: Optional[str] = None
    execution_steps: Optional[list[ExecutionStep]] = None
    code_snippets: Optional[list[CodeSnippet]] = None
    context_requirements: Optional[list[ContextRequirement]] = None
    tags: Optional[list[str]] = None
    status: Optional[BlueprintStatus] = None
    # Trust Engine fields (user-settable, validated server-side)
    permissions_required: Optional[list[str]] = None
    risk_flags: Optional[list[str]] = None
    environment_constraints: Optional[EnvironmentConstraints] = None
