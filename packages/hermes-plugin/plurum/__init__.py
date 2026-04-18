"""Plurum memory provider for Hermes Agent.

Plurum is the only memory provider that combines:
  - Personal memory (per-user facts, preferences, observations) — like Mem0/Honcho
  - Collective memory (structured experiences from every agent globally) — unique to Plurum

The plugin exposes 4 memory tools to the agent:
  - plurum_profile   — top personal memories + relevant experiences (prompt hydration)
  - plurum_search    — search the collective for relevant experiences
  - plurum_recall    — search this user's personal memories
  - plurum_conclude  — explicitly store a durable fact about the user

Lifecycle:
  - prefetch(query)      — calls /profile with the upcoming turn as query, injects personal + collective context
  - sync_turn(u, a)      — background POST to /memories/extract (LLM extracts facts)
  - on_session_end(msgs) — same extraction over the final turn (cheap, one call)
  - handle_tool_call     — dispatches the 4 tool schemas above

Config via environment variables:
  PLURUM_API_KEY   — Plurum agent API key (required). Get one at https://plurum.ai/signup.
  PLURUM_USER_ID   — UUID for the current user (required for memory scoping).
                     Gateway can pass a deterministic UUID5 from e.g. the Telegram user id.
  PLURUM_API_URL   — API base (default: https://api.plurum.ai).
"""

from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from typing import Any, Dict, List, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

try:
    from agent.memory_provider import MemoryProvider
    from tools.registry import tool_error
except ImportError:  # pragma: no cover — allows standalone import for linting
    MemoryProvider = object  # type: ignore
    def tool_error(msg: str) -> str:  # type: ignore
        return json.dumps({"error": msg})

logger = logging.getLogger(__name__)


DEFAULT_API_URL = "https://api.plurum.ai"


# ---------------------------------------------------------------------------
# HTTP client (stdlib only — no new dependencies)
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
        timeout: float = 8.0,
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

    def delete(self, path: str, params: Optional[dict] = None) -> Any:
        return self._request("DELETE", path, params=params)


# ---------------------------------------------------------------------------
# Tool schemas
# ---------------------------------------------------------------------------

PROFILE_SCHEMA = {
    "name": "plurum_profile",
    "description": (
        "Retrieve the user's top personal memories plus relevant collective experiences for the current task. "
        "Call at the start of a task to hydrate context cheaply."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "What you're about to do (used to fetch matching collective experiences).",
            },
        },
    },
}

SEARCH_SCHEMA = {
    "name": "plurum_search",
    "description": (
        "Search the COLLECTIVE — experiences from every agent globally. Use for problem-solving recall "
        "('how do I deploy rust to arm64 k8s?'). Returns ranked experiences with trust scores."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Natural language task description."},
            "limit": {"type": "integer", "description": "Max results (default 5)."},
        },
        "required": ["query"],
    },
}

RECALL_SCHEMA = {
    "name": "plurum_recall",
    "description": (
        "Search this user's PERSONAL memories — facts, preferences, observations about THIS user. "
        "Use when you need to recall what the user said or prefers."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "What to recall about the user."},
            "limit": {"type": "integer", "description": "Max results (default 10)."},
        },
        "required": ["query"],
    },
}

CONCLUDE_SCHEMA = {
    "name": "plurum_conclude",
    "description": (
        "Explicitly store a durable fact about the user. Stored verbatim — no LLM extraction. "
        "Use for explicit preferences, identity facts, and user-stated corrections."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "content": {"type": "string", "description": "The fact, written as a complete sentence."},
            "memory_type": {
                "type": "string",
                "enum": ["fact", "preference", "observation", "note"],
                "description": "Category (default: fact).",
            },
            "importance": {
                "type": "string",
                "enum": ["high", "medium", "low"],
                "description": "Priority (default: medium).",
            },
        },
        "required": ["content"],
    },
}


# ---------------------------------------------------------------------------
# MemoryProvider implementation
# ---------------------------------------------------------------------------

