"""Tests for experience endpoints — public reads and auth-required writes."""

from unittest.mock import MagicMock, patch

import pytest

from app.core.exceptions import NotFoundError
from app.models.experience_views import EXPERIENCE_LIST_SELECT
from app.repositories.experience_repo import ExperienceRepository
from app.services.experience_service import ExperienceService


def test_event_experience_id_prefers_feedbacks_canonical_reference():
    from app.api.v1.experiences import _exp_id

    assert _exp_id(
        {
            "id": "20000000-0000-0000-0000-000000000001",
            "experience_id": "10000000-0000-0000-0000-000000000001",
        }
    ) == "10000000-0000-0000-0000-000000000001"


class TestExperiencePublicEndpoints:
    """Public endpoints should work WITHOUT authentication."""

    def test_search_experiences_no_auth(self, client, mock_supabase):
        """Search is public — no auth required."""
        with patch("app.services.experience_service.ExperienceService.search") as mock_search:
            mock_search.return_value = {"query": "deploy docker", "results": [], "total_found": 0}

            response = client.post(
                "/api/v1/experiences/search",
                json={"query": "deploy docker", "limit": 5},
            )

            assert response.status_code == 200
            data = response.json()
            assert data["query"] == "deploy docker"
            assert "results" in data

    def test_list_experiences_no_auth(self, client, mock_supabase):
        """List is public — no auth required."""
        with patch("app.services.experience_service.ExperienceService.list_experiences") as mock_list:
            mock_list.return_value = {"items": [], "total": 0, "limit": 20, "offset": 0}

            response = client.get("/api/v1/experiences")

            assert response.status_code == 200
            data = response.json()
            assert "items" in data

    def test_list_experiences_with_filters(self, client, mock_supabase):
        """List with query params works."""
        with patch("app.services.experience_service.ExperienceService.list_experiences") as mock_list:
            mock_list.return_value = {"items": [], "total": 0, "limit": 10, "offset": 0}

            response = client.get(
                "/api/v1/experiences?status=published&domain=deployment&limit=10"
            )

            assert response.status_code == 200
            mock_list.assert_called_once_with(
                status="published",
                domain="deployment",
                limit=10,
                offset=0,
                include_archived=False,
                viewer_agent_id=None,
            )

    def test_get_experience_no_auth(self, client, mock_supabase):
        """Get by identifier is public."""
        with patch("app.services.experience_service.ExperienceService.get") as mock_get:
            mock_get.return_value = {
                "id": "uuid-1",
                "short_id": "Ab3xKp9z",
                "goal": "Deploy Docker to ECS",
                "domain": "deployment",
                "quality_score": 0.85,
            }

            response = client.get("/api/v1/experiences/Ab3xKp9z")

            assert response.status_code == 200
            data = response.json()
            assert data["short_id"] == "Ab3xKp9z"
            mock_get.assert_called_once_with("Ab3xKp9z", viewer_agent_id=None)

    def test_find_similar_no_auth(self, client, mock_supabase):
        """Find similar is public."""
        with patch("app.services.experience_service.ExperienceService.find_similar") as mock_similar:
            mock_similar.return_value = []

            response = client.get("/api/v1/experiences/Ab3xKp9z/similar?limit=3")

            assert response.status_code == 200
            mock_similar.assert_called_once_with(
                "Ab3xKp9z",
                limit=3,
                viewer_agent_id=None,
            )


