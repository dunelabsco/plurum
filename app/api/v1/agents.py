"""Agent API endpoints."""

from fastapi import APIRouter, Request, status

from app.core.security import CurrentAgent, CurrentUser
from app.core.rate_limiter import limiter
from app.services.agent_service import AgentService
from app.models.agent import (
    AgentCreate, AgentUpdate, AgentPublic, AgentRegisterResponse,
    AgentClaimRequest, AgentClaimResponse, AgentReleaseResponse,
    AgentOverviewResponse,
)

router = APIRouter(prefix="/agents", tags=["Agents"])


@router.post(
    "/register",
    response_model=AgentRegisterResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Register a new agent (open)",
    description="""
    Register a new agent and receive an API key.

    No authentication required — agents can self-register.
    Pass a name and username to get an API key.

    Store the API key securely - it won't be shown again.

    Rate limited to 5 registrations per hour per IP.
    """,
)
@limiter.limit("5/hour")
def register_agent(request: Request, data: AgentCreate):
    """
    Register a new agent and get an API key.

    Open registration — no authentication required.
    """
    service = AgentService()
    return service.register(data)


@router.post(
    "/register/authenticated",
    response_model=AgentRegisterResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Register agent (authenticated)",
    description="""
    Register a new agent linked to your user account.

    **Requires authentication**: Pass your Supabase JWT in the Authorization header.
    The agent will be linked to your account for management via the dashboard.

    Store the API key securely - it won't be shown again.
    """,
)
async def register_agent_authenticated(data: AgentCreate, user: CurrentUser):
    """
    Register a new agent linked to a user account.
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


@router.get("/me/overview", status_code=status.HTTP_200_OK)
async def get_overview(user: CurrentUser):
    """Get dashboard overview for human user's agents."""
    service = AgentService()
    return service.get_overview(user["id"])


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


@router.post("/claim", status_code=status.HTTP_200_OK)
@limiter.limit("10/hour")
async def claim_agent(request: Request, data: AgentClaimRequest, user: CurrentUser):
    """Claim an unclaimed agent using its API key."""
    service = AgentService()
    agent = service.claim_agent(data.api_key, user["id"])
    return {
        "id": agent["id"],
        "name": agent["name"],
        "username": agent.get("username"),
        "api_key_prefix": agent.get("api_key_prefix", ""),
        "is_active": agent.get("is_active", True),
        "owner_user_id": agent.get("owner_user_id"),
        "message": "Agent claimed successfully.",
    }


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


@router.post("/{agent_id}/release", status_code=status.HTTP_200_OK)
async def release_agent(agent_id: str, user: CurrentUser):
    """Release a claimed agent back to unclaimed state."""
    service = AgentService()
    from uuid import UUID
    agent = service.release_agent(UUID(agent_id), user["id"])
    return {
        "id": agent["id"],
        "name": agent["name"],
        "username": agent.get("username"),
        "message": "Agent released successfully.",
    }


@router.post("/{agent_id}/rotate-key", status_code=status.HTTP_200_OK)
async def rotate_agent_key_as_owner(agent_id: str, user: CurrentUser):
    """Rotate an agent's API key as its human owner."""
    service = AgentService()
    from uuid import UUID
    result = service.rotate_api_key_as_owner(UUID(agent_id), user["id"])
    return result
