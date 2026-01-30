"""Tests for agent endpoints."""

from unittest.mock import MagicMock, patch


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
