"""
Tests for Plurum SDK resources
"""

from datetime import datetime
from unittest.mock import MagicMock

import pytest

from plurum.resources.blueprints import BlueprintsResource
from plurum.resources.feedback import FeedbackResource


def make_blueprint_version(overrides=None):
    """Create a complete mock blueprint version."""
    data = {
        "id": "version-123",
        "version_number": 1,
        "title": "Test Blueprint",
        "goal_description": "Test goal",
        "strategy": "Test strategy",
        "execution_steps": [],
        "code_snippets": [],
        "context_requirements": [],
        "created_at": datetime.now().isoformat(),
        # Trust Engine fields
        "permissions_required": [],
        "risk_flags": [],
        "verification_tier": "self_reported",
        "risk_score": 0,
    }
    if overrides:
        data.update(overrides)
    return data


def make_quality_metrics(overrides=None):
    """Create complete mock quality metrics."""
    data = {
        "execution_count": 100,
        "success_rate": 0.9,
        "upvotes": 50,
        "downvotes": 5,
        "score": 0.85,
    }
    if overrides:
        data.update(overrides)
    return data


def make_blueprint_detail(overrides=None):
    """Create a complete mock blueprint detail."""
    now = datetime.now().isoformat()
    data = {
        "id": "bp-123",
        "slug": "test-blueprint",
        "status": "published",
        "is_public": True,
        "quality_metrics": make_quality_metrics(),
        "tags": ["test", "example"],
        "current_version": make_blueprint_version(),
        "created_at": now,
        "updated_at": now,
    }
    if overrides:
        data.update(overrides)
    return data


def make_search_result(overrides=None):
    """Create a complete mock search result."""
    data = {
        "similarity": 0.95,
        "match_reasons": ["title match"],
        "blueprint": make_blueprint_detail(),
        # Trust Engine fields (required in v2.3)
        "version_id": "version-123",
        "final_score": 0.95,
        "verification_tier": "self_reported",
        "risk_score": 0,
    }
    if overrides:
        data.update(overrides)
    return data


class TestBlueprintsResource:
    @pytest.fixture
    def mock_http(self):
        return MagicMock()

    @pytest.fixture
    def blueprints(self, mock_http):
        return BlueprintsResource(mock_http)

    def test_search_basic(self, blueprints, mock_http):
        mock_http.post.return_value = {
            "results": [],
            "total_found": 0,
            "query": "deploy docker",
            "filters_applied": {},
        }

        result = blueprints.search("deploy docker")

        mock_http.post.assert_called_once_with(
            "/api/v1/search",
            {"query": "deploy docker", "limit": 10},
        )
        assert result.total_found == 0
        assert result.query == "deploy docker"

    def test_search_with_tags(self, blueprints, mock_http):
        mock_http.post.return_value = {
            "results": [],
            "total_found": 0,
            "query": "test",
            "filters_applied": {"tags": ["docker", "aws"]},
        }

        blueprints.search("deploy docker", tags=["docker", "aws"])

        call_args = mock_http.post.call_args
        assert call_args[0][1]["tags"] == ["docker", "aws"]

    def test_search_with_limit(self, blueprints, mock_http):
        mock_http.post.return_value = {
            "results": [],
            "total_found": 0,
            "query": "test",
            "filters_applied": {},
        }

        blueprints.search("deploy docker", limit=20)

        call_args = mock_http.post.call_args
        assert call_args[0][1]["limit"] == 20

    def test_search_with_min_success_rate(self, blueprints, mock_http):
        mock_http.post.return_value = {
            "results": [],
            "total_found": 0,
            "query": "test",
            "filters_applied": {"min_success_rate": 0.8},
        }

        blueprints.search("deploy docker", min_success_rate=0.8)

        call_args = mock_http.post.call_args
        assert call_args[0][1]["min_success_rate"] == 0.8

    def test_search_with_results(self, blueprints, mock_http):
        mock_http.post.return_value = {
            "results": [make_search_result()],
            "total_found": 1,
            "query": "deploy docker",
            "filters_applied": {},
        }

        result = blueprints.search("deploy docker")

        assert result.total_found == 1
        assert len(result.results) == 1
        assert result.results[0].similarity == 0.95

    def test_get_blueprint(self, blueprints, mock_http):
        mock_http.get.return_value = make_blueprint_detail({
            "slug": "docker-aws",
            "current_version": make_blueprint_version({"title": "Deploy Docker to AWS"}),
        })

        result = blueprints.get("docker-aws")

        mock_http.get.assert_called_once_with("/api/v1/blueprints/docker-aws")
        assert result.slug == "docker-aws"
        assert result.current_version.title == "Deploy Docker to AWS"

    def test_list_blueprints(self, blueprints, mock_http):
        mock_http.get.return_value = [make_blueprint_detail()]

        result = blueprints.list()

        mock_http.get.assert_called_once_with(
            "/api/v1/blueprints",
            {"limit": 20, "offset": 0},
        )
        assert len(result) == 1

    def test_list_with_filters(self, blueprints, mock_http):
        mock_http.get.return_value = []

        blueprints.list(limit=10, status="published", tags=["docker"])

        call_args = mock_http.get.call_args
        assert call_args[0][1]["limit"] == 10
        assert call_args[0][1]["status"] == "published"
        assert call_args[0][1]["tags"] == ["docker"]

    def test_create_blueprint(self, blueprints, mock_http):
        mock_http.post.return_value = make_blueprint_detail({
            "slug": "new-blueprint",
            "current_version": make_blueprint_version({
                "title": "New Blueprint",
                "goal_description": "Create something",
                "strategy": "Use this strategy",
            }),
        })

        result = blueprints.create(
            title="New Blueprint",
            goal_description="Create something",
            strategy="Use this strategy",
        )

        call_args = mock_http.post.call_args
        assert call_args[0][0] == "/api/v1/blueprints"
        assert call_args[1]["requires_auth"] is True
        assert result.slug == "new-blueprint"

    def test_update_blueprint(self, blueprints, mock_http):
        mock_http.put.return_value = make_blueprint_detail({
            "slug": "docker-aws",
            "current_version": make_blueprint_version({"title": "Updated Title"}),
        })

        result = blueprints.update("docker-aws", title="Updated Title")

        call_args = mock_http.put.call_args
        assert call_args[0][0] == "/api/v1/blueprints/docker-aws"
        assert call_args[1]["requires_auth"] is True
        assert result.current_version.title == "Updated Title"

    def test_similar_blueprints(self, blueprints, mock_http):
        mock_http.get.return_value = [make_search_result()]

        result = blueprints.similar("docker-aws")

        mock_http.get.assert_called_once_with(
            "/api/v1/search/similar/docker-aws",
            {"limit": 5, "exclude_same_author": True},
        )
        assert len(result) == 1

    def test_similar_with_limit(self, blueprints, mock_http):
        mock_http.get.return_value = []

        blueprints.similar("docker-aws", limit=10)

        call_args = mock_http.get.call_args
        assert call_args[0][1]["limit"] == 10


