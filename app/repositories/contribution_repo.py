"""Contribution repository for agent profile operations."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from uuid import UUID

from postgrest.exceptions import APIError

from app.db.supabase_client import get_supabase_client
from app.models.agent_profile import AgentEventType, IMPACT_WEIGHTS


class ContributionRepository:
    """Repository for agent contribution events and profile data."""

    def __init__(self):
        self.client = get_supabase_client()

    # =========================================================================
    # CONTRIBUTION EVENT OPERATIONS
    # =========================================================================

    def insert_event(
        self,
        agent_id: UUID,
        event_type: AgentEventType,
        blueprint_id: UUID | None = None,
        version_id: UUID | None = None,
        success: bool | None = None,
        cost_usd: float | None = None,
    ) -> dict | None:
        """Insert a contribution event.

        Returns the created event, or None if dedupe constraint violated.
        Uses explicit impact_weight based on event_type.
        """
        impact_weight = IMPACT_WEIGHTS.get(event_type, 1)

        data = {
            "agent_id": str(agent_id),
            "event_type": event_type.value,
            "impact_weight": impact_weight,
        }

        if blueprint_id:
            data["blueprint_id"] = str(blueprint_id)
        if version_id:
            data["version_id"] = str(version_id)
        if success is not None:
            data["success"] = success
        if cost_usd is not None:
            data["cost_usd"] = cost_usd

        try:
            result = (
                self.client.table("agent_contribution_events").insert(data).execute()
            )
            return result.data[0] if result.data else None
        except APIError as e:
            # Handle unique constraint violation (dedupe for execution_report)
            if "unique" in str(e).lower() or "duplicate" in str(e).lower():
                return None
            raise

    def get_events_by_agent(
        self,
        agent_id: UUID,
        limit: int = 100,
        offset: int = 0,
        event_type: AgentEventType | None = None,
    ) -> list[dict]:
        """Get contribution events for an agent."""
        query = (
            self.client.table("agent_contribution_events")
            .select("*")
            .eq("agent_id", str(agent_id))
            .order("created_at", desc=True)
        )

        if event_type:
            query = query.eq("event_type", event_type.value)

        result = query.range(offset, offset + limit - 1).execute()
        return result.data or []

    # =========================================================================
    # CONTRIBUTION GRAPH QUERIES
    # =========================================================================

    def get_contribution_points_by_day(
        self,
        agent_id: UUID,
        days: int = 365,
    ) -> dict[date, int]:
        """Get contribution points grouped by day.

        Returns a dict mapping date -> total points for that day.
        Only includes days with events (missing days should be filled with 0).
        """
        # Calculate the start date
        start_date = date.today() - timedelta(days=days - 1)

        # Query events within date range
        result = (
            self.client.table("agent_contribution_events")
            .select("event_day, impact_weight")
            .eq("agent_id", str(agent_id))
            .gte("event_day", start_date.isoformat())
            .execute()
        )

        # Aggregate points by day
        points_by_day: dict[date, int] = {}
        for row in result.data or []:
            event_day = (
                datetime.fromisoformat(row["event_day"]).date()
                if isinstance(row["event_day"], str)
                else row["event_day"]
            )
            points_by_day[event_day] = (
                points_by_day.get(event_day, 0) + row["impact_weight"]
            )

        return points_by_day

    def get_activity_points_30d(self, agent_id: UUID) -> int:
        """Get total activity points in the last 30 days."""
        start_date = date.today() - timedelta(days=29)

        result = (
            self.client.table("agent_contribution_events")
            .select("impact_weight")
            .eq("agent_id", str(agent_id))
            .gte("event_day", start_date.isoformat())
            .execute()
        )

        return sum(row["impact_weight"] for row in result.data or [])

    # =========================================================================
    # CONTRIBUTION STATS QUERIES
    # =========================================================================

    def get_blueprints_authored_count(self, agent_id: UUID) -> int:
        """Count blueprints authored by this agent."""
        result = (
            self.client.table("blueprints")
            .select("id", count="exact")
            .eq("created_by_agent_id", str(agent_id))
            .execute()
        )
        return result.count or 0

    def get_versions_authored_count(self, agent_id: UUID) -> int:
        """Count versions authored by this agent."""
        result = (
            self.client.table("blueprint_versions")
            .select("id", count="exact")
            .eq("created_by_agent_id", str(agent_id))
            .execute()
        )
        return result.count or 0

    # =========================================================================
    # IMPACT STATS QUERIES (from execution_reports for authored content)
    # =========================================================================

    def get_authored_version_ids(self, agent_id: UUID) -> list[str]:
        """Get all version IDs authored by this agent."""
        result = (
            self.client.table("blueprint_versions")
            .select("id")
            .eq("created_by_agent_id", str(agent_id))
            .execute()
        )
        return [row["id"] for row in result.data or []]

    def get_execution_stats_for_versions(
        self, version_ids: list[str]
    ) -> dict:
        """Get execution stats for a list of version IDs.

        Returns dict with total_runs, successful_runs, total_cost_usd.
        """
        if not version_ids:
            return {
                "total_runs": 0,
                "successful_runs": 0,
                "total_cost_usd": None,
            }

        # Get all execution reports for these versions
        result = (
            self.client.table("execution_reports")
            .select("success, cost_usd")
            .in_("version_id", version_ids)
            .execute()
        )

        reports = result.data or []
        total_runs = len(reports)
        successful_runs = sum(1 for r in reports if r["success"])
        total_cost = sum(
            r["cost_usd"] for r in reports if r["cost_usd"] is not None
        )

        return {
            "total_runs": total_runs,
            "successful_runs": successful_runs,
            "total_cost_usd": total_cost if total_cost > 0 else None,
        }

    def get_version_risk_stats(self, agent_id: UUID) -> dict:
        """Get risk score statistics for versions authored by agent.

        Returns dict with avg_risk_score, low_risk_share.
        """
        result = (
            self.client.table("blueprint_versions")
            .select("risk_score")
            .eq("created_by_agent_id", str(agent_id))
            .execute()
        )

        versions = result.data or []
        if not versions:
            return {"avg_risk_score": 0.0, "low_risk_share": 0.0}

        risk_scores = [v["risk_score"] for v in versions]
        avg_risk_score = sum(risk_scores) / len(risk_scores)
        low_risk_count = sum(1 for s in risk_scores if s <= 20)
        low_risk_share = low_risk_count / len(versions)

        return {
            "avg_risk_score": avg_risk_score,
            "low_risk_share": low_risk_share,
        }

    # =========================================================================
    # TOP BLUEPRINTS/VERSIONS QUERIES
    # =========================================================================

    def get_top_blueprints_by_impact(
        self, agent_id: UUID, limit: int = 5
    ) -> list[dict]:
        """Get top blueprints authored by agent, ranked by successful executions.

        Uses execution_reports joined to blueprints, NOT the events table.
        """
        # Get blueprints authored by agent with their current version titles
        blueprints_result = (
            self.client.table("blueprints")
            .select("id, slug, current_version_id")
            .eq("created_by_agent_id", str(agent_id))
            .execute()
        )

        if not blueprints_result.data:
            return []

        # For each blueprint, get execution stats and title
        top_blueprints = []
        for bp in blueprints_result.data:
            # Get title from current version
            version_result = (
                self.client.table("blueprint_versions")
                .select("title")
                .eq("id", bp["current_version_id"])
                .execute()
            )
            title = (
                version_result.data[0]["title"]
                if version_result.data
                else "Unknown"
            )

            # Get execution stats for this blueprint
            exec_result = (
                self.client.table("execution_reports")
                .select("success, cost_usd")
                .eq("blueprint_id", bp["id"])
                .execute()
            )

            reports = exec_result.data or []
            total_runs = len(reports)
            successful_runs = sum(1 for r in reports if r["success"])
            total_cost = sum(
                r["cost_usd"] for r in reports if r["cost_usd"] is not None
            )

            if total_runs > 0:
                top_blueprints.append({
                    "slug": bp["slug"],
                    "title": title,
                    "impact_score": successful_runs,
                    "total_runs": total_runs,
                    "success_rate": successful_runs / total_runs,
                    "total_cost_usd": total_cost if total_cost > 0 else None,
                })

        # Sort by impact_score and return top N
        top_blueprints.sort(key=lambda x: x["impact_score"], reverse=True)
        return top_blueprints[:limit]

    def get_top_versions_by_impact(
        self, agent_id: UUID, limit: int = 5
    ) -> list[dict]:
        """Get top versions authored by agent with trust metadata.

        Includes verification_tier and risk_score from blueprint_versions.
        """
        # Get versions authored by agent
        versions_result = (
            self.client.table("blueprint_versions")
            .select(
                "id, blueprint_id, version_number, title, "
                "verification_tier, risk_score"
            )
            .eq("created_by_agent_id", str(agent_id))
            .execute()
        )

        if not versions_result.data:
            return []

        # Get blueprint slugs
        blueprint_ids = list(set(v["blueprint_id"] for v in versions_result.data))
        blueprints_result = (
            self.client.table("blueprints")
            .select("id, slug")
            .in_("id", blueprint_ids)
            .execute()
        )
        slug_map = {bp["id"]: bp["slug"] for bp in blueprints_result.data or []}

        # For each version, get execution stats
        top_versions = []
        for v in versions_result.data:
            exec_result = (
                self.client.table("execution_reports")
                .select("success")
                .eq("version_id", v["id"])
                .execute()
            )

            reports = exec_result.data or []
            total_runs = len(reports)
            successful_runs = sum(1 for r in reports if r["success"])

            top_versions.append({
                "version_id": v["id"],
                "blueprint_slug": slug_map.get(v["blueprint_id"], "unknown"),
                "version_number": v["version_number"],
                "title": v["title"],
                "verification_tier": v["verification_tier"],
                "risk_score": v["risk_score"],
                "impact_score": successful_runs,
                "total_runs": total_runs,
                "success_rate": successful_runs / total_runs if total_runs > 0 else 0.0,
            })

        # Sort by impact_score and return top N
        top_versions.sort(key=lambda x: x["impact_score"], reverse=True)
        return top_versions[:limit]

    # =========================================================================
    # ACCOMPLISHMENT/BADGE QUERIES
    # =========================================================================

    def get_distinct_env_count(self, agent_id: UUID) -> int:
        """Count distinct environments that successfully ran agent's blueprints.

        Uses (os, runtime, runtime_version, arch) tuple for distinctness.
        Only counts successful runs with non-null env_fingerprint.
        """
        # Get version IDs authored by agent
        version_ids = self.get_authored_version_ids(agent_id)
        if not version_ids:
            return 0

        # Get successful execution reports with env_fingerprint
        result = (
            self.client.table("execution_reports")
            .select("env_fingerprint")
            .in_("version_id", version_ids)
            .eq("success", True)
            .not_.is_("env_fingerprint", "null")
            .execute()
        )

        # Count distinct (os, runtime, runtime_version, arch) tuples
        seen_envs = set()
        for row in result.data or []:
            fp = row.get("env_fingerprint")
            if fp:
                env_tuple = (
                    fp.get("os"),
                    fp.get("runtime"),
                    fp.get("runtime_version"),
                    fp.get("arch"),
                )
                seen_envs.add(env_tuple)

        return len(seen_envs)

    def get_low_risk_version_count(self, agent_id: UUID) -> int:
        """Count versions with risk_score <= 20."""
        result = (
            self.client.table("blueprint_versions")
            .select("id", count="exact")
            .eq("created_by_agent_id", str(agent_id))
            .lte("risk_score", 20)
            .execute()
        )
        return result.count or 0

    def has_org_verified_version(self, agent_id: UUID) -> bool:
        """Check if agent has any org_verified versions."""
        result = (
            self.client.table("blueprint_versions")
            .select("id")
            .eq("created_by_agent_id", str(agent_id))
            .eq("verification_tier", "org_verified")
            .limit(1)
            .execute()
        )
        return bool(result.data)

    # =========================================================================
    # AGENT QUERIES
    # =========================================================================

    def get_agent(self, agent_id: UUID) -> dict | None:
        """Get agent by ID."""
        result = (
            self.client.table("agents")
            .select("id, name, publisher_domain, created_at")
            .eq("id", str(agent_id))
            .execute()
        )
        return result.data[0] if result.data else None
