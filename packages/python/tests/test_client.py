"""
Tests for Plurum SDK client
"""

from unittest.mock import patch, MagicMock

import pytest

from plurum import Plurum
from plurum.resources.sessions import SessionsResource
from plurum.resources.experiences import ExperiencesResource
from plurum.resources.agents import AgentsResource


class TestPlurimClient:
    def test_create_with_defaults(self):
        with patch("plurum._http.httpx.Client"):
            client = Plurum()
            assert client.sessions is not None
            assert client.experiences is not None
            assert client.agents is not None

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

    def test_has_sessions_resource(self):
        with patch("plurum._http.httpx.Client"):
            client = Plurum()
            assert isinstance(client.sessions, SessionsResource)

    def test_has_experiences_resource(self):
        with patch("plurum._http.httpx.Client"):
            client = Plurum()
            assert isinstance(client.experiences, ExperiencesResource)

    def test_has_agents_resource(self):
        with patch("plurum._http.httpx.Client"):
            client = Plurum()
            assert isinstance(client.agents, AgentsResource)

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

    # Sessions resource
    def test_sessions_has_open(self, client):
        assert hasattr(client.sessions, "open")
        assert callable(client.sessions.open)

    def test_sessions_has_get(self, client):
        assert hasattr(client.sessions, "get")
        assert callable(client.sessions.get)

    def test_sessions_has_list(self, client):
        assert hasattr(client.sessions, "list")
        assert callable(client.sessions.list)

    def test_sessions_has_log_entry(self, client):
        assert hasattr(client.sessions, "log_entry")
        assert callable(client.sessions.log_entry)

    def test_sessions_has_close(self, client):
        assert hasattr(client.sessions, "close")
        assert callable(client.sessions.close)

    def test_sessions_has_abandon(self, client):
        assert hasattr(client.sessions, "abandon")
        assert callable(client.sessions.abandon)

    def test_sessions_has_contribute(self, client):
        assert hasattr(client.sessions, "contribute")
        assert callable(client.sessions.contribute)

    def test_sessions_has_list_contributions(self, client):
        assert hasattr(client.sessions, "list_contributions")
        assert callable(client.sessions.list_contributions)

    # Experiences resource
    def test_experiences_has_create(self, client):
        assert hasattr(client.experiences, "create")
        assert callable(client.experiences.create)

    def test_experiences_has_get(self, client):
        assert hasattr(client.experiences, "get")
        assert callable(client.experiences.get)

    def test_experiences_has_list(self, client):
        assert hasattr(client.experiences, "list")
        assert callable(client.experiences.list)

    def test_experiences_has_search(self, client):
        assert hasattr(client.experiences, "search")
        assert callable(client.experiences.search)

    def test_experiences_has_acquire(self, client):
        assert hasattr(client.experiences, "acquire")
        assert callable(client.experiences.acquire)

    def test_experiences_has_publish(self, client):
        assert hasattr(client.experiences, "publish")
        assert callable(client.experiences.publish)

    def test_experiences_has_report_outcome(self, client):
        assert hasattr(client.experiences, "report_outcome")
        assert callable(client.experiences.report_outcome)

    def test_experiences_has_vote(self, client):
        assert hasattr(client.experiences, "vote")
        assert callable(client.experiences.vote)

    def test_experiences_has_find_similar(self, client):
        assert hasattr(client.experiences, "find_similar")
        assert callable(client.experiences.find_similar)

    # Agents resource
    def test_agents_has_register(self, client):
        assert hasattr(client.agents, "register")
        assert callable(client.agents.register)

    def test_agents_has_me(self, client):
        assert hasattr(client.agents, "me")
        assert callable(client.agents.me)

    def test_agents_has_rotate_key(self, client):
        assert hasattr(client.agents, "rotate_key")
        assert callable(client.agents.rotate_key)
