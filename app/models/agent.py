"""Agent-related Pydantic models."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
import re
from typing import Literal
import unicodedata
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, UUID4, field_validator


class SubscriptionTier(str, Enum):
    """Agent subscription tiers."""

    FREE = "free"
    PRO = "pro"
    ENTERPRISE = "enterprise"


class RateLimitTier(str, Enum):
    """Rate limit tiers."""

    STANDARD = "standard"
    PREMIUM = "premium"
    UNLIMITED = "unlimited"


class AgentBase(BaseModel):
    """Base agent model."""

    name: str = Field(..., min_length=1, max_length=255)


class AgentCreate(BaseModel):
    """Model for creating a new agent."""

    name: str = Field(..., min_length=1, max_length=255)
    username: str = Field(
        ...,
        min_length=3,
        max_length=50,
        pattern=r"^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$",
        description="Unique username for profiles (e.g., 'anthropic'). Lowercase alphanumeric with dashes/underscores.",
    )


class AgentUpdate(BaseModel):
    """Model for updating an agent."""

    name: str | None = Field(None, min_length=1, max_length=255)
    username: str | None = Field(
        None,
        min_length=3,
        max_length=50,
        pattern=r"^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$",
        description="Unique username for profiles.",
    )


class Agent(AgentBase):
    """Full agent model (internal use)."""

    id: UUID
    api_key_hash: str
    api_key_prefix: str
    is_active: bool = True
    rate_limit_tier: RateLimitTier = RateLimitTier.STANDARD
    subscription_tier: SubscriptionTier = SubscriptionTier.FREE
    credits_balance: int = 0
    publisher_domain: str | None = None
    created_at: datetime
    updated_at: datetime
    last_active_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


class AgentPublic(BaseModel):
    """Public agent model (returned from /me endpoint)."""

    id: UUID
    name: str
    username: str | None = None
    api_key_prefix: str
    is_active: bool
    rate_limit_tier: RateLimitTier
    subscription_tier: SubscriptionTier
    credits_balance: int
    publisher_domain: str | None = None
    created_at: datetime
    last_active_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


class UsernameCheckResponse(BaseModel):
    """Availability + suggestions for a desired username."""

    available: bool
    suggestions: list[str] = Field(default_factory=list)


class AgentRegisterResponse(BaseModel):
    """Response model for agent registration."""

    id: UUID
    name: str
    api_key: str = Field(..., description="Store this securely - it won't be shown again")
    api_key_prefix: str
    message: str = "API key created successfully. Store it securely - it cannot be retrieved later."

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "id": "123e4567-e89b-12d3-a456-426614174000",
                "name": "my-agent",
                "api_key": "plrm_live_abc123xyz...",
                "api_key_prefix": "plrm_live_abc123...",
                "message": "API key created successfully. Store it securely - it cannot be retrieved later.",
            }
        }
    )


_PLURUM_API_KEY_TOKEN = re.compile(r"plrm_live_[A-Za-z0-9_-]{10,}")


def _is_default_ignorable(character: str) -> bool:
    code_point = ord(character)
    return (
        unicodedata.category(character) == "Cf"
        or code_point == 0x034F
        or 0x115F <= code_point <= 0x1160
        or 0x17B4 <= code_point <= 0x17B5
        or 0x180B <= code_point <= 0x180D
        or code_point == 0x3164
        or 0xFE00 <= code_point <= 0xFE0F
        or code_point == 0xFFA0
        or 0xE0100 <= code_point <= 0xE01EF
    )


def _contains_plurum_api_key_token(value: str) -> bool:
    """Recognize raw or visually obscured Plurum key-shaped text."""
    try:
        normalized = unicodedata.normalize("NFKC", value)
    except Exception:
        return True
    display_skeleton = "".join(
        character
        for character in normalized
        if not _is_default_ignorable(character)
    )
    return any(
        _PLURUM_API_KEY_TOKEN.search(candidate)
        for candidate in (value, normalized, display_skeleton)
    )


class AgentCliRegisterRequest(BaseModel):
    """Secret-free request for recoverable CLI registration."""

    protocol_version: Literal[1] = 1
    registration_request_id: UUID4
    name: str = Field(..., min_length=1, max_length=255)
    username: str = Field(
        ...,
        min_length=3,
        max_length=50,
        pattern=r"^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$",
    )
    api_key_hash: str = Field(
        ...,
        min_length=64,
        max_length=64,
        pattern=r"^[0-9a-f]{64}$",
    )
    api_key_prefix: str = Field(
        ...,
        min_length=19,
        max_length=19,
        pattern=r"^plrm_live_[A-Za-z0-9_-]{6}\.\.\.$",
    )

    model_config = ConfigDict(extra="forbid", frozen=True)

    @field_validator("protocol_version", mode="before")
    @classmethod
    def validate_protocol_version(cls, value: object) -> object:
        """Accept only the JSON integer 1, not booleans or floats."""
        if type(value) is not int or value != 1:  # noqa: E721
            raise ValueError("Invalid protocol version")
        return value

    @field_validator("registration_request_id", mode="before")
    @classmethod
    def validate_canonical_request_id(cls, value: object) -> object:
        """Require a canonical lowercase RFC 4122 UUID-v4 string."""
        if type(value) is not str or not re.fullmatch(  # noqa: E721
            r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
            value,
        ):
            raise ValueError("Invalid registration request ID")
        return value

    @field_validator("name")
    @classmethod
    def validate_display_name(cls, value: str) -> str:
        """Reject control and bidirectional-display characters."""
        if re.search(r"[\x00-\x1f\x7f-\x9f]", value) or re.search(
            r"[\u061c\u200e\u200f\u2028-\u202e\u2066-\u206f]",
            value,
        ):
            raise ValueError("Invalid agent name")
        if any(0xD800 <= ord(character) <= 0xDFFF for character in value):
            raise ValueError("Invalid agent name")
        if _contains_plurum_api_key_token(value):
            raise ValueError("Invalid agent name")
        return value

    @field_validator("username")
    @classmethod
    def validate_username_secret_free(cls, value: str) -> str:
        """Keep key-shaped text out of the public agent identity."""
        if _contains_plurum_api_key_token(value):
            raise ValueError("Invalid username")
        return value


class AgentCliRegisterResponse(BaseModel):
    """Minimal result for recoverable CLI registration."""

    agent_id: UUID
    disposition: Literal["created", "replayed"]

    model_config = ConfigDict(extra="forbid", frozen=True)


class AgentClaimRequest(BaseModel):
    api_key: str


class AgentClaimResponse(BaseModel):
    id: str
    name: str
    username: str | None = None
    api_key_prefix: str
    is_active: bool
    owner_user_id: str
    message: str


class AgentReleaseResponse(BaseModel):
    id: str
    name: str
    username: str | None = None
    message: str


class AgentOverviewAgent(BaseModel):
    id: str
    name: str
    username: str | None = None
    is_active: bool
    last_active_at: str | None = None


class AgentOverviewSession(BaseModel):
    id: str
    short_id: str
    agent_name: str
    topic: str
    status: str
    started_at: str


class AgentOverviewExperience(BaseModel):
    id: str
    short_id: str
    agent_name: str
    goal: str
    status: str
    quality_score: float
    created_at: str


class AgentOverviewStats(BaseModel):
    total_sessions: int
    total_experiences: int
    overall_success_rate: float
    total_upvotes: int


class AgentOverviewResponse(BaseModel):
    agents: list[AgentOverviewAgent]
    recent_sessions: list[AgentOverviewSession]
    recent_experiences: list[AgentOverviewExperience]
    aggregate_stats: AgentOverviewStats
