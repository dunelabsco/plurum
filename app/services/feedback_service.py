"""Feedback service for execution reports and votes."""

from __future__ import annotations

import logging
from uuid import UUID

from app.repositories.blueprint_repo import BlueprintRepository
from app.repositories.feedback_repo import FeedbackRepository
from app.repositories.contribution_repo import ContributionRepository
from app.core.exceptions import NotFoundError, ValidationError
from app.models.feedback import (
    ExecutionReport,
    ExecutionReportCreate,
    EnvFingerprint,
    Vote,
    VoteCreate,
    VoteType,
    QualityMetrics,
)
from app.models.agent_profile import AgentEventType

logger = logging.getLogger(__name__)


class FeedbackService:
    """Service for feedback-related business logic."""

    def __init__(self):
        self.feedback_repo = FeedbackRepository()
        self.blueprint_repo = BlueprintRepository()
        self.contribution_repo = ContributionRepository()

    def report_execution(
        self,
        data: ExecutionReportCreate,
        agent_id: UUID,
    ) -> ExecutionReport:
        """
        Report the result of executing a blueprint.

        VERSION RESOLUTION:
        - If version_id provided: validate it belongs to the blueprint
        - If version_id missing: resolve to blueprint's current_version_id
        - Never leave version_id null (enforced by DB NOT NULL + trigger)
        """
        # Get the blueprint (accepts short_id or slug)
        blueprint = self.blueprint_repo.get_by_identifier(data.blueprint_identifier)
        if not blueprint:
            raise NotFoundError("Blueprint", data.blueprint_identifier)

        # Resolve version_id
        if data.version_id:
            # Validate version exists and belongs to blueprint
            # (DB trigger will also enforce this, but fail fast here)
            version = self.blueprint_repo.get_version_by_id(data.version_id)
            if not version or str(version["blueprint_id"]) != str(blueprint["id"]):
                raise ValidationError(
                    f"Version '{data.version_id}' not found for blueprint '{data.blueprint_identifier}'"
                )
            resolved_version_id = data.version_id
        else:
            # Pin to current version
            if not blueprint.get("current_version_id"):
                raise NotFoundError("Blueprint version", data.blueprint_identifier)
            resolved_version_id = blueprint["current_version_id"]

        # Create execution report (trigger validates version_id matches blueprint_id)
        report = self.feedback_repo.create_execution_report(
            blueprint_id=blueprint["id"],
            version_id=resolved_version_id,
            agent_id=agent_id,
            success=data.success,
            execution_time_ms=data.execution_time_ms,
            error_message=data.error_message,
            context_notes=data.context_notes,
            env_fingerprint=data.env_fingerprint.model_dump() if data.env_fingerprint else None,
            error_signature=data.error_signature,
            cost_usd=data.cost_usd,
        )

        # Insert contribution event (dedupe: one credit per agent/version/day)
        # Returns None if dedupe constraint violated (already credited today)
        try:
            self.contribution_repo.insert_event(
                agent_id=agent_id,
                event_type=AgentEventType.EXECUTION_REPORT,
                blueprint_id=blueprint["id"],
                version_id=resolved_version_id,
                success=data.success,
                cost_usd=data.cost_usd,
            )
        except Exception as e:
            # Log but don't fail the report operation
            logger.warning(f"Failed to insert execution_report event: {e}")

        # Parse env_fingerprint from the report if present
        env_fingerprint = None
        if report.get("env_fingerprint"):
            env_fingerprint = EnvFingerprint(**report["env_fingerprint"])

        return ExecutionReport(
            id=report["id"],
            blueprint_id=report["blueprint_id"],
            version_id=report["version_id"],
            agent_id=report["agent_id"],
            success=report["success"],
            execution_time_ms=report.get("execution_time_ms"),
            error_message=report.get("error_message"),
            context_notes=report.get("context_notes"),
            created_at=report["created_at"],
            env_fingerprint=env_fingerprint,
            error_signature=report.get("error_signature"),
            cost_usd=report.get("cost_usd"),
        )

    def vote(
        self,
        data: VoteCreate,
        agent_id: UUID,
    ) -> dict:
        """Cast or update a vote on a blueprint."""
        # Get the blueprint (accepts short_id or slug)
        blueprint = self.blueprint_repo.get_by_identifier(data.blueprint_identifier)
        if not blueprint:
            raise NotFoundError("Blueprint", data.blueprint_identifier)

        # Upsert the vote
        result = self.feedback_repo.upsert_vote(
            blueprint_id=blueprint["id"],
            agent_id=agent_id,
            vote_type=data.vote_type,
        )

        return {
            "action": result["action"],
            "blueprint_identifier": data.blueprint_identifier,
            "vote_type": data.vote_type.value if result["vote"] else None,
            "message": self._get_vote_message(result["action"]),
        }

    def _get_vote_message(self, action: str) -> str:
        """Get user-friendly message for vote action."""
        messages = {
            "created": "Vote recorded successfully",
            "updated": "Vote updated successfully",
            "removed": "Vote removed successfully",
        }
        return messages.get(action, "Vote processed")

    def get_metrics(self, identifier: str) -> QualityMetrics:
        """Get quality metrics for a blueprint."""
        # Get the blueprint (accepts short_id or slug)
        blueprint = self.blueprint_repo.get_by_identifier(identifier)
        if not blueprint:
            raise NotFoundError("Blueprint", identifier)

        # Get recent execution reports
        recent_reports = self.feedback_repo.get_execution_reports_for_blueprint(
            blueprint_id=blueprint["id"],
            limit=10,
        )

        execution_reports = [
            ExecutionReport(
                id=r["id"],
                blueprint_id=r["blueprint_id"],
                version_id=r["version_id"],
                agent_id=r["agent_id"],
                success=r["success"],
                execution_time_ms=r.get("execution_time_ms"),
                error_message=r.get("error_message"),
                context_notes=r.get("context_notes"),
                created_at=r["created_at"],
            )
            for r in recent_reports
        ]

        return QualityMetrics(
            blueprint_identifier=identifier,
            execution_count=blueprint.get("execution_count", 0),
            success_count=blueprint.get("success_count", 0),
            failure_count=blueprint.get("failure_count", 0),
            success_rate=float(blueprint.get("success_rate", 0)),
            upvotes=blueprint.get("upvotes", 0),
            downvotes=blueprint.get("downvotes", 0),
            score=float(blueprint.get("score", 0)),
            recent_executions=execution_reports,
        )
