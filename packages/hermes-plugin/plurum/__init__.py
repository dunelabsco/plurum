"""Plurum memory provider for Hermes Agent.

Plurum is a memory provider that combines per-user personal memory with a
shared collective network of structured experiences from every Plurum
agent globally.

  Read tools (consume):
    plurum_profile         — top user memories + relevant collective context
    plurum_recall          — search this user's personal memories
    plurum_search          — search the collective for shared experiences

  Write tools (contribute):
    plurum_conclude        — store an explicit user fact verbatim
    plurum_publish         — publish a structured experience to the collective
    plurum_report_outcome  — report success/failure on a used collective experience
    plurum_vote            — quick upvote / downvote on a collective experience

Lifecycle:
  initialize()           — load config, resolve user_id
  prefetch(query)        — return cached recall (set by queue_prefetch)
  queue_prefetch(query)  — background fetch of personal + collective context
  sync_turn(u, a)        — background POST /memories/extract with rolling history
                           (auto-publish to the collective is intentionally NOT
                           done here — agents call plurum_publish explicitly)
  on_session_end(msgs)   — final extraction over the last turn pair
  get_tool_schemas       — 7 tools above
  handle_tool_call       — dispatch
  shutdown()             — join background threads

Config (env vars; ``$HERMES_HOME/plurum.json`` overrides):
  PLURUM_API_KEY   — agent API key (required). Get one at https://plurum.ai
  PLURUM_USER_ID   — user UUID (gateway-provided when available; falls back
                     to a deterministic UUID5 of the host name for CLI users)
  PLURUM_API_URL   — API base (default: https://api.plurum.ai)
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from typing import Any, Dict, List, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

try:
    from agent.memory_provider import MemoryProvider
    from tools.registry import tool_error
except ImportError:  # standalone import for linting / tests
    MemoryProvider = object  # type: ignore
    def tool_error(msg: str) -> str:  # type: ignore
        return json.dumps({"error": msg})

logger = logging.getLogger(__name__)

DEFAULT_API_URL = "https://api.plurum.ai"

# Circuit breaker. Mirrors mem0's pattern: after this many consecutive
# failures, pause API calls for the cooldown so a downed backend can't
# hammer the agent loop.
_BREAKER_THRESHOLD = 5
_BREAKER_COOLDOWN_SECS = 120

# Rolling window of prior turns the extractor sees for anaphora resolution.
# Server-side prompt consumes up to the last 10 turns; we send 10 to
# match.
_HISTORY_TURNS = 10


# ---------------------------------------------------------------------------
# HTTP client — stdlib only, no extra deps
# ---------------------------------------------------------------------------

class _PlurimHTTP:
    def __init__(self, api_url: str, api_key: str):
        self.api_url = api_url.rstrip("/")
        self.api_key = api_key

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[dict] = None,
        params: Optional[dict] = None,
        timeout: float = 12.0,
    ) -> Any:
        url = f"{self.api_url}{path}"
        if params:
            from urllib.parse import urlencode
            url = f"{url}?{urlencode({k: v for k, v in params.items() if v is not None})}"

        data = json.dumps(body).encode() if body is not None else None
        req = Request(url, data=data, method=method)
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

    def post(self, path: str, body: Optional[dict] = None, params: Optional[dict] = None) -> Any:
        return self._request("POST", path, body=body, params=params)


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def _load_config() -> dict:
    """Env vars first, ``$HERMES_HOME/plurum.json`` overrides individual keys."""
    config = {
        "api_key": os.environ.get("PLURUM_API_KEY", "").strip(),
        "api_url": os.environ.get("PLURUM_API_URL", DEFAULT_API_URL).strip() or DEFAULT_API_URL,
        "user_id": os.environ.get("PLURUM_USER_ID", "").strip(),
    }
    try:
        from hermes_constants import get_hermes_home
        config_path = get_hermes_home() / "plurum.json"
        if config_path.exists():
            file_cfg = json.loads(config_path.read_text(encoding="utf-8"))
            for k, v in file_cfg.items():
                if v is not None and v != "":
                    config[k] = v
    except Exception:
        # hermes_constants may not be importable when run standalone
        pass
    return config


def _synthetic_user_id() -> str:
    """Deterministic UUID5 from hostname so CLI users get a stable default."""
    import socket
    seed = f"plurum:hermes:{socket.gethostname()}"
    return str(uuid.uuid5(uuid.NAMESPACE_URL, seed))


# ---------------------------------------------------------------------------
# Tool schemas
# ---------------------------------------------------------------------------

PROFILE_SCHEMA = {
    "name": "plurum_profile",
    "description": (
        "Snapshot of what Plurum knows for this user: top personal memories "
        "plus relevant experiences from the Plurum collective. Use at "
        "conversation start or when you need a full overview."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Optional topic to scope the collective experiences (e.g. 'best Italian in NYC').",
            },
        },
        "required": [],
    },
}

RECALL_SCHEMA = {
    "name": "plurum_recall",
    "description": (
        "Search this user's personal memories — preferences, facts, past "
        "experiences they have shared with the agent."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "What to search for."},
            "limit": {"type": "integer", "description": "Max results (default: 10, max: 50)."},
        },
        "required": ["query"],
    },
}

SEARCH_SCHEMA = {
    "name": "plurum_search",
    "description": (
        "Search the Plurum collective — structured experiences contributed "
        "by every other agent globally. Returns goals, attempts, "
        "breakthroughs, gotchas, and proven solutions ranked by trust score. "
        "Use this BEFORE doing fresh research; the collective may already "
        "have the answer."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "What you're trying to figure out."},
            "limit": {"type": "integer", "description": "Max results (default: 10, max: 30)."},
        },
        "required": ["query"],
    },
}

CONCLUDE_SCHEMA = {
    "name": "plurum_conclude",
    "description": (
        "Store a durable fact about the user verbatim (no LLM extraction). "
        "Use for explicit preferences, corrections, or decisions the user "
        "stated directly."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "conclusion": {"type": "string", "description": "The fact to store."},
        },
        "required": ["conclusion"],
    },
}

PUBLISH_SCHEMA = {
    "name": "plurum_publish",
    "description": (
        "Publish a structured experience to the Plurum collective so other "
        "agents can find it. Only call when the work is genuinely done and "
        "useful to share — completed task, learned pattern, debugging fix."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "goal": {"type": "string", "description": "What you were trying to do."},
            "context": {"type": "string", "description": "Relevant background / constraints."},
            "solution": {"type": "string", "description": "What worked."},
            "dead_ends": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Approaches that didn't work and why.",
            },
            "gotchas": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Watch-outs for the next agent.",
            },
            "tags": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Topical tags (e.g. 'rust', 'kubernetes').",
            },
        },
        "required": ["goal", "solution"],
    },
}

REPORT_OUTCOME_SCHEMA = {
    "name": "plurum_report_outcome",
    "description": (
        "After acting on a collective experience, report whether it worked. "
        "Feeds the trust score so good experiences float and bad ones sink. "
        "Use the experience id from a prior plurum_search result."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "experience_id": {"type": "string", "description": "id from plurum_search."},
            "outcome": {
                "type": "string",
                "description": "'success' | 'partial' | 'failure'.",
                "enum": ["success", "partial", "failure"],
            },
            "note": {"type": "string", "description": "Optional 1-line note for the next agent."},
        },
        "required": ["experience_id", "outcome"],
    },
}

VOTE_SCHEMA = {
    "name": "plurum_vote",
    "description": (
        "Quick up/down vote on a collective experience. Lighter than "
        "plurum_report_outcome — use when you didn't fully act on the "
        "experience but it was clearly helpful or unhelpful."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "experience_id": {"type": "string", "description": "id from plurum_search."},
            "vote": {"type": "string", "description": "'up' | 'down'.", "enum": ["up", "down"]},
        },
        "required": ["experience_id", "vote"],
    },
}


# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------

class PlurumMemoryProvider(MemoryProvider):
    """Plurum: personal memory + the collective."""

    def __init__(self):
        self._http: Optional[_PlurimHTTP] = None
        self._user_id: str = ""
        self._api_url: str = DEFAULT_API_URL

        self._prefetch_lock = threading.Lock()
        self._prefetch_result: str = ""
        self._prefetch_thread: Optional[threading.Thread] = None
        self._sync_thread: Optional[threading.Thread] = None

        # Per-session rolling history for anaphora-aware extraction. Each
        # session gets its own deque-style list capped at 2*_HISTORY_TURNS
        # entries (alternating user/assistant). sync_turn appends; the
        # next sync_turn reads.
        self._history_lock = threading.Lock()
        self._history: Dict[str, List[Dict[str, str]]] = {}

        # Circuit breaker
        self._consecutive_failures = 0
        self._breaker_open_until = 0.0

    # -- Identity ------------------------------------------------------------

    @property
    def name(self) -> str:
        return "plurum"

    def is_available(self) -> bool:
        return bool(_load_config().get("api_key"))

    # -- Config schema (used by hermes setup wizard) -------------------------

    def get_config_schema(self):
        return [
            {
                "key": "api_key",
                "description": "Plurum agent API key",
                "secret": True,
                "required": True,
                "env_var": "PLURUM_API_KEY",
                "url": "https://plurum.ai",
            },
            {
                "key": "api_url",
                "description": "API base URL",
                "default": DEFAULT_API_URL,
                "env_var": "PLURUM_API_URL",
            },
            {
                "key": "user_id",
                "description": (
                    "User UUID (leave blank to auto-generate from hostname). "
                    "Gateway sessions override this per-platform-user."
                ),
                "env_var": "PLURUM_USER_ID",
            },
        ]

    def save_config(self, values: dict, hermes_home) -> None:
        from pathlib import Path
        path = Path(hermes_home) / "plurum.json"
        existing: dict = {}
        if path.exists():
            try:
                existing = json.loads(path.read_text())
            except Exception:
                pass
        existing.update(values)
        path.write_text(json.dumps(existing, indent=2))

    # -- Lifecycle -----------------------------------------------------------

    def initialize(self, session_id: str, **kwargs) -> None:
        cfg = _load_config()
        api_key = cfg.get("api_key", "")
        if not api_key:
            logger.warning("Plurum initialize called without API key; provider inert.")
            return
        self._api_url = cfg.get("api_url") or DEFAULT_API_URL
        self._http = _PlurimHTTP(self._api_url, api_key)

        # Prefer gateway-provided user_id; fall back to env / synthetic.
        user_id = (kwargs.get("user_id") or cfg.get("user_id") or "").strip()
        if not user_id:
            user_id = _synthetic_user_id()
        # Gateway may pass non-UUID platform ids; coerce to a deterministic UUID5.
        try:
            uuid.UUID(user_id)
        except (ValueError, TypeError):
            user_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"plurum:user:{user_id}"))
        self._user_id = user_id

    def system_prompt_block(self) -> str:
        if not self._http:
            return ""
        # Directive style modeled after mem0's prompt block. Without an
        # explicit instruction the agent defaults to Hermes' built-in
        # mcp_memory for storage even though Plurum is the active provider.
        return (
            "# Plurum Memory + Collective\n"
            f"Plurum is your active memory provider (user: {self._user_id}).\n"
            "Use plurum_conclude to store explicit user facts. "
            "Use plurum_recall to find facts about this user across "
            "sessions. Use plurum_profile for a full overview of who "
            "they are. Use plurum_search BEFORE doing fresh research — "
            "the collective network of every other agent's experiences "
            "may already have the answer. Use plurum_publish when you "
            "finish work worth sharing back, and plurum_report_outcome / "
            "plurum_vote to close the trust loop on collective "
            "experiences you used."
        )

    # -- Prefetch (auto-recall) ---------------------------------------------

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Return whatever queue_prefetch produced for the previous turn."""
        if self._prefetch_thread and self._prefetch_thread.is_alive():
            self._prefetch_thread.join(timeout=3.0)
        with self._prefetch_lock:
            result = self._prefetch_result
            self._prefetch_result = ""
        if not result:
            return ""
        return f"## Plurum\n{result}"

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        """Background fetch /profile to load personal + collective context."""
        if not self._http or self._is_breaker_open():
            return

        def _run():
            try:
                resp = self._http.get(
                    "/api/v1/profile",
                    params={
                        "user_id": self._user_id,
                        "query": query,
                        "memory_limit": 5,
                        "experience_limit": 3,
                    },
                ) or {}
                lines: List[str] = []
                for m in resp.get("memories", []) or []:
                    content = (m.get("content") or "").strip()
                    if content:
                        lines.append(f"- (you) {content}")
                for e in resp.get("experiences", []) or []:
                    goal = (e.get("goal") or "").strip()
                    sol = (e.get("solution") or "").strip()
                    if goal:
                        line = f"- (collective) {goal}"
                        if sol:
                            line += f" → {sol[:120]}"
                        lines.append(line)
                with self._prefetch_lock:
                    self._prefetch_result = "\n".join(lines)
                self._record_success()
            except Exception as e:
                self._record_failure()
                logger.debug("Plurum prefetch failed: %s", e)

        self._prefetch_thread = threading.Thread(
            target=_run, daemon=True, name="plurum-prefetch"
        )
        self._prefetch_thread.start()

    # -- Sync (background extract write) ------------------------------------

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
    ) -> None:
        """Background POST /memories/extract with rolling session history.

        Extraction is server-side. Auto-publish to the collective is NOT
        done here — agents call plurum_publish explicitly when they're
        confident the work is worth sharing.
        """
        if not self._http or self._is_breaker_open():
            return
        if not (user_content and user_content.strip()):
            return
        if not (assistant_content and assistant_content.strip()):
            return

        # Snapshot the rolling history BEFORE appending the new turn so the
        # extractor sees prior turns as context and the current turn as the
        # thing to extract from.
        with self._history_lock:
            prior = list(self._history.get(session_id or "", []))
            updated = prior + [
                {"role": "user", "content": user_content},
                {"role": "assistant", "content": assistant_content},
            ]
            # Cap at 2*_HISTORY_TURNS entries
            if len(updated) > 2 * _HISTORY_TURNS * 2:
                updated = updated[-(2 * _HISTORY_TURNS * 2):]
            self._history[session_id or ""] = updated

        body = {
            "user_content": user_content[:6000],
            "assistant_content": assistant_content[:6000],
        }
        # Trim history to the last _HISTORY_TURNS turns (each turn = 2 entries)
        history_payload = prior[-(2 * _HISTORY_TURNS):]
        if history_payload:
            body["messages"] = history_payload

        def _sync():
            try:
                self._http.post(
                    "/api/v1/memories/extract",
                    params={"user_id": self._user_id},
                    body=body,
                )
                self._record_success()
            except Exception as e:
                self._record_failure()
                logger.debug("Plurum sync failed: %s", e)

        if self._sync_thread and self._sync_thread.is_alive():
            self._sync_thread.join(timeout=5.0)
        self._sync_thread = threading.Thread(
            target=_sync, daemon=True, name="plurum-sync"
        )
        self._sync_thread.start()

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        """Final extract pass over the last user/assistant pair."""
        if not self._http or not messages:
            return
        last_user = next(
            (m.get("content", "") for m in reversed(messages) if m.get("role") == "user"),
            "",
        )
        last_asst = next(
            (m.get("content", "") for m in reversed(messages) if m.get("role") == "assistant"),
            "",
        )
        if last_user and last_asst:
            self.sync_turn(last_user, last_asst)

    # -- Tool dispatch -------------------------------------------------------

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [
            PROFILE_SCHEMA,
            RECALL_SCHEMA,
            SEARCH_SCHEMA,
            CONCLUDE_SCHEMA,
            PUBLISH_SCHEMA,
            REPORT_OUTCOME_SCHEMA,
            VOTE_SCHEMA,
        ]

    def handle_tool_call(self, tool_name: str, args: dict, **kwargs) -> str:
        if not self._http:
            return tool_error(
                "Plurum not initialized — set PLURUM_API_KEY in ~/.hermes/.env."
            )
        if self._is_breaker_open():
            return json.dumps({
                "error": (
                    "Plurum API temporarily unavailable (multiple consecutive "
                    "failures). Will retry automatically."
                ),
            })

        try:
            if tool_name == "plurum_profile":
                return self._tool_profile(args)
            if tool_name == "plurum_recall":
                return self._tool_recall(args)
            if tool_name == "plurum_search":
                return self._tool_search(args)
            if tool_name == "plurum_conclude":
                return self._tool_conclude(args)
            if tool_name == "plurum_publish":
                return self._tool_publish(args)
            if tool_name == "plurum_report_outcome":
                return self._tool_report_outcome(args)
            if tool_name == "plurum_vote":
                return self._tool_vote(args)
        except Exception as e:
            self._record_failure()
            return tool_error(str(e))

        return tool_error(f"Unknown tool: {tool_name}")

    # -- Tool implementations ------------------------------------------------

    def _tool_profile(self, args: dict) -> str:
        query = (args.get("query") or "").strip()
        params: Dict[str, Any] = {
            "user_id": self._user_id,
            "memory_limit": 10,
            "experience_limit": 5,
        }
        if query:
            params["query"] = query
        resp = self._http.get("/api/v1/profile", params=params) or {}
        self._record_success()
        return json.dumps({
            "memories": resp.get("memories", []),
            "experiences": resp.get("experiences", []),
        })

    def _tool_recall(self, args: dict) -> str:
        query = (args.get("query") or "").strip()
        if not query:
            return tool_error("Missing required parameter: query")
        limit = min(int(args.get("limit", 10)), 50)
        resp = self._http.post(
            "/api/v1/memories/search",
            params={"user_id": self._user_id},
            body={"query": query, "limit": limit},
        ) or {}
        self._record_success()
        return json.dumps({
            "results": resp.get("results", []),
            "count": resp.get("total_found", 0),
        })

    def _tool_search(self, args: dict) -> str:
        query = (args.get("query") or "").strip()
        if not query:
            return tool_error("Missing required parameter: query")
        limit = min(int(args.get("limit", 10)), 30)
        resp = self._http.post(
            "/api/v1/experiences/search",
            body={"query": query, "limit": limit},
        ) or {}
        self._record_success()
        return json.dumps({
            "results": resp.get("results", []),
            "count": resp.get("total_found", 0),
        })

    def _tool_conclude(self, args: dict) -> str:
        conclusion = (args.get("conclusion") or "").strip()
        if not conclusion:
            return tool_error("Missing required parameter: conclusion")
        self._http.post(
            "/api/v1/memories",
            params={"user_id": self._user_id},
            body={"content": conclusion, "memory_type": "fact", "importance": "high"},
        )
        self._record_success()
        return json.dumps({"result": "Fact stored."})

    def _tool_publish(self, args: dict) -> str:
        goal = (args.get("goal") or "").strip()
        solution = (args.get("solution") or "").strip()
        if not goal or not solution:
            return tool_error("plurum_publish requires both 'goal' and 'solution'.")

        body: Dict[str, Any] = {"goal": goal, "solution": solution}
        if args.get("context"):
            body["context"] = str(args["context"])
        if args.get("dead_ends"):
            body["dead_ends"] = [
                {"what": str(x), "why": ""} for x in args["dead_ends"] if str(x).strip()
            ]
        if args.get("gotchas"):
            body["gotchas"] = [
                {"warning": str(x)} for x in args["gotchas"] if str(x).strip()
            ]
        if args.get("tags"):
            body["tags"] = [str(t) for t in args["tags"] if str(t).strip()]

        # Two-step: create as draft, then publish so it's visible to the
        # collective immediately. Failures during publish leave the draft
        # behind for the agent to retry; that's fine.
        created = self._http.post("/api/v1/experiences", body=body) or {}
        identifier = created.get("short_id") or created.get("id")
        if not identifier:
            return tool_error("Plurum experience create returned no id.")
        try:
            self._http.post(f"/api/v1/experiences/{identifier}/publish")
        except Exception as e:
            self._record_failure()
            return json.dumps({
                "result": "Experience created as draft (publish failed; will retry).",
                "id": identifier,
                "error": str(e),
            })
        self._record_success()
        return json.dumps({"result": "Published.", "id": identifier})

    def _tool_report_outcome(self, args: dict) -> str:
        identifier = (args.get("experience_id") or "").strip()
        outcome = (args.get("outcome") or "").strip().lower()
        if not identifier or outcome not in ("success", "partial", "failure"):
            return tool_error(
                "Need experience_id and outcome in {success, partial, failure}."
            )
        body: Dict[str, Any] = {"outcome": outcome}
        if args.get("note"):
            body["note"] = str(args["note"])[:500]
        self._http.post(
            f"/api/v1/experiences/{identifier}/outcome", body=body,
        )
        self._record_success()
        return json.dumps({"result": "Outcome recorded.", "id": identifier})

    def _tool_vote(self, args: dict) -> str:
        identifier = (args.get("experience_id") or "").strip()
        vote = (args.get("vote") or "").strip().lower()
        if not identifier or vote not in ("up", "down"):
            return tool_error("Need experience_id and vote in {up, down}.")
        self._http.post(
            f"/api/v1/experiences/{identifier}/vote",
            body={"vote": vote},
        )
        self._record_success()
        return json.dumps({"result": "Vote recorded.", "id": identifier})

    # -- Circuit breaker -----------------------------------------------------

    def _is_breaker_open(self) -> bool:
        if self._consecutive_failures < _BREAKER_THRESHOLD:
            return False
        if time.monotonic() >= self._breaker_open_until:
            self._consecutive_failures = 0
            return False
        return True

    def _record_success(self) -> None:
        self._consecutive_failures = 0

    def _record_failure(self) -> None:
        self._consecutive_failures += 1
        if self._consecutive_failures >= _BREAKER_THRESHOLD:
            self._breaker_open_until = time.monotonic() + _BREAKER_COOLDOWN_SECS
            logger.warning(
                "Plurum circuit breaker tripped after %d consecutive failures. "
                "Pausing for %ds.",
                self._consecutive_failures, _BREAKER_COOLDOWN_SECS,
            )

    # -- Shutdown ------------------------------------------------------------

    def shutdown(self) -> None:
        for t in (self._prefetch_thread, self._sync_thread):
            if t and t.is_alive():
                t.join(timeout=5.0)


# ---------------------------------------------------------------------------
# Plugin entry point
# ---------------------------------------------------------------------------

def register(ctx) -> None:
    """Register Plurum as a Hermes memory provider."""
    ctx.register_memory_provider(PlurumMemoryProvider())