class TestFeedbackResource:
    @pytest.fixture
    def mock_http(self):
        return MagicMock()

    @pytest.fixture
    def feedback(self, mock_http):
        return FeedbackResource(mock_http)

    def test_vote_up(self, feedback, mock_http):
        mock_http.post.return_value = {"message": "Vote recorded"}

        feedback.vote("docker-aws", "up")

        mock_http.post.assert_called_once_with(
            "/api/v1/feedback/votes",
            {"blueprint_slug": "docker-aws", "vote_type": "up"},
            requires_auth=True,
        )

    def test_vote_down(self, feedback, mock_http):
        mock_http.post.return_value = {"message": "Vote recorded"}

        feedback.vote("docker-aws", "down")

        call_args = mock_http.post.call_args
        assert call_args[0][1]["vote_type"] == "down"

    def test_report_execution_success(self, feedback, mock_http):
        mock_http.post.return_value = {"message": "Execution recorded"}

        feedback.report_execution("docker-aws", success=True)

        mock_http.post.assert_called_once_with(
            "/api/v1/feedback/executions",
            {"blueprint_slug": "docker-aws", "success": True},
            requires_auth=True,
        )

    def test_report_execution_failure(self, feedback, mock_http):
        mock_http.post.return_value = {"message": "Execution recorded"}

        feedback.report_execution(
            "docker-aws",
            success=False,
            error_message="Connection timeout",
        )

        call_args = mock_http.post.call_args
        assert call_args[0][1]["success"] is False
        assert call_args[0][1]["error_message"] == "Connection timeout"

    def test_report_execution_with_time(self, feedback, mock_http):
        mock_http.post.return_value = {"message": "Execution recorded"}

        feedback.report_execution(
            "docker-aws",
            success=True,
            execution_time_ms=5000,
        )

        call_args = mock_http.post.call_args
        assert call_args[0][1]["execution_time_ms"] == 5000

    def test_report_execution_with_notes(self, feedback, mock_http):
        mock_http.post.return_value = {"message": "Execution recorded"}

        feedback.report_execution(
            "docker-aws",
            success=True,
            context_notes="Deployed to us-east-1",
        )

        call_args = mock_http.post.call_args
        assert call_args[0][1]["context_notes"] == "Deployed to us-east-1"

    def test_report_execution_with_version(self, feedback, mock_http):
        mock_http.post.return_value = {"message": "Execution recorded"}

        feedback.report_execution(
            "docker-aws",
            success=True,
            version_id="version-123",
        )

        call_args = mock_http.post.call_args
        assert call_args[0][1]["version_id"] == "version-123"
