"""
Tests for Plurum SDK client
"""

from unittest.mock import patch, MagicMock

import pytest

from plurum import Plurum
from plurum.resources.blueprints import BlueprintsResource
from plurum.resources.feedback import FeedbackResource


class TestPlurimClient:
    def test_create_with_defaults(self):
        with patch("plurum._http.httpx.Client"):
            client = Plurum()
            assert client.blueprints is not None
            assert client.feedback is not None

    def test_create_with_api_key(self):
        with patch("plurum._http.httpx.Client"):
            client = Plurum(api_key="test_key")
            assert client._http.api_key == "test_key"

    def test_create_with_api_url(self):
        with patch("plurum._http.httpx.Client"):
            client = Plurum(api_url="http://localhost:8000")
            assert client._http.api_url == "http://localhost:8000"

    def test_create_with_timeout(self):
        with patch("plurum._http.httpx.Client"):
            client = Plurum(timeout=60.0)
            assert client._http.timeout == 60.0

    def test_has_blueprints_resource(self):
        with patch("plurum._http.httpx.Client"):
            client = Plurum()
            assert isinstance(client.blueprints, BlueprintsResource)

    def test_has_feedback_resource(self):
        with patch("plurum._http.httpx.Client"):
            client = Plurum()
            assert isinstance(client.feedback, FeedbackResource)

    def test_context_manager(self):
        with patch("plurum._http.httpx.Client") as MockClient:
            mock_instance = MagicMock()
            MockClient.return_value = mock_instance

            with Plurum() as client:
                assert client is not None

            mock_instance.close.assert_called_once()

    def test_close_method(self):
        with patch("plurum._http.httpx.Client") as MockClient:
            mock_instance = MagicMock()
            MockClient.return_value = mock_instance

            client = Plurum()
            client.close()

            mock_instance.close.assert_called_once()


class TestPlurimClientResources:
    @pytest.fixture
    def client(self):
        with patch("plurum._http.httpx.Client"):
            return Plurum(api_key="test_key")

    def test_blueprints_has_search(self, client):
        assert hasattr(client.blueprints, "search")
        assert callable(client.blueprints.search)

    def test_blueprints_has_get(self, client):
        assert hasattr(client.blueprints, "get")
        assert callable(client.blueprints.get)

    def test_blueprints_has_list(self, client):
        assert hasattr(client.blueprints, "list")
        assert callable(client.blueprints.list)

    def test_blueprints_has_create(self, client):
        assert hasattr(client.blueprints, "create")
        assert callable(client.blueprints.create)

    def test_blueprints_has_update(self, client):
        assert hasattr(client.blueprints, "update")
        assert callable(client.blueprints.update)

    def test_blueprints_has_similar(self, client):
        assert hasattr(client.blueprints, "similar")
        assert callable(client.blueprints.similar)

    def test_feedback_has_vote(self, client):
        assert hasattr(client.feedback, "vote")
        assert callable(client.feedback.vote)

    def test_feedback_has_report_execution(self, client):
        assert hasattr(client.feedback, "report_execution")
        assert callable(client.feedback.report_execution)
