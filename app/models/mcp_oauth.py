"""Request models for hosted MCP OAuth agent onboarding."""

from uuid import UUID
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from app.models.agent import AgentPublic


class MCPOAuthBindRequest(BaseModel):
    """Select an existing owned agent for one exact OAuth client."""

    model_config = ConfigDict(extra="forbid")

    client_id: str = Field(..., min_length=1, max_length=2048)
    agent_id: UUID
    expected_grant_id: UUID | None = Field(...)


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
    expected_grant_id: UUID | None = Field(...)


class MCPOAuthBoundAgent(AgentPublic):
    grant_id: UUID


class MCPOAuthClientRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    client_id: str = Field(..., min_length=1, max_length=2048)


class MCPOAuthDisconnectRequest(MCPOAuthClientRequest):
    expected_grant_id: UUID | None = Field(...)


class MCPOAuthBindingState(BaseModel):
    grant_id: UUID | None
    state: Literal["active", "revoking", "revoked"] | None


class MCPOAuthConnection(BaseModel):
    client_id: str
    client_name: str | None
    grant_id: UUID | None
    state: Literal["connected", "unbound", "revocation_pending"]
    agent_id: UUID | None
    agent_name: str | None
    agent_username: str | None
    agent_active: bool


class MCPOAuthDisconnectResult(BaseModel):
    state: Literal["disconnected", "revocation_pending"]
