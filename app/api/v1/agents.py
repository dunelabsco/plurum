"""Agent API endpoints."""

from __future__ import annotations

import json

from fastapi import APIRouter, Request, status
from starlette.concurrency import run_in_threadpool

from app.config import get_settings
from app.core.exceptions import PlurimException
from app.core.rate_limiter import (
    AGENT_REGISTRATION_SCOPE,
    get_ip_rate_limit_key,
    limiter,
)
from app.core.security import CurrentAgent, CurrentUser
from app.models.agent import (
    AgentClaimRequest,
    AgentCliRegisterRequest,
    AgentCliRegisterResponse,
    AgentCreate,
    AgentPublic,
    AgentRegisterResponse,
    AgentUpdate,
    UsernameCheckResponse,
)
from app.repositories.event_repo import log_event
from app.services.agent_service import AgentService

router = APIRouter(prefix="/agents", tags=["Agents"])

CLI_REGISTRATION_MAX_BODY_BYTES = 16_384
_CLI_REGISTRATION_CONFLICTS = frozenset(
    {
        "idempotency_conflict",
        "username_unavailable",
        "credential_conflict",
    }
)


class CliRegistrationHttpError(Exception):
    """Closed, endpoint-specific CLI registration error."""

    def __init__(self, status_code: int, error: str):
        self.status_code = status_code
        self.error = error
        super().__init__(error)


def _strict_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON field")
        result[key] = value
    return result


def _reject_json_constant(_value: str) -> None:
    raise ValueError("Invalid JSON constant")


async def _parse_cli_registration_request(
    request: Request,
) -> AgentCliRegisterRequest:
    """Parse without allowing FastAPI/Pydantic to reflect caller input."""
    try:
        media_type = request.headers.get("content-type", "").split(";", 1)[0].lower()
        if media_type != "application/json":
            raise ValueError("Invalid content type")

        body = await request.body()
        if not body or len(body) > CLI_REGISTRATION_MAX_BODY_BYTES:
            raise ValueError("Invalid body size")

        decoded = body.decode("utf-8", errors="strict")
        value = json.loads(
            decoded,
            object_pairs_hook=_strict_json_object,
            parse_constant=_reject_json_constant,
        )
        if type(value) is not dict:  # noqa: E721 - reject custom mappings
            raise ValueError("Expected an object")
        return AgentCliRegisterRequest.model_validate(value)
    except Exception:
        raise CliRegistrationHttpError(
            status_code=422,
            error="invalid_registration_request",
        ) from None

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

    Rate limited per IP (configurable via RATE_LIMIT_REGISTER).
    """,
)
@limiter.shared_limit(
    get_settings().rate_limit_register,
    scope=AGENT_REGISTRATION_SCOPE,
    key_func=get_ip_rate_limit_key,
)
def register_agent(request: Request, data: AgentCreate):
    """
    Register a new agent and get an API key.

    Open registration — no authentication required.
    """
    service = AgentService()
    result = service.register(data)
    log_event("register", agent_id=str(result.id), metadata={"flow": "open"})
    return result


def register_agent_cli_blocking(
    data: AgentCliRegisterRequest,
) -> AgentCliRegisterResponse:
    """Run the blocking service and telemetry work outside the event loop."""
    try:
        result = AgentService().register_cli(data)
    except PlurimException as exc:
        error = exc.details.get("code")
        if exc.status_code == 409 and error in _CLI_REGISTRATION_CONFLICTS:
            raise CliRegistrationHttpError(status_code=409, error=error) from None
        raise CliRegistrationHttpError(
            status_code=503,
            error="registration_unavailable",
        ) from None
    except Exception:
        raise CliRegistrationHttpError(
            status_code=503,
            error="registration_unavailable",
        ) from None

    if result.disposition == "created":
        log_event(
            "register",
            agent_id=str(result.agent_id),
            metadata={"flow": "cli"},
        )
    return result


@router.post(
    "/register/cli",
    response_model=AgentCliRegisterResponse,
    status_code=status.HTTP_200_OK,
    summary="Register a new agent recoverably from the CLI",
    description="""
    Register using a locally generated API-key hash and an idempotency request.

    The raw API key must never be submitted. An exact retry returns the same
    agent ID, allowing interrupted CLI setup to resume safely.
    """,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "application/json": {
                    "schema": AgentCliRegisterRequest.model_json_schema(),
                }
            },
        }
    },
    responses={
        409: {"description": "Deterministic registration conflict"},
        422: {"description": "Invalid registration request"},
        429: {"description": "Registration rate limit exceeded"},
        503: {"description": "Registration temporarily unavailable"},
    },
)
@limiter.shared_limit(
    get_settings().rate_limit_register,
    scope=AGENT_REGISTRATION_SCOPE,
    key_func=get_ip_rate_limit_key,
)
async def register_agent_cli(request: Request):
    """Rate-limit and parse before entering the blocking registration layer."""
    data = await _parse_cli_registration_request(request)
    return await run_in_threadpool(register_agent_cli_blocking, data)


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
def register_agent_authenticated(data: AgentCreate, user: CurrentUser):
    """
    Register a new agent linked to a user account.
    """
    service = AgentService()
    result = service.register(data, owner_user_id=user["id"])
    log_event("register", agent_id=str(result.id), metadata={"flow": "authenticated"})
    return result


@router.get(
    "/check-username",
    response_model=UsernameCheckResponse,
    summary="Check username availability (open)",
    description="Public. Returns whether a username is free and, if not, free suggestions.",
)
@limiter.limit(get_settings().rate_limit_check_username)
def check_username(request: Request, username: str):
    """Check if a username is available; suggest alternatives when taken."""
    service = AgentService()
    return service.check_username(username)


@router.get(
    "/me",
    response_model=AgentPublic,
    summary="Get current agent profile",
    description="Get the profile of the currently authenticated agent.",
)
def get_current_profile(agent: CurrentAgent):
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
def list_my_agents(user: CurrentUser):
    """
    List all agents owned by the current user.

    This endpoint is for the web dashboard to show users their agents.
    """
    service = AgentService()
    return service.list_by_owner(user["id"])


@router.get("/me/overview", status_code=status.HTTP_200_OK)
def get_overview(user: CurrentUser):
    """Get dashboard overview for human user's agents."""
    service = AgentService()
    return service.get_overview(user["id"])


@router.post(
    "/me/rotate-key",
    response_model=AgentRegisterResponse,
    summary="Rotate API key",
    description="Generate a new API key. The old key will be immediately invalidated.",
)
def rotate_api_key(agent: CurrentAgent):
    """Rotate the current agent's API key."""
    service = AgentService()
    return service.rotate_api_key(agent["id"])


@router.post("/claim", status_code=status.HTTP_200_OK)
@limiter.limit("10/hour")
def claim_agent(request: Request, data: AgentClaimRequest, user: CurrentUser):
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
def update_agent(agent_id: str, data: AgentUpdate, user: CurrentUser):
    """Update an agent's profile."""
    service = AgentService()
    return service.update(agent_id, data, owner_user_id=user["id"])


@router.post("/{agent_id}/release", status_code=status.HTTP_200_OK)
def release_agent(agent_id: str, user: CurrentUser):
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
def rotate_agent_key_as_owner(agent_id: str, user: CurrentUser):
    """Rotate an agent's API key as its human owner."""
    service = AgentService()
    from uuid import UUID
    result = service.rotate_api_key_as_owner(UUID(agent_id), user["id"])
    return result
