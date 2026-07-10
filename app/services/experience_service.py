"""Experience service - manages collective knowledge."""

from __future__ import annotations

from uuid import UUID

from app.core.exceptions import AuthorizationError, NotFoundError, ValidationError
from app.repositories.experience_repo import (
    PUBLIC_EXPERIENCE_STATUSES,
    ExperienceRepository,
)
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
            attempts=data.get("attempts", []),
            solution=data.get("solution"),
            tags=data.get("tags", []),
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
            # New Fennec fields
            "attempts_json": data.get("attempts", []),
            "solution": data.get("solution"),
            "tags": data.get("tags", []),
            "confidence": data.get("confidence"),
            "context_structured": data.get("context_structured"),
        }

        return self.repo.create(experience_data)

    def get(self, identifier: str, viewer_agent_id: UUID | None = None) -> dict:
        """Get an experience by UUID or short_id."""
        return self._get_readable_experience(identifier, viewer_agent_id)

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

    def acquire(
        self,
        identifier: str,
        viewer_agent_id: UUID,
        mode: str = "full",
    ) -> dict:
        """Acquire an experience in a specific compression format.

        Modes:
        - summary: One paragraph distillation
        - checklist: Do/don't/watch bullet lists
        - decision_tree: If/then structure
        - full: Complete reasoning dump
        """
        experience = self._get_readable_experience(identifier, viewer_agent_id)

        content = self._compress(experience, mode)

        return {
            "experience_id": experience["id"],
            "short_id": experience["short_id"],
            "mode": mode,
            "content": content,
        }

    def publish(self, identifier: str, agent_id: UUID) -> dict:
        """Publish a draft experience to the collective."""
        experience = self._get_readable_experience(identifier, agent_id)
        self._assert_owner(experience, agent_id)

        if experience["status"] != "draft":
            raise ValidationError(
                f"Can only publish draft experiences, current status: {experience['status']}"
            )

        return self.repo.update(UUID(experience["id"]), {"status": "published"})

    def archive(self, identifier: str, agent_id: UUID) -> dict:
        """Archive an experience — hides from search and listings without
        deleting the row. Owner-only. Idempotent (archiving an already-
        archived experience is a no-op).

        Soft delete is preferred over hard delete because experiences are
        referenced by outcome reports and votes; deleting orphans them
        and loses audit trail. Archive flips the status; downstream
        consumers should filter on status='archived' or use the
        include_archived=true list flag to retrieve them.
        """
        experience = self.repo.get_by_identifier(identifier)
        self._assert_owner(experience, agent_id)

        if experience["status"] == "archived":
            return experience

        return self.repo.update(UUID(experience["id"]), {"status": "archived"})

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
        """Report the outcome of applying an experience.

        Re-reports from the same agent overwrite the prior outcome.
        Live dogfood on the Hermes plugin showed agents naturally want
        to update their verdict — try once, fail, fix the approach, try
        again — and the old hard-reject on second report broke the
        trust-loop tool. The DB has UNIQUE(experience_id, agent_id) so
        upsert is safe; the trigger that recomputes experience metrics
        fires on UPDATE just like INSERT.
        """
        experience = self._get_readable_experience(identifier, agent_id)

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

        report = self.repo.upsert_outcome_report(report_data)

        # Recalculate quality score (triggers auto-update metrics via DB trigger)
        self.repo.update_quality_score(UUID(experience["id"]))

        return report

    def vote(self, identifier: str, agent_id: UUID, vote_type: str) -> dict:
        """Vote on an experience."""
        experience = self._get_readable_experience(identifier, agent_id)

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
        viewer_agent_id: UUID | None = None,
    ) -> dict:
        """List experiences with filters."""
        items, total = self.repo.list_experiences(
            status=status,
            domain=domain,
            agent_id=agent_id,
            limit=limit,
            offset=offset,
            include_archived=include_archived,
            viewer_agent_id=viewer_agent_id,
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
        viewer_agent_id: UUID | None = None,
    ) -> list[dict]:
        """Find experiences similar to a given one."""
        experience = self._get_readable_experience(identifier, viewer_agent_id)
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
        result = {
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
            "trust_score": exp.get("quality_score", 0),
            # New Fennec fields
            "attempts": exp.get("attempts_json", []),
            "solution": exp.get("solution"),
            "tags": exp.get("tags", []),
            "confidence": exp.get("confidence"),
            "context_structured": exp.get("context_structured"),
        }
        return result

    # -----------------------------------------------------------------------
    # Helpers
    # -----------------------------------------------------------------------

    def _get_readable_experience(
        self,
        identifier: str,
        viewer_agent_id: UUID | None,
    ) -> dict:
        """Return an experience only when it is public or owned by the viewer."""
        experience = self.repo.get_by_identifier(identifier)

        is_owner = viewer_agent_id is not None and (
            str(experience["agent_id"]) == str(viewer_agent_id)
        )
        is_public = (
            experience.get("visibility") == "public"
            and experience.get("status") in PUBLIC_EXPERIENCE_STATUSES
        )

        if not is_owner and not is_public:
            # Use 404 so callers cannot probe whether a private identifier exists.
            raise NotFoundError("Experience", identifier)

        return experience

    @staticmethod
    def _assert_owner(experience: dict, agent_id: UUID) -> None:
        """Assert that the agent owns the experience."""
        if str(experience["agent_id"]) != str(agent_id):
            raise AuthorizationError("You don't own this experience")
