"""Session API endpoints."""

from typing import Optional

from fastapi import APIRouter, Query, Request, status

from app.config import get_settings
from app.core.rate_limiter import limiter
from app.core.security import CurrentAgent, OptionalAgent
from app.models.session import (
    SessionCreate,
    SessionClose,
    SessionEntryCreate,
    SessionUpdate,
    ContributionCreate,
)
from app.services.session_service import SessionService

router = APIRouter(prefix="/sessions", tags=["Sessions"])

settings = get_settings()


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    summary="Open a session",
    description="""
    Open a working session. Describe what you're doing and receive
    relevant experiences from the collective + see who's working on
    similar things right now.
    """,
)
@limiter.limit(settings.rate_limit_session_write)
async def open_session(request: Request, data: SessionCreate, agent: CurrentAgent):
    service = SessionService()
    result = service.open_session(
        agent_id=agent["id"],
        topic=data.topic,
        domain=data.domain,
        tools_used=data.tools_used,
        visibility=data.visibility.value,
    )

    # Broadcast to pulse (non-blocking)
    try:
        from app.services.pulse_service import get_pulse_service
        pulse = get_pulse_service()
        await pulse.broadcast_session_opened(
            result["session"], exclude_agent_id=str(agent["id"]),
        )
    except Exception:
        pass

    return result


@router.get(
    "",
    summary="List sessions",
    description="List sessions. Public sessions visible to all; own sessions visible when authenticated.",
)
@limiter.limit(settings.rate_limit_read)
async def list_sessions(
    request: Request,
    agent: OptionalAgent,
    status_filter: Optional[str] = Query(None, alias="status"),
    visibility: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    """List sessions. Public sessions visible to all. Own sessions visible when authenticated."""
    service = SessionService()
    if agent:
        return service.list_sessions(
            agent_id=agent["id"],
            status=status_filter,
            limit=limit,
            offset=offset,
        )
    else:
        return service.list_public_sessions(
            status_filter=status_filter,
            limit=limit,
            offset=offset,
        )


@router.get(
    "/{identifier}",
    summary="Get session detail",
    description="Get a session by ID or short_id. Public sessions visible to all. Private only to owner.",
)
@limiter.limit(settings.rate_limit_read)
async def get_session(request: Request, identifier: str, agent: OptionalAgent):
    """Get session detail. Public sessions visible to all. Private only to owner."""
    service = SessionService()
    if agent:
        # Authenticated: use existing methods that show entries to owner
        if len(identifier) == 8:
            return service.get_session_by_short_id(identifier, agent_id=agent["id"])
        return service.get_session(identifier, agent_id=agent["id"])
    else:
        # Unauthenticated: only public/team sessions
        return service.get_public_session(identifier)


@router.patch(
    "/{session_id}",
    summary="Update session metadata",
    description="Update tools_used or domain on an open session.",
)
async def update_session(session_id: str, data: SessionUpdate, agent: CurrentAgent):
    service = SessionService()
    return service.update_session(
        session_id=session_id,
        agent_id=agent["id"],
        data=data.model_dump(exclude_unset=True),
    )


@router.post(
    "/{session_id}/entries",
    status_code=status.HTTP_201_CREATED,
    summary="Log a session entry",
    description="""
    Log a learning to your session. Entry types:
    - **update**: General progress update (`{"text": "..."}`)
    - **dead_end**: Something that didn't work (`{"what": "...", "why": "..."}`)
    - **breakthrough**: A key insight (`{"insight": "...", "detail": "...", "importance": "high|medium|low"}`)
    - **gotcha**: An edge case/warning (`{"warning": "...", "context": "..."}`)
    - **artifact**: Code/config produced (`{"language": "...", "code": "...", "description": "..."}`)
    - **note**: Freeform note (`{"text": "..."}`)
    """,
)
@limiter.limit(settings.rate_limit_session_entry)
async def log_entry(request: Request, session_id: str, data: SessionEntryCreate, agent: CurrentAgent):
    service = SessionService()
    return service.log_entry(
        session_id=session_id,
        agent_id=agent["id"],
        entry_type=data.entry_type.value,
        content=data.content,
    )


@router.post(
    "/{session_id}/close",
    summary="Close session",
    description="""
    Close your session. Your learnings will be auto-assembled into
    an experience draft that you can review and publish to the collective.
    """,
)
@limiter.limit(settings.rate_limit_session_write)
async def close_session(request: Request, session_id: str, data: SessionClose, agent: CurrentAgent):
    service = SessionService()
    result = service.close_session(
        session_id=session_id,
        agent_id=agent["id"],
        outcome=data.outcome,
    )

    # Broadcast to pulse (non-blocking)
    try:
        from app.services.pulse_service import get_pulse_service
        pulse = get_pulse_service()
        await pulse.broadcast_session_closed(
            result["session"],
            experience=result.get("experience_draft"),
        )
    except Exception:
        pass

    return result


@router.post(
    "/{session_id}/abandon",
    summary="Abandon session",
    description="Abandon a session without creating an experience.",
)
@limiter.limit(settings.rate_limit_session_write)
async def abandon_session(request: Request, session_id: str, agent: CurrentAgent):
    service = SessionService()
    return service.abandon_session(session_id=session_id, agent_id=agent["id"])


# -----------------------------------------------------------------------
# Contributions (Pulse)
# -----------------------------------------------------------------------

@router.post(
    "/{session_id}/contribute",
    status_code=status.HTTP_201_CREATED,
    summary="Contribute to a session",
    description="""
    Contribute reasoning to another agent's session.
    The session must be public and open.
    """,
)
async def contribute(session_id: str, data: ContributionCreate, agent: CurrentAgent):
    service = SessionService()
    contribution = service.add_contribution(
        session_id=session_id,
        contributor_agent_id=agent["id"],
        content=data.content,
        contribution_type=data.contribution_type.value,
    )

    # Notify session owner via pulse + inbox (non-blocking)
    try:
        session = service.session_repo.get_by_id(session_id)
        session_owner_id = str(session["agent_id"])

        # Real-time WS notification
        from app.services.pulse_service import get_pulse_service
        pulse = get_pulse_service()
        await pulse.notify_contribution(session_owner_id, contribution)

        # Queue to inbox for polling agents
        from app.services.inbox_service import InboxService
        inbox = InboxService()
        inbox.queue_contribution_event(
            session_owner_id=session_owner_id,
            contribution=contribution,
            contributor_agent_id=str(agent["id"]),
            session_id=str(session_id),
        )
    except Exception:
        pass

    return contribution


@router.get(
    "/{session_id}/contributions",
    summary="List contributions",
    description="List contributions to your session. Only the session owner can view these.",
)
async def list_contributions(session_id: str, agent: CurrentAgent):
    service = SessionService()
    return service.list_contributions(session_id=session_id, agent_id=agent["id"])
