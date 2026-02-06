"""Experience repository for database operations."""

from __future__ import annotations

from uuid import UUID

from app.db.supabase_client import get_supabase_client
from app.core.exceptions import NotFoundError, DuplicateError


class ExperienceRepository:
    """Repository for experience, outcome report, and vote database operations."""

    def __init__(self):
        self.client = get_supabase_client()

    # -----------------------------------------------------------------------
    # Experiences
    # -----------------------------------------------------------------------

    def create(self, data: dict) -> dict:
        """Create a new experience."""
        result = self.client.table("experiences").insert(data).execute()
        if not result.data:
            raise Exception("Failed to create experience")
        return result.data[0]

    def get_by_id(self, experience_id: UUID) -> dict:
        """Get an experience by ID."""
        result = (
            self.client.table("experiences")
            .select("*")
            .eq("id", str(experience_id))
            .execute()
        )
        if not result.data:
            raise NotFoundError("Experience", str(experience_id))
        return result.data[0]

    def get_by_short_id(self, short_id: str) -> dict:
        """Get an experience by short_id."""
        result = (
            self.client.table("experiences")
            .select("*")
            .eq("short_id", short_id)
            .execute()
        )
        if not result.data:
            raise NotFoundError("Experience", short_id)
        return result.data[0]

    def get_by_identifier(self, identifier: str) -> dict:
        """Get an experience by either UUID or short_id."""
        try:
            UUID(identifier)
            return self.get_by_id(UUID(identifier))
        except ValueError:
            return self.get_by_short_id(identifier)

    def list_experiences(
        self,
        status: str | None = None,
        domain: str | None = None,
        agent_id: UUID | None = None,
        limit: int = 20,
        offset: int = 0,
        include_archived: bool = False,
    ) -> tuple[list[dict], int]:
        """List experiences with optional filters."""
        query = (
            self.client.table("experiences")
            .select("*", count="exact")
        )

        if status:
            query = query.eq("status", status)
        elif not include_archived:
            query = query.neq("status", "archived")

        if domain:
            query = query.eq("domain", domain)
        if agent_id:
            query = query.eq("agent_id", str(agent_id))

        result = (
            query
            .order("created_at", desc=True)
            .range(offset, offset + limit - 1)
            .execute()
        )
        return result.data or [], result.count or 0

    def update(self, experience_id: UUID, data: dict) -> dict:
        """Update an experience."""
        result = (
            self.client.table("experiences")
            .update(data)
            .eq("id", str(experience_id))
            .execute()
        )
        if not result.data:
            raise NotFoundError("Experience", str(experience_id))
        return result.data[0]

    def search(
        self,
        query_text: str,
        query_embedding: list[float],
        match_count: int = 10,
        min_quality: float = 0.0,
        domain: str | None = None,
    ) -> list[dict]:
        """Hybrid search using the search_experiences RPC."""
        params: dict = {
            "query_text": query_text,
            "query_embedding": query_embedding,
            "match_count": match_count,
            "min_quality": min_quality,
        }
        if domain:
            params["domain_filter"] = domain

        result = self.client.rpc("search_experiences", params).execute()
        return result.data or []

    def find_similar(
        self,
        embedding: list[float],
        match_count: int = 5,
        min_similarity: float = 0.5,
        exclude_id: UUID | None = None,
    ) -> list[dict]:
        """Find similar experiences by embedding using the RPC."""
        params: dict = {
            "query_embedding": embedding,
            "match_count": match_count,
            "min_similarity": min_similarity,
        }
        if exclude_id:
            params["exclude_experience_id"] = str(exclude_id)

        result = self.client.rpc("find_similar_experiences", params).execute()
        return result.data or []

    def update_quality_score(self, experience_id: UUID) -> dict:
        """Recalculate and update quality_score using Wilson lower bound.

        quality_score = 0.7 * wilson(success, total_reports) + 0.3 * wilson(upvotes, total_votes)
        """
        exp = self.get_by_id(experience_id)

        total_votes = exp["upvotes"] + exp["downvotes"]
        total_reports = exp["total_reports"]

        outcome_score = self._wilson_lower_bound(exp["success_count"], total_reports)
        social_score = self._wilson_lower_bound(exp["upvotes"], total_votes)

        quality_score = 0.7 * outcome_score + 0.3 * social_score

        return self.update(experience_id, {"quality_score": quality_score})

    # -----------------------------------------------------------------------
    # Outcome Reports
    # -----------------------------------------------------------------------

    def create_outcome_report(self, data: dict) -> dict:
        """Create an outcome report for an experience."""
        result = self.client.table("outcome_reports").insert(data).execute()
        if not result.data:
            raise Exception("Failed to create outcome report")
        return result.data[0]

    def get_outcome_report(self, experience_id: UUID, agent_id: UUID) -> dict | None:
        """Get an agent's outcome report for an experience."""
        result = (
            self.client.table("outcome_reports")
            .select("*")
            .eq("experience_id", str(experience_id))
            .eq("agent_id", str(agent_id))
            .execute()
        )
        return result.data[0] if result.data else None

    # -----------------------------------------------------------------------
    # Votes
    # -----------------------------------------------------------------------

    def upsert_vote(self, experience_id: UUID, agent_id: UUID, vote_type: str) -> dict:
        """Create or update a vote on an experience."""
        data = {
            "experience_id": str(experience_id),
            "agent_id": str(agent_id),
            "vote_type": vote_type,
            "updated_at": "now()",
        }
        result = (
            self.client.table("experience_votes")
            .upsert(data, on_conflict="experience_id,agent_id")
            .execute()
        )
        if not result.data:
            raise Exception("Failed to upsert vote")
        return result.data[0]

    def get_vote(self, experience_id: UUID, agent_id: UUID) -> dict | None:
        """Get an agent's vote on an experience."""
        result = (
            self.client.table("experience_votes")
            .select("*")
            .eq("experience_id", str(experience_id))
            .eq("agent_id", str(agent_id))
            .execute()
        )
        return result.data[0] if result.data else None

    # -----------------------------------------------------------------------
    # Helpers
    # -----------------------------------------------------------------------

    @staticmethod
    def _wilson_lower_bound(positive: int, total: int) -> float:
        """Calculate Wilson lower bound score for confidence-adjusted ranking."""
        if total == 0:
            return 0.0
        import math
        z = 1.96  # 95% confidence
        phat = positive / total
        return (
            phat + z * z / (2 * total)
            - z * math.sqrt((phat * (1 - phat) + z * z / (4 * total)) / total)
        ) / (1 + z * z / total)
