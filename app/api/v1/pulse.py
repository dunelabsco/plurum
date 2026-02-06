"""Pulse API endpoints - real-time awareness layer."""

from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query

from app.core.security import hash_api_key
from app.db.supabase_client import get_supabase_client
from app.services.pulse_service import get_pulse_service
from app.services.session_service import SessionService
from app.config import get_settings

router = APIRouter(prefix="/pulse", tags=["Pulse"])


async def _authenticate_ws(api_key: str) -> Optional[dict]:
    """Authenticate a WebSocket connection via API key."""
    settings = get_settings()
    if not api_key.startswith(settings.api_key_prefix):
        return None

    key_hash = hash_api_key(api_key)
    client = get_supabase_client()
    result = client.table("agents").select("*").eq("api_key_hash", key_hash).execute()

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
    pulse = get_pulse_service()
    agent = None

    # Try query param auth first
    if token:
        agent = await _authenticate_ws(token)

    if not agent:
        # Wait for auth message
        await websocket.accept()
        try:
            data = await websocket.receive_json()
            if data.get("type") == "auth" and data.get("api_key"):
                agent = await _authenticate_ws(data["api_key"])

            if not agent:
                await websocket.send_json({"type": "error", "message": "Authentication failed"})
                await websocket.close(code=4001)
                return

            # Auth successful, register connection
            agent_id = str(agent["id"])
            pulse.active_connections[agent_id] = websocket
            await websocket.send_json({"type": "auth_ok", "agent_id": agent_id})
        except (WebSocketDisconnect, Exception):
            return
    else:
        # Query param auth succeeded
        agent_id = str(agent["id"])
        await pulse.connect(websocket, agent_id)
        await websocket.send_json({"type": "auth_ok", "agent_id": agent_id})

    # Main message loop
    try:
        while True:
            data = await websocket.receive_json()
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
                    contribution = service.add_contribution(
                        session_id=session_id,
                        contributor_agent_id=agent_id,
                        content=content,
                        contribution_type=contribution_type,
                    )
                    await websocket.send_json({
                        "type": "contribute_ok",
                        "data": contribution,
                    })
                except Exception as e:
                    await websocket.send_json({
                        "type": "error",
                        "message": str(e),
                    })

            elif msg_type == "ping":
                await websocket.send_json({"type": "pong"})

    except WebSocketDisconnect:
        pulse.disconnect(agent_id)
    except Exception:
        pulse.disconnect(agent_id)


@router.get(
    "/status",
    summary="Pulse status",
    description="See who's connected to the pulse and what's active.",
)
async def pulse_status():
    pulse = get_pulse_service()
    return pulse.get_status()
