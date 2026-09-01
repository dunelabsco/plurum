"""Human-authenticated onboarding endpoints for hosted MCP OAuth."""

from fastapi import APIRouter, status

from app.core.security import CurrentUser
from app.models.agent import AgentPublic
from app.models.mcp_oauth import (
    MCPOAuthBindRequest,
    MCPOAuthCreateAndBindRequest,
)
from app.repositories.event_repo import log_event
from app.services.mcp_oauth_binding_service import MCPOAuthBindingService


router = APIRouter(prefix="/mcp/oauth", tags=["MCP OAuth"])


@router.post(
    "/bind",
    response_model=AgentPublic,
    summary="Select an existing agent for MCP OAuth",
)
def bind_existing_agent(data: MCPOAuthBindRequest, user: CurrentUser):
    """Bind one exact OAuth client to an active agent owned by the user."""
    return MCPOAuthBindingService().bind(
        owner_user_id=user["id"],
        client_id=data.client_id,
        agent_id=data.agent_id,
    )


@router.post(
    "/create-and-bind",
    response_model=AgentPublic,
    status_code=status.HTTP_201_CREATED,
    summary="Create and select an OAuth-only agent",
)
def create_and_bind_agent(
    data: MCPOAuthCreateAndBindRequest,
    user: CurrentUser,
):
    """Atomically create an OAuth-only owned agent and bind the client."""
    agent = MCPOAuthBindingService().create_agent_and_bind(
        owner_user_id=user["id"],
        client_id=data.client_id,
        name=data.name,
        username=data.username,
    )
    log_event("register", agent_id=str(agent["id"]), metadata={"flow": "mcp_oauth"})
    return agent
