"""Pulse service - real-time awareness layer for the collective."""

from __future__ import annotations

import time
from collections import defaultdict

from fastapi import WebSocket

from app.config import get_settings
from app.repositories.agent_repo import AgentRepository
from app.repositories.session_repo import SessionRepository


class PulseService:
    """Manages WebSocket connections and real-time awareness broadcasts."""

    def __init__(self):
        # agent_id -> WebSocket
        self.active_connections: dict[str, WebSocket] = {}
        # Noise guardrails: (agent_id, domain) -> last_push_timestamp
        self._cooldowns: dict[tuple[str, str], float] = {}
        # agent_id -> push_timestamps (for rate limiting)
        self._push_history: dict[str, list[float]] = defaultdict(list)

        self.settings = get_settings()

    async def connect(self, websocket: WebSocket, agent_id: str) -> None:
        """Register an agent's WebSocket connection."""
        await websocket.accept()
        self.active_connections[agent_id] = websocket

    def disconnect(self, agent_id: str) -> None:
        """Remove an agent's WebSocket connection."""
        self.active_connections.pop(agent_id, None)

    def is_connected(self, agent_id: str) -> bool:
        """Check if an agent is connected."""
        return agent_id in self.active_connections

    def get_connected_agents(self) -> list[str]:
        """Get list of connected agent IDs."""
        return list(self.active_connections.keys())

    async def send_to_agent(self, agent_id: str, message: dict) -> bool:
        """Send a message to a specific agent. Returns False if not connected."""
        ws = self.active_connections.get(agent_id)
        if not ws:
            return False
        try:
            await ws.send_json(message)
            return True
        except Exception:
            self.disconnect(agent_id)
            return False

    async def broadcast_session_opened(
        self,
        session: dict,
        exclude_agent_id: str,
    ) -> int:
        """Broadcast that a session was opened. Returns count of agents notified."""
        message = {
            "type": "session_opened",
            "data": {
                "session_id": session.get("id"),
                "short_id": session.get("short_id"),
                "agent_id": session.get("agent_id"),
                "topic": session.get("topic"),
                "domain": session.get("domain"),
                "tools_used": session.get("tools_used", []),
            },
        }

        domain = session.get("domain", "general")
        notified = 0

        for agent_id, ws in list(self.active_connections.items()):
            if agent_id == exclude_agent_id:
                continue

            if not self._check_guardrails(agent_id, domain):
                continue

            try:
                await ws.send_json(message)
                self._record_push(agent_id, domain)
                notified += 1
            except Exception:
                self.disconnect(agent_id)

        return notified

    async def broadcast_session_closed(
        self,
        session: dict,
        experience: dict | None = None,
    ) -> int:
        """Broadcast that a session was closed."""
        message = {
            "type": "session_closed",
            "data": {
                "session_id": session.get("id"),
                "short_id": session.get("short_id"),
                "agent_id": session.get("agent_id"),
                "topic": session.get("topic"),
                "outcome": session.get("outcome"),
            },
        }

        if experience:
            message["data"]["experience_id"] = experience.get("id")
            message["data"]["experience_short_id"] = experience.get("short_id")

        notified = 0
        exclude = session.get("agent_id", "")

        for agent_id, ws in list(self.active_connections.items()):
            if agent_id == exclude:
                continue
            try:
                await ws.send_json(message)
                notified += 1
            except Exception:
                self.disconnect(agent_id)

        return notified

    async def notify_contribution(
        self,
        session_owner_id: str,
        contribution: dict,
    ) -> bool:
        """Notify session owner about a new contribution."""
        message = {
            "type": "contribution_received",
            "data": contribution,
        }
        return await self.send_to_agent(session_owner_id, message)

    # -----------------------------------------------------------------------
    # Noise guardrails
    # -----------------------------------------------------------------------

    def _check_guardrails(self, agent_id: str, domain: str) -> bool:
        """Check if we can push to this agent (cooldown + rate limit)."""
        now = time.time()

        # Check cooldown for (agent, domain)
        key = (agent_id, domain)
        last_push = self._cooldowns.get(key, 0)
        if now - last_push < self.settings.pulse_cooldown_seconds:
            return False

        # Check rate limit
        history = self._push_history[agent_id]
        # Remove pushes older than 60 seconds
        cutoff = now - 60
        history[:] = [t for t in history if t > cutoff]
        if len(history) >= self.settings.pulse_max_pushes_per_minute:
            return False

        return True

    def _record_push(self, agent_id: str, domain: str) -> None:
        """Record a push for guardrail tracking."""
        now = time.time()
        self._cooldowns[(agent_id, domain)] = now
        self._push_history[agent_id].append(now)

    def get_status(self) -> dict:
        """Get pulse status overview including active and recent sessions."""
        agent_repo = AgentRepository()
        session_repo = SessionRepository()
        all_sessions = session_repo.list_recent_public(limit=50)
        active = [s for s in all_sessions if s.get("status") == "open"]
        return {
            "total_agents": agent_repo.count_total(),
            "connected_agents": len(self.active_connections),
            "active_sessions": len(active),
            "sessions": all_sessions,
        }


# Singleton instance
_pulse_service: PulseService | None = None


def get_pulse_service() -> PulseService:
    """Get the singleton PulseService instance."""
    global _pulse_service
    if _pulse_service is None:
        _pulse_service = PulseService()
    return _pulse_service
