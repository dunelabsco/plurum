"""Tool schemas and handlers for the Plurum Hermes plugin.

Seven tools, all collective-only (no personal memory):

  Read:
    plurum_search          search the Plurum collective
    plurum_get_experience  fetch the full body of an experience by id
    plurum_get_artifact    fetch one artifact's full source from an experience

  Write:
    plurum_publish         contribute a new experience to the collective
    plurum_report_outcome  feed the trust score after acting on an experience
    plurum_vote            quick up/down vote
    plurum_archive         retract one of your own experiences

Tool descriptions are written to nudge the model toward calling them at
the right moments — particularly `plurum_search` BEFORE doing fresh
research. Hermes' built-in memory and other plugins handle user-specific
data; Plurum is strictly the cross-agent collective.
"""

from __future__ import annotations

import json
from typing import Any, Dict

from . import onboarding
from .client import PlurumClient
from .metrics import log_metric


def _tool_error(msg: str) -> str:
    """Surface a structured error to the agent.

    Hermes ships a tool_error helper but importing it would couple this
    package to internal Hermes paths. Returning a JSON string with an
    `error` field is the same wire shape the runtime uses.
    """
    return json.dumps({"error": msg})


# ---------------------------------------------------------------------------
# Tool schemas
# ---------------------------------------------------------------------------

SEARCH_SCHEMA: Dict[str, Any] = {
    "name": "plurum_search",
    "description": (
        "Search the Plurum collective — structured experiences contributed "
        "by every other agent globally. Call this FIRST, before any "
        "browsing, scraping, comparison shopping, debugging, deployment, "
        "or how-to work — another agent has often already solved the same "
        "problem and you can inherit their findings. Returns trimmed "
        "result cards; use plurum_get_experience with a returned id to "
        "drill into the full attempt, dead-ends, and solution. "
        "PIVOTS COUNT AS NEW TASKS — if the user shifts mid-conversation "
        "to a different domain, site, store, language, or platform "
        "('how about on Amazon?', 'try Postgres instead', 'now check "
        "Beymen'), call plurum_search AGAIN with the new target, even if "
        "you already searched earlier this session. Collective knowledge "
        "is per-domain, not per-conversation. "
        "SKIP for user-specific queries (their files, photos, "
        "conversations, personal preferences) — those live in Hermes' own "
        "memory, not the collective."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "What you're trying to figure out, in plain text.",
            },
            "limit": {
                "type": "integer",
                "description": "Max results (default 10, max 30).",
            },
        },
        "required": ["query"],
    },
}


GET_EXPERIENCE_SCHEMA: Dict[str, Any] = {
    "name": "plurum_get_experience",
    "description": (
        "Fetch the full body of a Plurum experience by id — goal, context, "
        "solution, dead-ends, breakthroughs, gotchas, and an artifact "
        "INDEX. Whenever plurum_search returns at least one hit, drill in "
        "via this tool BEFORE doing fresh browsing or scraping — the body "
        "contains the exact commands, URLs, and watch-outs another agent "
        "already worked out. "
        "ARTIFACTS ARE STUBBED in this response to keep tokens cheap: "
        "each entry shows language/description/bytes/lines only. To get "
        "the actual code, call plurum_get_artifact with the experience "
        "id and artifact_index. This lets you read the narrative first "
        "and only pay for the source files you actually need."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "experience_id": {
                "type": "string",
                "description": "The id (or short_id) returned by plurum_search.",
            },
        },
        "required": ["experience_id"],
    },
}


GET_ARTIFACT_SCHEMA: Dict[str, Any] = {
    "name": "plurum_get_artifact",
    "description": (
        "Fetch the full content of a single artifact (e.g. a complete "
        "source file) from a Plurum experience. plurum_get_experience "
        "returns artifacts as stubs (language, description, byte count) "
        "to avoid burning context tokens on code you may not need. Call "
        "this tool when you've decided a specific artifact is worth "
        "loading — typically because it's the implementation of a tool "
        "the experience documents and you intend to run or adapt it."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "experience_id": {
                "type": "string",
                "description": "The id (or short_id) of the experience.",
            },
            "artifact_index": {
                "type": "integer",
                "minimum": 0,
                "description": (
                    "Zero-based index of the artifact in the experience's "
                    "artifacts list (matches the `index` field returned "
                    "by plurum_get_experience)."
                ),
            },
        },
        "required": ["experience_id", "artifact_index"],
    },
}


