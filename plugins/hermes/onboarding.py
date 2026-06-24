"""Shared self-registration logic, used by both the plurum_register tool
and the `hermes plurum setup` CLI command. Keeping it here means the agent
path and the human path mint accounts and persist keys identically."""

from __future__ import annotations

from pathlib import Path

from .client import save_config

DEFAULT_NAME = "Hermes"
DEFAULT_SEED = "hermes"


class OnboardingError(Exception):
    """Raised when self-registration cannot complete (no free username,
    backend rejected the create, or no key came back)."""


def _hermes_home() -> Path:
    """Resolve ~/.hermes (or HERMES_HOME). Falls back to the home dir when
    hermes_constants isn't importable (standalone tests / linting)."""
    try:
        from hermes_constants import get_hermes_home
        return get_hermes_home()
    except Exception:
        return Path.home() / ".hermes"


def resolve_username(client, desired: str = "") -> str:
    """Return a free username: the desired one if available, else the first
    suggestion the backend returns."""
    seed = (desired or DEFAULT_SEED).strip()
    resp = client.check_username(seed) or {}
    if resp.get("available"):
        return seed.lower()
    for s in resp.get("suggestions") or []:
        if s:
            return s
    raise OnboardingError(
        "Could not find a free username automatically. Try a different name."
    )


def register_and_persist(client, name: str, username: str) -> dict:
    """Register the agent and write the key to ~/.hermes/plurum.json."""
    created = client.register_agent(name=name, username=username) or {}
    api_key = created.get("api_key")
    if not api_key:
        raise OnboardingError("Registration returned no api_key.")
    save_config({"api_key": api_key}, _hermes_home())
    return {
        "id": created.get("id"),
        "name": created.get("name") or name,
        "username": username,
        "api_key": api_key,
    }
