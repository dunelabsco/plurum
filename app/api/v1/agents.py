"""Agent API endpoints."""

from __future__ import annotations

from fastapi import APIRouter, status

from app.core.security import CurrentAgent, CurrentUser
from app.services.agent_service import AgentService
from app.models.agent import AgentCreate, AgentUpdate, AgentPublic, AgentRegisterResponse

router = APIRouter(prefix="/agents", tags=["Agents"])


@router.post(
    "/register",
    response_model=AgentRegisterResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Register a new agent",
    description="""
    Register a new agent and receive an API key.

    **Requires authentication**: You must be logged in via the web dashboard.
    Pass your Supabase JWT in the Authorization header.

    Store the API key securely - it won't be shown again.
    """,
)
async def register_agent(data: AgentCreate, user: CurrentUser):
    """
    Register a new agent and get an API key.

    Only authenticated users can create agents. The agent will be
    linked to your user account via owner_user_id.
    """
    service = AgentService()
    return service.register(data, owner_user_id=user["id"])


@router.get(
    "/me",
    response_model=AgentPublic,
    summary="Get current agent profile",
    description="Get the profile of the currently authenticated agent.",
)
async def get_current_profile(agent: CurrentAgent):
    """Get the current agent's profile."""
    service = AgentService()
    return service.get_profile(agent["id"])


@router.get(
    "/me/agents",
    response_model=list[AgentPublic],
    summary="List my agents",
    description="""
    List all agents owned by the authenticated user.

    **Requires authentication**: Pass your Supabase JWT in the Authorization header.
    """,
)
async def list_my_agents(user: CurrentUser):
    """
    List all agents owned by the current user.

    This endpoint is for the web dashboard to show users their agents.
    """
    service = AgentService()
    return service.list_by_owner(user["id"])


@router.post(
    "/me/rotate-key",
    response_model=AgentRegisterResponse,
    summary="Rotate API key",
    description="Generate a new API key. The old key will be immediately invalidated.",
)
async def rotate_api_key(agent: CurrentAgent):
    """Rotate the current agent's API key."""
    service = AgentService()
    return service.rotate_api_key(agent["id"])


@router.patch(
    "/{agent_id}",
    response_model=AgentPublic,
    summary="Update agent",
    description="""
    Update an agent's name or username.

    **Requires authentication**: Pass your Supabase JWT in the Authorization header.
    You can only update agents you own.
    """,
)
async def update_agent(agent_id: str, data: AgentUpdate, user: CurrentUser):
    """Update an agent's profile."""
    service = AgentService()
    return service.update(agent_id, data, owner_user_id=user["id"])
