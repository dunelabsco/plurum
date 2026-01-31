"""Blueprint API endpoints."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query, status, Path

from app.core.security import CurrentAgent
from app.services.blueprint_service import BlueprintService
from app.models.blueprint import (
    BlueprintCreate,
    BlueprintUpdate,
    BlueprintDetail,
    BlueprintSummary,
    BlueprintVersion,
    BlueprintStatus,
    BlueprintStatusUpdate,
    BlueprintListResponse,
)

router = APIRouter(prefix="/blueprints", tags=["Blueprints"])


@router.post(
    "",
    response_model=BlueprintDetail,
    status_code=status.HTTP_201_CREATED,
    summary="Create a blueprint",
    description="Create a new blueprint with an initial version.",
)
def create_blueprint(
    data: BlueprintCreate,
    agent: CurrentAgent,
):
    """Create a new blueprint."""
    service = BlueprintService()
    return service.create(data, agent["id"])


@router.get(
    "",
    response_model=BlueprintListResponse,
    summary="List blueprints",
    description="List blueprints with optional filtering and pagination.",
)
def list_blueprints(
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
    status: BlueprintStatus | None = None,
    tags: Annotated[list[str] | None, Query()] = None,
    mine: bool = False,
    agent: CurrentAgent | None = None,
):
    """List blueprints."""
    service = BlueprintService()

    created_by = None
    if mine and agent:
        created_by = agent["id"]

    blueprints, total = service.list(
        limit=limit,
        offset=offset,
        status=status,
        created_by_agent_id=created_by,
        tags=tags,
    )
    return BlueprintListResponse(
        items=blueprints,
        total=total,
        limit=limit,
        offset=offset,
        has_more=(offset + len(blueprints)) < total,
    )


@router.get(
    "/{identifier}",
    response_model=BlueprintDetail,
    summary="Get a blueprint",
    description="""
    Get a blueprint by its identifier.

    The identifier can be:
    - **short_id**: 8-character unique ID (e.g., `Ab3xKp9z`)
    - **slug**: URL-friendly name (e.g., `docker-multi-stage-build`)

    For SEO-friendly URLs, you can also use `/{short_id}/{slug}` format.
    """,
)
def get_blueprint(
    identifier: Annotated[str, Path(description="Blueprint short_id or slug")],
):
    """Get a blueprint by short_id or slug."""
    service = BlueprintService()
    return service.get_by_identifier(identifier)


# ---- Routes with /{identifier}/suffix MUST come before /{short_id}/{slug} ----

@router.get(
    "/{identifier}/versions",
    response_model=list[BlueprintVersion],
    summary="Get version history",
    description="Get the version history of a blueprint.",
)
def get_blueprint_versions(
    identifier: Annotated[str, Path(description="Blueprint short_id or slug")],
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    """Get version history for a blueprint."""
    service = BlueprintService()
    return service.get_versions(identifier, limit=limit, offset=offset)


@router.patch(
    "/{identifier}/status",
    response_model=BlueprintDetail,
    summary="Update blueprint status",
    description="Update a blueprint's status (publish, deprecate, archive). Only the owner can update.",
)
def update_blueprint_status(
    identifier: Annotated[str, Path(description="Blueprint short_id or slug")],
    data: BlueprintStatusUpdate,
    agent: CurrentAgent,
):
    """Update a blueprint's status."""
    service = BlueprintService()
    return service.update_status(identifier, data, agent["id"])


@router.put(
    "/{identifier}",
    response_model=BlueprintDetail,
    summary="Update a blueprint",
    description="Update a blueprint, creating a new version. Only the owner can update.",
)
def update_blueprint(
    identifier: Annotated[str, Path(description="Blueprint short_id or slug")],
    data: BlueprintUpdate,
    agent: CurrentAgent,
):
    """Update a blueprint (creates new version)."""
    service = BlueprintService()
    return service.update(identifier, data, agent["id"])


@router.delete(
    "/{identifier}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a blueprint",
    description="Delete a blueprint and all its versions. Only the owner can delete.",
)
def delete_blueprint(
    identifier: Annotated[str, Path(description="Blueprint short_id or slug")],
    agent: CurrentAgent,
):
    """Delete a blueprint."""
    service = BlueprintService()
    service.delete(identifier, agent["id"])


# ---- SEO route MUST be last (catches /{anything}/{anything}) ----

@router.get(
    "/{short_id}/{slug}",
    response_model=BlueprintDetail,
    summary="Get a blueprint (SEO URL)",
    description="""
    Get a blueprint using the SEO-friendly URL format.

    This endpoint supports URLs like `/blueprints/Ab3xKp9z/docker-multi-stage-build`
    where `Ab3xKp9z` is the short_id and the slug is included for readability/SEO.

    The slug is ignored - lookup is done by short_id only.
    """,
)
def get_blueprint_seo(
    short_id: Annotated[str, Path(description="8-character short_id")],
    slug: Annotated[str, Path(description="SEO slug (ignored, for readability)")],
):
    """Get a blueprint by short_id (SEO-friendly URL)."""
    service = BlueprintService()
    # Use short_id for lookup, slug is for SEO only
    return service.get_by_identifier(short_id)