class TestExperienceAuthRequired:
    """Write endpoints should REQUIRE authentication."""

    def test_create_experience_no_auth(self, client):
        """Create requires auth."""
        response = client.post(
            "/api/v1/experiences",
            json={
                "goal": "Test experience",
                "context": "Testing",
                "outcome": "success",
            },
        )
        assert response.status_code == 401

    def test_vote_no_auth(self, client):
        """Voting requires auth."""
        response = client.post(
            "/api/v1/experiences/Ab3xKp9z/vote",
            json={"vote_type": "up"},
        )
        assert response.status_code == 401

    def test_report_outcome_no_auth(self, client):
        """Reporting outcome requires auth."""
        response = client.post(
            "/api/v1/experiences/Ab3xKp9z/outcome",
            json={"success": True},
        )
        assert response.status_code == 401

    def test_acquire_no_auth(self, client):
        """Acquiring requires auth."""
        response = client.post(
            "/api/v1/experiences/Ab3xKp9z/acquire",
            json={"mode": "summary"},
        )
        assert response.status_code == 401

    def test_publish_no_auth(self, client):
        """Publishing requires auth."""
        response = client.post("/api/v1/experiences/Ab3xKp9z/publish")
        assert response.status_code == 401

    def test_create_experience_with_auth(self, client, mock_supabase, mock_agent, auth_headers):
        """Create works with valid auth."""
        # Mock auth
        mock_supabase.table.return_value.select.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[mock_agent]
        )
        mock_supabase.table.return_value.update.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[mock_agent]
        )

        with patch("app.services.experience_service.ExperienceService.create") as mock_create:
            mock_create.return_value = {
                "id": "uuid-new",
                "short_id": "Xy9zAb12",
                "goal": "Test experience",
                "status": "draft",
            }

            response = client.post(
                "/api/v1/experiences",
                headers=auth_headers,
                json={
                    "goal": "Test experience",
                    "context": "Testing",
                    "outcome": "success",
                },
            )

            assert response.status_code == 201


class TestExperienceSearch:
    """Search-specific behavior tests."""

    def test_search_with_filters(self, client, mock_supabase):
        """Search accepts optional filters."""
        with patch("app.services.experience_service.ExperienceService.search") as mock_search:
            mock_search.return_value = {"query": "docker", "results": [], "total_found": 0}

            response = client.post(
                "/api/v1/experiences/search",
                json={
                    "query": "docker deployment",
                    "domain": "devops",
                    "tools": ["docker", "aws"],
                    "min_quality": 0.5,
                    "limit": 10,
                },
            )

            assert response.status_code == 200
            mock_search.assert_called_once_with(
                query="docker deployment",
                domain="devops",
                tools=["docker", "aws"],
                min_quality=0.5,
                limit=10,
            )

    def test_search_empty_query_rejected(self, client, mock_supabase):
        """Search with empty query should be rejected."""
        response = client.post(
            "/api/v1/experiences/search",
            json={"query": ""},
        )
        # Pydantic validation should reject empty query
        assert response.status_code == 422


