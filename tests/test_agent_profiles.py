"""Tests for agent profiles functionality."""

from datetime import date, datetime, timedelta
from unittest.mock import MagicMock, patch
from uuid import UUID

import pytest

from app.models.agent_profile import (
    AgentEventType,
    AgentIdentity,
    AgentProfileResponse,
    ContributionDay,
    ContributionStats,
    ImpactStats,
    IMPACT_WEIGHTS,
)
from app.repositories.contribution_repo import ContributionRepository
from app.services.profile_service import ProfileService, map_to_intensity


# ============================================================================
# Intensity Mapping Tests
# ============================================================================


class TestIntensityMapping:
    """Tests for contribution graph intensity mapping."""

    def test_zero_points_returns_zero_intensity(self):
        """0 points should return intensity 0 (no activity)."""
        assert map_to_intensity(0) == 0

    def test_low_points_returns_intensity_1(self):
        """1-2 points should return intensity 1 (low)."""
        assert map_to_intensity(1) == 1
        assert map_to_intensity(2) == 1

    def test_medium_points_returns_intensity_2(self):
        """3-5 points should return intensity 2 (medium)."""
        assert map_to_intensity(3) == 2
        assert map_to_intensity(4) == 2
        assert map_to_intensity(5) == 2

    def test_high_points_returns_intensity_3(self):
        """6-10 points should return intensity 3 (high)."""
        assert map_to_intensity(6) == 3
        assert map_to_intensity(10) == 3

    def test_very_high_points_returns_intensity_4(self):
        """11+ points should return intensity 4 (very high)."""
        assert map_to_intensity(11) == 4
        assert map_to_intensity(100) == 4


# ============================================================================
# Impact Weights Tests
# ============================================================================


class TestImpactWeights:
    """Tests for event impact weights."""

    def test_publish_blueprint_weight(self):
        """publish_blueprint should have weight 5."""
        assert IMPACT_WEIGHTS[AgentEventType.PUBLISH_BLUEPRINT] == 5

    def test_publish_version_weight(self):
        """publish_version should have weight 3."""
        assert IMPACT_WEIGHTS[AgentEventType.PUBLISH_VERSION] == 3

    def test_execution_report_weight(self):
        """execution_report should have weight 1."""
        assert IMPACT_WEIGHTS[AgentEventType.EXECUTION_REPORT] == 1

    def test_verification_upgrade_weight(self):
        """verification_upgrade should have weight 10."""
        assert IMPACT_WEIGHTS[AgentEventType.VERIFICATION_UPGRADE] == 10

    def test_metadata_edit_weight(self):
        """metadata_edit should have weight 1."""
        assert IMPACT_WEIGHTS[AgentEventType.METADATA_EDIT] == 1


# ============================================================================
# Contribution Repository Tests
# ============================================================================


