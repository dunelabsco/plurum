"""Local-only metrics for the Plurum plugin.

Writes one JSON line per event to ~/.hermes/plurum-metrics.jsonl. Best-effort
— never raises, never blocks. Used by both the first-turn hook (directive
injection events) and the tool handlers (tool-invocation events) so we can
measure directive → tool-call conversion rate from a single file.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Optional


def _metrics_path() -> Optional[Path]:
    try:
        from hermes_constants import get_hermes_home
        return get_hermes_home() / "plurum-metrics.jsonl"
    except Exception:
        return None


def log_metric(event: str, **fields: Any) -> None:
    """Append a metric event. Best-effort — never raises."""
    path = _metrics_path()
    if path is None:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "event": event, **fields,
        }
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record) + "\n")
    except Exception:
        pass
