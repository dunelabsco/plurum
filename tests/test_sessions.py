"""Tests for session endpoints."""

from unittest.mock import MagicMock, patch


class TestSessionAuthRequired:
    """Write endpoints still require authentication."""

    def test_open_session_no_auth(self, client):
        """Open session requires auth."""
        response = client.post(
            "/api/v1/sessions",
            json={
                "topic": "Deploy FastAPI to AWS",
                "domain": "deployment",
            },
        )
        assert response.status_code == 401

    def test_list_sessions_no_auth_returns_public(self, client, mock_supabase):
        """List sessions without auth returns public sessions."""
        with patch("app.services.session_service.SessionService.list_public_sessions") as mock_list:
            mock_list.return_value = {"items": [], "total": 0, "limit": 20, "offset": 0, "has_more": False}
            response = client.get("/api/v1/sessions")
        assert response.status_code == 200

    def test_get_session_no_auth_returns_public(self, client, mock_supabase):
        """Get public session without auth succeeds."""
        with patch("app.services.session_service.SessionService.get_public_session") as mock_get:
            mock_get.return_value = {
                "id": "test-id", "short_id": "Ab3xKp9z", "topic": "test",
                "status": "open", "visibility": "public", "entries": []
            }
            response = client.get("/api/v1/sessions/Ab3xKp9z")
        assert response.status_code == 200


class TestPublicSessionAccess:
    """Tests for unauthenticated session browsing."""

    def test_list_public_sessions_no_auth(self, client, mock_supabase):
        """List public sessions without authentication."""
        with patch("app.services.session_service.SessionService.list_public_sessions") as mock_list:
            mock_list.return_value = {"items": [], "total": 0, "limit": 20, "offset": 0, "has_more": False}
            response = client.get("/api/v1/sessions?visibility=public")
        assert response.status_code == 200

    def test_get_public_session_no_auth(self, client, mock_supabase):
        """View a public session without authentication."""
        with patch("app.services.session_service.SessionService.get_public_session") as mock_get:
            mock_get.return_value = {
                "id": "test-id", "short_id": "abc12345", "topic": "test",
                "status": "open", "visibility": "public", "entries": []
            }
            response = client.get("/api/v1/sessions/abc12345")
        assert response.status_code == 200

    def test_get_private_session_no_auth_rejected(self, client, mock_supabase):
        """Cannot view a private session without authentication."""
        with patch("app.services.session_service.SessionService.get_public_session") as mock_get:
            from app.core.exceptions import NotFoundError
            mock_get.side_effect = NotFoundError("Session", "private123")
            response = client.get("/api/v1/sessions/private123")
        assert response.status_code == 404


class TestSessionOperations:
    """Session operations with valid auth."""

    def test_open_session(self, client, mock_supabase, mock_agent, auth_headers):
        """Open session with valid auth works."""
        mock_supabase.table.return_value.select.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[mock_agent]
        )
        mock_supabase.table.return_value.update.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[mock_agent]
        )

        with patch("app.services.session_service.SessionService.open_session") as mock_open:
            mock_open.return_value = {
                "session_id": "uuid-session",
                "short_id": "Se1sAbCd",
                "topic": "Deploy FastAPI to AWS",
                "status": "open",
                "relevant_experiences": [],
                "active_sessions": [],
            }

            response = client.post(
                "/api/v1/sessions",
                headers=auth_headers,
                json={
                    "topic": "Deploy FastAPI to AWS",
                    "domain": "deployment",
                    "tools_used": ["docker", "aws-cli"],
                },
            )

            assert response.status_code == 201
            data = response.json()
            assert data["status"] == "open"
            assert "relevant_experiences" in data

    def test_list_sessions(self, client, mock_supabase, mock_agent, auth_headers):
        """List sessions returns user's sessions."""
        mock_supabase.table.return_value.select.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[mock_agent]
        )
        mock_supabase.table.return_value.update.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[mock_agent]
        )

        with patch("app.services.session_service.SessionService.list_sessions") as mock_list:
            mock_list.return_value = {
                "items": [],
                "total": 0,
                "limit": 20,
                "offset": 0,
            }

            response = client.get("/api/v1/sessions", headers=auth_headers)

            assert response.status_code == 200
            data = response.json()
            assert "items" in data