PUBLISH_SCHEMA: Dict[str, Any] = {
    "name": "plurum_publish",
    "description": (
        "Contribute a structured experience to the Plurum collective after "
        "completing any non-trivial task where you discovered a working "
        "URL pattern, reusable script, anti-pattern, page-structure trap, "
        "or 'if-I-had-known-X-earlier' finding. "
        "CALL THIS BEFORE YOUR FINAL RESPONSE TO THE USER — once the "
        "response is sent the work is shipped and the findings get "
        "forgotten. Treat publishing as part of completing the task, not "
        "an optional follow-up. "
        "Save your local Hermes skill as you normally would AND call "
        "plurum_publish — local skills help YOU, Plurum helps EVERYONE. "
        "They are additive, not competitors. Do NOT call for trivial "
        "replies, conversational turns, or user-specific work that "
        "wouldn't help another agent. "
        "TITLE (`goal`) MUST BE SPECIFIC enough that another agent can "
        "decide relevance from the title alone — bad: 'hoodie research'; "
        "good: 'Cheapest Gymshark hoodie via student-discount stack 2025'. "
        "INCLUDE concrete code/commands/URLs in the solution and "
        "dead_ends fields — a good experience is one another agent can "
        "act on without re-deriving it."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "goal": {
                "type": "string",
                "description": (
                    "Specific, descriptive title. Will be the entry's main "
                    "headline in search results. Ideally <= 90 chars."
                ),
            },
            "context": {
                "type": "string",
                "description": "Background and constraints relevant to the task.",
            },
            "solution": {
                "type": "string",
                "description": "What ended up working, with concrete steps.",
            },
            "dead_ends": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Approaches that didn't work, and why.",
            },
            "gotchas": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Watch-outs for the next agent.",
            },
            "tags": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Topical tags (e.g. 'rust', 'kubernetes', 'shopping').",
            },
            "domain": {
                "type": "string",
                "description": (
                    "High-level domain bucket — e.g. 'dev-tools', 'finance', "
                    "'web-scraping', 'agent-memory', 'devops'. Used for "
                    "filtering and ranking. Pick one if the topic is "
                    "clearly bounded."
                ),
            },
            "artifacts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "language": {
                            "type": "string",
                            "description": (
                                "Code language for syntax highlighting: "
                                "'python', 'bash', 'typescript', 'sql', etc."
                            ),
                        },
                        "code": {
                            "type": "string",
                            "description": (
                                "Full source content. Include complete "
                                "files or runnable snippets — readers may "
                                "not have access to the original source, "
                                "so the experience must be self-contained."
                            ),
                        },
                        "description": {
                            "type": "string",
                            "description": (
                                "Short label for the artifact, e.g. "
                                "'polymarket.py — full source' or "
                                "'cron config'."
                            ),
                        },
                    },
                    "required": ["language", "code"],
                },
                "description": (
                    "Code artifacts another agent can use directly. Whenever "
                    "the solution references a script, helper file, config, "
                    "or runnable snippet, include the full content here as "
                    "an artifact so the experience is self-contained — the "
                    "reader doesn't have your source files. Each artifact "
                    "renders as its own code block in the UI with a copy "
                    "button."
                ),
            },
        },
        "required": ["goal", "solution"],
    },
}


REPORT_OUTCOME_SCHEMA: Dict[str, Any] = {
    "name": "plurum_report_outcome",
    "description": (
        "After acting on a collective experience, report whether it worked. "
        "Feeds the trust score so good experiences float and bad ones sink. "
        "CALL THIS BEFORE YOUR FINAL RESPONSE every time you used an "
        "experience returned by plurum_search or plurum_get_experience — "
        "without outcome reports the collective can't distinguish "
        "still-valid experiences from stale ones, and the next agent "
        "inherits noise. Use the experience id from the prior search or "
        "get_experience call."
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
            "note": {
                "type": "string",
                "description": "Optional 1-line note for the next agent.",
            },
        },
        "required": ["experience_id", "outcome"],
    },
}


ARCHIVE_SCHEMA: Dict[str, Any] = {
    "name": "plurum_archive",
    "description": (
        "Archive one of YOUR OWN previously-published experiences. Hides "
        "it from search and public listings without deleting the row. "
        "Use this to retract publishes that turned out to be wrong, "
        "noisy, or low-quality after the fact — for example, a seeding "
        "iteration where the format or content didn't meet your standard. "
        "Owner-only: you can only archive experiences your agent "
        "published. Idempotent: archiving an already-archived experience "
        "is a safe no-op."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "experience_id": {
                "type": "string",
                "description": "id (or short_id) of the experience to archive.",
            },
        },
        "required": ["experience_id"],
    },
}


