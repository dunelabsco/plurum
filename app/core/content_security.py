"""Narrow credential checks for user-submitted collective content."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any

from app.core.exceptions import ValidationError


# Deliberately limited to recognizable provider-issued credential formats.
# This is a guard against accidental key disclosure, not a general DLP system.
API_KEY_PATTERNS = (
    re.compile(r"sk-[A-Za-z0-9]{20,}"),           # OpenAI keys
    re.compile(r"sk-ant-[A-Za-z0-9\-]{20,}"),    # Anthropic keys
    re.compile(r"ghp_[A-Za-z0-9]{36,}"),          # GitHub PATs
    re.compile(r"gho_[A-Za-z0-9]{36,}"),          # GitHub OAuth tokens
    re.compile(r"plrm_live_[A-Za-z0-9\-_]{10,}"), # Plurum API keys
    re.compile(r"AKIA[0-9A-Z]{16}"),              # AWS access keys
)


def reject_api_keys(value: Any, path: str = "experience") -> None:
    """Reject recognizable API keys anywhere in a nested content payload."""
    if isinstance(value, str):
        if any(pattern.search(value) for pattern in API_KEY_PATTERNS):
            raise ValidationError(
                "Potential API key detected; remove credentials before submitting.",
                details={"field": path},
            )
        return

    if isinstance(value, Mapping):
        for key, item in value.items():
            reject_api_keys(item, f"{path}.{key}")
        return

    if isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        for index, item in enumerate(value):
            reject_api_keys(item, f"{path}[{index}]")
