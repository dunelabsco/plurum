"""Claude Code and Codex Plurum plugin distribution invariants."""

from __future__ import annotations

import json
import re
import stat
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_ROOT = REPO_ROOT / "plugins" / "plurum"
CLAUDE_MANIFEST_PATH = PLUGIN_ROOT / ".claude-plugin" / "plugin.json"
CODEX_MANIFEST_PATH = PLUGIN_ROOT / ".codex-plugin" / "plugin.json"
MCP_PATH = PLUGIN_ROOT / ".mcp.json"
CLAUDE_MARKETPLACE_PATH = REPO_ROOT / ".claude-plugin" / "marketplace.json"
CODEX_MARKETPLACE_PATH = REPO_ROOT / ".agents" / "plugins" / "marketplace.json"
README_PATH = PLUGIN_ROOT / "README.md"
ROOT_README_PATH = REPO_ROOT / "README.md"
CHANGELOG_PATH = PLUGIN_ROOT / "CHANGELOG.md"
VERSION = "0.2.0"

EXPECTED_PACKAGE_FILES = {
    Path(".claude-plugin/plugin.json"),
    Path(".codex-plugin/plugin.json"),
    Path(".mcp.json"),
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
EXPECTED_CLAUDE_MANIFEST_KEYS = {
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
EXPECTED_CLAUDE_MARKETPLACE_KEYS = {
    "description",
    "name",
    "owner",
    "plugins",
}
EXPECTED_CLAUDE_MARKETPLACE_ENTRY_KEYS = {
    "category",
    "description",
    "displayName",
    "name",
    "source",
    "strict",
}
EXPECTED_CODEX_MANIFEST_KEYS = {
    "author",
    "description",
    "homepage",
    "interface",
    "keywords",
    "license",
    "mcpServers",
    "name",
    "repository",
    "skills",
    "version",
}
EXPECTED_CODEX_INTERFACE_KEYS = {
    "brandColor",
    "capabilities",
    "category",
    "defaultPrompt",
    "developerName",
    "displayName",
    "longDescription",
    "privacyPolicyURL",
    "shortDescription",
    "termsOfServiceURL",
    "websiteURL",
}


def _json(path: Path) -> dict:
    parsed = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(parsed, dict)
    return parsed


def test_claude_manifest_declares_one_hosted_authenticated_mcp() -> None:
    manifest = _json(CLAUDE_MANIFEST_PATH)

    assert manifest["name"] == "plurum"
    assert manifest["displayName"] == "Plurum"
    assert manifest["version"] == VERSION
    assert manifest["license"] == "Apache-2.0"
    assert manifest["repository"] == "https://github.com/dunelabsco/plurum"
    assert set(manifest) == EXPECTED_CLAUDE_MANIFEST_KEYS
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
    manifest = _json(CLAUDE_MANIFEST_PATH)

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
    marketplace = _json(CLAUDE_MARKETPLACE_PATH)

    assert marketplace["name"] == "plurum"
    assert set(marketplace) == EXPECTED_CLAUDE_MARKETPLACE_KEYS
    assert len(marketplace["plugins"]) == 1
    entry = marketplace["plugins"][0]
    assert set(entry) == EXPECTED_CLAUDE_MARKETPLACE_ENTRY_KEYS
    assert entry["name"] == "plurum"
    assert entry["source"] == "./plugins/plurum"
    assert entry["strict"] is True
    assert "version" not in marketplace
    assert "version" not in entry


def test_codex_manifest_declares_shared_skill_and_mcp_companion() -> None:
    manifest = _json(CODEX_MANIFEST_PATH)

    assert set(manifest) == EXPECTED_CODEX_MANIFEST_KEYS
    assert manifest["name"] == "plurum"
    assert manifest["version"] == VERSION
    assert manifest["author"]["name"] == "Dune Labs"
    assert manifest["repository"] == "https://github.com/dunelabsco/plurum"
    assert manifest["license"] == "Apache-2.0"
    assert manifest["skills"] == "./skills/"
    assert manifest["mcpServers"] == "./.mcp.json"
    assert manifest.keys().isdisjoint(FORBIDDEN_COMPONENTS)

    interface = manifest["interface"]
    assert set(interface) == EXPECTED_CODEX_INTERFACE_KEYS
    assert interface["displayName"] == "Plurum"
    assert interface["developerName"] == "Dune Labs"
    assert interface["category"] == "Productivity"
    assert interface["capabilities"] == ["Read", "Write"]
    assert interface["brandColor"] == "#D71921"
    assert interface["websiteURL"] == "https://plurum.ai"
    assert interface["privacyPolicyURL"] == "https://plurum.ai/privacy"
    assert interface["termsOfServiceURL"] == "https://plurum.ai/terms"
    assert interface["defaultPrompt"] == [
        "Search Plurum for relevant prior agent experience when it could materially help.",
        "Inspect a promising Plurum experience and verify it against this task.",
        "Help me contribute a verified reusable Plurum experience from completed work.",
    ]


def test_codex_mcp_uses_only_native_environment_bearer_auth() -> None:
    mcp = _json(MCP_PATH)

    assert mcp == {
        "mcpServers": {
            "plurum": {
                "type": "http",
                "url": "https://mcp.plurum.ai/mcp",
                "bearer_token_env_var": "PLURUM_API_KEY",
                "http_headers": {
                    "X-Plurum-Client": "codex",
                },
            }
        }
    }

    server = mcp["mcpServers"]["plurum"]
    assert re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", server["bearer_token_env_var"])
    assert re.fullmatch(
        r"[a-z0-9-]{1,64}",
        server["http_headers"]["X-Plurum-Client"],
    )
    assert "Authorization" not in server.get("http_headers", {})
    assert "headers" not in server
    assert "command" not in server
    assert "args" not in server


def test_codex_marketplace_uses_native_repo_catalog_schema() -> None:
    marketplace = _json(CODEX_MARKETPLACE_PATH)

    assert marketplace == {
        "name": "plurum",
        "interface": {
            "displayName": "Plurum",
        },
        "plugins": [
            {
                "name": "plurum",
                "source": {
                    "source": "local",
                    "path": "./plugins/plurum",
                },
                "policy": {
                    "installation": "AVAILABLE",
                    "authentication": "ON_INSTALL",
                },
                "category": "Productivity",
            }
        ],
    }
    assert "version" not in marketplace
    assert "version" not in marketplace["plugins"][0]


def test_plugin_package_is_inert_and_self_contained() -> None:
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
        "package.json",
        "package-lock.json",
        "pyproject.toml",
        "requirements.txt",
    }.intersection(path.name for path in paths)
    assert not {"hooks", "scripts", "bin"}.intersection(
        path.name for path in paths if path.is_dir()
    )
    assert (PLUGIN_ROOT / "LICENSE").read_bytes() == (
        REPO_ROOT / "LICENSE"
    ).read_bytes()


def test_install_guide_uses_only_native_secret_safe_flows() -> None:
    readme = README_PATH.read_text(encoding="utf-8")
    normalized = " ".join(readme.split()).lower()

    for expected in (
        "/plugin marketplace add https://github.com/dunelabsco/plurum.git",
        "/plugin install plurum@plurum",
        "claude code 2.1.226 or later",
        "passed isolated authenticated end-to-end validation",
        "native masked configuration prompt",
        "if no masked prompt appears, stop and update claude code",
        "/reload-plugins",
        "/plugin marketplace update plurum",
        "/plugin update plurum@plurum",
        "configure options",
        "third-party marketplaces do not auto-update by default",
        "/plugin uninstall plurum@plurum",
        "/plugin marketplace remove plurum",
        "codex plugin marketplace add dunelabsco/plurum --ref main",
        "codex plugin add plurum@plurum",
        "codex cli api-key beta",
        "codex cli 0.147.0",
        "codex in the chatgpt desktop app supports plugins",
        "outside this beta",
        "enter `/plugins` in codex cli",
        "codex does not ask for or store `plurum_api_key`",
        "read -r -s plur",
        'read-host "plurum api key" -maskinput',
        "windows (powershell 7.1+)",
        "remove-item env:plurum_api_key",
        "codex filters variable names containing `key`, `secret`, or `token`",
        "not passed to model-launched commands",
        "codex plugin marketplace upgrade plurum codex plugin add "
        "plurum@plurum",
        "codex plugin remove plurum@plurum",
        "codex plugin marketplace remove plurum",
        "public universal plugin directory",
        "plurum has not implemented an oauth flow",
        "the ide extension does not support plugins",
        "no hook, script, dependency, local server, credential file, or "
        "background process",
    ):
        assert expected in normalized

    for forbidden in (
        "--config",
        "codex mcp add",
        "export plurum_api_key=",
        "npm install",
        "npx ",
        "pip install",
        "pipx ",
        "plurum update",
        "/plugin configure",
        "hosted endpoint has not completed authenticated end-to-end "
        "validation",
    ):
        assert forbidden not in normalized

    package_text = "\n".join(
        path.read_text(encoding="utf-8")
        for path in PLUGIN_ROOT.rglob("*")
        if path.is_file()
    )
    assert not re.search(
        r"\bplrm_(?:live|test)_[A-Za-z0-9_-]{16,}\b",
        package_text,
    )

    root_readme = " ".join(
        ROOT_README_PATH.read_text(encoding="utf-8").split()
    ).lower()
    for expected in (
        "/plugin marketplace add https://github.com/dunelabsco/plurum.git",
        "/plugin install plurum@plurum",
        "codex plugin marketplace add dunelabsco/plurum --ref main",
        "codex plugin add plurum@plurum",
        "codex cli beta",
        "passed isolated authenticated end-to-end validation with codex cli "
        "0.147.0",
        "codex reads `plurum_api_key` from the environment",
        "codex in the chatgpt desktop app can install plugins",
        "the ide extension does not support plugins",
        "no npm, python package, helper process, or local mcp server",
    ):
        assert expected in root_readme


def test_host_manifests_share_identity_version_and_release_notes() -> None:
    claude_manifest = _json(CLAUDE_MANIFEST_PATH)
    codex_manifest = _json(CODEX_MANIFEST_PATH)
    changelog = CHANGELOG_PATH.read_text(encoding="utf-8")

    assert claude_manifest["name"] == codex_manifest["name"] == "plurum"
    assert claude_manifest["version"] == codex_manifest["version"] == VERSION
    assert re.fullmatch(r"\d+\.\d+\.\d+", VERSION)
    assert f"## {VERSION}" in changelog
