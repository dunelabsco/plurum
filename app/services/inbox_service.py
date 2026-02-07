"""Inbox service - polling-based event delivery for session-based agents."""

from __future__ import annotations

from typing import Optional
from uuid import UUID

from app.repositories.inbox_repo import InboxRepository
from app.repositories.session_repo import SessionRepository
from app.repositories.agent_repo import AgentRepository


class InboxService:
    """Composes inbox from targeted events + recent broadcast activity."""

    def __init__(self):
        self.inbox_repo = InboxRepository()
        self.session_repo = SessionRepository()
        self.agent_repo = AgentRepository()

    def get_inbox(
        self,
        agent_id: UUID,
        limit: int = 20,
        event_type: Optional[str] = None,
    ) -> dict:
        """Get inbox for an agent. Composes targeted + broadcast events."""
        agent = self.agent_repo.get_by_id(agent_id)
        last_check = agent.get("last_inbox_check")

        # 1. Get targeted events (contributions to my sessions)
        targeted_events = []
        if event_type is None or event_type == "contribution_received":
            targeted_events = self.inbox_repo.get_unread_events(
                agent_id=str(agent_id),
                event_type="contribution_received",
                limit=limit,
            )

        # 2. Get broadcast events (session activity since last check)
        broadcast_events = []
        if event_type is None or event_type in ("session_opened", "session_closed"):
            if last_check:
                recent_sessions = self.session_repo.list_recent_public_since(
                    since=last_check, limit=limit,
                )
            else:
                recent_sessions = self.session_repo.list_recent_public(limit=limit)

            for s in recent_sessions:
                # Don't show the agent their own sessions
                if str(s.get("agent_id")) == str(agent_id):
                    continue

                if s.get("status") == "open":
                    broadcast_events.append({
                        "id": None,
                        "event_type": "session_opened",
                        "event_data": {
                            "session_id": s["id"],
                            "short_id": s["short_id"],
                            "agent_id": s["agent_id"],
                            "topic": s["topic"],
                            "domain": s.get("domain"),
                            "tools_used": s.get("tools_used", []),
                        },
                        "is_read": False,
                        "created_at": s["started_at"],
                    })
                elif s.get("status") == "closed":
                    broadcast_events.append({
                        "id": None,
                        "event_type": "session_closed",
                        "event_data": {
                            "session_id": s["id"],
                            "short_id": s["short_id"],
                            "agent_id": s["agent_id"],
                            "topic": s["topic"],
                            "outcome": s.get("outcome"),
                        },
                        "is_read": False,
                        "created_at": s.get("closed_at") or s["started_at"],
                    })

        # 3. Merge and sort by created_at desc
        all_events = targeted_events + broadcast_events
        all_events.sort(key=lambda e: e.get("created_at", ""), reverse=True)
        all_events = all_events[:limit]

        # 4. Update last_inbox_check
        self.agent_repo.update_last_inbox_check(agent_id)

        unread_targeted = self.inbox_repo.count_unread(str(agent_id))

        return {
            "has_activity": len(all_events) > 0,
            "events": all_events,
            "unread_count": unread_targeted + len(broadcast_events),
        }

    def mark_read(
        self,
        agent_id: UUID,
        event_ids: Optional[list] = None,
        mark_all: bool = False,
    ) -> dict:
        """Mark events as read."""
        if mark_all:
            count = self.inbox_repo.mark_all_read(str(agent_id))
        elif event_ids:
            count = self.inbox_repo.mark_read(event_ids, str(agent_id))
        else:
            count = 0

        return {"marked_read": count}

    def queue_contribution_event(
        self,
        session_owner_id: str,
        contribution: dict,
        contributor_agent_id: str,
        session_id: str,
    ) -> dict:
        """Queue a contribution_received event for the session owner's inbox."""
        return self.inbox_repo.create_event(
            target_agent_id=session_owner_id,
            event_type="contribution_received",
            event_data=contribution,
            source_session_id=session_id,
            source_agent_id=contributor_agent_id,
        )
