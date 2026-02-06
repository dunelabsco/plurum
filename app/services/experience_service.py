"""Experience service - manages collective knowledge."""

from __future__ import annotations

from uuid import UUID

from app.core.exceptions import AuthorizationError, ValidationError
from app.repositories.experience_repo import ExperienceRepository
from app.services.embedding_service import get_embedding_service


class ExperienceService:
    """Service for managing experiences - the collective's distilled knowledge."""

    def __init__(self):
        self.repo = ExperienceRepository()
        self.embedding = get_embedding_service()

    def create(self, agent_id: UUID, data: dict) -> dict:
        """Create a new experience manually (not from a session)."""
        # Generate reasoning embedding from the experience content
        reasoning_embedding = self.embedding.generate_reasoning_embedding(
            goal=data["goal"],
            dead_ends=[d for d in data.get("dead_ends", [])],
            breakthroughs=[b for b in data.get("breakthroughs", [])],
            gotchas=[g for g in data.get("gotchas", [])],
            context=data.get("context"),
        )

        experience_data = {
            "agent_id": str(agent_id),
            "goal": data["goal"],
            "domain": data.get("domain"),
            "tools_used": data.get("tools_used", []),
            "dead_ends": data.get("dead_ends", []),
            "breakthroughs": data.get("breakthroughs", []),
            "gotchas": data.get("gotchas", []),
            "context": data.get("context"),
            "artifacts": data.get("artifacts", []),
            "status": "draft",
            "visibility": data.get("visibility", "public"),
            "outcome": data.get("outcome"),
            "reasoning_embedding": reasoning_embedding,
        }

        return self.repo.create(experience_data)

    def get(self, identifier: str) -> dict:
        """Get an experience by UUID or short_id."""
        return self.repo.get_by_identifier(identifier)

    def search(
        self,
        query: str,
        domain: str | None = None,
        tools: list[str] | None = None,
        min_quality: float = 0.0,
        limit: int = 10,
    ) -> dict:
        """Search experiences using hybrid vector+keyword search."""
        # Generate query embedding
        query_embedding = self.embedding.generate_topic_embedding(
            topic=query, domain=domain, tools=tools,
        )

        results = self.repo.search(
            query_text=query,
            query_embedding=query_embedding,
            match_count=limit,
            min_quality=min_quality,
            domain=domain,
        )

        return {
            "query": query,
            "results": results,
            "total_found": len(results),
        }

    def acquire(self, identifier: str, mode: str = "full") -> dict:
        """Acquire an experience in a specific compression format.

        Modes:
        - summary: One paragraph distillation
        - checklist: Do/don't/watch bullet lists
        - decision_tree: If/then structure
        - full: Complete reasoning dump
        """
        experience = self.repo.get_by_identifier(identifier)

        content = self._compress(experience, mode)

        return {
            "experience_id": experience["id"],
            "short_id": experience["short_id"],
            "mode": mode,
            "content": content,
        }

    def publish(self, identifier: str, agent_id: UUID) -> dict:
        """Publish a draft experience to the collective."""
        experience = self.repo.get_by_identifier(identifier)
        self._assert_owner(experience, agent_id)

        if experience["status"] != "draft":
            raise ValidationError(
                f"Can only publish draft experiences, current status: {experience['status']}"
            )

        return self.repo.update(UUID(experience["id"]), {"status": "published"})

    def report_outcome(
        self,
        identifier: str,
        agent_id: UUID,
        success: bool,
        execution_time_ms: int | None = None,
        error_message: str | None = None,
        context_notes: str | None = None,
        env_fingerprint: dict | None = None,
    ) -> dict:
        """Report the outcome of applying an experience."""
        experience = self.repo.get_by_identifier(identifier)

        # Check if agent already reported
        existing = self.repo.get_outcome_report(UUID(experience["id"]), agent_id)
        if existing:
            raise ValidationError("You have already reported an outcome for this experience")

        report_data = {
            "experience_id": experience["id"],
            "agent_id": str(agent_id),
            "success": success,
        }
        if execution_time_ms is not None:
            report_data["execution_time_ms"] = execution_time_ms
        if error_message:
            report_data["error_message"] = error_message
        if context_notes:
            report_data["context_notes"] = context_notes
        if env_fingerprint:
            report_data["env_fingerprint"] = env_fingerprint

        report = self.repo.create_outcome_report(report_data)

        # Recalculate quality score (triggers auto-update metrics via DB trigger)
        self.repo.update_quality_score(UUID(experience["id"]))

        return report

    def vote(self, identifier: str, agent_id: UUID, vote_type: str) -> dict:
        """Vote on an experience."""
        experience = self.repo.get_by_identifier(identifier)

        result = self.repo.upsert_vote(UUID(experience["id"]), agent_id, vote_type)

        # Recalculate quality score
        self.repo.update_quality_score(UUID(experience["id"]))

        return result

    def list_experiences(
        self,
        status: str | None = None,
        domain: str | None = None,
        agent_id: UUID | None = None,
        limit: int = 20,
        offset: int = 0,
        include_archived: bool = False,
    ) -> dict:
        """List experiences with filters."""
        items, total = self.repo.list_experiences(
            status=status,
            domain=domain,
            agent_id=agent_id,
            limit=limit,
            offset=offset,
            include_archived=include_archived,
        )
        return {
            "items": items,
            "total": total,
            "limit": limit,
            "offset": offset,
            "has_more": offset + limit < total,
        }

    def find_similar(
        self,
        identifier: str,
        limit: int = 5,
    ) -> list[dict]:
        """Find experiences similar to a given one."""
        experience = self.repo.get_by_identifier(identifier)
        if not experience.get("reasoning_embedding"):
            return []

        return self.repo.find_similar(
            embedding=experience["reasoning_embedding"],
            match_count=limit,
            exclude_id=UUID(experience["id"]),
        )

    # -----------------------------------------------------------------------
    # Compression modes
    # -----------------------------------------------------------------------

    def _compress(self, experience: dict, mode: str) -> dict:
        """Compress an experience into the requested format."""
        if mode == "summary":
            return self._compress_summary(experience)
        elif mode == "checklist":
            return self._compress_checklist(experience)
        elif mode == "decision_tree":
            return self._compress_decision_tree(experience)
        else:  # full
            return self._compress_full(experience)

    def _compress_summary(self, exp: dict) -> dict:
        """One-paragraph distillation."""
        parts = [f"Goal: {exp['goal']}."]

        breakthroughs = exp.get("breakthroughs") or []
        if breakthroughs:
            top = breakthroughs[0]
            parts.append(f"Key insight: {top.get('insight', '')}.")

        gotchas = exp.get("gotchas") or []
        if gotchas:
            top = gotchas[0]
            parts.append(f"Watch out: {top.get('warning', '')}.")

        if exp.get("total_reports", 0) > 0:
            rate = exp.get("success_rate", 0)
            parts.append(f"Success rate: {rate:.0%} ({exp['total_reports']} reports).")

        outcome = exp.get("outcome")
        if outcome:
            parts.append(f"Outcome: {outcome}.")

        return {"summary": " ".join(parts)}

    def _compress_checklist(self, exp: dict) -> dict:
        """Do/don't/watch bullet lists."""
        do_list = []
        for b in (exp.get("breakthroughs") or []):
            do_list.append(f"{b.get('insight', '')}: {b.get('detail', '')}")

        dont_list = []
        for d in (exp.get("dead_ends") or []):
            dont_list.append(f"{d.get('what', '')} - {d.get('why', '')}")

        watch_list = []
        for g in (exp.get("gotchas") or []):
            watch_list.append(g.get("warning", ""))

        return {
            "do": do_list,
            "dont": dont_list,
            "watch": watch_list,
        }

    def _compress_decision_tree(self, exp: dict) -> dict:
        """If/then structure from breakthroughs and dead ends."""
        decisions = []

        for b in (exp.get("breakthroughs") or []):
            decisions.append({
                "condition": f"If working on: {exp['goal']}",
                "action": b.get("insight", ""),
                "detail": b.get("detail", ""),
                "type": "do",
            })

        for d in (exp.get("dead_ends") or []):
            decisions.append({
                "condition": f"If considering: {d.get('what', '')}",
                "action": "Avoid this approach",
                "detail": d.get("why", ""),
                "type": "avoid",
            })

        for g in (exp.get("gotchas") or []):
            decisions.append({
                "condition": g.get("context") or f"When: {exp['goal']}",
                "action": f"Watch out: {g.get('warning', '')}",
                "detail": "",
                "type": "warning",
            })

        return {"decisions": decisions}

    def _compress_full(self, exp: dict) -> dict:
        """Complete reasoning dump."""
        return {
            "goal": exp["goal"],
            "domain": exp.get("domain"),
            "tools_used": exp.get("tools_used", []),
            "outcome": exp.get("outcome"),
            "dead_ends": exp.get("dead_ends", []),
            "breakthroughs": exp.get("breakthroughs", []),
            "gotchas": exp.get("gotchas", []),
            "context": exp.get("context"),
            "artifacts": exp.get("artifacts", []),
            "success_rate": exp.get("success_rate", 0),
            "total_reports": exp.get("total_reports", 0),
            "quality_score": exp.get("quality_score", 0),
        }

    # -----------------------------------------------------------------------
    # Helpers
    # -----------------------------------------------------------------------

    @staticmethod
    def _assert_owner(experience: dict, agent_id: UUID) -> None:
        """Assert that the agent owns the experience."""
        if str(experience["agent_id"]) != str(agent_id):
            raise AuthorizationError("You don't own this experience")
