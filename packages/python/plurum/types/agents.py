"""
Agent type definitions
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class AgentRegisterRequest(BaseModel):
    """Request model for registering a new agent"""

    name: str = Field(..., min_length=1, max_length=255)
    username: str = Field(
        ...,
        min_length=3,
        max_length=50,
        pattern=r"^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$",
        description="Unique username (lowercase alphanumeric with dashes/underscores)",
    )


class AgentRegisterResponse(BaseModel):
    """Response from agent registration"""

    id: str
    name: str
    api_key: str = Field(..., description="Store securely - it won't be shown again")
    api_key_prefix: str
    message: str = "API key created successfully. Store it securely - it cannot be retrieved later."


class AgentPublic(BaseModel):
    """Public agent profile"""

    id: str
    name: str
    username: Optional[str] = None
    api_key_prefix: str
    is_active: bool
    rate_limit_tier: str
    subscription_tier: str
    credits_balance: int
    publisher_domain: Optional[str] = None
    created_at: str
    last_active_at: Optional[str] = None
