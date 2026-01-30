"""Profile service for agent profile computation."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from uuid import UUID

from app.repositories.contribution_repo import ContributionRepository
from app.core.exceptions import NotFoundError
from app.models.agent_profile import (
    AgentIdentity,
    AgentProfileResponse,
    ContributionStats,
    ImpactStats,
    ContributionDay,
    ProfileTopBlueprint,
    ProfileTopVersion,
    Accomplishment,
    BADGES,
)


def map_to_intensity(points: int) -> int:
    """Map contribution points to intensity level (0-4).

    Mapping:
    - 0 points: intensity 0 (no activity)
    - 1-2 points: intensity 1 (low)
    - 3-5 points: intensity 2 (medium)
    - 6-10 points: intensity 3 (high)
    - 11+ points: intensity 4 (very high)
    """
    if points == 0:
        return 0
    if points <= 2:
        return 1
    if points <= 5:
        return 2
    if points <= 10:
        return 3
    return 4


class ProfileService:
    """Service for computing agent profiles."""

    def __init__(self):
        self.repo = ContributionRepository()

    def get_profile(self, agent_id: UUID) -> AgentProfileResponse:
        """Get complete agent profile.

        Combines:
        - Agent identity
        - Contribution stats (own activity from events table)
        - Impact stats (adoption from execution_reports)
        - 365-day contribution graph
        - Top blueprints/versions by adoption
        - Earned accomplishments
        """
        # Get agent identity
        agent_data = self.repo.get_agent(agent_id)
        if not agent_data:
            raise NotFoundError("Agent", str(agent_id))

        agent = AgentIdentity(
            id=str(agent_data["id"]),
            name=agent_data["name"],
            publisher_domain=agent_data.get("publisher_domain"),
            created_at=agent_data["created_at"],
        )

        # Get contribution stats (own activity)
        contribution_stats = self._get_contribution_stats(agent_id)

        # Get impact stats (adoption of authored content)
        impact_stats = self._get_impact_stats(agent_id)

        # Get contribution graph (always 365 days)
        contribution_graph = self._get_contribution_graph(agent_id)

        # Get top blueprints by adoption
        top_blueprints = self._get_top_blueprints(agent_id)

        # Get top versions with trust metadata
        top_versions = self._get_top_versions(agent_id)

        # Get earned accomplishments
        accomplishments = self._get_accomplishments(
            agent_id, contribution_stats, impact_stats, agent_data
        )

        return AgentProfileResponse(
            agent=agent,
            contribution_stats=contribution_stats,
            impact_stats=impact_stats,
            contribution_graph=contribution_graph,
            top_blueprints=top_blueprints,
            top_versions=top_versions,
            accomplishments=accomplishments,
        )

    def _get_contribution_stats(self, agent_id: UUID) -> ContributionStats:
        """Get agent's own activity metrics from contribution events."""
        blueprints_authored = self.repo.get_blueprints_authored_count(agent_id)
        versions_authored = self.repo.get_versions_authored_count(agent_id)
        activity_points_30d = self.repo.get_activity_points_30d(agent_id)

        return ContributionStats(
            blueprints_authored=blueprints_authored,
            versions_authored=versions_authored,
            activity_points_30d=activity_points_30d,
        )

    def _get_impact_stats(self, agent_id: UUID) -> ImpactStats:
        """Get impact metrics from execution_reports for authored content."""
        # Get version IDs authored by this agent
        version_ids = self.repo.get_authored_version_ids(agent_id)

        # Get execution stats for those versions
        exec_stats = self.repo.get_execution_stats_for_versions(version_ids)

        # Get risk score stats
        risk_stats = self.repo.get_version_risk_stats(agent_id)

        total_runs = exec_stats["total_runs"]
        successful_runs = exec_stats["successful_runs"]
        success_rate = successful_runs / total_runs if total_runs > 0 else 0.0

        return ImpactStats(
            total_runs=total_runs,
            successful_runs=successful_runs,
            success_rate=success_rate,
            total_cost_usd=exec_stats["total_cost_usd"],
            avg_risk_score=risk_stats["avg_risk_score"],
            low_risk_share=risk_stats["low_risk_share"],
        )

    def _get_contribution_graph(self, agent_id: UUID) -> list[ContributionDay]:
        """Get 365-day contribution graph.

        Always returns exactly 365 days, filling missing days with zeros.
        """
        # Get contribution points by day
        points_by_day = self.repo.get_contribution_points_by_day(agent_id, days=365)

        # Build 365-day graph (oldest first)
        graph = []
        today = date.today()

        for i in range(365):
            day = today - timedelta(days=364 - i)
            points = points_by_day.get(day, 0)
            graph.append(
                ContributionDay(
                    date=day.isoformat(),
                    intensity=map_to_intensity(points),
                    points=points,
                )
            )

        return graph

    def _get_top_blueprints(
        self, agent_id: UUID, limit: int = 5
    ) -> list[ProfileTopBlueprint]:
        """Get top blueprints by adoption impact."""
        top_data = self.repo.get_top_blueprints_by_impact(agent_id, limit=limit)

        return [
            ProfileTopBlueprint(
                slug=bp["slug"],
                title=bp["title"],
                impact_score=bp["impact_score"],
                total_runs=bp["total_runs"],
                success_rate=bp["success_rate"],
                total_cost_usd=bp["total_cost_usd"],
            )
            for bp in top_data
        ]

    def _get_top_versions(
        self, agent_id: UUID, limit: int = 5
    ) -> list[ProfileTopVersion]:
        """Get top versions with trust metadata."""
        top_data = self.repo.get_top_versions_by_impact(agent_id, limit=limit)

        return [
            ProfileTopVersion(
                version_id=str(v["version_id"]),
                blueprint_slug=v["blueprint_slug"],
                version_number=v["version_number"],
                title=v["title"],
                verification_tier=v["verification_tier"],
                risk_score=v["risk_score"],
                impact_score=v["impact_score"],
                total_runs=v["total_runs"],
                success_rate=v["success_rate"],
            )
            for v in top_data
        ]

    def _get_accomplishments(
        self,
        agent_id: UUID,
        contribution_stats: ContributionStats,
        impact_stats: ImpactStats,
        agent_data: dict,
    ) -> list[Accomplishment]:
        """Get earned accomplishments/badges."""
        # Build stats dict for badge checks
        distinct_env_count = self.repo.get_distinct_env_count(agent_id)
        low_risk_versions = self.repo.get_low_risk_version_count(agent_id)
        has_org_verified = self.repo.has_org_verified_version(agent_id)

        stats = {
            "blueprints_authored": contribution_stats.blueprints_authored,
            "versions_authored": contribution_stats.versions_authored,
            "successful_runs": impact_stats.successful_runs,
            "distinct_env_count": distinct_env_count,
            "low_risk_versions": low_risk_versions,
            "has_publisher_domain": bool(agent_data.get("publisher_domain")),
            "has_org_verified_version": has_org_verified,
        }

        # Check each badge
        accomplishments = []
        agent_created_at = agent_data["created_at"]
        if isinstance(agent_created_at, str):
            agent_created_at = datetime.fromisoformat(
                agent_created_at.replace("Z", "+00:00")
            )

        for badge_id, badge_info in BADGES.items():
            earned = self._check_badge(badge_id, stats)
            if earned:
                # Use agent created_at as earned_at (simplified)
                # In a real implementation, we'd track when threshold was crossed
                accomplishments.append(
                    Accomplishment(
                        id=badge_id,
                        title=badge_info["title"],
                        description=badge_info["description"],
                        earned_at=agent_created_at,
                    )
                )

        return accomplishments

    def _check_badge(self, badge_id: str, stats: dict) -> bool:
        """Check if a badge is earned.

        Uses .get() with defaults to handle partial stats dicts in tests.
        """
        checks = {
            "first_publish": stats.get("blueprints_authored", 0) >= 1,
            "hundred_successful_runs": stats.get("successful_runs", 0) >= 100,
            "reproducible": stats.get("distinct_env_count", 0) >= 10,
            "low_risk_maintainer": stats.get("low_risk_versions", 0) >= 10,
            "org_verified_publisher": (
                stats.get("has_publisher_domain", False)
                or stats.get("has_org_verified_version", False)
            ),
        }
        return checks.get(badge_id, False)
