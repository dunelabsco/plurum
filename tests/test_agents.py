"""Tests for agent endpoints."""

from unittest.mock import MagicMock, patch

import pytest


MOCK_USER = {"id": "user-123", "email": "test@example.com", "created_at": "2024-01-01T00:00:00Z"}


@pytest.fixture
def user_auth_client(mock_supabase, mock_openai):
    """Create test client with get_current_user overridden to return a mock user."""
    from app.main import app
    from app.core.security import get_current_user
    from fastapi.testclient import TestClient

    async def mock_get_current_user():
        return MOCK_USER

    app.dependency_overrides[get_current_user] = mock_get_current_user
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.pop(get_current_user, None)


class TestAgentRegistration:
    """Tests for agent registration."""

    def test_register_agent_success(self, client, mock_supabase):
        """Test successful agent registration."""
        # Mock the insert response
        mock_supabase.table.return_value.insert.return_value.execute.return_value = MagicMock(
            data=[{
                "id": "00000000-0000-0000-0000-000000000001",
                "name": "my-agent",
                "api_key_hash": "hashed",
                "api_key_prefix": "plrm_live_abc...",
                "is_active": True,
            }]
        )

        response = client.post(
            "/api/v1/agents/register",
            json={"name": "my-agent"},
        )

        assert response.status_code == 201
        data = response.json()
        assert data["name"] == "my-agent"
        assert "api_key" in data
        assert data["api_key"].startswith("plrm_live_")

    def test_register_agent_invalid_name(self, client):
        """Test registration with invalid name."""
        response = client.post(
            "/api/v1/agents/register",
            json={"name": ""},
        )

        assert response.status_code == 422


class TestAgentProfile:
    """Tests for agent profile endpoints."""

    def test_get_profile_unauthenticated(self, client):
        """Test getting profile without authentication."""
        response = client.get("/api/v1/agents/me")
        assert response.status_code == 401

    def test_get_profile_success(self, client, mock_supabase, mock_agent, auth_headers):
        """Test getting profile with valid authentication."""
        # Mock the select response for auth
        mock_supabase.table.return_value.select.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[mock_agent]
        )
        # Mock the update for last_active_at
        mock_supabase.table.return_value.update.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[mock_agent]
        )

        response = client.get("/api/v1/agents/me", headers=auth_headers)

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "test-agent"


class TestApiKeyRotation:
    """Tests for API key rotation."""

    def test_rotate_key_success(self, client, mock_supabase, mock_agent, auth_headers):
        """Test successful API key rotation."""
        # Mock auth lookup
        mock_supabase.table.return_value.select.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[mock_agent]
        )
        # Mock update for last_active and key rotation
        mock_supabase.table.return_value.update.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[mock_agent]
        )

        response = client.post("/api/v1/agents/me/rotate-key", headers=auth_headers)

        assert response.status_code == 200
        data = response.json()
        assert "api_key" in data
        assert data["api_key"].startswith("plrm_live_")


