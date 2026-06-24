"""HTTP client + circuit breaker for the Plurum Hermes plugin.

Stdlib only — no extra dependencies. Plugin loads on every Hermes start;
keeping it dep-free means no install friction for users.

Circuit breaker mirrors the pattern in plugins/memory/mem0/__init__.py:
after N consecutive failures, pause API calls for a cooldown so a downed
backend can't hammer the agent loop.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

logger = logging.getLogger(__name__)

DEFAULT_API_URL = "https://api.plurum.ai"
DEFAULT_TIMEOUT = 12.0

# Circuit breaker constants
_BREAKER_THRESHOLD = 5
_BREAKER_COOLDOWN_SECS = 120


# ---------------------------------------------------------------------------
# Config loading — env vars first, ~/.hermes/plurum.json overrides keys
# ---------------------------------------------------------------------------

def load_config() -> dict:
    """Resolve config from env + optional JSON override file."""
    config = {
        "api_key": os.environ.get("PLURUM_API_KEY", "").strip(),
        "api_url": (
            os.environ.get("PLURUM_API_URL", "").strip() or DEFAULT_API_URL
        ),
    }
    try:
        from hermes_constants import get_hermes_home
        path = get_hermes_home() / "plurum.json"
        if path.exists():
            file_cfg = json.loads(path.read_text(encoding="utf-8"))
            for k, v in file_cfg.items():
                if v is not None and v != "":
                    config[k] = v
    except Exception:
        # hermes_constants only available inside Hermes; skip silently for
        # standalone tests / linting.
        pass
    return config


def save_config(values: dict, hermes_home) -> None:
    """Write config back to ~/.hermes/plurum.json. Used by `hermes memory setup`
    or any future generic plugin-config wizard."""
    path = Path(hermes_home) / "plurum.json"
    existing: dict = {}
    if path.exists():
        try:
            existing = json.loads(path.read_text())
        except Exception:
            pass
    existing.update(values)
    path.write_text(json.dumps(existing, indent=2))


# ---------------------------------------------------------------------------
# HTTP client with circuit breaker
# ---------------------------------------------------------------------------

class PlurumClient:
    """Thin HTTP wrapper around the Plurum API with breaker.

    Failure modes are explicit: on persistent failure we open the breaker
    and return a sentinel that callers can format as a user-facing error
    without crashing the agent loop.
    """

    # Breaker state is class-level on purpose: handlers construct a fresh
    # client per tool call (so config changes are picked up without a
    # restart), but failure history must survive across calls or the
    # breaker can never reach its threshold.
    _consecutive_failures = 0
    _breaker_open_until = 0.0

    def __init__(self, api_url: Optional[str] = None, api_key: Optional[str] = None):
        if api_url is None or api_key is None:
            cfg = load_config()
            api_url = api_url or cfg.get("api_url") or DEFAULT_API_URL
            api_key = api_key or cfg.get("api_key") or ""
        self.api_url = api_url.rstrip("/")
        self.api_key = api_key

    @property
    def has_api_key(self) -> bool:
        return bool(self.api_key)

    # -- Breaker accessors --------------------------------------------------

    def is_breaker_open(self) -> bool:
        cls = type(self)
        if cls._consecutive_failures < _BREAKER_THRESHOLD:
            return False
        if time.monotonic() >= cls._breaker_open_until:
            cls._consecutive_failures = 0
            return False
        return True

    def _record_success(self) -> None:
        type(self)._consecutive_failures = 0

    def _record_failure(self) -> None:
        cls = type(self)
        cls._consecutive_failures += 1
        if cls._consecutive_failures >= _BREAKER_THRESHOLD:
            cls._breaker_open_until = time.monotonic() + _BREAKER_COOLDOWN_SECS
            logger.warning(
                "Plurum circuit breaker tripped after %d consecutive failures; "
                "pausing API calls for %ds.",
                cls._consecutive_failures, _BREAKER_COOLDOWN_SECS,
            )

    # -- Core request -------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[dict] = None,
        params: Optional[dict] = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> Any:
        url = f"{self.api_url}{path}"
        if params:
            from urllib.parse import urlencode
            url = (
                f"{url}?"
                + urlencode({k: v for k, v in params.items() if v is not None})
            )

        data = json.dumps(body).encode() if body is not None else None
        req = Request(url, data=data, method=method)
        if self.api_key:
            req.add_header("Authorization", f"Bearer {self.api_key}")
        req.add_header("Content-Type", "application/json")

        try:
            with urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                if not raw:
                    return None
                return json.loads(raw)
        except HTTPError as e:
            detail = e.read().decode(errors="replace")[:500]
            raise RuntimeError(f"Plurum {e.code}: {detail}")
        except URLError as e:
            raise RuntimeError(f"Plurum network error: {e.reason}")

    def get(self, path: str, params: Optional[dict] = None) -> Any:
        return self._request("GET", path, params=params)

    def post(
        self, path: str, body: Optional[dict] = None, params: Optional[dict] = None,
    ) -> Any:
        return self._request("POST", path, body=body, params=params)

    # -- Domain endpoints ---------------------------------------------------

    def register_agent(self, name: str, username: str) -> dict:
        return self.post(
            "/api/v1/agents/register",
            body={"name": name, "username": username},
        ) or {}

    def check_username(self, username: str) -> dict:
        return self.get(
            "/api/v1/agents/check-username",
            params={"username": username},
        ) or {}

    def search_experiences(self, query: str, limit: int = 10) -> dict:
        return self.post("/api/v1/experiences/search", body={"query": query, "limit": limit}) or {}

    def get_experience(self, identifier: str) -> dict:
        return self.get(f"/api/v1/experiences/{identifier}") or {}

    def create_experience(self, body: dict) -> dict:
        return self.post("/api/v1/experiences", body=body) or {}

    def publish_experience(self, identifier: str) -> dict:
        return self.post(f"/api/v1/experiences/{identifier}/publish") or {}

    def archive_experience(self, identifier: str) -> dict:
        return self.post(f"/api/v1/experiences/{identifier}/archive") or {}

    def report_outcome(self, identifier: str, body: dict) -> dict:
        return self.post(f"/api/v1/experiences/{identifier}/outcome", body=body) or {}

    def vote_experience(self, identifier: str, vote: str) -> dict:
        # Backend's ExperienceVoteCreate uses `vote_type`, not `vote`.
        return self.post(f"/api/v1/experiences/{identifier}/vote", body={"vote_type": vote}) or {}
