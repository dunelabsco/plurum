"""Packaging invariants for the shared Claude Code and Codex plugin."""

from __future__ import annotations

import json
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_ROOT = REPO_ROOT / "plugins" / "plurum"
MCP_URL = "https://mcp.plurum.ai/mcp"


def _manifest(host: str) -> dict:
    path = PLUGIN_ROOT / f".{host}-plugin" / "plugin.json"
    return json.loads(path.read_text(encoding="utf-8"))


def test_host_manifests_share_identity_and_version() -> None:
    claude = _manifest("claude")
    codex = _manifest("codex")

    assert claude["name"] == codex["name"] == PLUGIN_ROOT.name == "plurum"
    assert claude["version"] == codex["version"] == "0.1.0"
    assert claude["license"] == codex["license"] == "Apache-2.0"
    assert not (PLUGIN_ROOT / ".mcp.json").exists()


def test_claude_uses_protected_user_config_for_mcp_authentication() -> None:
    manifest = _manifest("claude")
    server = manifest["mcpServers"]["plurum"]
    api_key = manifest["userConfig"]["api_key"]

    assert server == {
        "type": "http",
        "url": MCP_URL,
        "headers": {
            "Authorization": "Bearer ${user_config.api_key}",
            "X-Plurum-Client": "claude-code",
        },
    }
    assert api_key["type"] == "string"
    assert api_key["sensitive"] is True
    assert api_key["required"] is True
    assert "hooks" not in manifest


def test_codex_uses_environment_backed_bearer_authentication() -> None:
    manifest = _manifest("codex")
    server = manifest["mcpServers"]["plurum"]

    assert server == {
        "type": "http",
        "url": MCP_URL,
        "bearer_token_env_var": "PLURUM_API_KEY",
        "http_headers": {"X-Plurum-Client": "codex"},
    }
    assert "hooks" not in manifest
