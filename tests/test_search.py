"""Tests for search endpoints."""

from unittest.mock import MagicMock


class TestSemanticSearch:
    """Tests for semantic search."""

    def test_search_empty_results(self, client, mock_supabase):
        """Test search with no results."""
        mock_supabase.rpc.return_value.execute.return_value = MagicMock(data=[])

        response = client.post(
            "/api/v1/search",
            json={
                "query": "how to deploy to kubernetes",
                "limit": 10,
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["query"] == "how to deploy to kubernetes"
        assert data["results"] == []
        assert data["total_found"] == 0

    def test_search_with_results(self, client, mock_supabase):
        """Test search with results."""
        mock_supabase.rpc.return_value.execute.return_value = MagicMock(
            data=[
                {
                    "id": "00000000-0000-0000-0000-000000000001",
                    "slug": "deploy-to-kubernetes",
                    "title": "Deploy to Kubernetes",
                    "goal_description": "Deploy an application to Kubernetes",
                    "status": "published",
                    "is_public": True,
                    "execution_count": 10,
                    "success_count": 8,
                    "failure_count": 2,
                    "success_rate": 0.8,
                    "upvotes": 5,
                    "downvotes": 1,
                    "score": 0.7,
                    "created_at": "2024-01-01T00:00:00Z",
                    "updated_at": "2024-01-01T00:00:00Z",
                    "similarity": 0.85,
                    "tags": ["kubernetes", "deployment"],
                }
            ]
        )

        response = client.post(
            "/api/v1/search",
            json={
                "query": "how to deploy to kubernetes",
                "limit": 10,
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data["results"]) == 1
        assert data["results"][0]["blueprint"]["slug"] == "deploy-to-kubernetes"
        assert data["results"][0]["similarity"] == 0.85

    def test_search_with_tag_filter(self, client, mock_supabase):
        """Test search with tag filtering."""
        mock_supabase.rpc.return_value.execute.return_value = MagicMock(data=[])

        response = client.post(
            "/api/v1/search",
            json={
                "query": "deployment automation",
                "tags": ["python", "aws"],
                "limit": 10,
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert "tags" in data["filters_applied"]

    def test_search_with_quality_filters(self, client, mock_supabase):
        """Test search with minimum score and success rate."""
        mock_supabase.rpc.return_value.execute.return_value = MagicMock(data=[])

        response = client.post(
            "/api/v1/search",
            json={
                "query": "deployment",
                "min_score": 0.5,
                "min_success_rate": 0.7,
                "limit": 10,
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["filters_applied"]["min_score"] == 0.5
        assert data["filters_applied"]["min_success_rate"] == 0.7


class TestSimilarBlueprints:
    """Tests for finding similar blueprints."""

    def test_find_similar_not_found(self, client, mock_supabase):
        """Test finding similar to non-existent blueprint."""
        mock_supabase.table.return_value.select.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[]
        )

        response = client.get("/api/v1/search/similar/non-existent-slug")

        assert response.status_code == 200
        assert response.json() == []