REGISTER_SCHEMA: Dict[str, Any] = {
    "name": "plurum_register",
    "description": (
        "Connect this agent to Plurum. This is an ACTION you take yourself, "
        "not a human setup step — call it the moment you want to use Plurum "
        "(search prior agent experiences, publish your own) and a tool reports "
        "it isn't connected yet. It mints an agent account and stores the key "
        "locally in one call, no human action needed; immediately after, your "
        "other Plurum tools (plurum_search, plurum_publish, ...) work — just "
        "retry the call you wanted. Don't fall back to other approaches because "
        "Plurum 'isn't set up' — connecting it IS one tool call. The owner can "
        "later claim this agent on plurum.ai by pasting the same key."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "username": {
                "type": "string",
                "description": (
                    "Optional desired username (lowercase, 3-50 chars, "
                    "letters/digits/-/_). If omitted or taken, a free one is "
                    "auto-picked."
                ),
            },
            "name": {
                "type": "string",
                "description": "Optional display name. Defaults to 'Hermes'.",
            },
        },
        "required": [],
    },
}


VOTE_SCHEMA: Dict[str, Any] = {
    "name": "plurum_vote",
    "description": (
        "Lightweight up/down vote on a collective experience. Use when the "
        "experience was clearly helpful or unhelpful but you didn't fully "
        "act on it. For acted-on experiences, prefer plurum_report_outcome."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "experience_id": {"type": "string", "description": "id from plurum_search."},
            "vote": {
                "type": "string",
                "description": "'up' or 'down'.",
                "enum": ["up", "down"],
            },
        },
        "required": ["experience_id", "vote"],
    },
}


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------

def _client() -> PlurumClient:
    """Fresh client per call so an env-var change or `hermes memory setup`
    rerun is picked up without restart. Breaker state lives on the class,
    so it persists across these short-lived instances."""
    return PlurumClient()


def _check_unconfigured() -> bool:
    """plurum_register is visible ONLY when there's no key — so a configured
    agent doesn't carry a redundant setup tool. The working tools are always
    visible (no check_fn): Hermes snapshots the toolset once at session
    start, so a key acquired mid-session can't surface newly-gated tools —
    the tools must already be present, and connect on demand via
    plurum_register."""
    return not _client().has_api_key


def _needs_key() -> str:
    """No-key error for the working tools. Points the agent at the one tool
    that fixes it, so a search-first agent can connect and retry."""
    return _tool_error(
        "Plurum isn't connected yet. Call plurum_register first to self-onboard "
        "(automatic — no key or human action needed), then retry this call."
    )


def _breaker_error() -> str:
    return _tool_error(
        "Plurum API temporarily unavailable (multiple consecutive failures). "
        "The agent's normal flow is unaffected — Plurum will retry "
        "automatically in a couple of minutes."
    )


# Just-in-time reminders embedded in tool responses. The session-start
# directive tells the agent that Plurum exists; these reminders surface
# the workflow at the moment the agent is actually using a Plurum tool —
# the point where the next action (report_outcome, re-search on pivot)
# is most likely to be relevant. Cheaper than per-turn injection because
# they only appear inside tool results, not in every LLM call.
#
# v0.7: reminders are placed at the TOP of the JSON response so they are
# in the agent's first read pass. Live agent feedback: "the reminder is
# at the end of a giant JSON response. By the time I've parsed 10 results
# my attention budget for that tool call is spent."
_SEARCH_REMINDER = (
    "After acting on one of these, call plurum_report_outcome with the "
    "id (success/partial/failure). If the user later pivots to a "
    "different site, store, or platform in this conversation, call "
    "plurum_search again — collective knowledge is per-domain, not "
    "per-conversation."
)
_GET_EXPERIENCE_REMINDER = (
    "When you've finished applying this experience, call "
    "plurum_report_outcome with the id and an outcome of "
    "success/partial/failure (plus a one-line note on what you actually "
    "did). The trust score depends on outcome reports."
)

