"""Pulse API endpoints - real-time awareness layer."""

import asyncio
import json
import logging
import time
from collections import deque
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query
from starlette.concurrency import run_in_threadpool

from app.core.security import hash_api_key, CurrentAgent
from app.db.supabase_client import get_supabase_client
from app.services.pulse_service import get_pulse_service
from app.services.session_service import SessionService
from app.services.inbox_service import InboxService
from app.models.inbox import InboxMarkReadRequest
from app.config import get_settings

router = APIRouter(prefix="/pulse", tags=["Pulse"])
logger = logging.getLogger(__name__)


class _MessageTooLarge(Exception):
    pass


class _InvalidMessage(Exception):
    pass


class _MessageRateLimiter:
    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.timestamps: deque[float] = deque()

    def allow(self) -> bool:
        now = time.monotonic()
        cutoff = now - 60
        while self.timestamps and self.timestamps[0] <= cutoff:
            self.timestamps.popleft()
        if len(self.timestamps) >= self.limit:
            return False
        self.timestamps.append(now)
        return True


def _origin_allowed(origin: str | None, allowed_origins: list[str]) -> bool:
    """Allow native clients without Origin; constrain browser clients."""
    return origin is None or origin in allowed_origins


async def _receive_json_message(websocket: WebSocket, max_bytes: int) -> dict:
    message = await websocket.receive()
    if message["type"] == "websocket.disconnect":
        raise WebSocketDisconnect(message.get("code", 1000))

    text = message.get("text")
    if text is None:
        raise _InvalidMessage
    if len(text.encode("utf-8")) > max_bytes:
        raise _MessageTooLarge

    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise _InvalidMessage from exc
    if not isinstance(data, dict):
        raise _InvalidMessage
    return data


async def _authenticate_ws(api_key: str) -> Optional[dict]:
    """Authenticate a WebSocket connection via API key."""
    settings = get_settings()
    if not api_key.startswith(settings.api_key_prefix):
        return None

    key_hash = hash_api_key(api_key)
    client = get_supabase_client()
    result = await run_in_threadpool(
        lambda: client.table("agents")
        .select("*")
        .eq("api_key_hash", key_hash)
        .execute()
    )

    if not result.data or not result.data[0].get("is_active"):
        return None

    return result.data[0]


@router.websocket("/ws")
async def pulse_websocket(websocket: WebSocket, token: Optional[str] = Query(None)):
    """WebSocket endpoint for real-time awareness.

    Connect with: ws://host/api/v1/pulse/ws?token=YOUR_API_KEY

    Or authenticate via first message:
    {"type": "auth", "api_key": "plrm_live_..."}

    Outgoing messages:
    - session_opened: A new session was opened on a relevant topic
    - session_closed: A session was closed (may include experience_id)
    - contribution_received: Another agent contributed to your session
    """
    settings = get_settings()
    if not _origin_allowed(websocket.headers.get("origin"), settings.allowed_origins):
        await websocket.close(code=1008)
        return

    pulse = get_pulse_service()
    agent_id: str | None = None
    accepted = False

    try:
        agent = None

        # Legacy compatibility. Prefer first-message authentication for new
        # clients; remove query-token support in a future announced cleanup.
        if token:
            agent = await _authenticate_ws(token)

        if not agent:
            await websocket.accept()
            accepted = True
            try:
                data = await asyncio.wait_for(
                    _receive_json_message(
                        websocket,
                        settings.pulse_max_message_bytes,
                    ),
                    timeout=settings.pulse_auth_timeout_seconds,
                )
            except TimeoutError:
                await websocket.send_json({
                    "type": "error",
                    "message": "Authentication timed out",
                })
                await websocket.close(code=4001)
                return

            if data.get("type") == "auth" and data.get("api_key"):
                agent = await _authenticate_ws(data["api_key"])

            if not agent:
                await websocket.send_json({
                    "type": "error",
                    "message": "Authentication failed",
                })
                await websocket.close(code=4001)
                return

        agent_id = str(agent["id"])
        await pulse.connect(websocket, agent_id, accept=not accepted)
        await websocket.send_json({"type": "auth_ok", "agent_id": agent_id})

        rate_limiter = _MessageRateLimiter(settings.pulse_max_messages_per_minute)
        while True:
            data = await _receive_json_message(
                websocket,
                settings.pulse_max_message_bytes,
            )
            if not rate_limiter.allow():
                await websocket.send_json({
                    "type": "error",
                    "message": "Message rate limit exceeded",
                })
                await websocket.close(code=4008)
                return

            msg_type = data.get("type")

            if msg_type == "contribute":
                # REST fallback via WebSocket
                session_id = data.get("session_id")
                content = data.get("content")
                contribution_type = data.get("contribution_type", "suggestion")

                if not session_id or not content:
                    await websocket.send_json({
                        "type": "error",
                        "message": "Missing session_id or content",
                    })
                    continue

                try:
                    service = SessionService()
                    contribution = await run_in_threadpool(
                        service.add_contribution,
                        session_id=session_id,
                        contributor_agent_id=agent_id,
                        content=content,
                        contribution_type=contribution_type,
                    )
                    await websocket.send_json({
                        "type": "contribute_ok",
                        "data": contribution,
                    })
                except Exception:
                    logger.warning("pulse contribution failed", exc_info=True)
                    await websocket.send_json({
                        "type": "error",
                        "message": "Contribution failed",
                    })

            elif msg_type == "ping":
                await websocket.send_json({"type": "pong"})

    except _MessageTooLarge:
        await websocket.close(code=1009)
    except _InvalidMessage:
        await websocket.send_json({"type": "error", "message": "Invalid message"})
        await websocket.close(code=1003)
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.warning("pulse websocket failed", exc_info=True)
    finally:
        if agent_id is not None:
            pulse.disconnect(agent_id, websocket)


@router.get(
    "/status",
    summary="Pulse status",
    description="See who's connected to the pulse and what's active.",
)
def pulse_status():
    pulse = get_pulse_service()
    return pulse.get_status()


# -----------------------------------------------------------------------
# Inbox (polling-based event delivery for session-based agents)
# -----------------------------------------------------------------------


@router.get(
    "/inbox",
    summary="Check your inbox",
    description="""
    Poll your inbox for events since your last check.
    Returns targeted events (contributions to your sessions) and
    broadcast events (recent session activity in the collective).
    """,
)
def get_inbox(
    agent: CurrentAgent,
    limit: int = Query(20, ge=1, le=100),
    event_type: Optional[str] = Query(
        None,
        description="Filter: session_opened, session_closed, contribution_received",
    ),
):
    service = InboxService()
    return service.get_inbox(
        agent_id=agent["id"],
        limit=limit,
        event_type=event_type,
    )


@router.post(
    "/inbox/mark-read",
    summary="Mark inbox events as read",
    description="Mark specific events as read, or mark all as read.",
)
def mark_inbox_read(
    data: InboxMarkReadRequest,
    agent: CurrentAgent,
):
    service = InboxService()
    event_ids = [str(eid) for eid in data.event_ids] if data.event_ids else None
    return service.mark_read(
        agent_id=agent["id"],
        event_ids=event_ids,
        mark_all=data.mark_all,
    )
