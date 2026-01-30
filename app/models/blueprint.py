"""Blueprint-related Pydantic models."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_validator
import re


class BlueprintStatus(str, Enum):
    """Blueprint status options."""

    DRAFT = "draft"
    PUBLISHED = "published"
    DEPRECATED = "deprecated"
    ARCHIVED = "archived"


class ActionType(str, Enum):
    """Types of execution steps."""

    COMMAND = "command"
    CODE = "code"
    DECISION = "decision"
    LOOP = "loop"


class VerificationTier(str, Enum):
    """Trust level for blueprint versions (write-protected)."""

    SELF_REPORTED = "self_reported"
    SANDBOX = "sandbox"
    ORG_VERIFIED = "org_verified"


class RiskFlag(str, Enum):
    """Risk indicators for blueprint execution."""

    DESTRUCTIVE = "destructive"
    SHELL_EXEC = "shell_exec"
    NETWORK_EGRESS = "network_egress"
    CREDENTIAL_ACCESS = "credential_access"
    FILE_SYSTEM_WRITE = "fs_write"
    ENVIRONMENT_MODIFY = "env_modify"


class Permission(str, Enum):
    """Permissions required by blueprint."""

    FS_READ = "fs_read"
    FS_WRITE = "fs_write"
    NETWORK = "network"
    SHELL = "shell"
    ENV_VARS = "env_vars"
    CREDENTIALS = "credentials"


class EnvironmentConstraints(BaseModel):
    """Required environment for blueprint execution."""

    os: Optional[list[str]] = Field(default=None, description="Supported OS")
    runtime: Optional[str] = Field(default=None, description="Required runtime")
    min_version: Optional[str] = Field(default=None, description="Min runtime version")
    dependencies: Optional[list[str]] = Field(default=None, description="Dependencies")


class ExecutionStep(BaseModel):
    """A single step in the blueprint execution."""

    order: int = Field(..., ge=1)
    title: str = Field(..., min_length=1, max_length=200)
    description: str
    action_type: ActionType
    expected_outcome: str | None = None
    fallback: str | None = None


class CodeSnippet(BaseModel):
    """Code snippet with metadata."""

    language: str = Field(..., min_length=1, max_length=50)
    code: str
    description: str | None = None
    dependencies: list[str] = Field(default_factory=list)
    inputs: list[str] = Field(default_factory=list)
    outputs: list[str] = Field(default_factory=list)


class ContextRequirement(BaseModel):
    """Requirements for executing the blueprint."""

    tools: list[str] = Field(default_factory=list, description="Required tools/CLIs")
    environment: dict[str, str] = Field(default_factory=dict, description="Environment variables")
    permissions: list[str] = Field(default_factory=list, description="Required permissions")
    dependencies: list[str] = Field(default_factory=list, description="Package dependencies")
    constraints: list[str] = Field(default_factory=list, description="Constraints/limitations")


class BlueprintVersionBase(BaseModel):
    """Base model for blueprint version content."""

    title: str = Field(..., min_length=1, max_length=500)
    goal_description: str = Field(..., min_length=10, description="What task/problem this solves")
    strategy: str = Field(..., min_length=10, description="The workflow that worked")
    execution_steps: list[ExecutionStep] = Field(default_factory=list)
    code_snippets: list[CodeSnippet] = Field(default_factory=list)
    context_requirements: ContextRequirement = Field(default_factory=ContextRequirement)


class BlueprintCreate(BlueprintVersionBase):
    """Model for creating a new blueprint."""

    slug: str | None = Field(
        None,
        min_length=3,
        max_length=255,
        pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$",
        description="URL-friendly identifier. Auto-generated from title if not provided.",
    )
    tags: list[str] = Field(default_factory=list, description="Tag names to associate")
    is_public: bool = True
    # User CAN set these (validated against enums):
    permissions_required: list[str] = Field(default_factory=list)
    risk_flags: list[str] = Field(default_factory=list)
    environment_constraints: EnvironmentConstraints | None = None

    @field_validator("slug", mode="before")
    @classmethod
    def generate_slug(cls, v: str | None, info) -> str | None:
        """Generate slug from title if not provided."""
        if v is not None:
            return v
        # Will be generated in the service layer from title
        return None

    @field_validator("permissions_required")
    @classmethod
    def validate_permissions(cls, v: list[str]) -> list[str]:
        """Validate permissions against Permission enum."""
        valid_permissions = {p.value for p in Permission}
        invalid = [p for p in v if p not in valid_permissions]
        if invalid:
            raise ValueError(
                f"Invalid permissions: {invalid}. Valid: {sorted(valid_permissions)}"
            )
        return v

    @field_validator("risk_flags")
    @classmethod
    def validate_risk_flags(cls, v: list[str]) -> list[str]:
        """Validate risk_flags against RiskFlag enum."""
        valid_flags = {f.value for f in RiskFlag}
        invalid = [f for f in v if f not in valid_flags]
        if invalid:
            raise ValueError(
                f"Invalid risk_flags: {invalid}. Valid: {sorted(valid_flags)}"
            )
        return v


class BlueprintUpdate(BlueprintVersionBase):
    """Model for updating a blueprint (creates new version)."""

    tags: list[str] | None = None
    is_public: bool | None = None
    # User CAN set these (validated against enums):
    permissions_required: list[str] = Field(default_factory=list)
    risk_flags: list[str] = Field(default_factory=list)
    environment_constraints: EnvironmentConstraints | None = None

    @field_validator("permissions_required")
    @classmethod
    def validate_permissions(cls, v: list[str]) -> list[str]:
        """Validate permissions against Permission enum."""
        valid_permissions = {p.value for p in Permission}
        invalid = [p for p in v if p not in valid_permissions]
        if invalid:
            raise ValueError(
                f"Invalid permissions: {invalid}. Valid: {sorted(valid_permissions)}"
            )
        return v

    @field_validator("risk_flags")
    @classmethod
    def validate_risk_flags(cls, v: list[str]) -> list[str]:
        """Validate risk_flags against RiskFlag enum."""
        valid_flags = {f.value for f in RiskFlag}
        invalid = [f for f in v if f not in valid_flags]
        if invalid:
            raise ValueError(
                f"Invalid risk_flags: {invalid}. Valid: {sorted(valid_flags)}"
            )
        return v


class BlueprintStatusUpdate(BaseModel):
    """Model for updating blueprint status."""

    status: BlueprintStatus


class BlueprintVersion(BlueprintVersionBase):
    """Full blueprint version model."""

    id: UUID
    blueprint_id: UUID
    version_number: int
    created_by_agent_id: UUID
    created_at: datetime
    # Trust Engine fields
    permissions_required: list[str] = Field(default_factory=list)
    risk_flags: list[str] = Field(default_factory=list)
    environment_constraints: EnvironmentConstraints | None = None
    # Read-only protected fields (server-set):
    verification_tier: VerificationTier = VerificationTier.SELF_REPORTED
    risk_score: int = 0
    verified_at: datetime | None = None

    class Config:
        from_attributes = True


class QualityMetricsEmbed(BaseModel):
    """Embedded quality metrics for blueprint responses."""

    execution_count: int = 0
    success_count: int = 0
    failure_count: int = 0
    success_rate: float = 0.0
    upvotes: int = 0
    downvotes: int = 0
    score: float = 0.0


class BlueprintAuthor(BaseModel):
    """Author info for blueprint attribution."""

    id: UUID
    name: str
    username: str | None = None
    publisher_domain: str | None = None


class BlueprintSummary(BaseModel):
    """Summary blueprint model for list responses."""

    id: UUID
    slug: str
    short_id: str = Field("", description="8-character unique identifier for URLs")
    title: str
    goal_description: str
    status: BlueprintStatus
    is_public: bool
    quality_metrics: QualityMetricsEmbed
    tags: list[str] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime
    author: BlueprintAuthor | None = None

    class Config:
        from_attributes = True


class BlueprintDetail(BaseModel):
    """Detailed blueprint model with current version content."""

    id: UUID
    slug: str
    short_id: str = Field("", description="8-character unique identifier for URLs")
    status: BlueprintStatus
    is_public: bool
    quality_metrics: QualityMetricsEmbed
    tags: list[str] = Field(default_factory=list)
    created_by_agent_id: UUID
    created_at: datetime
    updated_at: datetime
    author: BlueprintAuthor | None = None

    # Current version content
    current_version: BlueprintVersion | None = None

    class Config:
        from_attributes = True


class Blueprint(BaseModel):
    """Internal blueprint model."""

    id: UUID
    slug: str
    short_id: str = Field("", description="8-character unique identifier for URLs")
    current_version_id: UUID | None
    created_by_agent_id: UUID
    execution_count: int = 0
    success_count: int = 0
    failure_count: int = 0
    success_rate: float = 0.0
    upvotes: int = 0
    downvotes: int = 0
    score: float = 0.0
    status: BlueprintStatus = BlueprintStatus.DRAFT
    is_public: bool = True
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class PaginatedResponse(BaseModel):
    """Generic paginated response wrapper."""

    items: list
    total: int
    limit: int
    offset: int
    has_more: bool


class BlueprintListResponse(BaseModel):
    """Paginated blueprint list response."""

    items: list[BlueprintSummary]
    total: int
    limit: int
    offset: int
    has_more: bool

    class Config:
        from_attributes = True


def slugify(text: str) -> str:
    """Convert text to URL-friendly slug."""
    # Convert to lowercase
    slug = text.lower()
    # Replace spaces and underscores with hyphens
    slug = re.sub(r"[\s_]+", "-", slug)
    # Remove non-alphanumeric characters except hyphens
    slug = re.sub(r"[^a-z0-9-]", "", slug)
    # Remove multiple consecutive hyphens
    slug = re.sub(r"-+", "-", slug)
    # Remove leading/trailing hyphens
    slug = slug.strip("-")
    return slug[:255]  # Limit length