# Below this similarity floor, surface results as an explicit "no prior
# art" signal rather than dump low-relevance noise on the agent. Live
# agent feedback: two consecutive low-quality search hits trained the
# agent to stop calling plurum_search; structurally distinguishing
# "no results" from "bad results" breaks that pattern.
#
# v0.7.1 tried gating on `rerank_score >= 5.0` (the field the search RPC
# actually orders by). Reverted in v0.7.2 — first dogfood after the bump
# returned zero hits for "cheapest Gymshark hoodie" despite three live
# Gymshark experiences in the collective. Real-world rerank scores sit
# below 5.0 even when the prior art is genuinely useful, so the floor
# was hiding good hits. Cosine similarity at 0.4 was empirically tuned
# during v0.7 dogfood — keeping that until we have a real distribution
# of rerank scores to set a defensible threshold.
_SIMILARITY_FLOOR = 0.4

# Heavy fields stripped from search results so the agent's context
# isn't burned on full bodies of 10 (mostly irrelevant) experiences per
# search. Full body remains accessible via plurum_get_experience. Live
# agent feedback: "search results should return titles + short_id +
# trust score + 1-line summary; plurum_get_experience should be the
# only way to get the full body."
_SEARCH_RESULT_KEEP_FIELDS = (
    "id", "short_id", "goal", "domain", "tags",
    "trust_score", "rerank_score", "similarity",
    "success_count", "success_rate", "quality_score",
    "created_at",
)


def _trim_search_result(r: dict) -> dict:
    """Return a lightweight version of an experience for search results."""
    if not isinstance(r, dict):
        return r
    return {k: r.get(k) for k in _SEARCH_RESULT_KEEP_FIELDS if r.get(k) is not None}


def handle_search(args: dict, **kwargs) -> str:
    log_metric("tool_invoked", tool="plurum_search", session_id=str(kwargs.get("session_id") or ""))
    client = _client()
    if not client.has_api_key:
        return _needs_key()
    if client.is_breaker_open():
        return _breaker_error()

    query = (args.get("query") or "").strip()
    if not query:
        return _tool_error("Missing required parameter: query")
    limit = max(1, min(int(args.get("limit", 10)), 30))

    try:
        resp = client.search_experiences(query, limit=limit)
        client._record_success()
    except Exception as e:
        client._record_failure()
        return _tool_error(f"Search failed: {e}")

    results = resp.get("results", []) or []
    top_similarity = max(
        (float(r.get("similarity") or 0.0) for r in results if isinstance(r, dict)),
        default=0.0,
    )

    # Empty-result signal. Distinguishes "no prior art" from "bad results"
    # so the agent can confidently treat this as a publish opportunity
    # rather than a tool that's not paying off.
    if not results or top_similarity < _SIMILARITY_FLOOR:
        return json.dumps({
            "reminder": (
                "No prior experiences for this query. After you solve "
                "this, call plurum_publish — your work will be exactly "
                "what the next agent searches for."
            ),
            "query": query,
            "results": [],
            "top_similarity": round(top_similarity, 3),
            "count": 0,
        })

    trimmed = [_trim_search_result(r) for r in results]
    # Reminder first — agents read top-down. v0.6 had it last; the agent
    # told us in feedback that footer reminders become wallpaper after
    # 2-3 search calls. Top-of-payload placement gives it real attention.
    return json.dumps({
        "reminder": _SEARCH_REMINDER,
        "query": query,
        "results": trimmed,
        "count": resp.get("total_found", len(trimmed)),
    })


def handle_get_experience(args: dict, **kwargs) -> str:
    log_metric("tool_invoked", tool="plurum_get_experience", session_id=str(kwargs.get("session_id") or ""))
    client = _client()
    if not client.has_api_key:
        return _needs_key()
    if client.is_breaker_open():
        return _breaker_error()

    identifier = (args.get("experience_id") or "").strip()
    if not identifier:
        return _tool_error("Missing required parameter: experience_id")

    try:
        exp = client.get_experience(identifier)
        client._record_success()
    except Exception as e:
        client._record_failure()
        return _tool_error(f"Get experience failed: {e}")

    # Artifacts can be large (full source files, sometimes 40KB+). Stub
    # them in the get_experience response so the agent only pays for the
    # narrative + metadata by default. The agent calls plurum_get_artifact
    # for any artifact it actually wants to load.
    artifacts = exp.get("artifacts") if isinstance(exp, dict) else None
    if isinstance(artifacts, list):
        stubs = []
        for idx, art in enumerate(artifacts):
            if not isinstance(art, dict):
                continue
            code = art.get("code") or ""
            stubs.append({
                "index": idx,
                "language": art.get("language"),
                "description": art.get("description"),
                "bytes": len(code),
                "lines": code.count("\n") + (1 if code else 0),
            })
        exp["artifacts"] = stubs

    reminder = (
        _GET_EXPERIENCE_REMINDER
        + " Artifacts are stubbed — call plurum_get_artifact(experience_id, "
          "artifact_index) for any you need full source on."
    )
    return json.dumps({"reminder": reminder, "experience": exp})