class TestExperienceReadAccess:
    """Visibility and lifecycle status must be enforced by the API layer."""

    @staticmethod
    def experience(**overrides):
        data = {
            "id": "00000000-0000-0000-0000-000000000100",
            "short_id": "Ab3xKp9z",
            "agent_id": "00000000-0000-0000-0000-000000000001",
            "goal": "Deploy Docker safely",
            "visibility": "public",
            "status": "published",
            "reasoning_embedding": [0.1] * 1536,
        }
        data.update(overrides)
        return data

    def test_public_published_experience_is_readable(self, mock_supabase, mock_openai):
        experience = self.experience()
        with patch.object(
            ExperienceRepository,
            "get_by_identifier",
            return_value=experience,
        ):
            result = ExperienceService().get("Ab3xKp9z")

        assert result["id"] == experience["id"]
        assert result["goal"] == experience["goal"]
        assert "reasoning_embedding" not in result

    @pytest.mark.parametrize(
        ("visibility", "status"),
        [
            ("private", "published"),
            ("team", "published"),
            ("public", "draft"),
            ("public", "archived"),
        ],
    )
    def test_nonpublic_experience_is_hidden(
        self,
        mock_supabase,
        mock_openai,
        visibility,
        status,
    ):
        experience = self.experience(visibility=visibility, status=status)
        with patch.object(
            ExperienceRepository,
            "get_by_identifier",
            return_value=experience,
        ), pytest.raises(NotFoundError):
            ExperienceService().get("Ab3xKp9z")

    def test_owner_can_read_own_private_draft(self, mock_supabase, mock_openai):
        experience = self.experience(visibility="private", status="draft")
        with patch.object(
            ExperienceRepository,
            "get_by_identifier",
            return_value=experience,
        ):
            result = ExperienceService().get(
                "Ab3xKp9z",
                viewer_agent_id=experience["agent_id"],
            )
        assert result["id"] == experience["id"]
        assert result["visibility"] == "private"
        assert result["status"] == "draft"
        assert "reasoning_embedding" not in result

    def test_private_experience_route_returns_404(self, client):
        experience = self.experience(visibility="private")
        with patch.object(
            ExperienceRepository,
            "get_by_identifier",
            return_value=experience,
        ):
            response = client.get("/api/v1/experiences/Ab3xKp9z")

        assert response.status_code == 404

    def test_unrelated_agent_cannot_acquire_private_experience(
        self,
        mock_supabase,
        mock_openai,
    ):
        experience = self.experience(visibility="private")
        with patch.object(
            ExperienceRepository,
            "get_by_identifier",
            return_value=experience,
        ), pytest.raises(NotFoundError):
            ExperienceService().acquire(
                "Ab3xKp9z",
                viewer_agent_id="00000000-0000-0000-0000-000000000002",
            )

    @pytest.mark.parametrize("action", ["vote", "report_outcome"])
    def test_unrelated_agent_cannot_send_feedback_on_private_experience(
        self,
        mock_supabase,
        mock_openai,
        action,
    ):
        experience = self.experience(visibility="private")
        service = ExperienceService()
        with patch.object(
            ExperienceRepository,
            "get_by_identifier",
            return_value=experience,
        ), pytest.raises(NotFoundError):
            if action == "vote":
                service.vote(
                    "Ab3xKp9z",
                    agent_id="00000000-0000-0000-0000-000000000002",
                    vote_type="up",
                )
            else:
                service.report_outcome(
                    "Ab3xKp9z",
                    agent_id="00000000-0000-0000-0000-000000000002",
                    success=True,
                )

    def test_public_list_applies_visibility_and_status_filters(
        self,
        mock_supabase,
    ):
        query = MagicMock()
        mock_supabase.table.return_value.select.return_value = query
        query.eq.return_value = query
        query.in_.return_value = query
        query.neq.return_value = query
        query.order.return_value = query
        query.range.return_value = query
        query.execute.return_value = MagicMock(data=[], count=0)

        ExperienceRepository().list_experiences()

        mock_supabase.table.return_value.select.assert_called_once_with(
            EXPERIENCE_LIST_SELECT,
            count="exact",
        )
        query.eq.assert_any_call("visibility", "public")
        query.in_.assert_called_once_with("status", ["published", "verified"])

    def test_authenticated_list_includes_public_records_or_owners_records(
        self,
        mock_supabase,
    ):
        viewer_id = "00000000-0000-0000-0000-000000000001"
        query = MagicMock()
        mock_supabase.table.return_value.select.return_value = query
        query.or_.return_value = query
        query.neq.return_value = query
        query.order.return_value = query
        query.range.return_value = query
        query.execute.return_value = MagicMock(data=[], count=0)

        ExperienceRepository().list_experiences(viewer_agent_id=viewer_id)

        query.or_.assert_called_once_with(
            "and(visibility.eq.public,status.in.(published,verified)),"
            f"agent_id.eq.{viewer_id}"
        )

    def test_agent_stats_uses_database_aggregate(self, mock_supabase):
        agent_ids = [
            "00000000-0000-0000-0000-000000000001",
            "00000000-0000-0000-0000-000000000002",
        ]
        mock_supabase.rpc.return_value.execute.return_value = MagicMock(
            data=[{
                "total_experiences": 20,
                "successful_experiences": 15,
                "total_upvotes": 42,
            }]
        )

        result = ExperienceRepository().get_agent_stats(agent_ids)

        assert result == {
            "total_experiences": 20,
            "successful_experiences": 15,
            "total_upvotes": 42,
        }
        mock_supabase.rpc.assert_called_once_with(
            "get_agent_experience_stats",
            {"agent_ids": agent_ids},
        )

    def test_agent_stats_empty_agent_set_skips_database(self, mock_supabase):
        result = ExperienceRepository().get_agent_stats([])

        assert result == {
            "total_experiences": 0,
            "successful_experiences": 0,
            "total_upvotes": 0,
        }
        mock_supabase.rpc.assert_not_called()
