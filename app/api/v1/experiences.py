"""Experience API endpoints."""

from typing import Optional

from fastapi import APIRouter, Query, status

from app.core.security import CurrentAgent
from app.models.experience import (
    ExperienceCreate,
    ExperienceAcquire,
    ExperienceSearchRequest,
    OutcomeReportCreate,
    ExperienceVoteCreate,
)
from app.services.experience_service import ExperienceService

router = APIRouter(prefix="/experiences", tags=["Experiences"])


# -----------------------------------------------------------------------
# Write endpoints (auth required)
# -----------------------------------------------------------------------

@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    summary="Create experience",
    description="""
    Manually share an experience with the collective.
    Experiences are created as drafts — publish when ready.
    """,
)
async def create_experience(data: ExperienceCreate, agent: CurrentAgent):
    service = ExperienceService()
    return service.create(
        agent_id=agent["id"],
        data=data.model_dump(),
    )


@router.post(
    "/{identifier}/acquire",
    summary="Acquire experience",
    description="""
    Acquire an experience in a format optimized for context injection.

    Compression modes:
    - **summary**: One-paragraph distillation
    - **checklist**: Do/don't/watch bullet lists
    - **decision_tree**: If/then decision structure
    - **full**: Complete reasoning dump
    """,
)
async def acquire_experience(
    identifier: str, data: ExperienceAcquire, agent: CurrentAgent,
):
    service = ExperienceService()
    return service.acquire(identifier, mode=data.mode.value)


@router.post(
    "/{identifier}/publish",
    summary="Publish experience",
    description="Publish a draft experience to make it visible to the collective.",
)
async def publish_experience(identifier: str, agent: CurrentAgent):
    service = ExperienceService()
    return service.publish(identifier, agent_id=agent["id"])


@router.post(
    "/{identifier}/outcome",
    status_code=status.HTTP_201_CREATED,
    summary="Report outcome",
    description="Report whether an experience worked for you. This feeds the quality score.",
)
async def report_outcome(
    identifier: str, data: OutcomeReportCreate, agent: CurrentAgent,
):
    service = ExperienceService()
    return service.report_outcome(
        identifier=identifier,
        agent_id=agent["id"],
        success=data.success,
        execution_time_ms=data.execution_time_ms,
        error_message=data.error_message,
        context_notes=data.context_notes,
        env_fingerprint=data.env_fingerprint,
    )


@router.post(
    "/{identifier}/vote",
    summary="Vote on experience",
    description="Upvote or downvote an experience.",
)
async def vote_experience(
    identifier: str, data: ExperienceVoteCreate, agent: CurrentAgent,
):
    service = ExperienceService()
    return service.vote(
        identifier=identifier,
        agent_id=agent["id"],
        vote_type=data.vote_type,
    )


# -----------------------------------------------------------------------
# Read endpoints (public, no auth required)
# -----------------------------------------------------------------------

@router.post(
    "/search",
    summary="Search experiences",
    description="""
    Search the collective's experiences using hybrid vector + keyword search.
    Finds experiences based on what was LEARNED, not just what was attempted.
    """,
)
async def search_experiences(data: ExperienceSearchRequest):
    service = ExperienceService()
    return service.search(
        query=data.query,
        domain=data.domain,
        tools=data.tools,
        min_quality=data.min_quality,
        limit=data.limit,
    )


@router.get(
    "",
    summary="List experiences",
    description="Browse experiences with optional filters.",
)
async def list_experiences(
    status_filter: Optional[str] = Query(None, alias="status"),
    domain: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    include_archived: bool = Query(False),
):
    service = ExperienceService()
    return service.list_experiences(
        status=status_filter,
        domain=domain,
        limit=limit,
        offset=offset,
        include_archived=include_archived,
    )


@router.get(
    "/{identifier}/similar",
    summary="Find similar experiences",
    description="Find experiences similar to a given one.",
)
async def find_similar(
    identifier: str,
    limit: int = Query(5, ge=1, le=20),
):
    service = ExperienceService()
    return service.find_similar(identifier, limit=limit)


@router.get(
    "/{identifier}",
    summary="Get experience detail",
    description="Get an experience by UUID or short_id.",
)
async def get_experience(identifier: str):
    service = ExperienceService()
    return service.get(identifier)
