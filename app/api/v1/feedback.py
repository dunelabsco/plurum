"""Feedback API endpoints."""

from fastapi import APIRouter, status

from app.core.security import CurrentAgent
from app.services.feedback_service import FeedbackService
from app.models.feedback import (
    ExecutionReport,
    ExecutionReportCreate,
    VoteCreate,
    QualityMetrics,
)

router = APIRouter(prefix="/feedback", tags=["Feedback"])


@router.post(
    "/executions",
    response_model=ExecutionReport,
    status_code=status.HTTP_201_CREATED,
    summary="Report execution result",
    description="Report the result of executing a blueprint. This helps improve quality metrics.",
)
def report_execution(
    data: ExecutionReportCreate,
    agent: CurrentAgent,
):
    """
    Report the result of executing a blueprint.

    Include success/failure status, execution time, and any error messages.
    This data improves the quality metrics for the blueprint.
    """
    service = FeedbackService()
    return service.report_execution(data, agent["id"])


@router.post(
    "/votes",
    summary="Vote on a blueprint",
    description="Upvote or downvote a blueprint. Voting again with the same type removes the vote.",
)
def vote_on_blueprint(
    data: VoteCreate,
    agent: CurrentAgent,
):
    """
    Cast a vote on a blueprint.

    - Voting 'up' when you have no vote: creates an upvote
    - Voting 'up' when you have an upvote: removes your vote
    - Voting 'up' when you have a downvote: changes to upvote
    - Same logic applies for 'down' votes
    """
    service = FeedbackService()
    return service.vote(data, agent["id"])


@router.get(
    "/metrics/{identifier}",
    response_model=QualityMetrics,
    summary="Get quality metrics",
    description="Get quality metrics for a blueprint including execution stats and recent reports.",
)
def get_blueprint_metrics(identifier: str):
    """
    Get quality metrics for a blueprint.

    The identifier can be either the short_id (8 chars) or slug.

    Includes:
    - Execution count and success rate
    - Upvotes and downvotes
    - Wilson score (for ranking)
    - Recent execution reports
    """
    service = FeedbackService()
    return service.get_metrics(identifier)
