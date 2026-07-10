"""Experience assembler - builds experience drafts from session entries."""

from __future__ import annotations

from uuid import UUID

from app.core.content_security import reject_api_keys
from app.repositories.session_repo import SessionRepository
from app.repositories.experience_repo import ExperienceRepository
from app.services.embedding_service import get_embedding_service


class ExperienceAssembler:
    """Assembles structured experience drafts from session journal entries."""

    def __init__(self):
        self.session_repo = SessionRepository()
        self.experience_repo = ExperienceRepository()
        self.embedding = get_embedding_service()

    def assemble_from_session(self, session_id: UUID, agent_id: UUID) -> dict:
        """Read session entries and build an experience draft.

        Categorizes entries by type and structures them into the experience
        format (dead_ends, breakthroughs, gotchas, artifacts, context).
        """
        session = self.session_repo.get_by_id(session_id)
        entries = self.session_repo.list_entries(session_id)

        if not entries:
            return {}

        # Categorize entries by type
        dead_ends = []
        breakthroughs = []
        gotchas = []
        artifacts = []
        context_parts = []
        attempts = []

        for entry in entries:
            entry_type = entry["entry_type"]
            content = entry["content"]

            if entry_type == "dead_end":
                dead_ends.append({
                    "what": content.get("what", ""),
                    "why": content.get("why", ""),
                })
                # Also populate attempts (unified format)
                attempts.append({
                    "action": content.get("what", ""),
                    "outcome": content.get("why", ""),
                    "dead_end": True,
                    "insight": content.get("why", ""),
                })
            elif entry_type == "breakthrough":
                breakthroughs.append({
                    "insight": content.get("insight", ""),
                    "detail": content.get("detail", ""),
                    "importance": content.get("importance", "medium"),
                })
                # Also populate attempts (unified format)
                attempts.append({
                    "action": content.get("insight", ""),
                    "outcome": content.get("detail", ""),
                    "dead_end": False,
                    "insight": content.get("detail", ""),
                })
            elif entry_type == "gotcha":
                gotchas.append({
                    "warning": content.get("warning", ""),
                    "context": content.get("context"),
                })
            elif entry_type == "artifact":
                artifacts.append({
                    "language": content.get("language", ""),
                    "code": content.get("code", ""),
                    "description": content.get("description"),
                })
            elif entry_type in ("update", "note"):
                text = content.get("text", "")
                if text:
                    context_parts.append(text)

        context = "\n\n".join(context_parts) if context_parts else None

        # Assemble and validate all user-controlled content before it reaches
        # the embedding provider or database.
        experience_data = {
            "session_id": str(session_id),
            "agent_id": str(agent_id),
            "goal": session["topic"],
            "domain": session.get("domain"),
            "tools_used": session.get("tools_used", []),
            "dead_ends": dead_ends,
            "breakthroughs": breakthroughs,
            "gotchas": gotchas,
            "context": context,
            "artifacts": artifacts,
            "status": "published" if session.get("visibility") == "public" else "draft",
            "visibility": session.get("visibility", "public"),
            "outcome": session.get("outcome"),
            # Auto-assembled attempts from session entries
            "attempts_json": attempts,
        }

        reject_api_keys(experience_data)

        experience_data["reasoning_embedding"] = (
            self.embedding.generate_reasoning_embedding(
                goal=session["topic"],
                dead_ends=dead_ends or None,
                breakthroughs=breakthroughs or None,
                gotchas=gotchas or None,
                context=context,
                attempts=attempts or None,
            )
        )

        return self.experience_repo.create(experience_data)