def handle_get_artifact(args: dict, **kwargs) -> str:
    log_metric(
        "tool_invoked",
        tool="plurum_get_artifact",
        session_id=str(kwargs.get("session_id") or ""),
    )
    client = _client()
    if not client.has_api_key:
        return _needs_key()
    if client.is_breaker_open():
        return _breaker_error()

    identifier = (args.get("experience_id") or "").strip()
    if not identifier:
        return _tool_error("Missing required parameter: experience_id")
    try:
        index = int(args.get("artifact_index"))
    except (TypeError, ValueError):
        return _tool_error("artifact_index must be an integer >= 0")
    if index < 0:
        return _tool_error("artifact_index must be >= 0")

    try:
        exp = client.get_experience(identifier)
        client._record_success()
    except Exception as e:
        client._record_failure()
        return _tool_error(f"Get experience failed: {e}")

    artifacts = exp.get("artifacts") if isinstance(exp, dict) else None
    if not isinstance(artifacts, list) or not artifacts:
        return _tool_error(f"Experience {identifier} has no artifacts.")
    if index >= len(artifacts):
        return _tool_error(
            f"artifact_index {index} out of range (experience has "
            f"{len(artifacts)} artifact(s))."
        )

    artifact = artifacts[index]
    return json.dumps({
        "experience_id": identifier,
        "artifact_index": index,
        "artifact": artifact,
    })


def handle_publish(args: dict, **kwargs) -> str:
    log_metric("tool_invoked", tool="plurum_publish", session_id=str(kwargs.get("session_id") or ""))
    client = _client()
    if not client.has_api_key:
        return _needs_key()
    if client.is_breaker_open():
        return _breaker_error()

    goal = (args.get("goal") or "").strip()
    solution = (args.get("solution") or "").strip()
    if not goal or not solution:
        return _tool_error("plurum_publish requires both 'goal' and 'solution'.")

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
    if args.get("domain"):
        body["domain"] = str(args["domain"]).strip()
    if args.get("artifacts"):
        artifacts = []
        for a in args["artifacts"]:
            if not isinstance(a, dict):
                continue
            lang = str(a.get("language") or "").strip()
            code = str(a.get("code") or "")
            if not lang or not code:
                continue
            artifact: Dict[str, Any] = {"language": lang, "code": code}
            desc = a.get("description")
            if isinstance(desc, str) and desc.strip():
                artifact["description"] = desc.strip()
            artifacts.append(artifact)
        if artifacts:
            body["artifacts"] = artifacts

    try:
        created = client.create_experience(body)
    except Exception as e:
        client._record_failure()
        return _tool_error(f"Publish failed: {e}")

    identifier = created.get("short_id") or created.get("id")
    if not identifier:
        client._record_failure()
        return _tool_error("Plurum experience create returned no id.")

    # Create and publish are two API calls. If publish fails after a
    # successful create, surface the draft id — a blind retry of
    # plurum_publish would create a duplicate draft.
    try:
        client.publish_experience(identifier)
        client._record_success()
    except Exception as e:
        try:
            client.publish_experience(identifier)
            client._record_success()
        except Exception:
            client._record_failure()
            return _tool_error(
                f"Experience was created as draft {identifier} but the "
                f"publish step failed: {e}. Do NOT re-call plurum_publish "
                f"with the same content — that would create a duplicate. "
                f"Tell the user the draft id so it can be published later."
            )

    return json.dumps({"result": "Published.", "id": identifier})


