"""Session repository for database operations."""

from __future__ import annotations

from uuid import UUID

from app.db.supabase_client import get_supabase_client
from app.core.exceptions import NotFoundError


class SessionRepository:
    """Repository for session and session entry database operations."""

    def __init__(self):
        self.client = get_supabase_client()

    # -----------------------------------------------------------------------
    # Sessions
    # -----------------------------------------------------------------------

    def create(self, data: dict) -> dict:
        """Create a new session."""
        result = self.client.table("sessions").insert(data).execute()
        if not result.data:
            raise Exception("Failed to create session")
        return result.data[0]

    def get_by_id(self, session_id: UUID) -> dict:
        """Get a session by ID."""
        result = (
            self.client.table("sessions")
            .select("*")
            .eq("id", str(session_id))
            .execute()
        )
        if not result.data:
            raise NotFoundError("Session", str(session_id))
        return result.data[0]

    def get_by_short_id(self, short_id: str) -> dict:
        """Get a session by short_id."""
        result = (
            self.client.table("sessions")
            .select("*")
            .eq("short_id", short_id)
            .execute()
        )
        if not result.data:
            raise NotFoundError("Session", short_id)
        return result.data[0]

    def list_by_agent(
        self,
        agent_id: UUID,
        status: str | None = None,
        limit: int = 20,
        offset: int = 0,
    ) -> tuple[list[dict], int]:
        """List sessions for an agent with optional status filter."""
        query = (
            self.client.table("sessions")
            .select("*", count="exact")
            .eq("agent_id", str(agent_id))
        )
        if status:
            query = query.eq("status", status)

        result = (
            query
            .order("started_at", desc=True)
            .range(offset, offset + limit - 1)
            .execute()
        )
        return result.data or [], result.count or 0

    def list_open_public(self, limit: int = 20) -> list[dict]:
        """List all open public sessions (for Pulse status)."""
        result = (
            self.client.table("sessions")
            .select("id,short_id,agent_id,topic,domain,tools_used,started_at")
            .eq("status", "open")
            .eq("visibility", "public")
            .order("started_at", desc=True)
            .limit(limit)
            .execute()
        )
        return result.data or []

    def list_recent_public(self, limit: int = 50) -> list[dict]:
        """List recent public sessions (open + closed) for the Pulse feed."""
        result = (
            self.client.table("sessions")
            .select("id,short_id,agent_id,topic,domain,tools_used,status,outcome,started_at,closed_at")
            .eq("visibility", "public")
            .in_("status", ["open", "closed"])
            .order("started_at", desc=True)
            .limit(limit)
            .execute()
        )
        return result.data or []

    def list_recent_public_since(self, since: str, limit: int = 50) -> list[dict]:
        """List public sessions opened or closed since a given timestamp."""
        result = (
            self.client.table("sessions")
            .select("id,short_id,agent_id,topic,domain,tools_used,status,outcome,started_at,closed_at")
            .eq("visibility", "public")
            .in_("status", ["open", "closed"])
            .gte("started_at", since)
            .order("started_at", desc=True)
            .limit(limit)
            .execute()
        )
        return result.data or []

    def update(self, session_id: UUID, data: dict) -> dict:
        """Update a session."""
        result = (
            self.client.table("sessions")
            .update(data)
            .eq("id", str(session_id))
            .execute()
        )
        if not result.data:
            raise NotFoundError("Session", str(session_id))
        return result.data[0]

    def close(self, session_id: UUID, outcome: str | None = None) -> dict:
        """Close a session."""
        data: dict = {"status": "closed", "closed_at": "now()"}
        if outcome:
            data["outcome"] = outcome
        return self.update(session_id, data)

    def abandon(self, session_id: UUID) -> dict:
        """Mark a session as abandoned."""
        return self.update(session_id, {"status": "abandoned", "closed_at": "now()"})

    def match_by_topic(
        self,
        topic_embedding: list[float],
        match_count: int = 5,
        min_similarity: float = 0.6,
        exclude_agent_id: UUID | None = None,
    ) -> list[dict]:
        """Find active sessions with similar topics using the RPC function."""
        params: dict = {
            "query_embedding": topic_embedding,
            "match_count": match_count,
            "min_similarity": min_similarity,
        }
        if exclude_agent_id:
            params["exclude_agent_id"] = str(exclude_agent_id)

        result = self.client.rpc("match_sessions_by_topic", params).execute()
        return result.data or []

    # -----------------------------------------------------------------------
    # Session Entries
    # -----------------------------------------------------------------------

    def get_next_ordinal(self, session_id: UUID) -> int:
        """Get the next ordinal for a session entry."""
        result = (
            self.client.table("session_entries")
            .select("ordinal")
            .eq("session_id", str(session_id))
            .order("ordinal", desc=True)
            .limit(1)
            .execute()
        )
        if result.data:
            return result.data[0]["ordinal"] + 1
        return 1

    def create_entry(self, data: dict) -> dict:
        """Create a session entry."""
        result = self.client.table("session_entries").insert(data).execute()
        if not result.data:
            raise Exception("Failed to create session entry")
        return result.data[0]

    def list_entries(self, session_id: UUID) -> list[dict]:
        """List all entries for a session in order."""
        result = (
            self.client.table("session_entries")
            .select("*")
            .eq("session_id", str(session_id))
            .order("ordinal", desc=False)
            .execute()
        )
        return result.data or []

    def count_entries(self, session_id: UUID) -> int:
        """Count entries in a session."""
        result = (
            self.client.table("session_entries")
            .select("id", count="exact")
            .eq("session_id", str(session_id))
            .execute()
        )
        return result.count or 0

    # -----------------------------------------------------------------------
    # Contributions (Pulse)
    # -----------------------------------------------------------------------

    def create_contribution(self, data: dict) -> dict:
        """Create a contribution to a session."""
        result = self.client.table("session_contributions").insert(data).execute()
        if not result.data:
            raise Exception("Failed to create contribution")
        return result.data[0]

    def list_contributions(self, session_id: UUID) -> list[dict]:
        """List contributions for a session."""
        result = (
            self.client.table("session_contributions")
            .select("*")
            .eq("session_id", str(session_id))
            .order("created_at", desc=False)
            .execute()
        )
        return result.data or []

    def count_contributions_by_agent(
        self, session_id: UUID, agent_id: UUID
    ) -> int:
        """Count contributions from a specific agent to a session."""
        result = (
            self.client.table("session_contributions")
            .select("id", count="exact")
            .eq("session_id", str(session_id))
            .eq("contributor_agent_id", str(agent_id))
            .execute()
        )
        return result.count or 0