class TestContributionRepository:
    """Tests for contribution event repository."""

    @pytest.fixture
    def mock_supabase_client(self):
        """Create mock Supabase client."""
        with patch("app.repositories.contribution_repo.get_supabase_client") as mock:
            client = MagicMock()
            mock.return_value = client
            yield client

    @pytest.fixture
    def repo(self, mock_supabase_client):
        """Create repository with mocked client."""
        return ContributionRepository()

    def test_insert_event_sets_correct_weight(self, repo, mock_supabase_client):
        """Event insertion should use weight from IMPACT_WEIGHTS."""
        agent_id = UUID("00000000-0000-0000-0000-000000000001")
        blueprint_id = UUID("00000000-0000-0000-0000-000000000002")
        version_id = UUID("00000000-0000-0000-0000-000000000003")

        mock_supabase_client.table.return_value.insert.return_value.execute.return_value = MagicMock(
            data=[{"id": "event-id"}]
        )

        # Insert publish_blueprint event
        repo.insert_event(
            agent_id=agent_id,
            event_type=AgentEventType.PUBLISH_BLUEPRINT,
            blueprint_id=blueprint_id,
            version_id=version_id,
        )

        # Verify weight was set correctly
        insert_call = mock_supabase_client.table.return_value.insert.call_args
        inserted_data = insert_call[0][0]
        assert inserted_data["impact_weight"] == 5  # publish_blueprint weight

    def test_insert_event_returns_none_on_dedupe_violation(
        self, repo, mock_supabase_client
    ):
        """Insert should return None when dedupe constraint is violated."""
        from postgrest.exceptions import APIError

        agent_id = UUID("00000000-0000-0000-0000-000000000001")
        version_id = UUID("00000000-0000-0000-0000-000000000003")

        mock_supabase_client.table.return_value.insert.return_value.execute.side_effect = APIError(
            {"message": "duplicate key value violates unique constraint"}
        )

        result = repo.insert_event(
            agent_id=agent_id,
            event_type=AgentEventType.EXECUTION_REPORT,
            version_id=version_id,
            success=True,
        )

        assert result is None

    def test_get_contribution_points_aggregates_by_day(
        self, repo, mock_supabase_client
    ):
        """Points should be aggregated by event_day."""
        agent_id = UUID("00000000-0000-0000-0000-000000000001")
        today = date.today()

        mock_supabase_client.table.return_value.select.return_value.eq.return_value.gte.return_value.execute.return_value = MagicMock(
            data=[
                {"event_day": today.isoformat(), "impact_weight": 5},
                {"event_day": today.isoformat(), "impact_weight": 3},
            ]
        )

        result = repo.get_contribution_points_by_day(agent_id, days=365)

        # Both events on same day should be summed
        assert result.get(today, 0) == 8


# ============================================================================
# Profile Service Tests
# ============================================================================


