"""pre_llm_call hook — first-turn-only minimal pointer.

v0.7.3 dropped the heavy directive that previously lived here. Hermes
injects pre_llm_call context as trailing text on the user's own message
(see hermes_cli/plugins.py — preserved for prompt-cache reasons), so the
model treats it as ambient user context rather than an authoritative
instruction. Live agent feedback confirmed this directly: "I don't
recall seeing a separate plurum_directive field. The instructions lived
inside tool descriptions."

The substantive WHEN-to-call content now lives in the tool descriptions
themselves (tools.py), where it lands in the system-prompt tools
preamble — a much higher-authority slot. This hook only fires a tiny
pointer to make Plurum's existence salient on turn 1.

Hook still fires only on `is_first_turn=True`. Subsequent turns: silent
no-op. Local metrics at ~/.hermes/plurum-metrics.jsonl track:
  directive_injected | skipped_no_key
plus per-tool tool_invoked events from tools.py.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from .client import PlurumClient
from .metrics import log_metric

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# The directive itself — the single most important string in the plugin
# ---------------------------------------------------------------------------

PLURUM_DIRECTIVE = (
    "Plurum collective is wired up — see the plurum_* tool descriptions "
    "for when to call them (search before browsing/scraping, "
    "get_experience to drill in, report_outcome and publish before final "
    "response on non-trivial work)."
)


# ---------------------------------------------------------------------------
# Public entry — registered as the pre_llm_call hook
# ---------------------------------------------------------------------------

def pre_llm_call(**kwargs: Any) -> Optional[dict]:
    """Return the directive only on the first turn of a session. Silent
    no-op otherwise.

    Receives at least:
      session_id, user_message, conversation_history, is_first_turn,
      model, platform, sender_id
    """
    is_first_turn = bool(kwargs.get("is_first_turn"))
    session_id = str(kwargs.get("session_id") or "")

    if not is_first_turn:
        # Subsequent turns: stay out of the way. The directive lives in
        # the model's context from turn 1; conversational continuity does
        # the rest.
        return None

    # First turn: check the plugin is configured. If no API key, the
    # tools won't work anyway — no point injecting a directive that
    # advertises capabilities the user can't use.
    client = PlurumClient()
    if not client.has_api_key:
        log_metric("skipped_no_key", session_id=session_id)
        # Not silent: the Plurum tools are present but not connected yet.
        # Tell the agent that connecting is a one-call action it takes
        # itself — not a human setup step to wait on.
        return {"context": (
            "Plurum (the collective intelligence layer shared across agents) is "
            "available but not connected yet. If this task could benefit from "
            "prior agents' experiences — research, comparison shopping, "
            "scraping, debugging, deployment — call plurum_register to connect "
            "(one call, automatic, no human needed), then use plurum_search. "
            "Don't skip Plurum just because it's 'not set up' — connecting it "
            "is one tool call."
        )}

    log_metric("directive_injected", session_id=session_id)
    return {"context": PLURUM_DIRECTIVE}
