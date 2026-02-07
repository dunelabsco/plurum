"""Inbox repository for database operations."""

from __future__ import annotations

from typing import Optional

from app.db.supabase_client import get_supabase_client


class InboxRepository:
    """Repository for inbox event database operations."""

    def __init__(self):
        self.client = get_supabase_client()

    def create_event(
        self,
        target_agent_id: str,
        event_type: str,
        event_data: dict,
        source_session_id: Optional[str] = None,
        source_agent_id: Optional[str] = None,
    ) -> dict:
        """Create a targeted inbox event."""
        data = {
            "target_agent_id": target_agent_id,
            "event_type": event_type,
            "event_data": event_data,
        }
        if source_session_id:
            data["source_session_id"] = source_session_id
        if source_agent_id:
            data["source_agent_id"] = source_agent_id

        result = self.client.table("inbox_events").insert(data).execute()
        if not result.data:
            raise Exception("Failed to create inbox event")
        return result.data[0]

    def get_unread_events(
        self,
        agent_id: str,
        event_type: Optional[str] = None,
        limit: int = 20,
    ) -> list:
        """Get unread targeted events for an agent."""
        query = (
            self.client.table("inbox_events")
            .select("*")
            .eq("target_agent_id", agent_id)
            .eq("is_read", False)
        )
        if event_type:
            query = query.eq("event_type", event_type)

        result = (
            query
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        return result.data or []

    def count_unread(self, agent_id: str) -> int:
        """Count unread events for an agent."""
        result = (
            self.client.table("inbox_events")
            .select("id", count="exact")
            .eq("target_agent_id", agent_id)
            .eq("is_read", False)
            .execute()
        )
        return result.count or 0

    def mark_read(self, event_ids: list, agent_id: str) -> int:
        """Mark specific events as read. Returns count updated."""
        result = (
            self.client.table("inbox_events")
            .update({"is_read": True})
            .eq("target_agent_id", agent_id)
            .in_("id", event_ids)
            .execute()
        )
        return len(result.data) if result.data else 0

    def mark_all_read(self, agent_id: str) -> int:
        """Mark all events as read for an agent. Returns count updated."""
        result = (
            self.client.table("inbox_events")
            .update({"is_read": True})
            .eq("target_agent_id", agent_id)
            .eq("is_read", False)
            .execute()
        )
        return len(result.data) if result.data else 0
