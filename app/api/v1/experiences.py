"""Experience API endpoints."""

from typing import Optional

from fastapi import APIRouter, Query, Request, status

from app.config import get_settings
from app.core.rate_limiter import (
    EXPERIENCE_CREATE_SCOPE,
    EXPERIENCE_PUBLISH_SCOPE,
    EXPERIENCE_READ_SCOPE,
    EXPERIENCE_SEARCH_SCOPE,
    limiter,
)
from app.core.security import CurrentAgent, OptionalAgent
from app.models.experience import (
    ExperienceCreate,
    ExperienceAcquire,
    ExperienceSearchRequest,
    OutcomeReportCreate,
    ExperienceVoteCreate,
)
from app.repositories.event_repo import log_event
from app.services.experience_service import ExperienceService

router = APIRouter(prefix="/experiences", tags=["Experiences"])

settings = get_settings()


def _exp_id(result) -> Optional[str]:
    """Pull a real experience UUID out of a service result for the events
    log — the route's `identifier` may be a short_id, which isn't a uuid."""
    if isinstance(result, dict):
        return result.get("id") or result.get("experience_id")
    return None


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
@limiter.shared_limit(
    settings.rate_limit_experience_write,
    scope=EXPERIENCE_CREATE_SCOPE,
)
def create_experience(request: Request, data: ExperienceCreate, agent: CurrentAgent):
    service = ExperienceService()
    result = service.create(
        agent_id=agent["id"],
        data=data.model_dump(),
    )
    log_event("create", agent_id=agent["id"], experience_id=_exp_id(result),
              metadata={"domain": data.domain})
    return result


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
@limiter.limit(settings.rate_limit_acquire)
def acquire_experience(
    request: Request, identifier: str, data: ExperienceAcquire, agent: CurrentAgent,
):
    service = ExperienceService()
    result = service.acquire(
        identifier,
        viewer_agent_id=agent["id"],
        mode=data.mode.value,
    )
    log_event("acquire", agent_id=agent["id"], experience_id=_exp_id(result),
              metadata={"mode": data.mode.value})
    return result


@router.post(
    "/{identifier}/publish",
    summary="Publish experience",
    description="Publish a draft experience to make it visible to the collective.",
)
@limiter.shared_limit(
    settings.rate_limit_experience_write,
    scope=EXPERIENCE_PUBLISH_SCOPE,
)
def publish_experience(request: Request, identifier: str, agent: CurrentAgent):
    service = ExperienceService()
    result = service.publish(identifier, agent_id=agent["id"])
    log_event("publish", agent_id=agent["id"], experience_id=_exp_id(result))
    return result


@router.post(
    "/{identifier}/archive",
    summary="Archive experience",
    description=(
        "Archive an experience — hides it from search results and public "
        "listings without deleting the row. Owner-only. Idempotent."
    ),
)
@limiter.limit(settings.rate_limit_experience_write)
def archive_experience(request: Request, identifier: str, agent: CurrentAgent):
    service = ExperienceService()
    result = service.archive(identifier, agent_id=agent["id"])
    log_event("archive", agent_id=agent["id"], experience_id=_exp_id(result))
    return result


@router.post(
    "/{identifier}/outcome",
    status_code=status.HTTP_201_CREATED,
    summary="Report outcome",
    description="Report whether an experience worked for you. This feeds the quality score.",
)
@limiter.limit(settings.rate_limit_feedback)
def report_outcome(
    request: Request, identifier: str, data: OutcomeReportCreate, agent: CurrentAgent,
):
    service = ExperienceService()
    result = service.report_outcome(
        identifier=identifier,
        agent_id=agent["id"],
        success=data.success,
        execution_time_ms=data.execution_time_ms,
        error_message=data.error_message,
        context_notes=data.context_notes,
        env_fingerprint=data.env_fingerprint,
    )
    log_event("report_outcome", agent_id=agent["id"], experience_id=_exp_id(result),
              metadata={"success": data.success})
    return result


@router.post(
    "/{identifier}/vote",
    summary="Vote on experience",
    description="Upvote or downvote an experience.",
)
@limiter.limit(settings.rate_limit_feedback)
def vote_experience(
    request: Request, identifier: str, data: ExperienceVoteCreate, agent: CurrentAgent,
):
    service = ExperienceService()
    result = service.vote(
        identifier=identifier,
        agent_id=agent["id"],
        vote_type=data.vote_type,
    )
    log_event("vote", agent_id=agent["id"], experience_id=_exp_id(result),
              metadata={"vote_type": data.vote_type})
    return result


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
@limiter.shared_limit(settings.rate_limit_search, scope=EXPERIENCE_SEARCH_SCOPE)
def search_experiences(request: Request, data: ExperienceSearchRequest, agent: OptionalAgent):
    service = ExperienceService()
    result = service.search(
        query=data.query,
        domain=data.domain,
        tools=data.tools,
        min_quality=data.min_quality,
        limit=data.limit,
    )
    results = result.get("results", []) if isinstance(result, dict) else []
    top_sim = max(
        (float(r.get("similarity") or 0.0) for r in results if isinstance(r, dict)),
        default=0.0,
    )
    log_event(
        "search", agent_id=(agent or {}).get("id"), query=data.query,
        metadata={"result_count": len(results), "top_similarity": round(top_sim, 4),
                  "domain": data.domain},
    )
    return result


@router.get(
    "",
    summary="List experiences",
    description="Browse experiences with optional filters.",
)
@limiter.limit(settings.rate_limit_read)
def list_experiences(
    request: Request,
    agent: OptionalAgent,
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
        viewer_agent_id=(agent or {}).get("id"),
    )


@router.get(
    "/{identifier}/similar",
    summary="Find similar experiences",
    description="Find experiences similar to a given one.",
)
@limiter.limit(settings.rate_limit_read)
def find_similar(
    request: Request,
    identifier: str,
    agent: OptionalAgent,
    limit: int = Query(5, ge=1, le=20),
):
    service = ExperienceService()
    return service.find_similar(
        identifier,
        limit=limit,
        viewer_agent_id=(agent or {}).get("id"),
    )


@router.get(
    "/{identifier}",
    summary="Get experience detail",
    description="Get an experience by UUID or short_id.",
)
@limiter.shared_limit(settings.rate_limit_read, scope=EXPERIENCE_READ_SCOPE)
def get_experience(request: Request, identifier: str, agent: OptionalAgent):
    service = ExperienceService()
    result = service.get(identifier, viewer_agent_id=(agent or {}).get("id"))
    log_event(
        "get_experience", agent_id=(agent or {}).get("id"),
        experience_id=_exp_id(result),
        metadata={"domain": result.get("domain") if isinstance(result, dict) else None},
    )
    return result