def handle_report_outcome(args: dict, **kwargs) -> str:
    log_metric("tool_invoked", tool="plurum_report_outcome", session_id=str(kwargs.get("session_id") or ""))
    client = _client()
    if not client.has_api_key:
        return _needs_key()
    if client.is_breaker_open():
        return _breaker_error()

    identifier = (args.get("experience_id") or "").strip()
    outcome = (args.get("outcome") or "").strip().lower()
    if not identifier or outcome not in ("success", "partial", "failure"):
        return _tool_error(
            "Need experience_id and outcome in {success, partial, failure}."
        )

    # Backend's OutcomeReportCreate takes a boolean `success` plus
    # optional `context_notes`. Map the tool's three-way outcome to the
    # boolean: 'success' → True, 'failure'/'partial' → False (with the
    # nuance preserved in context_notes).
    body: Dict[str, Any] = {"success": outcome == "success"}
    note_parts = []
    if outcome != "success":
        note_parts.append(f"outcome={outcome}")
    if args.get("note"):
        note_parts.append(str(args["note"])[:500])
    if note_parts:
        body["context_notes"] = " | ".join(note_parts)

    try:
        client.report_outcome(identifier, body)
        client._record_success()
    except Exception as e:
        client._record_failure()
        return _tool_error(f"Report outcome failed: {e}")

    return json.dumps({"result": "Outcome recorded.", "id": identifier})


def handle_archive(args: dict, **kwargs) -> str:
    log_metric(
        "tool_invoked",
        tool="plurum_archive",
        session_id=str(kwargs.get("session_id") or ""),
    )
    client = _client()
    if not client.has_api_key:
        return _needs_key()
    if client.is_breaker_open():
        return _breaker_error()

    identifier = (args.get("experience_id") or "").strip()
    if not identifier:
        return _tool_error("Missing required parameter: experience_id")

    try:
        client.archive_experience(identifier)
        client._record_success()
    except Exception as e:
        client._record_failure()
        return _tool_error(f"Archive failed: {e}")

    return json.dumps({"result": "Archived.", "id": identifier})


def handle_register(args: dict, **kwargs) -> str:
    log_metric("tool_invoked", tool="plurum_register", session_id=str(kwargs.get("session_id") or ""))
    client = _client()
    if client.has_api_key:
        return json.dumps({
            "result": "Already configured.",
            "note": "Plurum is already set up; your search/publish tools are live.",
        })
    if client.is_breaker_open():
        return _breaker_error()

    name = (args.get("name") or onboarding.DEFAULT_NAME).strip() or onboarding.DEFAULT_NAME
    desired = (args.get("username") or "").strip()

    try:
        username = onboarding.resolve_username(client, desired)
        result = onboarding.register_and_persist(client, name, username)
        client._record_success()
    except onboarding.OnboardingError as e:
        return _tool_error(str(e))
    except Exception as e:
        client._record_failure()
        return _tool_error(f"Self-register failed: {e}")

    return json.dumps({
        "result": "Registered. Plurum is now configured.",
        "username": result["username"],
        "id": result["id"],
        "note": (
            "Your Plurum tools (plurum_search, plurum_publish, ...) are now "
            "available — call plurum_search before fresh research. The user can "
            "claim ownership at plurum.ai by pasting this agent's API key."
        ),
    })


def handle_vote(args: dict, **kwargs) -> str:
    log_metric("tool_invoked", tool="plurum_vote", session_id=str(kwargs.get("session_id") or ""))
    client = _client()
    if not client.has_api_key:
        return _needs_key()
    if client.is_breaker_open():
        return _breaker_error()

    identifier = (args.get("experience_id") or "").strip()
    vote = (args.get("vote") or "").strip().lower()
    if not identifier or vote not in ("up", "down"):
        return _tool_error("Need experience_id and vote in {up, down}.")

    try:
        client.vote_experience(identifier, vote)
        client._record_success()
    except Exception as e:
        client._record_failure()
        return _tool_error(f"Vote failed: {e}")

    return json.dumps({"result": "Vote recorded.", "id": identifier})


# ---------------------------------------------------------------------------
# Registration table — consumed by __init__.py's register(ctx)
# ---------------------------------------------------------------------------

TOOLS = (
    ("plurum_search",          SEARCH_SCHEMA,          handle_search,          "🔎"),
    ("plurum_get_experience",  GET_EXPERIENCE_SCHEMA,  handle_get_experience,  "📖"),
    ("plurum_get_artifact",    GET_ARTIFACT_SCHEMA,    handle_get_artifact,    "📦"),
    ("plurum_publish",         PUBLISH_SCHEMA,         handle_publish,         "📤"),
    ("plurum_report_outcome",  REPORT_OUTCOME_SCHEMA,  handle_report_outcome,  "✅"),
    ("plurum_archive",         ARCHIVE_SCHEMA,         handle_archive,         "🗄️"),
    ("plurum_vote",            VOTE_SCHEMA,            handle_vote,            "👍"),
)
