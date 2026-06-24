"""Usage event logging — best-effort, never on the critical path.

`log_event` swallows every error: analytics must never break or slow a real
request. Writes one row to the `events` table (migration 030).
"""

from typing import Optional
from uuid import UUID

from app.db.supabase_client import get_supabase_client
from app.config import get_settings

# Module-level logger uses Python logging only for diagnostics; a failed
# event write is logged at debug and otherwise ignored.
import logging

logger = logging.getLogger(__name__)


def log_event(
    event_type: str,
    agent_id: Optional[str] = None,
    experience_id: Optional[str] = None,
    query: Optional[str] = None,
    metadata: Optional[dict] = None,
) -> None:
    """Append a usage event. Best-effort: any failure is swallowed."""
    if not get_settings().events_enabled:
        return
    try:
        row = {"event_type": event_type, "metadata": metadata or {}}
        if agent_id:
            row["agent_id"] = str(agent_id)
        if experience_id:
            row["experience_id"] = str(experience_id)
        if query:
            row["query"] = query[:2000]  # cap stored query length
        get_supabase_client().table("events").insert(row).execute()
    except Exception as e:  # never propagate — analytics is non-critical
        logger.debug("log_event(%s) failed (ignored): %s", event_type, e)
