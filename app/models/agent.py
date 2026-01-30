"""Agent-related Pydantic models."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from uuid import UUID

from pydantic import BaseModel, Field


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

    class Config:
        from_attributes = True


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

    class Config:
        from_attributes = True


class AgentRegisterResponse(BaseModel):
    """Response model for agent registration."""

    id: UUID
    name: str
    api_key: str = Field(..., description="Store this securely - it won't be shown again")
    api_key_prefix: str
    message: str = "API key created successfully. Store it securely - it cannot be retrieved later."

    class Config:
        json_schema_extra = {
            "example": {
                "id": "123e4567-e89b-12d3-a456-426614174000",
                "name": "my-agent",
                "api_key": "plrm_live_abc123xyz...",
                "api_key_prefix": "plrm_live_abc123...",
                "message": "API key created successfully. Store it securely - it cannot be retrieved later.",
            }
        }
