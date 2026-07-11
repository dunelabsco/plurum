"""Tests for pulse endpoints and WebSocket connection handling."""

import asyncio
import json
from unittest.mock import AsyncMock, patch

import pytest
from starlette.websockets import WebSocketDisconnect

from app.api.v1.pulse import _origin_allowed
from app.config import get_settings
from app.services.pulse_service import PulseService


AGENT_ID = "00000000-0000-0000-0000-000000000001"
TEST_AGENT = {"id": AGENT_ID, "is_active": True}


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


class TestPulseWebSocket:
    def test_legacy_query_token_authentication_still_works(self, client):
        pulse = PulseService()

        with (
            patch(
                "app.api.v1.pulse._authenticate_ws",
                new=AsyncMock(return_value=TEST_AGENT),
            ),
            patch("app.api.v1.pulse.get_pulse_service", return_value=pulse),
        ):
            with client.websocket_connect(
                "/api/v1/pulse/ws?token=plrm_live_legacy"
            ) as websocket:
                assert websocket.receive_json() == {
                    "type": "auth_ok",
                    "agent_id": AGENT_ID,
                }
                websocket.send_json({"type": "ping"})
                assert websocket.receive_json() == {"type": "pong"}

        assert pulse.active_connections == {}

    def test_first_message_authentication_works(self, client):
        pulse = PulseService()

        with (
            patch(
                "app.api.v1.pulse._authenticate_ws",
                new=AsyncMock(return_value=TEST_AGENT),
            ) as authenticate,
            patch("app.api.v1.pulse.get_pulse_service", return_value=pulse),
        ):
            with client.websocket_connect("/api/v1/pulse/ws") as websocket:
                websocket.send_json({
                    "type": "auth",
                    "api_key": "plrm_live_first_message",
                })
                assert websocket.receive_json() == {
                    "type": "auth_ok",
                    "agent_id": AGENT_ID,
                }

        authenticate.assert_awaited_once_with("plrm_live_first_message")
        assert pulse.active_connections == {}

    def test_authentication_times_out(self, client):
        settings = get_settings().model_copy(
            update={"pulse_auth_timeout_seconds": 0.01}
        )

        with patch("app.api.v1.pulse.get_settings", return_value=settings):
            with client.websocket_connect("/api/v1/pulse/ws") as websocket:
                assert websocket.receive_json() == {
                    "type": "error",
                    "message": "Authentication timed out",
                }
                with pytest.raises(WebSocketDisconnect) as exc_info:
                    websocket.receive_json()

        assert exc_info.value.code == 4001

    def test_oversized_message_is_closed(self, client):
        settings = get_settings().model_copy(
            update={"pulse_max_message_bytes": 128}
        )

        with (
            patch(
                "app.api.v1.pulse._authenticate_ws",
                new=AsyncMock(return_value=TEST_AGENT),
            ),
            patch("app.api.v1.pulse.get_settings", return_value=settings),
        ):
            with client.websocket_connect(
                "/api/v1/pulse/ws?token=plrm_live_legacy"
            ) as websocket:
                websocket.receive_json()
                websocket.send_text(json.dumps({
                    "type": "ping",
                    "padding": "x" * 200,
                }))
                with pytest.raises(WebSocketDisconnect) as exc_info:
                    websocket.receive_json()

        assert exc_info.value.code == 1009

    def test_message_rate_limit_closes_connection(self, client):
        settings = get_settings().model_copy(
            update={"pulse_max_messages_per_minute": 2}
        )

        with (
            patch(
                "app.api.v1.pulse._authenticate_ws",
                new=AsyncMock(return_value=TEST_AGENT),
            ),
            patch("app.api.v1.pulse.get_settings", return_value=settings),
        ):
            with client.websocket_connect(
                "/api/v1/pulse/ws?token=plrm_live_legacy"
            ) as websocket:
                websocket.receive_json()
                for _ in range(2):
                    websocket.send_json({"type": "ping"})
                    assert websocket.receive_json() == {"type": "pong"}

                websocket.send_json({"type": "ping"})
                assert websocket.receive_json() == {
                    "type": "error",
                    "message": "Message rate limit exceeded",
                }
                with pytest.raises(WebSocketDisconnect) as exc_info:
                    websocket.receive_json()

        assert exc_info.value.code == 4008

    def test_browser_origins_are_allowlisted(self):
        allowed = ["https://plurum.ai"]

        assert _origin_allowed(None, allowed)
        assert _origin_allowed("https://plurum.ai", allowed)
        assert not _origin_allowed("https://example.com", allowed)


class TestPulseConnectionLifecycle:
    def test_new_connection_supersedes_old_connection_safely(self):
        pulse = PulseService()
        previous = AsyncMock()
        replacement = AsyncMock()
        pulse.active_connections[AGENT_ID] = previous

        asyncio.run(pulse.connect(replacement, AGENT_ID, accept=False))

        previous.close.assert_awaited_once_with(code=4000)
        assert pulse.active_connections[AGENT_ID] is replacement

        pulse.disconnect(AGENT_ID, previous)
        assert pulse.active_connections[AGENT_ID] is replacement

        pulse.disconnect(AGENT_ID, replacement)
        assert AGENT_ID not in pulse.active_connections
