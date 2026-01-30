"""Cron/background job endpoints for scheduled tasks."""

from __future__ import annotations

from typing import Annotated
from pydantic import BaseModel, Field

from fastapi import APIRouter, Query, Header, HTTPException, status, Depends

from app.db.supabase_client import get_supabase_client
from app.config import get_settings, Settings


router = APIRouter(prefix="/cron", tags=["Cron Jobs"])


def verify_cron_secret(
    x_cron_secret: Annotated[str | None, Header()] = None,
    settings: Settings = Depends(get_settings),
) -> None:
    """Verify cron secret for protected endpoints."""
    # Skip auth in development if no secret configured
    if settings.is_development and not settings.cron_secret:
        return

    if not settings.cron_secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Cron secret not configured",
        )

    if x_cron_secret != settings.cron_secret:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid cron secret",
        )


class ScoreUpdateResponse(BaseModel):
    """Response for score update cron job."""

    success: bool
    updated_count: int
    blueprint_ids: list[str] = Field(default_factory=list)
    message: str


class MetricsRecalculateResponse(BaseModel):
    """Response for metrics recalculation."""

    success: bool
    blueprints_updated: int
    message: str


@router.post(
    "/update-scores",
    response_model=ScoreUpdateResponse,
    summary="Update Wilson scores",
    description="""
    Background job to recalculate Wilson scores for blueprints.

    This endpoint should be called periodically (e.g., every 10 minutes) by a
    cron job or scheduler. It processes blueprints that have been marked as
    needing score updates due to new votes or execution reports.

    **Security**: Requires a secret cron key in the `X-Cron-Secret` header.
    """,
)
def update_scores(
    batch_size: Annotated[int, Query(ge=1, le=500)] = 100,
    _: None = Depends(verify_cron_secret),
):
    """
    Recalculate Wilson scores for blueprints marked as needing updates.

    This replaces the heavy SQL triggers that were running synchronously
    on every vote. Instead, scores are now updated in batches.
    """
    client = get_supabase_client()

    try:
        # Call the batch update function
        result = client.rpc(
            "batch_update_wilson_scores",
            {"batch_size": batch_size}
        ).execute()

        if result.data and len(result.data) > 0:
            data = result.data[0]
            return ScoreUpdateResponse(
                success=True,
                updated_count=data.get("updated_count", 0),
                blueprint_ids=[str(id) for id in data.get("blueprint_ids", [])],
                message=f"Updated {data.get('updated_count', 0)} blueprint scores",
            )

        return ScoreUpdateResponse(
            success=True,
            updated_count=0,
            blueprint_ids=[],
            message="No blueprints needed score updates",
        )

    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update scores: {str(e)}",
        )


@router.post(
    "/recalculate-metrics",
    response_model=MetricsRecalculateResponse,
    summary="Recalculate all metrics",
    description="""
    Force recalculation of all blueprint metrics from the source data.

    This is a maintenance endpoint that should be run occasionally to ensure
    metrics are accurate. It recalculates:
    - execution_count, success_count, failure_count, success_rate
    - upvotes, downvotes, score

    **Warning**: This can be slow for large datasets. Use sparingly.

    **Security**: Requires a secret cron key in the `X-Cron-Secret` header.
    """,
)
def recalculate_all_metrics(
    _: None = Depends(verify_cron_secret),
):
    """
    Force recalculation of all blueprint metrics from source data.

    This rebuilds the denormalized metrics by counting votes and
    execution reports directly.
    """
    client = get_supabase_client()

    try:
        # Recalculate execution metrics
        client.rpc("recalculate_execution_metrics", {}).execute()

        # Recalculate vote metrics and scores
        client.rpc("recalculate_vote_metrics", {}).execute()

        # Count updated blueprints
        result = client.table("blueprints").select("id", count="exact").execute()
        count = result.count or 0

        return MetricsRecalculateResponse(
            success=True,
            blueprints_updated=count,
            message=f"Recalculated metrics for {count} blueprints",
        )

    except Exception as e:
        # If the RPC functions don't exist yet, provide helpful error
        if "function" in str(e).lower() and "does not exist" in str(e).lower():
            raise HTTPException(
                status_code=status.HTTP_501_NOT_IMPLEMENTED,
                detail="Recalculation functions not yet implemented. Run migration 003 first.",
            )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to recalculate metrics: {str(e)}",
        )


class DiscussionScoreUpdateResponse(BaseModel):
    """Response for discussion score update cron job."""

    success: bool
    updated_posts: int = 0
    updated_replies: int = 0
    message: str


class DiscussionCounterReconcileResponse(BaseModel):
    """Response for discussion counter reconciliation."""

    success: bool
    posts_fixed: int = 0
    channels_fixed: int = 0
    message: str


@router.post(
    "/update-discussion-scores",
    response_model=DiscussionScoreUpdateResponse,
    summary="Update discussion Wilson scores",
    description="""
    Background job to recalculate Wilson scores for discussion posts and replies.

    Processes items with `needs_score_update = true` in batches.

    **Security**: Requires a secret cron key in the `X-Cron-Secret` header.
    """,
)
def update_discussion_scores(
    batch_size: Annotated[int, Query(ge=1, le=500)] = 100,
    _: None = Depends(verify_cron_secret),
):
    """Batch update Wilson scores for discussion posts and replies."""
    client = get_supabase_client()

    try:
        result = client.rpc(
            "batch_update_discussion_scores",
            {"batch_size": batch_size},
        ).execute()

        if result.data and len(result.data) > 0:
            data = result.data[0]
            return DiscussionScoreUpdateResponse(
                success=True,
                updated_posts=data.get("updated_posts", 0),
                updated_replies=data.get("updated_replies", 0),
                message=(
                    f"Updated {data.get('updated_posts', 0)} post scores "
                    f"and {data.get('updated_replies', 0)} reply scores"
                ),
            )

        return DiscussionScoreUpdateResponse(
            success=True,
            message="No discussion items needed score updates",
        )

    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update discussion scores: {str(e)}",
        )


@router.post(
    "/reconcile-discussion-counters",
    response_model=DiscussionCounterReconcileResponse,
    summary="Reconcile discussion counters",
    description="""
    Recompute denormalized counters (reply_count, post_count, upvotes, downvotes)
    from source tables. Fixes counter drift.

    **Security**: Requires a secret cron key in the `X-Cron-Secret` header.
    """,
)
def reconcile_discussion_counters(
    _: None = Depends(verify_cron_secret),
):
    """Recompute denormalized discussion counters from source tables."""
    client = get_supabase_client()

    try:
        result = client.rpc("reconcile_discussion_counters", {}).execute()

        if result.data and len(result.data) > 0:
            data = result.data[0]
            return DiscussionCounterReconcileResponse(
                success=True,
                posts_fixed=data.get("posts_fixed", 0),
                channels_fixed=data.get("channels_fixed", 0),
                message=(
                    f"Fixed {data.get('posts_fixed', 0)} posts "
                    f"and {data.get('channels_fixed', 0)} channels"
                ),
            )

        return DiscussionCounterReconcileResponse(
            success=True,
            message="All counters are consistent",
        )

    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to reconcile discussion counters: {str(e)}",
        )


@router.get(
    "/health",
    summary="Cron health check",
    description="Simple health check for the cron system.",
)
def cron_health():
    """Health check for cron endpoints."""
    return {"status": "ok", "service": "cron"}