class TestProfileService:
    """Tests for profile computation service."""

    @pytest.fixture
    def mock_contribution_repo(self):
        """Create mock contribution repository."""
        with patch(
            "app.services.profile_service.ContributionRepository"
        ) as mock_class:
            mock_repo = MagicMock()
            mock_class.return_value = mock_repo
            yield mock_repo

    @pytest.fixture
    def service(self, mock_contribution_repo):
        """Create service with mocked repository."""
        return ProfileService()

    def test_contribution_graph_always_returns_365_days(
        self, service, mock_contribution_repo
    ):
        """Graph should always have exactly 365 entries, even with no events."""
        agent_id = UUID("00000000-0000-0000-0000-000000000001")

        # Mock empty events
        mock_contribution_repo.get_contribution_points_by_day.return_value = {}

        graph = service._get_contribution_graph(agent_id)

        assert len(graph) == 365

    def test_contribution_graph_fills_missing_days_with_zeros(
        self, service, mock_contribution_repo
    ):
        """Days with no events should have intensity=0, points=0."""
        agent_id = UUID("00000000-0000-0000-0000-000000000001")
        today = date.today()

        # Mock only one day with events
        mock_contribution_repo.get_contribution_points_by_day.return_value = {
            today: 5
        }

        graph = service._get_contribution_graph(agent_id)

        # Today should have points
        assert graph[-1].points == 5
        assert graph[-1].intensity == 2

        # Yesterday should be zero
        assert graph[-2].points == 0
        assert graph[-2].intensity == 0

    def test_contribution_stats_vs_impact_stats_separation(
        self, service, mock_contribution_repo
    ):
        """contribution_stats and impact_stats should come from different sources."""
        agent_id = UUID("00000000-0000-0000-0000-000000000001")

        # Set up contribution stats (from events/blueprints tables)
        mock_contribution_repo.get_blueprints_authored_count.return_value = 10
        mock_contribution_repo.get_versions_authored_count.return_value = 25
        mock_contribution_repo.get_activity_points_30d.return_value = 50

        # Set up impact stats (from execution_reports)
        mock_contribution_repo.get_authored_version_ids.return_value = ["v1", "v2"]
        mock_contribution_repo.get_execution_stats_for_versions.return_value = {
            "total_runs": 100,
            "successful_runs": 85,
            "total_cost_usd": 45.50,
        }
        mock_contribution_repo.get_version_risk_stats.return_value = {
            "avg_risk_score": 25.0,
            "low_risk_share": 0.6,
        }

        contribution_stats = service._get_contribution_stats(agent_id)
        impact_stats = service._get_impact_stats(agent_id)

        # Verify separation
        assert contribution_stats.blueprints_authored == 10
        assert contribution_stats.versions_authored == 25
        assert contribution_stats.activity_points_30d == 50

        assert impact_stats.total_runs == 100
        assert impact_stats.successful_runs == 85
        assert impact_stats.success_rate == 0.85
        assert impact_stats.total_cost_usd == 45.50

    def test_impact_stats_from_execution_reports(
        self, service, mock_contribution_repo
    ):
        """Impact stats should be computed from execution_reports."""
        agent_id = UUID("00000000-0000-0000-0000-000000000001")

        mock_contribution_repo.get_authored_version_ids.return_value = ["v1"]
        mock_contribution_repo.get_execution_stats_for_versions.return_value = {
            "total_runs": 200,
            "successful_runs": 180,
            "total_cost_usd": 100.0,
        }
        mock_contribution_repo.get_version_risk_stats.return_value = {
            "avg_risk_score": 15.0,
            "low_risk_share": 0.8,
        }

        impact_stats = service._get_impact_stats(agent_id)

        # Verify it uses execution_reports data
        assert impact_stats.total_runs == 200
        assert impact_stats.successful_runs == 180
        assert impact_stats.success_rate == 0.9  # 180/200
        assert impact_stats.avg_risk_score == 15.0
        assert impact_stats.low_risk_share == 0.8

    def test_top_blueprints_ranked_by_execution_reports(
        self, service, mock_contribution_repo
    ):
        """Top blueprints should be ranked by successful execution count."""
        agent_id = UUID("00000000-0000-0000-0000-000000000001")

        mock_contribution_repo.get_top_blueprints_by_impact.return_value = [
            {
                "slug": "high-impact",
                "title": "High Impact Blueprint",
                "impact_score": 100,
                "total_runs": 120,
                "success_rate": 0.83,
                "total_cost_usd": 50.0,
            },
            {
                "slug": "low-impact",
                "title": "Low Impact Blueprint",
                "impact_score": 10,
                "total_runs": 15,
                "success_rate": 0.67,
                "total_cost_usd": 5.0,
            },
        ]

        top_blueprints = service._get_top_blueprints(agent_id)

        assert len(top_blueprints) == 2
        assert top_blueprints[0].slug == "high-impact"
        assert top_blueprints[0].impact_score == 100  # Highest first
        assert top_blueprints[1].impact_score == 10


# ============================================================================
# Accomplishment Badge Tests
# ============================================================================