class PlurimMemoryProvider(MemoryProvider):
    """Plurum — collective + personal memory provider."""

    def __init__(self):
        self._http: Optional[_PlurimHTTP] = None
        self._api_key: str = ""
        self._api_url: str = DEFAULT_API_URL
        self._user_id: str = ""
        self._session_id: str = ""
        self._prefetch_result: str = ""
        self._prefetch_lock = threading.Lock()
        self._prefetch_thread: Optional[threading.Thread] = None
        self._sync_thread: Optional[threading.Thread] = None

    # -- Identity ------------------------------------------------------------

    @property
    def name(self) -> str:
        return "plurum"

    # -- Config --------------------------------------------------------------

    def _load_config(self) -> dict:
        return {
            "api_key": os.environ.get("PLURUM_API_KEY", "").strip(),
            "api_url": os.environ.get("PLURUM_API_URL", DEFAULT_API_URL).strip(),
            "user_id": os.environ.get("PLURUM_USER_ID", "").strip(),
        }

    def is_available(self) -> bool:
        """Ready when PLURUM_API_KEY is set. user_id can be provided at initialize time."""
        return bool(self._load_config()["api_key"])

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {
                "key": "api_key",
                "description": "Plurum API key",
                "secret": True,
                "required": True,
                "env_var": "PLURUM_API_KEY",
                "url": "https://plurum.ai/signup",
            },
            {
                "key": "api_url",
                "description": "API base URL",
                "default": DEFAULT_API_URL,
                "env_var": "PLURUM_API_URL",
            },
            {
                "key": "user_id",
                "description": "Default UUID for the single-user CLI case (gateways override per-user).",
                "env_var": "PLURUM_USER_ID",
            },
        ]

    def save_config(self, values: dict, hermes_home: str) -> None:
        """No native config file — everything is env vars."""
        return

    # -- Lifecycle -----------------------------------------------------------

    def initialize(self, session_id: str, **kwargs) -> None:
        cfg = self._load_config()
        self._api_key = cfg["api_key"]
        self._api_url = cfg["api_url"] or DEFAULT_API_URL
        self._session_id = session_id or ""

        # Prefer gateway-provided user_id (platform user); fall back to env for CLI.
        raw_uid = (kwargs.get("user_id") or cfg["user_id"] or "").strip()
        self._user_id = self._coerce_uuid(raw_uid) if raw_uid else self._synthetic_user_id()

        self._http = _PlurimHTTP(self._api_url, self._api_key)

    @staticmethod
    def _coerce_uuid(value: str) -> str:
        """Accept a UUID directly; otherwise derive a deterministic UUID5 from the string."""
        try:
            return str(uuid.UUID(value))
        except ValueError:
            return str(uuid.uuid5(uuid.NAMESPACE_URL, f"plurum:user:{value}"))

    @staticmethod
    def _synthetic_user_id() -> str:
        """Fallback: derive from $USER + hostname so it's stable for a single machine."""
        host = os.uname().nodename if hasattr(os, "uname") else "unknown"
        user = os.environ.get("USER") or os.environ.get("USERNAME") or "default"
        return str(uuid.uuid5(uuid.NAMESPACE_URL, f"plurum:local:{user}@{host}"))

    # -- System prompt -------------------------------------------------------

    def system_prompt_block(self) -> str:
        return (
            "# Plurum Memory\n"
            "Active. You have access to two layers:\n"
            "- **Personal memory** (this user): use `plurum_recall` to search their facts/preferences, "
            "`plurum_conclude` to store new facts.\n"
            "- **Collective memory** (every agent globally): use `plurum_search` to find experiences "
            "of agents who solved similar problems. Prefer acquiring collective knowledge over reasoning from scratch.\n"
            "Call `plurum_profile` at task start for a combined view."
        )

    # -- Prefetch ------------------------------------------------------------

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        if self._prefetch_thread and self._prefetch_thread.is_alive():
            self._prefetch_thread.join(timeout=3.0)
        with self._prefetch_lock:
            result = self._prefetch_result
            self._prefetch_result = ""
        if not result:
            return ""
        return f"## Plurum Context\n{result}"

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        if not self._http or not query or not query.strip():
            return

        def _run():
            try:
                profile = self._http.get(
                    "/api/v1/profile",
                    params={"user_id": self._user_id, "query": query, "memory_limit": 5, "experience_limit": 3},
                )
                formatted = self._format_profile(profile or {})
                if formatted:
                    with self._prefetch_lock:
                        self._prefetch_result = formatted
            except Exception as e:
                logger.debug("Plurum prefetch failed: %s", e)

        self._prefetch_thread = threading.Thread(target=_run, daemon=True, name="plurum-prefetch")
        self._prefetch_thread.start()

    @staticmethod
    def _format_profile(profile: dict) -> str:
        mems = profile.get("memories") or []
        exps = profile.get("experiences") or []
        out: List[str] = []
        if mems:
            out.append("**Personal memories:**")
            for m in mems[:8]:
                out.append(f"- {m.get('content', '').strip()}")
        if exps:
            out.append("\n**Relevant collective experiences:**")
            for e in exps[:5]:
                goal = e.get("goal") or ""
                sid = e.get("short_id") or ""
                trust = e.get("trust_score") or e.get("quality_score") or 0
                rate = e.get("success_rate") or 0
                out.append(f"- [{sid}] {goal}  _(trust {trust:.2f}, success {rate:.0%})_")
        return "\n".join(out).strip()

    # -- Sync turn -----------------------------------------------------------

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "") -> None:
        """Run LLM fact extraction against the turn, non-blocking."""
        if not self._http or not user_content or not assistant_content:
            return

        def _run():
            try:
                self._http.post(
                    "/api/v1/memories/extract",
                    params={"user_id": self._user_id},
                    body={
                        "user_content": user_content[:6000],
                        "assistant_content": assistant_content[:6000],
                    },
                )
            except Exception as e:
                logger.debug("Plurum sync_turn failed: %s", e)

        if self._sync_thread and self._sync_thread.is_alive():
            self._sync_thread.join(timeout=5.0)
        self._sync_thread = threading.Thread(target=_run, daemon=True, name="plurum-sync")
        self._sync_thread.start()

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        """Final extraction pass at session end. Picks the last user/assistant pair."""
        if not self._http or not messages:
            return
        last_user = next(
            (m.get("content", "") for m in reversed(messages) if m.get("role") == "user"), ""
        )
        last_assistant = next(
            (m.get("content", "") for m in reversed(messages) if m.get("role") == "assistant"), ""
        )
        if last_user and last_assistant:
            self.sync_turn(last_user, last_assistant)

    # -- Tools ---------------------------------------------------------------

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [PROFILE_SCHEMA, SEARCH_SCHEMA, RECALL_SCHEMA, CONCLUDE_SCHEMA]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        if not self._http:
            return tool_error("Plurum not initialized — missing PLURUM_API_KEY")

        if tool_name == "plurum_profile":
            return self._tool_profile(args)
        if tool_name == "plurum_search":
            return self._tool_search(args)
        if tool_name == "plurum_recall":
            return self._tool_recall(args)
        if tool_name == "plurum_conclude":
            return self._tool_conclude(args)
        return tool_error(f"Unknown tool: {tool_name}")

    def _tool_profile(self, args: Dict[str, Any]) -> str:
        try:
            result = self._http.get(
                "/api/v1/profile",
                params={
                    "user_id": self._user_id,
                    "query": args.get("query"),
                    "memory_limit": 10,
                    "experience_limit": 5,
                },
            )
            return json.dumps(result or {})
        except Exception as e:
            return tool_error(str(e))

    def _tool_search(self, args: Dict[str, Any]) -> str:
        q = (args.get("query") or "").strip()
        if not q:
            return tool_error("Missing required parameter: query")
        try:
            limit = int(args.get("limit") or 5)
            result = self._http.post(
                "/api/v1/experiences/search",
                body={"query": q, "limit": max(1, min(limit, 20))},
            )
            if not result:
                return json.dumps({"results": [], "count": 0})
            hits = result.get("results") or []
            condensed = [
                {
                    "short_id": h.get("short_id"),
                    "goal": h.get("goal"),
                    "trust_score": h.get("trust_score") or h.get("quality_score") or 0,
                    "success_rate": h.get("success_rate") or 0,
                    "total_reports": h.get("total_reports") or 0,
                    "similarity": h.get("similarity") or 0,
                    "tags": h.get("tags") or [],
                }
                for h in hits
            ]
            return json.dumps({"results": condensed, "count": len(condensed)})
        except Exception as e:
            return tool_error(str(e))

    def _tool_recall(self, args: Dict[str, Any]) -> str:
        q = (args.get("query") or "").strip()
        if not q:
            return tool_error("Missing required parameter: query")
        try:
            limit = int(args.get("limit") or 10)
            result = self._http.post(
                "/api/v1/memories/search",
                params={"user_id": self._user_id},
                body={"query": q, "limit": max(1, min(limit, 50))},
            )
            if not result:
                return json.dumps({"results": [], "count": 0})
            hits = result.get("results") or []
            condensed = [
                {"content": (h.get("content") or ""), "memory_type": h.get("memory_type"), "importance": h.get("importance")}
                if isinstance(h, dict) and "content" in h
                else h  # some rows come back in nested form — pass through
                for h in hits
            ]
            return json.dumps({"results": condensed, "count": len(condensed)})
        except Exception as e:
            return tool_error(str(e))

    def _tool_conclude(self, args: Dict[str, Any]) -> str:
        content = (args.get("content") or "").strip()
        if not content:
            return tool_error("Missing required parameter: content")
        try:
            body = {
                "content": content,
                "memory_type": args.get("memory_type") or "fact",
                "importance": args.get("importance") or "medium",
            }
            result = self._http.post(
                "/api/v1/memories",
                params={"user_id": self._user_id},
                body=body,
            )
            return json.dumps({"stored": True, "short_id": (result or {}).get("short_id")})
        except Exception as e:
            return tool_error(str(e))

    # -- Shutdown ------------------------------------------------------------

    def shutdown(self) -> None:
        for t in (self._prefetch_thread, self._sync_thread):
            if t and t.is_alive():
                t.join(timeout=5.0)


# ---------------------------------------------------------------------------
# Plugin registration
# ---------------------------------------------------------------------------

def register(ctx) -> None:
    """Register Plurum as Hermes's memory provider."""
    ctx.register_memory_provider(PlurimMemoryProvider())
