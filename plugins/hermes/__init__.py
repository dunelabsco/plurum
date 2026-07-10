"""Plurum Hermes plugin — collective intelligence for AI agents.

Pure standalone plugin. No memory slot squatting, no per-user fact
extraction. Seven tools that let the agent search, drill into, contribute
to, rate, and retract experiences in the Plurum collective.

Install (Git):
    hermes plugins install dunelabsco/plurum-hermes
    hermes plugins enable plurum

Configure:
    PLURUM_API_KEY in ~/.hermes/.env  (get one at https://plurum.ai)
    Optional: PLURUM_API_URL to point at a self-hosted instance.

Or run `hermes memory setup` and pick `plurum` if Hermes' generic
plugin-config wizard surfaces this plugin's schema.
"""

from __future__ import annotations

import logging

from .client import save_config  # noqa: F401  (re-exported for setup wizard)
from .hook import pre_llm_call as _pre_llm_call_handler
from .tools import (
    TOOLS, REGISTER_SCHEMA, handle_register, _check_unconfigured,
)
from .setup_cmd import setup_cli, run_command

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Hermes setup-wizard schema (optional but professional)
# ---------------------------------------------------------------------------

def get_config_schema():
    """Schema consumed by `hermes memory setup`-style wizards.

    Returning a list of fields lets Hermes prompt the user interactively
    instead of forcing them to edit ~/.hermes/.env by hand.
    """
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
            "description": "API base URL (advanced — leave default unless self-hosting)",
            "default": "https://api.plurum.ai",
            "env_var": "PLURUM_API_URL",
        },
    ]


# ---------------------------------------------------------------------------
# Plugin entry point
# ---------------------------------------------------------------------------

def register(ctx) -> None:
    """Register all tools and the first-turn directive hook.

    Called once at plugin load. The working tools are always visible; with
    no API key they return a "call plurum_register first" error the agent
    can act on in-session (Hermes snapshots the toolset at session start, so
    key-gated tools could never appear after a mid-session self-register).
    `plurum_register` itself is shown only when there's no key.

    The pre_llm_call hook fires only on the first turn of each session
    and injects a single directive telling the agent that Plurum exists
    and when to use it. After that, every subsequent turn is a no-op —
    the agent decides when to call plurum_*. No per-turn surveillance,
    no LLM gate, no silent search-and-inject. Trust the agent.

    For the v0.2.0 per-turn auto-inject design, see the
    `feat/auto-inject-hook` branch.
    """
    # Working tools are ALWAYS visible (no check_fn). Hermes snapshots the
    # agent's toolset once at session start, so gating these on the key would
    # mean an agent that self-registers mid-session never sees them appear.
    # Instead they're always present and return a "call plurum_register first"
    # error until a key exists — which the agent can fix in-session.
    for name, schema, handler, emoji in TOOLS:
        ctx.register_tool(
            name=name,
            toolset="plurum",
            schema=schema,
            handler=handler,
            check_fn=None,
            emoji=emoji,
        )

    # Self-registration. Inverse-gated: shown ONLY when there's no key, so a
    # configured agent doesn't carry a redundant setup tool.
    ctx.register_tool(
        name="plurum_register",
        toolset="plurum",
        schema=REGISTER_SCHEMA,
        handler=handle_register,
        check_fn=_check_unconfigured,
        emoji="🔑",
    )

    # Terminal onboarding: `hermes plurum setup`.
    try:
        ctx.register_cli_command(
            name="plurum",
            help="Connect Plurum (paste a key or self-register)",
            setup_fn=setup_cli,
            handler_fn=run_command,
            description="Set up the Plurum collective for this Hermes agent.",
        )
    except Exception as e:
        logger.debug("Plurum CLI command registration skipped: %s", e)

    ctx.register_hook("pre_llm_call", _pre_llm_call_handler)

    logger.info(
        "Plurum plugin registered (%d tools + setup command + first-turn directive)",
        len(TOOLS) + 1,
    )