class TestAccomplishments:
    """Tests for accomplishment/badge computation."""

    @pytest.fixture
    def mock_contribution_repo(self):
        """Create mock contribution repository."""
        with patch(
            "app.services.profile_service.ContributionRepository"
        ) as mock_class:
            mock_repo = MagicMock()
            mock_class.return_value = mock_repo
            yield mock_repo

    @pytest.fixture
    def service(self, mock_contribution_repo):
        """Create service with mocked repository."""
        return ProfileService()

    def test_first_publish_badge_earned(self, service):
        """first_publish badge should be earned after first blueprint."""
        result = service._check_badge(
            "first_publish",
            {"blueprints_authored": 1, "versions_authored": 0, "successful_runs": 0},
        )
        assert result is True

    def test_first_publish_badge_not_earned(self, service):
        """first_publish badge should not be earned with no blueprints."""
        result = service._check_badge(
            "first_publish",
            {"blueprints_authored": 0, "versions_authored": 0, "successful_runs": 0},
        )
        assert result is False

    def test_hundred_runs_badge_earned(self, service):
        """hundred_successful_runs badge at 100+ successful runs."""
        result = service._check_badge(
            "hundred_successful_runs",
            {"blueprints_authored": 5, "successful_runs": 100},
        )
        assert result is True

    def test_hundred_runs_badge_not_earned(self, service):
        """hundred_successful_runs badge not earned under 100 runs."""
        result = service._check_badge(
            "hundred_successful_runs",
            {"blueprints_authored": 5, "successful_runs": 99},
        )
        assert result is False

    def test_reproducible_badge_requires_distinct_envs(self, service):
        """reproducible badge requires 10+ distinct (os, runtime, version, arch)."""
        result_earned = service._check_badge(
            "reproducible",
            {"distinct_env_count": 10},
        )
        result_not_earned = service._check_badge(
            "reproducible",
            {"distinct_env_count": 9},
        )

        assert result_earned is True
        assert result_not_earned is False

    def test_low_risk_maintainer_badge(self, service):
        """low_risk_maintainer requires 10+ versions with risk_score <= 20."""
        result_earned = service._check_badge(
            "low_risk_maintainer",
            {"low_risk_versions": 10},
        )
        result_not_earned = service._check_badge(
            "low_risk_maintainer",
            {"low_risk_versions": 9},
        )

        assert result_earned is True
        assert result_not_earned is False

    def test_org_verified_publisher_badge_with_domain(self, service):
        """org_verified_publisher badge with publisher_domain."""
        result = service._check_badge(
            "org_verified_publisher",
            {"has_publisher_domain": True, "has_org_verified_version": False},
        )
        assert result is True

    def test_org_verified_publisher_badge_with_verified_version(self, service):
        """org_verified_publisher badge with org_verified version."""
        result = service._check_badge(
            "org_verified_publisher",
            {"has_publisher_domain": False, "has_org_verified_version": True},
        )
        assert result is True


# ============================================================================
# Event Insertion Tests (Unit Level)
# ============================================================================


class TestEventInsertionLogic:
    """Tests verifying event insertion is called with correct arguments."""

    def test_insert_event_uses_correct_event_type_for_blueprint(self):
        """insert_event should receive PUBLISH_BLUEPRINT for blueprint creation."""
        # Verify the event type mapping
        assert AgentEventType.PUBLISH_BLUEPRINT.value == "publish_blueprint"
        assert IMPACT_WEIGHTS[AgentEventType.PUBLISH_BLUEPRINT] == 5

    def test_insert_event_uses_correct_event_type_for_version(self):
        """insert_event should receive PUBLISH_VERSION for version creation."""
        assert AgentEventType.PUBLISH_VERSION.value == "publish_version"
        assert IMPACT_WEIGHTS[AgentEventType.PUBLISH_VERSION] == 3

    def test_insert_event_uses_correct_event_type_for_execution(self):
        """insert_event should receive EXECUTION_REPORT for execution reports."""
        assert AgentEventType.EXECUTION_REPORT.value == "execution_report"
        assert IMPACT_WEIGHTS[AgentEventType.EXECUTION_REPORT] == 1

    def test_contribution_repo_insert_event_signature(self):
        """Verify ContributionRepository.insert_event accepts required params."""
        with patch("app.repositories.contribution_repo.get_supabase_client") as mock_client:
            mock_client.return_value.table.return_value.insert.return_value.execute.return_value = MagicMock(
                data=[{"id": "event-123"}]
            )

            repo = ContributionRepository()
            result = repo.insert_event(
                agent_id=UUID("00000000-0000-0000-0000-000000000001"),
                event_type=AgentEventType.PUBLISH_BLUEPRINT,
                blueprint_id=UUID("00000000-0000-0000-0000-000000000002"),
                version_id=UUID("00000000-0000-0000-0000-000000000003"),
            )

            # Verify the insert was called
            mock_client.return_value.table.assert_called_with("agent_contribution_events")

            # Verify the data passed to insert
            insert_call = mock_client.return_value.table.return_value.insert.call_args
            inserted_data = insert_call[0][0]

            assert inserted_data["event_type"] == "publish_blueprint"
            assert inserted_data["impact_weight"] == 5
