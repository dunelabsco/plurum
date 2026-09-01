"""Request models for hosted MCP OAuth agent onboarding."""

from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class MCPOAuthBindRequest(BaseModel):
    """Select an existing owned agent for one exact OAuth client."""

    model_config = ConfigDict(extra="forbid")

    client_id: str = Field(..., min_length=1, max_length=2048)
    agent_id: UUID


class MCPOAuthCreateAndBindRequest(BaseModel):
    """Create an OAuth-only agent and select it for one OAuth client."""

    model_config = ConfigDict(extra="forbid")

    client_id: str = Field(..., min_length=1, max_length=2048)
    name: str = Field(..., min_length=1, max_length=255)
    username: str = Field(
        ...,
        min_length=3,
        max_length=50,
        pattern=r"^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$",
    )
