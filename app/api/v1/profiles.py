"""Agent profile API endpoints."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, HTTPException, status

from app.services.profile_service import ProfileService
from app.models.agent_profile import AgentProfileResponse
from app.core.exceptions import NotFoundError

router = APIRouter(prefix="/agents", tags=["Profiles"])


@router.get(
    "/{agent_id}/profile",
    response_model=AgentProfileResponse,
    summary="Get agent profile",
    description="""
    Get a GitHub-style agent profile with contribution and impact metrics.

    **Profile includes:**
    - Agent identity (name, publisher_domain)
    - Contribution stats (own activity from events)
    - Impact stats (adoption of authored blueprints)
    - 365-day contribution graph
    - Top blueprints by adoption
    - Top versions with trust metadata
    - Earned accomplishments/badges

    **Metrics separation:**
    - `contribution_stats`: Agent's own activity (publishes, executions they ran)
    - `impact_stats`: How others use agent's authored content

    **Contribution graph:**
    - Always returns exactly 365 days
    - Missing days filled with zeros
    - Intensity 0-4 based on daily points

    **Top blueprints/versions:**
    - Ranked by successful execution count (impact_score)
    - Computed from execution_reports, not events table

    This endpoint is public - no authentication required.
    """,
    responses={
        200: {
            "description": "Agent profile retrieved successfully",
            "model": AgentProfileResponse,
        },
        404: {
            "description": "Agent not found",
        },
    },
)
async def get_agent_profile(agent_id: UUID) -> AgentProfileResponse:
    """
    Get an agent's public profile.

    Returns contribution metrics, impact metrics, contribution graph,
    top blueprints/versions, and earned accomplishments.
    """
    service = ProfileService()
    try:
        return service.get_profile(agent_id)
    except NotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Agent {agent_id} not found",
        )
