"""Feedback repository for database operations."""

from __future__ import annotations

from uuid import UUID

from app.db.supabase_client import get_supabase_client
from app.core.exceptions import NotFoundError
from app.models.feedback import VoteType


class FeedbackRepository:
    """Repository for feedback (executions, votes) database operations."""

    def __init__(self):
        self.client = get_supabase_client()

    # =========================================================================
    # EXECUTION REPORT OPERATIONS
    # =========================================================================

    def create_execution_report(
        self,
        blueprint_id: UUID,
        version_id: UUID | str,
        agent_id: UUID,
        success: bool,
        execution_time_ms: int | None = None,
        error_message: str | None = None,
        context_notes: str | None = None,
        env_fingerprint: dict | None = None,
        error_signature: str | None = None,
        cost_usd: float | None = None,
    ) -> dict:
        """Create a new execution report."""
        data = {
            "blueprint_id": str(blueprint_id),
            "version_id": str(version_id),
            "agent_id": str(agent_id),
            "success": success,
        }

        if execution_time_ms is not None:
            data["execution_time_ms"] = execution_time_ms
        if error_message:
            data["error_message"] = error_message
        if context_notes:
            data["context_notes"] = context_notes
        if env_fingerprint:
            data["env_fingerprint"] = env_fingerprint
        if error_signature:
            data["error_signature"] = error_signature
        if cost_usd is not None:
            data["cost_usd"] = cost_usd

        result = self.client.table("execution_reports").insert(data).execute()

        if not result.data:
            raise Exception("Failed to create execution report")

        return result.data[0]

    def get_execution_reports_for_blueprint(
        self,
        blueprint_id: UUID,
        limit: int = 20,
        offset: int = 0,
    ) -> list[dict]:
        """Get execution reports for a blueprint."""
        result = (
            self.client.table("execution_reports")
            .select("*")
            .eq("blueprint_id", str(blueprint_id))
            .order("created_at", desc=True)
            .range(offset, offset + limit - 1)
            .execute()
        )
        return result.data or []

    def get_execution_reports_by_agent(
        self,
        agent_id: UUID,
        limit: int = 20,
        offset: int = 0,
    ) -> list[dict]:
        """Get execution reports by an agent."""
        result = (
            self.client.table("execution_reports")
            .select("*")
            .eq("agent_id", str(agent_id))
            .order("created_at", desc=True)
            .range(offset, offset + limit - 1)
            .execute()
        )
        return result.data or []

    # =========================================================================
    # VOTE OPERATIONS
    # =========================================================================

    def get_vote(self, blueprint_id: UUID, agent_id: UUID) -> dict | None:
        """Get an agent's vote for a blueprint."""
        result = (
            self.client.table("votes")
            .select("*")
            .eq("blueprint_id", str(blueprint_id))
            .eq("agent_id", str(agent_id))
            .execute()
        )
        return result.data[0] if result.data else None

    def create_vote(
        self,
        blueprint_id: UUID,
        agent_id: UUID,
        vote_type: VoteType,
    ) -> dict:
        """Create a new vote."""
        data = {
            "blueprint_id": str(blueprint_id),
            "agent_id": str(agent_id),
            "vote_type": vote_type.value,
        }

        result = self.client.table("votes").insert(data).execute()

        if not result.data:
            raise Exception("Failed to create vote")

        return result.data[0]

    def update_vote(
        self,
        vote_id: UUID,
        vote_type: VoteType,
    ) -> dict:
        """Update an existing vote."""
        result = (
            self.client.table("votes")
            .update({"vote_type": vote_type.value})
            .eq("id", str(vote_id))
            .execute()
        )

        if not result.data:
            raise NotFoundError("Vote", str(vote_id))

        return result.data[0]

    def delete_vote(self, vote_id: UUID) -> None:
        """Delete a vote."""
        self.client.table("votes").delete().eq("id", str(vote_id)).execute()

    def upsert_vote(
        self,
        blueprint_id: UUID,
        agent_id: UUID,
        vote_type: VoteType,
    ) -> dict:
        """Create or update a vote."""
        existing = self.get_vote(blueprint_id, agent_id)

        if existing:
            if existing["vote_type"] == vote_type.value:
                # Same vote - delete it (toggle off)
                self.delete_vote(existing["id"])
                return {"action": "removed", "vote": None}
            else:
                # Different vote - update
                updated = self.update_vote(existing["id"], vote_type)
                return {"action": "updated", "vote": updated}
        else:
            # New vote
            created = self.create_vote(blueprint_id, agent_id, vote_type)
            return {"action": "created", "vote": created}

    def get_votes_for_blueprint(self, blueprint_id: UUID) -> dict:
        """Get vote counts for a blueprint."""
        result = (
            self.client.table("votes")
            .select("vote_type")
            .eq("blueprint_id", str(blueprint_id))
            .execute()
        )

        votes = result.data or []
        upvotes = sum(1 for v in votes if v["vote_type"] == "up")
        downvotes = sum(1 for v in votes if v["vote_type"] == "down")

        return {
            "upvotes": upvotes,
            "downvotes": downvotes,
            "total": len(votes),
        }
