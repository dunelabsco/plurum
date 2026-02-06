"""Tests for pulse endpoints."""

from unittest.mock import patch


class TestPulseStatus:
    """Pulse status endpoint is public."""

    def test_pulse_status_no_auth(self, client, mock_supabase):
        """Pulse status is public — no auth required."""
        with patch("app.services.pulse_service.get_pulse_service") as mock_pulse:
            service = mock_pulse.return_value
            service.get_status.return_value = {
                "connected_agents": 0,
                "agent_ids": [],
            }

            response = client.get("/api/v1/pulse/status")

            assert response.status_code == 200
            data = response.json()
            assert "connected_agents" in data
