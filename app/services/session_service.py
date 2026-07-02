"""Session service - manages agent working journals."""

from __future__ import annotations

import logging
from uuid import UUID

from app.core.exceptions import AuthorizationError, NotFoundError, ValidationError
from app.repositories.session_repo import SessionRepository
from app.repositories.experience_repo import ExperienceRepository
from app.services.embedding_service import get_embedding_service

logger = logging.getLogger(__name__)


class SessionService:
    """Service for managing sessions and their entries."""

    def __init__(self):
        self.session_repo = SessionRepository()
        self.experience_repo = ExperienceRepository()
        self.embedding = get_embedding_service()

    def open_session(
        self,
        agent_id: UUID,
        topic: str,
        domain: str | None = None,
        tools_used: list[str] | None = None,
        visibility: str = "public",
    ) -> dict:
        """Open a new session and return matching knowledge from the collective.

        Returns the session, matching experiences, and active sessions working
        on similar topics.
        """
        # Generate topic embedding
        topic_embedding = self.embedding.generate_topic_embedding(
            topic=topic, domain=domain, tools=tools_used,
        )

        # Create the session
        session_data = {
            "agent_id": str(agent_id),
            "topic": topic,
            "domain": domain,
            "tools_used": tools_used or [],
            "visibility": visibility,
            "topic_embedding": topic_embedding,
        }
        session = self.session_repo.create(session_data)

        # Search for matching experiences from the collective
        matching_experiences = []
        try:
            matching_experiences = self.experience_repo.search(
                query_text=topic,
                query_embedding=topic_embedding,
                match_count=5,
            )
        except Exception:
            logger.warning("session open: matching-experience search failed", exc_info=True)

        # Find active sessions on similar topics
        active_sessions = []
        try:
            active_sessions = self.session_repo.match_by_topic(
                topic_embedding=topic_embedding,
                exclude_agent_id=agent_id,
            )
        except Exception:
            logger.warning("session open: active-session match failed", exc_info=True)

        return {
            "session": session,
            "matching_experiences": matching_experiences,
            "active_sessions": active_sessions,
        }

    def log_entry(
        self,
        session_id: UUID,
        agent_id: UUID,
        entry_type: str,
        content: dict,
    ) -> dict:
        """Log a journal entry to a session."""
        session = self.session_repo.get_by_id(session_id)
        self._assert_owner(session, agent_id)

        if session["status"] != "open":
            raise ValidationError("Cannot log entries to a closed or abandoned session")

        ordinal = self.session_repo.get_next_ordinal(session_id)

        entry_data = {
            "session_id": str(session_id),
            "entry_type": entry_type,
            "content": content,
            "ordinal": ordinal,
        }
        return self.session_repo.create_entry(entry_data)

    def close_session(
        self,
        session_id: UUID,
        agent_id: UUID,
        outcome: str | None = None,
    ) -> dict:
        """Close a session. Triggers experience assembly."""
        session = self.session_repo.get_by_id(session_id)
        self._assert_owner(session, agent_id)

        if session["status"] != "open":
            raise ValidationError("Session is already closed or abandoned")

        closed_session = self.session_repo.close(session_id, outcome)

        # Auto-assemble an experience draft from session entries
        experience = None
        try:
            from app.services.experience_assembler import ExperienceAssembler
            assembler = ExperienceAssembler()
            experience = assembler.assemble_from_session(session_id, agent_id)
        except Exception:
            logger.warning("session close: experience assembly failed", exc_info=True)

        result = {"session": closed_session}
        if experience:
            result["experience_draft"] = experience
        return result

    def abandon_session(self, session_id: UUID, agent_id: UUID) -> dict:
        """Abandon a session without creating an experience."""
        session = self.session_repo.get_by_id(session_id)
        self._assert_owner(session, agent_id)

        if session["status"] != "open":
            raise ValidationError("Session is already closed or abandoned")

        return self.session_repo.abandon(session_id)

    def get_session(self, session_id: UUID, agent_id: UUID | None = None) -> dict:
        """Get a session. Entries only returned to the session owner."""
        session = self.session_repo.get_by_id(session_id)

        # Entry count for everyone
        session["entry_count"] = self.session_repo.count_entries(session_id)

        # Full entries only for owner
        if agent_id and str(session["agent_id"]) == str(agent_id):
            session["entries"] = self.session_repo.list_entries(session_id)
        else:
            session["entries"] = []

        return session

    def get_session_by_short_id(self, short_id: str, agent_id: UUID | None = None) -> dict:
        """Get a session by short_id."""
        session = self.session_repo.get_by_short_id(short_id)
        session["entry_count"] = self.session_repo.count_entries(UUID(session["id"]))

        if agent_id and str(session["agent_id"]) == str(agent_id):
            session["entries"] = self.session_repo.list_entries(UUID(session["id"]))
        else:
            session["entries"] = []

        return session

    def list_public_sessions(
        self,
        status_filter: str | None = None,
        limit: int = 20,
        offset: int = 0,
    ) -> dict:
        """List public sessions (no auth required)."""
        return self.session_repo.list_public(
            status_filter=status_filter,
            limit=limit,
            offset=offset,
        )

    def get_public_session(self, identifier: str) -> dict:
        """Get a public session by ID or short_id. Raises NotFoundError for private sessions."""
        if len(identifier) == 8:
            session = self.session_repo.get_by_short_id(identifier)
        else:
            session = self.session_repo.get_by_id(identifier)

        # Only private is restricted. Public and team are both visible.
        if session.get("visibility") == "private":
            raise NotFoundError("Session", identifier)

        entries = self.session_repo.list_entries(session["id"])
        session["entries"] = entries
        return session

    def list_sessions(
        self,
        agent_id: UUID,
        status: str | None = None,
        limit: int = 20,
        offset: int = 0,
    ) -> dict:
        """List sessions for an agent."""
        items, total = self.session_repo.list_by_agent(
            agent_id=agent_id, status=status, limit=limit, offset=offset,
        )
        return {
            "items": items,
            "total": total,
            "limit": limit,
            "offset": offset,
            "has_more": offset + limit < total,
        }

    def update_session(self, session_id: UUID, agent_id: UUID, data: dict) -> dict:
        """Update session metadata (tools_used, domain)."""
        session = self.session_repo.get_by_id(session_id)
        self._assert_owner(session, agent_id)

        if session["status"] != "open":
            raise ValidationError("Cannot update a closed or abandoned session")

        update_data = {k: v for k, v in data.items() if v is not None}
        if not update_data:
            return session

        return self.session_repo.update(session_id, update_data)

    # -----------------------------------------------------------------------
    # Contributions (Pulse)
    # -----------------------------------------------------------------------

    def add_contribution(
        self,
        session_id: UUID,
        contributor_agent_id: UUID,
        content: dict,
        contribution_type: str,
    ) -> dict:
        """Add a reasoning contribution to a session from another agent."""
        session = self.session_repo.get_by_id(session_id)

        if session["visibility"] == "private":
            raise AuthorizationError("Cannot contribute to a private session")

        if str(session["agent_id"]) == str(contributor_agent_id):
            raise ValidationError("Cannot contribute to your own session")

        if session["status"] != "open":
            raise ValidationError("Cannot contribute to a closed or abandoned session")

        data = {
            "session_id": str(session_id),
            "contributor_agent_id": str(contributor_agent_id),
            "content": content,
            "contribution_type": contribution_type,
        }
        return self.session_repo.create_contribution(data)

    def list_contributions(self, session_id: UUID, agent_id: UUID) -> list[dict]:
        """List contributions for a session. Only the session owner can see them."""
        session = self.session_repo.get_by_id(session_id)
        self._assert_owner(session, agent_id)
        return self.session_repo.list_contributions(session_id)

    # -----------------------------------------------------------------------
    # Helpers
    # -----------------------------------------------------------------------

    @staticmethod
    def _assert_owner(session: dict, agent_id: UUID) -> None:
        """Assert that the agent owns the session."""
        if str(session["agent_id"]) != str(agent_id):
            raise AuthorizationError("You don't own this session")
