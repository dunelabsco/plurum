"""Validation models and leak-safe public schemas for hosted MCP tools."""

from __future__ import annotations

from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, WithJsonSchema


class PublishArtifactInput(BaseModel):
    """One optional source artifact attached to a published experience."""

    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True, strict=True)

    language: str
    code: str
    description: str | None = None


class PublishInput(BaseModel):
    """Internal strict validation after raw content has been scanned for secrets."""

    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True, strict=True)

    goal: str
    solution: str
    context: str | None = None
    dead_ends: list[str] | None = None
    gotchas: list[str] | None = None
    tags: list[str] | None = None
    domain: str | None = None
    artifacts: list[PublishArtifactInput] | None = None


class ReportOutcomeInput(BaseModel):
    """Internal strict validation after raw feedback has been scanned for secrets."""

    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True, strict=True)

    experience_id: str
    outcome: str
    note: str | None = None


# FastMCP validates function arguments before invoking the handler. Runtime `Any`
# keeps malformed, potentially secret-bearing values inside Plurum's sanitizing
# boundary, while WithJsonSchema preserves the precise schema clients should use.
LeakSafeStringInput = Annotated[Any, WithJsonSchema({"type": "string"})]
LeakSafeStringListInput = Annotated[
    Any,
    WithJsonSchema({"type": "array", "items": {"type": "string"}}),
]
OutcomeValueInput = Annotated[
    Any,
    WithJsonSchema(
        {
            "type": "string",
            "enum": ["success", "partial", "failure"],
        }
    ),
]
PublishArtifactsInput = Annotated[
    Any,
    WithJsonSchema(
        {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "language": {
                        "type": "string",
                        "description": (
                            "Code language for syntax highlighting: 'python', 'bash', "
                            "'typescript', 'sql', etc."
                        ),
                    },
                    "code": {
                        "type": "string",
                        "description": (
                            "Full source content. Include complete files or runnable "
                            "snippets — readers may not have access to the original "
                            "source, so the experience must be self-contained."
                        ),
                    },
                    "description": {
                        "type": "string",
                        "description": (
                            "Short label for the artifact, e.g. 'polymarket.py — full "
                            "source' or 'cron config'."
                        ),
                    },
                },
                "required": ["language", "code"],
                "additionalProperties": False,
            },
        }
    ),
]
