"""Claude Code Plurum plugin distribution and safety invariants."""

from __future__ import annotations

import json
import re
import stat
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_ROOT = REPO_ROOT / "plugins" / "plurum"
MANIFEST_PATH = PLUGIN_ROOT / ".claude-plugin" / "plugin.json"
MARKETPLACE_PATH = REPO_ROOT / ".claude-plugin" / "marketplace.json"
README_PATH = PLUGIN_ROOT / "README.md"
ROOT_README_PATH = REPO_ROOT / "README.md"
CHANGELOG_PATH = PLUGIN_ROOT / "CHANGELOG.md"

EXPECTED_PACKAGE_FILES = {
    Path(".claude-plugin/plugin.json"),
    Path("CHANGELOG.md"),
    Path("LICENSE"),
    Path("README.md"),
    Path("skills/plurum/SKILL.md"),
}
FORBIDDEN_COMPONENTS = {
    "agents",
    "channels",
    "commands",
    "dependencies",
    "experimental",
    "hooks",
    "lspServers",
    "outputStyles",
    "workflows",
}
EXPECTED_MANIFEST_KEYS = {
    "$schema",
    "author",
    "description",
    "displayName",
    "homepage",
    "keywords",
    "license",
    "mcpServers",
    "name",
    "repository",
    "userConfig",
    "version",
}
EXPECTED_MARKETPLACE_KEYS = {"description", "name", "owner", "plugins"}
EXPECTED_MARKETPLACE_ENTRY_KEYS = {
    "category",
    "description",
    "displayName",
    "name",
    "source",
    "strict",
}


def _json(path: Path) -> dict:
    parsed = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(parsed, dict)
    return parsed


def test_claude_manifest_declares_one_hosted_authenticated_mcp() -> None:
    manifest = _json(MANIFEST_PATH)

    assert manifest["name"] == "plurum"
    assert manifest["displayName"] == "Plurum"
    assert manifest["version"] == "0.1.0"
    assert manifest["license"] == "Apache-2.0"
    assert manifest["repository"] == "https://github.com/dunelabsco/plurum"
    assert set(manifest) == EXPECTED_MANIFEST_KEYS
    assert manifest.keys().isdisjoint(FORBIDDEN_COMPONENTS)
    assert "skills" not in manifest

    assert manifest["mcpServers"] == {
        "plurum": {
            "type": "http",
            "url": "https://mcp.plurum.ai/mcp",
            "headers": {
                "Authorization": "Bearer ${user_config.api_key}",
                "X-Plurum-Client": "claude-code",
            },
        }
    }


def test_claude_api_key_configuration_is_required_and_sensitive() -> None:
    manifest = _json(MANIFEST_PATH)

    assert manifest["userConfig"] == {
        "api_key": {
            "type": "string",
            "title": "Plurum API key",
            "description": (
                "The API key for the Plurum agent used by Claude Code. "
                "Create one at https://plurum.ai/dashboard/agents."
            ),
            "sensitive": True,
            "required": True,
        }
    }

    client_header = manifest["mcpServers"]["plurum"]["headers"][
        "X-Plurum-Client"
    ]
    assert re.fullmatch(r"[a-z0-9-]{1,64}", client_header)


def test_claude_marketplace_uses_manifest_as_single_authority() -> None:
    marketplace = _json(MARKETPLACE_PATH)

    assert marketplace["name"] == "plurum"
    assert set(marketplace) == EXPECTED_MARKETPLACE_KEYS
    assert len(marketplace["plugins"]) == 1
    entry = marketplace["plugins"][0]
    assert set(entry) == EXPECTED_MARKETPLACE_ENTRY_KEYS
    assert entry["name"] == "plurum"
    assert entry["source"] == "./plugins/plurum"
    assert entry["strict"] is True
    assert "version" not in marketplace
    assert "version" not in entry


def test_claude_plugin_package_is_inert_and_self_contained() -> None:
    paths = list(PLUGIN_ROOT.rglob("*"))

    assert not any(path.is_symlink() for path in paths)
    files = {
        path.relative_to(PLUGIN_ROOT)
        for path in paths
        if path.is_file()
    }
    assert files == EXPECTED_PACKAGE_FILES
    assert not any(
        path.stat().st_mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        for path in paths
        if path.is_file()
    )
    assert not {
        ".mcp.json",
        "package.json",
        "package-lock.json",
        "pyproject.toml",
        "requirements.txt",
    }.intersection(path.name for path in paths)
    assert (PLUGIN_ROOT / "LICENSE").read_bytes() == (
        REPO_ROOT / "LICENSE"
    ).read_bytes()


def test_claude_install_guide_keeps_secrets_out_of_commands() -> None:
    readme = README_PATH.read_text(encoding="utf-8")
    normalized = " ".join(readme.split()).lower()

    for expected in (
        "/plugin marketplace add dunelabsco/plurum",
        "/plugin install plurum@plurum",
        "claude code 2.1.210 or later",
        "https://plurum.ai/dashboard/agents",
        "native masked configuration prompt",
        "if no masked prompt appears, stop and update claude code",
        "/reload-plugins",
        "/mcp",
        "/plugin marketplace update plurum",
        "/plugin update plurum@plurum",
        "/plugin configure plurum@plurum",
        "/plugin uninstall plurum@plurum",
        "rotation invalidates the old key",
        "no hook, script, dependency, local server, or background process",
    ):
        assert expected in normalized

    for forbidden in (
        "--config",
        "npm install",
        "npx ",
        "pip install",
        "pipx ",
        "plurum update",
    ):
        assert forbidden not in normalized

    package_text = "\n".join(
        path.read_text(encoding="utf-8")
        for path in PLUGIN_ROOT.rglob("*")
        if path.is_file()
    )
    assert not re.search(r"\bplrm_(?:live|test)_[A-Za-z0-9_-]{16,}\b", package_text)

    root_readme = " ".join(
        ROOT_README_PATH.read_text(encoding="utf-8").split()
    ).lower()
    for expected in (
        "/plugin marketplace add dunelabsco/plurum",
        "/plugin install plurum@plurum",
        "requires claude code 2.1.210 or later",
        "if that masked prompt does not appear, stop and update claude code",
    ):
        assert expected in root_readme


def test_claude_plugin_version_has_release_notes() -> None:
    manifest = _json(MANIFEST_PATH)
    changelog = CHANGELOG_PATH.read_text(encoding="utf-8")

    assert re.fullmatch(r"\d+\.\d+\.\d+", manifest["version"])
    assert f"## {manifest['version']}" in changelog
