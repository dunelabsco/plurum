"""Packaging invariants for the shared Claude Code and Codex plugin."""

from __future__ import annotations

import json
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_ROOT = REPO_ROOT / "plugins" / "plurum"
MCP_URL = "https://mcp.plurum.ai/mcp"
SKILL_PATH = PLUGIN_ROOT / "skills" / "plurum" / "SKILL.md"


def _manifest(host: str) -> dict:
    path = PLUGIN_ROOT / f".{host}-plugin" / "plugin.json"
    return json.loads(path.read_text(encoding="utf-8"))


def _catalog(path: str) -> dict:
    return json.loads((REPO_ROOT / path).read_text(encoding="utf-8"))


def test_host_manifests_share_identity_and_version() -> None:
    claude = _manifest("claude")
    codex = _manifest("codex")

    assert claude["name"] == codex["name"] == PLUGIN_ROOT.name == "plurum"
    assert claude["version"] == codex["version"] == "0.1.0"
    assert claude["license"] == codex["license"] == "Apache-2.0"
    assert claude["skills"] == codex["skills"] == "./skills/"
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


def test_shared_skill_covers_the_collective_workflow_and_safety_boundaries() -> None:
    skill = SKILL_PATH.read_text(encoding="utf-8")
    normalized = " ".join(skill.split())

    assert skill.startswith("---\nname: plurum\ndescription:")
    for tool in (
        "plurum_search",
        "plurum_get_experience",
        "plurum_get_artifact",
        "plurum_publish",
        "plurum_report_outcome",
        "plurum_vote",
        "plurum_archive",
    ):
        assert f"`{tool}`" in skill

    assert "untrusted third-party evidence" in normalized
    assert "Never send Plurum credentials" in normalized
    assert "do not automatically call `plurum_publish` again" in normalized
    for excluded_feature in ("plurum_register", "sessions", "pulse", "heartbeat", "acquire"):
        assert excluded_feature not in skill


def test_native_marketplaces_point_to_the_same_plugin_without_copying_versions() -> None:
    claude = _catalog(".claude-plugin/marketplace.json")
    codex = _catalog(".agents/plugins/marketplace.json")

    assert claude["name"] == codex["name"] == "plurum"
    assert claude["owner"] == {"name": "Dune Labs"}
    assert codex["interface"] == {"displayName": "Plurum"}

    assert len(claude["plugins"]) == len(codex["plugins"]) == 1
    claude_plugin = claude["plugins"][0]
    codex_plugin = codex["plugins"][0]
    assert claude_plugin["name"] == codex_plugin["name"] == "plurum"
    assert claude_plugin["source"] == "./plugins/plurum"
    assert codex_plugin["source"] == {
        "source": "local",
        "path": "./plugins/plurum",
    }
    assert codex_plugin["policy"] == {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL",
    }
    assert "version" not in claude
    assert "version" not in codex
    assert "version" not in claude_plugin
    assert "version" not in codex_plugin
