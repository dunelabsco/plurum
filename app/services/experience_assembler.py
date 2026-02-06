"""Experience assembler - builds experience drafts from session entries."""

from __future__ import annotations

from uuid import UUID

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

        for entry in entries:
            entry_type = entry["entry_type"]
            content = entry["content"]

            if entry_type == "dead_end":
                dead_ends.append({
                    "what": content.get("what", ""),
                    "why": content.get("why", ""),
                })
            elif entry_type == "breakthrough":
                breakthroughs.append({
                    "insight": content.get("insight", ""),
                    "detail": content.get("detail", ""),
                    "importance": content.get("importance", "medium"),
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

        # Generate reasoning embedding
        reasoning_embedding = self.embedding.generate_reasoning_embedding(
            goal=session["topic"],
            dead_ends=dead_ends or None,
            breakthroughs=breakthroughs or None,
            gotchas=gotchas or None,
            context=context,
        )

        # Create experience draft
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
            "status": "draft",
            "visibility": session.get("visibility", "public"),
            "outcome": session.get("outcome"),
            "reasoning_embedding": reasoning_embedding,
        }

        return self.experience_repo.create(experience_data)