class TestAgentClaim:
    """Tests for agent claim and release functionality."""

    def test_claim_agent_success(self, user_auth_client, mock_agent):
        """Successfully claim an unclaimed agent."""
        unclaimed_agent = {**mock_agent, "owner_user_id": None, "is_active": True}
        with patch("app.services.agent_service.AgentService.claim_agent") as mock_claim:
            mock_claim.return_value = {**unclaimed_agent, "owner_user_id": "user-123"}
            response = user_auth_client.post(
                "/api/v1/agents/claim",
                headers={"Authorization": "Bearer fake-jwt-token"},
                json={"api_key": "plrm_live_testkey123456789012345678"},
            )
        assert response.status_code == 200
        data = response.json()
        assert data["message"] == "Agent claimed successfully."
        assert data["owner_user_id"] == "user-123"

    def test_claim_already_claimed_agent(self, user_auth_client):
        """Reject claiming an already-claimed agent."""
        with patch("app.services.agent_service.AgentService.claim_agent") as mock_claim:
            from app.core.exceptions import DuplicateError
            mock_claim.side_effect = DuplicateError("Agent is already claimed by another account")
            response = user_auth_client.post(
                "/api/v1/agents/claim",
                headers={"Authorization": "Bearer fake-jwt-token"},
                json={"api_key": "plrm_live_testkey123456789012345678"},
            )
        assert response.status_code == 409

    def test_release_agent_success(self, user_auth_client, mock_agent):
        """Successfully release a claimed agent."""
        with patch("app.services.agent_service.AgentService.release_agent") as mock_release:
            mock_release.return_value = {**mock_agent, "owner_user_id": None}
            response = user_auth_client.post(
                f"/api/v1/agents/{mock_agent['id']}/release",
                headers={"Authorization": "Bearer fake-jwt-token"},
            )
        assert response.status_code == 200
        data = response.json()
        assert data["message"] == "Agent released successfully."

    def test_release_agent_not_owner(self, user_auth_client, mock_agent):
        """Reject releasing an agent you don't own."""
        with patch("app.services.agent_service.AgentService.release_agent") as mock_release:
            from app.core.exceptions import AuthorizationError
            mock_release.side_effect = AuthorizationError("You do not own this agent")
            response = user_auth_client.post(
                f"/api/v1/agents/{mock_agent['id']}/release",
                headers={"Authorization": "Bearer fake-jwt-token"},
            )
        assert response.status_code == 403


class TestAgentRotateKeyAsOwner:
    """Tests for rotating an agent's API key as its owner."""

    def test_rotate_key_as_owner_success(self, user_auth_client, mock_agent):
        """Successfully rotate an agent's key as its owner."""
        with patch("app.services.agent_service.AgentService.rotate_api_key_as_owner") as mock_rotate:
            mock_rotate.return_value = {
                "id": mock_agent["id"],
                "name": mock_agent["name"],
                "api_key": "plrm_live_newkey123456789012345678",
                "api_key_prefix": "plrm_live_newkey...",
                "message": "API key rotated successfully. Store this key — it won't be shown again.",
            }
            response = user_auth_client.post(
                f"/api/v1/agents/{mock_agent['id']}/rotate-key",
                headers={"Authorization": "Bearer fake-jwt-token"},
            )
        assert response.status_code == 200
        data = response.json()
        assert "api_key" in data
        assert data["message"] == "API key rotated successfully. Store this key — it won't be shown again."

    def test_rotate_key_as_owner_not_owner(self, user_auth_client, mock_agent):
        """Reject rotating key for an agent you don't own."""
        with patch("app.services.agent_service.AgentService.rotate_api_key_as_owner") as mock_rotate:
            from app.core.exceptions import AuthorizationError
            mock_rotate.side_effect = AuthorizationError("You do not own this agent")
            response = user_auth_client.post(
                f"/api/v1/agents/{mock_agent['id']}/rotate-key",
                headers={"Authorization": "Bearer fake-jwt-token"},
            )
        assert response.status_code == 403


class TestAgentOverview:
    """Tests for the dashboard overview endpoint."""

    def test_overview_success(self, user_auth_client):
        """Successfully get dashboard overview."""
        overview_data = {
            "agents": [
                {"id": "a1", "name": "agent-1", "username": "agent1", "is_active": True, "last_active_at": None}
            ],
            "recent_sessions": [],
            "recent_experiences": [],
            "aggregate_stats": {
                "total_sessions": 0,
                "total_experiences": 0,
                "overall_success_rate": 0.0,
                "total_upvotes": 0,
            },
        }
        with patch("app.services.agent_service.AgentService.get_overview") as mock_overview:
            mock_overview.return_value = overview_data
            response = user_auth_client.get(
                "/api/v1/agents/me/overview",
                headers={"Authorization": "Bearer fake-jwt-token"},
            )
        assert response.status_code == 200
        data = response.json()
        assert "agents" in data
        assert "aggregate_stats" in data
        assert len(data["agents"]) == 1

    def test_overview_unauthenticated(self, client):
        """Overview requires authentication."""
        response = client.get("/api/v1/agents/me/overview")
        assert response.status_code == 401
