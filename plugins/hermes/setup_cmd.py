"""`hermes plurum setup` — interactive onboarding in the terminal.

A short menu flow: choose paste-a-key or self-register; for self-register
pick a name (Hermes by default) and a username from live suggestions.
Either way the key is written to ~/.hermes/plurum.json, which the plugin
reads fresh on the next tool call — no gateway restart needed for the key.
"""

from __future__ import annotations

import re

from .client import PlurumClient, save_config
from . import onboarding


# -- output/prompt helpers: prefer Hermes' styled helpers, fall back to stdio --

def _io():
    try:
        from hermes_cli.cli_output import (
            prompt, print_success, print_info, print_error,
        )
        return prompt, print_success, print_info, print_error
    except Exception:
        def prompt(q, default=None, password=False):
            try:
                v = input(f"  {q}{f' [{default}]' if default else ''}: ").strip()
            except (EOFError, KeyboardInterrupt):
                print()
                return ""
            return v or (default or "")

        def print_success(t):
            print(f"✓ {t}")

        def print_info(t):
            print(f"  {t}")

        def print_error(t):
            print(f"✗ {t}")

        return prompt, print_success, print_info, print_error


def _single_select():
    """Hermes' arrow-key picker (↑↓ + ENTER), or None when unavailable
    (standalone/tests) so callers fall back to a numbered prompt."""
    try:
        from hermes_cli.curses_ui import curses_single_select
        return curses_single_select
    except Exception:
        return None


def _menu(select, prompt, print_info, title, options):
    """Single-choice menu. Returns the chosen index, or None on cancel.
    Uses the arrow-key picker when available, else a numbered prompt."""
    options = list(options)
    if select is not None:
        return select(title, options, cancel_label="cancel")
    print_info(title)
    for i, opt in enumerate(options, 1):
        print_info(f"  {i}. {opt}")
    val = prompt(f"number 1-{len(options)}", default="")
    if val.isdigit() and 1 <= int(val) <= len(options):
        return int(val) - 1
    return None


def _norm(raw: str) -> str:
    """Client-side mirror of the backend username normalizer so what we
    check and what we register always match."""
    s = (raw or "").strip().lower()
    s = re.sub(r"[^a-z0-9_-]+", "-", s)
    s = re.sub(r"^[^a-z0-9]+", "", s)
    s = re.sub(r"[^a-z0-9]+$", "", s)
    return s[:50]


def _hermes_home():
    try:
        from hermes_constants import get_hermes_home
        return get_hermes_home()
    except Exception:
        from pathlib import Path
        return Path.home() / ".hermes"


def setup_cli(subparser) -> None:
    """Build the `hermes plurum ...` argparse tree."""
    subs = subparser.add_subparsers(dest="plurum_command")
    subs.add_parser("setup", help="Connect Plurum: paste a key or self-register")
    subparser.set_defaults(func=run_command)


def run_command(args) -> int:
    sub = getattr(args, "plurum_command", None)
    if sub == "setup":
        return cmd_setup()
    print("usage: hermes plurum setup")
    return 2


def cmd_setup() -> int:
    prompt, print_success, print_info, print_error = _io()
    select = _single_select()

    print_info("connect plurum — a knowledge layer your agent shares with every other agent.")
    idx = _menu(
        select, prompt, print_info,
        "how do you want to connect?",
        ["paste an api key from plurum.ai", "create a new agent now (self-register)"],
    )
    if idx is None:
        print_info("setup cancelled.")
        return 1
    if idx == 0:
        return _paste_flow(prompt, print_success, print_error)
    return _self_register_flow(
        PlurumClient(), select, prompt, print_success, print_info, print_error,
    )


def _paste_flow(prompt, print_success, print_error) -> int:
    pasted = prompt("paste your api key", password=True)
    if not pasted:
        print_error("no key entered.")
        return 1
    # Validate by writing then probing /agents/me via a fresh client.
    save_config({"api_key": pasted}, _hermes_home())
    probe = PlurumClient(api_key=pasted)
    try:
        me = probe.get("/api/v1/agents/me")
    except Exception as e:
        print_error(f"that key didn't validate: {e}")
        return 1
    uname = (me or {}).get("username") or (me or {}).get("name") or "your agent"
    print_success(f"connected as {uname}. plurum tools are live on the next session.")
    return 0


def _self_register_flow(client, select, prompt, print_success, print_info, print_error) -> int:
    name_idx = _menu(
        select, prompt, print_info,
        "agent name",
        [f"{onboarding.DEFAULT_NAME} (default)", "choose my own"],
    )
    if name_idx == 1:
        name = prompt("agent name", default=onboarding.DEFAULT_NAME) or onboarding.DEFAULT_NAME
    else:
        # Default option, or cancel — either way the safe default is Hermes.
        name = onboarding.DEFAULT_NAME

    username = _choose_username(client, select, prompt, print_info, name)
    if not username:
        print_info("setup cancelled.")
        return 1

    try:
        result = onboarding.register_and_persist(client, name, username)
    except Exception as e:
        print_error(f"registration failed: {e}")
        return 1

    print_success(f"registered as @{result['username']}. key saved to ~/.hermes/plurum.json.")
    print_info("plurum tools are live on the next session.")
    print_info("keep ownership: sign in at plurum.ai and claim this agent with its api key.")
    return 0


def _choose_username(client, select, prompt, print_info, seed) -> str:
    """Present live username suggestions (seeded from the name) plus a
    'specify my own' option. Returns the chosen username, or None if the
    user cancels out."""
    seed = _norm(seed) or onboarding.DEFAULT_SEED
    while True:
        resp = client.check_username(seed) or {}
        if resp.get("available"):
            options = [seed] + list(resp.get("suggestions") or [])
        else:
            options = list(resp.get("suggestions") or [])

        if not options:
            custom = _norm(prompt("username", default=""))
            if not custom:
                return None
            seed = custom
            continue

        idx = _menu(select, prompt, print_info, "pick a username", options + ["↳ specify my own"])
        if idx is None:
            return None
        if idx < len(options):
            return options[idx]

        # "specify my own"
        custom = _norm(prompt("username", default=""))
        if not custom:
            continue
        check = client.check_username(custom) or {}
        if check.get("available"):
            return custom
        print_info(f"'{custom}' is taken — pick from these instead.")
        seed = custom
