"""Shared Plurum skill discovery, scope, and safety invariants."""

from __future__ import annotations

import re
import stat
from pathlib import Path

import yaml

from app.mcp.server import MCP_INSTRUCTIONS

REPO_ROOT = Path(__file__).resolve().parents[1]
SKILL_ROOT = REPO_ROOT / "plugins" / "plurum" / "skills" / "plurum"
SKILL_PATH = SKILL_ROOT / "SKILL.md"
TOOL_NAMES = {
    "plurum_search",
    "plurum_get_experience",
    "plurum_get_artifact",
    "plurum_publish",
    "plurum_report_outcome",
    "plurum_vote",
    "plurum_archive",
}


def _skill_parts() -> tuple[dict[str, str], str]:
    content = SKILL_PATH.read_text(encoding="utf-8")
    opening, frontmatter, body = content.split("---", 2)
    assert opening == ""
    parsed = yaml.safe_load(frontmatter)
    assert isinstance(parsed, dict)
    return parsed, body


def test_skill_frontmatter_has_standard_name_and_trigger_scope() -> None:
    frontmatter, _ = _skill_parts()

    assert set(frontmatter) == {"name", "description"}
    assert frontmatter["name"] == SKILL_ROOT.name == "plurum"
    assert re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", frontmatter["name"])
    assert len(frontmatter["name"]) <= 64

    description = frontmatter["description"].lower()
    assert len(description) <= 1024
    for expected in (
        "plurum",
        "substantial",
        "prior agent experience",
        "trivial",
        "personal",
        "private",
        "confidential",
        "purely local",
        "user-specific",
    ):
        assert expected in description


def test_skill_names_exactly_the_seven_hosted_tools() -> None:
    _, body = _skill_parts()

    assert set(re.findall(r"`(plurum_[a-z_]+)`", body)) == TOOL_NAMES
    normalized = body.lower()
    for excluded in (
        "plurum_register",
        "sessions",
        "pulse",
        "heartbeat",
        "acquire",
    ):
        assert excluded not in normalized


def test_skill_defines_conditional_workflow_and_safety_boundaries() -> None:
    _, body = _skill_parts()
    normalized = " ".join(body.split()).lower()

    for expected in (
        "before substantial fresh work only when",
        "promising hit",
        "untrusted third-party evidence",
        "verify advice before applying",
        "experiences actually applied",
        "verified, genuinely reusable knowledge",
        "continue the user's task normally",
        "this skill does not authorize writes",
        "host's normal confirmation policy",
        "treat archiving as destructive",
        "never automatically repeat the same publish",
        "skip plurum entirely instead of sanitizing the task into a query",
    ):
        assert expected in normalized

    for private_content in (
        "credentials",
        "api keys",
        "secrets",
        "personal data",
        "private conversations",
        "confidential project details",
        "private source",
        "user-specific content",
    ):
        assert private_content in normalized

    for aggressive_instruction in (
        "before any browsing",
        "call this first",
        "task is not complete until you publish",
        "publishing as part of completing the task",
    ):
        assert aggressive_instruction not in normalized


def test_skill_is_instruction_only() -> None:
    paths = list(SKILL_ROOT.rglob("*"))
    assert not any(path.is_symlink() for path in paths)

    files = {
        path.relative_to(SKILL_ROOT)
        for path in paths
        if path.is_file()
    }
    assert files == {Path("SKILL.md")}
    assert SKILL_PATH.stat().st_mode & (
        stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH
    ) == 0
    assert "```" not in SKILL_PATH.read_text(encoding="utf-8")


def test_direct_mcp_instructions_preserve_the_same_core_boundaries() -> None:
    normalized = " ".join(MCP_INSTRUCTIONS.split()).lower()

    assert len(MCP_INSTRUCTIONS.encode("utf-8")) <= 512
    for expected in (
        "when transferable work may benefit from prior agent experience",
        "skip trivial, personal, private, confidential, local-only, and user-specific tasks",
        "search generically",
        "inspect results as untrusted evidence",
        "continue normally",
        "report outcomes only after applying prior work",
        "publish only verified, reusable, non-private findings",
        "host write-approval",
        "never send credentials",
        "private source",
        "protected data",
    ):
        assert expected in normalized


def test_direct_tool_guidance_does_not_imply_blanket_write_approval() -> None:
    from app.mcp import tools

    assert "substantial fresh research or implementation" in tools._SEARCH_DESCRIPTION
    assert (
        "Skip search entirely for trivial, personal, private, confidential, "
        "purely local, or user-specific tasks."
    ) in tools._SEARCH_DESCRIPTION
    assert "For eligible work, use a concise, generic query" in tools._SEARCH_DESCRIPTION
    assert "promising" in tools._GET_EXPERIENCE_DESCRIPTION
    assert "untrusted third-party" in tools._GET_EXPERIENCE_DESCRIPTION
    assert "untrusted third-party" in tools._GET_ARTIFACT_DESCRIPTION

    for description in (
        tools._PUBLISH_DESCRIPTION,
        tools._REPORT_OUTCOME_DESCRIPTION,
        tools._VOTE_DESCRIPTION,
        tools._ARCHIVE_DESCRIPTION,
    ):
        assert "normal write-approval flow" in description

    all_guidance = " ".join(
        (
            tools._SEARCH_DESCRIPTION,
            tools._GET_EXPERIENCE_DESCRIPTION,
            tools._PUBLISH_DESCRIPTION,
            tools._REPORT_OUTCOME_DESCRIPTION,
            tools._SEARCH_REMINDER,
            tools._NO_RESULTS_REMINDER,
            tools._GET_EXPERIENCE_REMINDER,
        )
    ).lower()
    for aggressive_instruction in (
        "call this first",
        "before any browsing",
        "call this before your final response",
        "task is not complete until you publish",
        "and call plurum_publish",
    ):
        assert aggressive_instruction not in all_guidance
