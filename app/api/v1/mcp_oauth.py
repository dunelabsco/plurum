"""Human-authenticated onboarding endpoints for hosted MCP OAuth."""

from typing import Annotated

from fastapi import APIRouter, Header, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from fastapi.responses import JSONResponse

from app.core.security import CurrentUser, extract_bearer_token
from app.core.exceptions import PlurimException
from app.models.mcp_oauth import (
    MCPOAuthBindRequest,
    MCPOAuthCreateAndBindRequest,
    MCPOAuthBoundAgent,
    MCPOAuthClientRequest,
    MCPOAuthBindingState,
    MCPOAuthConnection,
    MCPOAuthDisconnectRequest,
    MCPOAuthDisconnectResult,
)
from app.repositories.event_repo import log_event
from app.services.mcp_oauth_binding_service import MCPOAuthBindingService
from app.services.mcp_oauth_grant_service import MCPOAuthGrantService


class OAuthRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def protected(request):
            try:
                response = await handler(request)
            except RequestValidationError:
                response = JSONResponse(
                    {"error": "Invalid OAuth connection request"}, status_code=422
                )
            except PlurimException as error:
                response = JSONResponse({"error": error.message}, status_code=error.status_code)
            except Exception:
                response = JSONResponse({"error": "OAuth connection unavailable"}, status_code=503)
            response.headers["Cache-Control"] = "no-store"
            response.headers["Referrer-Policy"] = "no-referrer"
            return response

        return protected


router = APIRouter(prefix="/mcp/oauth", tags=["MCP OAuth"], route_class=OAuthRoute)


@router.post(
    "/bind",
    response_model=MCPOAuthBoundAgent,
    summary="Select an existing agent for MCP OAuth",
)
def bind_existing_agent(data: MCPOAuthBindRequest, user: CurrentUser):
    """Bind one exact OAuth client to an active agent owned by the user."""
    return MCPOAuthBindingService().bind(
        owner_user_id=user["id"],
        client_id=data.client_id,
        agent_id=data.agent_id,
        expected_grant_id=data.expected_grant_id,
    )


@router.post(
    "/create-and-bind",
    response_model=MCPOAuthBoundAgent,
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
        expected_grant_id=data.expected_grant_id,
    )
    log_event("register", agent_id=str(agent["id"]), metadata={"flow": "mcp_oauth"})
    return agent


@router.post("/binding-state", response_model=MCPOAuthBindingState)
def binding_state(data: MCPOAuthClientRequest, user: CurrentUser):
    return MCPOAuthBindingService().state(owner_user_id=user["id"], client_id=data.client_id)


@router.get("/connections", response_model=list[MCPOAuthConnection])
def list_connections(user: CurrentUser, authorization: Annotated[str, Header()]):
    return MCPOAuthGrantService().list_connections(
        owner_user_id=user["id"],
        user_token=extract_bearer_token(authorization),
    )


@router.post("/disconnect", response_model=MCPOAuthDisconnectResult)
def disconnect(
    data: MCPOAuthDisconnectRequest,
    user: CurrentUser,
    authorization: Annotated[str, Header()],
    response: Response,
):
    result = MCPOAuthGrantService().disconnect(
        owner_user_id=user["id"],
        client_id=data.client_id,
        expected_grant_id=str(data.expected_grant_id) if data.expected_grant_id else None,
        user_token=extract_bearer_token(authorization),
    )
    log_event("mcp_oauth_disconnect", metadata={"state": result.state})
    if result.state == "revocation_pending":
        response.status_code = 202
        response.headers["Retry-After"] = "30"
    return result
