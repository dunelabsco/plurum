"""Synchronous, best-effort usage event logging.

Each call makes at most one insert attempt. Writes are non-transactional and
are not an exactly-once delivery mechanism; analytics failures never fail the
product operation that triggered them.
"""

import logging
from typing import Any, Optional

from app.config import get_settings
from app.core.content_security import reject_api_keys
from app.core.exceptions import ValidationError
from app.db.supabase_client import get_supabase_client

logger = logging.getLogger(__name__)


def _contains_detected_credentials(value: Any) -> bool:
    """Return whether a telemetry value contains a recognizable credential."""
    try:
        reject_api_keys(value, path="event")
    except ValidationError:
        return True
    return False


def _safe_metadata(metadata: dict[str, Any] | None) -> dict[str, Any]:
    """Drop only unsafe top-level metadata fields so attribution survives."""
    return {
        key: value
        for key, value in (metadata or {}).items()
        if not _contains_detected_credentials({key: value})
    }


def log_event(
    event_type: str,
    agent_id: Optional[str] = None,
    experience_id: Optional[str] = None,
    query: Optional[str] = None,
    metadata: Optional[dict] = None,
) -> None:
    """Attempt one event insert and swallow every analytics-side failure."""
    try:
        if not get_settings().events_enabled:
            return

        safe_metadata = _safe_metadata(metadata)
        safe_query = query if query and not _contains_detected_credentials(query) else None
        row = {"event_type": event_type, "metadata": safe_metadata}
        if agent_id:
            row["agent_id"] = str(agent_id)
        if experience_id:
            row["experience_id"] = str(experience_id)
        if safe_query:
            row["query"] = safe_query[:2000]
        get_supabase_client().table("events").insert(row).execute()
    except Exception as exc:  # never propagate — analytics is non-critical
        logger.debug(
            "log_event(%s) failed (ignored; %s)",
            event_type,
            type(exc).__name__,
        )
