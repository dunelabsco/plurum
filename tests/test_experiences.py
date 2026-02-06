"""Tests for experience endpoints — public reads and auth-required writes."""

from unittest.mock import MagicMock, patch


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

    def test_find_similar_no_auth(self, client, mock_supabase):
        """Find similar is public."""
        with patch("app.services.experience_service.ExperienceService.find_similar") as mock_similar:
            mock_similar.return_value = []

            response = client.get("/api/v1/experiences/Ab3xKp9z/similar?limit=3")

            assert response.status_code == 200
            mock_similar.assert_called_once_with("Ab3xKp9z", limit=3)


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
