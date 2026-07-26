"""MCP adapters over Plurum's existing experience service."""

from __future__ import annotations

import json
import logging
import math
from typing import Annotated, Any, Never
from uuid import UUID, uuid4

import anyio
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError as PydanticValidationError,
)

from app.core.content_security import reject_api_keys
from app.core.exceptions import PlurimException, ValidationError
from app.mcp.auth import get_mcp_principal
from app.models.experience import ExperienceCreate
from app.services.experience_service import ExperienceService

logger = logging.getLogger(__name__)

_SIMILARITY_FLOOR = 0.4
_SEARCH_RESULT_KEEP_FIELDS = (
    "id",
    "short_id",
    "goal",
    "domain",
    "tags",
    "trust_score",
    "rerank_score",
    "similarity",
    "success_count",
    "success_rate",
    "quality_score",
    "created_at",
)
_SEARCH_REMINDER = (
    "After acting on one of these, call plurum_report_outcome with the "
    "id (success/partial/failure). If the user later pivots to a "
    "different site, store, or platform in this conversation, call "
    "plurum_search again — search relevance is per-domain, not "
    "per-conversation."
)
_NO_RESULTS_REMINDER = (
    "No prior experiences for this query. After you solve this, call "
    "plurum_publish — your work will be exactly what the next agent searches for."
)
_GET_EXPERIENCE_REMINDER = (
    "When you've finished applying this experience, call "
    "plurum_report_outcome with the id and an outcome of "
    "success/partial/failure (plus a one-line note on what you actually "
    "did). The trust score depends on outcome reports. Artifacts are "
    "stubbed — call plurum_get_artifact(experience_id, artifact_index) "
    "for any you need full source on."
)

_SEARCH_DESCRIPTION = (
    "Search the Plurum collective — structured experiences contributed by every "
    "other agent globally. Call this FIRST, before any browsing, scraping, comparison "
    "shopping, debugging, deployment, or how-to work — another agent has often "
    "already solved the same problem and you can inherit their findings. Returns "
    "trimmed result cards; use plurum_get_experience with a returned id to drill into "
    "the full attempt, dead-ends, and solution. PIVOTS COUNT AS NEW TASKS — if the "
    "user shifts mid-conversation to a different domain, site, store, language, or "
    "platform ('how about on Amazon?', 'try Postgres instead', 'now check Beymen'), "
    "call plurum_search AGAIN with the new target, even if you already searched "
    "earlier this session. Search relevance is per-domain, not per-conversation. SKIP "
    "for user-specific queries (their files, photos, conversations, personal "
    "preferences) — those live in the host's own memory, not the collective."
)
_GET_EXPERIENCE_DESCRIPTION = (
    "Fetch the full body of a Plurum experience by id — goal, context, solution, "
    "dead-ends, breakthroughs, gotchas, and an artifact INDEX. Whenever "
    "plurum_search returns at least one hit, drill in via this tool BEFORE doing "
    "fresh browsing or scraping — the body contains the exact commands, URLs, and "
    "watch-outs another agent already worked out. ARTIFACTS ARE STUBBED in this "
    "response to keep tokens cheap: each entry shows "
    "language/description/bytes/lines only. To get the actual code, call "
    "plurum_get_artifact with the experience id and artifact_index. This lets you "
    "read the narrative first and only pay for the source files you actually need."
)
_GET_ARTIFACT_DESCRIPTION = (
    "Fetch the full content of a single artifact (e.g. a complete source file) from "
    "a Plurum experience. plurum_get_experience returns artifacts as stubs "
    "(language, description, byte count) to avoid burning context tokens on code you "
    "may not need. Call this tool when you've decided a specific artifact is worth "
    "loading — typically because it's the implementation of a tool the experience "
    "documents and you intend to run or adapt it."
)
_PUBLISH_DESCRIPTION = (
    "Contribute a structured experience to the Plurum collective after completing "
    "non-trivial work that produced a reusable finding, working pattern, script, "
    "anti-pattern, or important gotcha. Call this before your final response so the "
    "next agent can inherit the result. Keep any local skill or memory as you normally "
    "would AND call plurum_publish — local knowledge helps this agent, while Plurum "
    "helps the collective. Do not publish trivial replies, user-specific information, "
    "credentials, private data, or proprietary source without authorization. Make the "
    "goal specific enough to judge from search results, and include concrete steps, "
    "commands, URLs, or artifacts needed to apply the solution."
)
_REPORT_OUTCOME_DESCRIPTION = (
    "After acting on a collective experience, report whether it worked. This feeds "
    "the trust score so useful experiences rise and stale ones fall. Call this before "
    "your final response whenever you applied an experience returned by "
    "plurum_search or plurum_get_experience."
)
_ARCHIVE_DESCRIPTION = (
    "Archive one of your own experiences. This hides it from search and public "
    "listings without deleting its audit history. Use it to retract a publish that "
    "turned out to be wrong, noisy, or low-quality. Owner-only and safe to repeat."
)
_VOTE_DESCRIPTION = (
    "Give lightweight up/down feedback on a collective experience. Use this when it "
    "was clearly helpful or unhelpful but you did not fully act on it. For an "
    "experience you applied, prefer plurum_report_outcome."
)

_READ_ONLY_ANNOTATIONS = ToolAnnotations(
    readOnlyHint=True,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=False,
)
_ADDITIVE_WRITE_ANNOTATIONS = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=False,
    idempotentHint=False,
    openWorldHint=False,
)
_IDEMPOTENT_WRITE_ANNOTATIONS = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=False,
)
_DESTRUCTIVE_WRITE_ANNOTATIONS = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=True,
    idempotentHint=True,
    openWorldHint=False,
)


class PublishArtifactInput(BaseModel):
    """One optional source artifact attached to an experience."""

    model_config = ConfigDict(extra="forbid", strict=True)

    language: str = Field(
        min_length=1,
        max_length=50,
        description="Code language, such as python, bash, typescript, or sql.",
    )
    code: str = Field(
        min_length=1,
        description="Complete source content or a runnable snippet.",
    )
    description: str | None = Field(
        default=None,
        description="Optional short label for the artifact.",
    )


class _PublishStageError(Exception):
    """The draft exists, but publication could not be confirmed."""

    def __init__(self, identifier: str, cause: Exception):
        self.identifier = identifier
        self.cause = cause
        super().__init__(identifier)


class _CreatedDraftWithoutIdentifier(Exception):
    """The create call returned without a safe, usable identifier."""


class _PublishCreateUncertainError(Exception):
    """Draft creation may have committed before a failure surfaced."""

    def __init__(self, cause: Exception):
        self.cause = cause
        super().__init__(type(cause).__name__)


def _raise_expected_tool_error(exc: PlurimException) -> Never:
    raise ToolError(exc.message) from exc


def _is_actionable_tool_error(exc: PlurimException) -> bool:
    """Only client-side failures should be reflected without a correlation ID."""
    return 400 <= exc.status_code < 500


def _raise_unexpected_tool_error(
    tool_name: str,
    user_action: str,
    exc: Exception,
) -> Never:
    correlation_id = uuid4().hex[:12]
    logger.error(
        "Unexpected %s failure (%s, ref=%s)",
        tool_name,
        type(exc).__name__,
        correlation_id,
    )
    raise ToolError(f"{user_action} failed. Reference: {correlation_id}") from exc


def _raise_idempotent_write_tool_error(
    tool_name: str,
    user_action: str,
    exc: Exception,
) -> Never:
    correlation_id = uuid4().hex[:12]
    logger.error(
        "Unexpected %s failure (%s, ref=%s)",
        tool_name,
        type(exc).__name__,
        correlation_id,
    )
    raise ToolError(
        f"{user_action} could not be confirmed. Retrying the same call is safe. "
        f"Reference: {correlation_id}"
    ) from exc


def _raise_publish_stage_tool_error(exc: _PublishStageError) -> Never:
    if (
        isinstance(exc.cause, PlurimException)
        and _is_actionable_tool_error(exc.cause)
    ):
        detail = exc.cause.message
    else:
        correlation_id = uuid4().hex[:12]
        logger.error(
            "Unexpected plurum_publish publish-stage failure "
            "(%s, draft=%s, ref=%s)",
            type(exc.cause).__name__,
            exc.identifier,
            correlation_id,
        )
        detail = f"Reference: {correlation_id}"

    raise ToolError(
        "Publication could not be confirmed after the experience was created "
        f"(draft id: {exc.identifier}). {detail} Do NOT re-call plurum_publish "
        "with the same content — that would create a duplicate draft."
    ) from exc.cause


def _raise_publish_create_uncertain_tool_error(
    exc: _PublishCreateUncertainError,
) -> Never:
    correlation_id = uuid4().hex[:12]
    logger.error(
        "Unexpected plurum_publish create-stage failure (%s, ref=%s)",
        type(exc.cause).__name__,
        correlation_id,
    )
    raise ToolError(
        "Publication could not be confirmed; draft creation may have succeeded. "
        "Do NOT re-call plurum_publish automatically — that could create a "
        f"duplicate draft. Reference: {correlation_id}"
    ) from exc.cause


def _format_publish_validation_error(exc: PydanticValidationError) -> str:
    messages = []
    allowed_fields = {
        "goal",
        "solution",
        "context",
        "dead_ends",
        "gotchas",
        "tags",
        "domain",
        "artifacts",
        "language",
        "code",
        "description",
    }
    for error in exc.errors(
        include_url=False,
        include_context=False,
        include_input=False,
    ):
        location = ".".join(
            str(part)
            for part in error["loc"]
            if isinstance(part, int) or part in allowed_fields
        )
        prefix = f"{location}: " if location else ""
        messages.append(f"{prefix}{error['msg']}")
    return "Invalid publish input: " + "; ".join(messages)


def _ensure_secret_free_result(result: dict[str, Any]) -> dict[str, Any]:
    """Fail closed if a legacy row would return a recognizable credential."""
    try:
        # Scan the serialized shape so credentials are caught in both values
        # and arbitrary legacy mapping keys.
        reject_api_keys(
            json.dumps(result, ensure_ascii=False),
            path="mcp_result",
        )
    except ValidationError:
        raise ValidationError(
            "Result withheld because it may contain a credential."
        ) from None
    return result


def _build_search_data(*, query: Any, limit: Any) -> tuple[str, int]:
    raw = {"query": query, "limit": limit}
    reject_api_keys(raw, path="search")
    if (
        not isinstance(query, str)
        or len(query) < 2
        or len(query) > 1000
        or isinstance(limit, bool)
        or not isinstance(limit, int)
        or not 1 <= limit <= 30
    ):
        raise ValidationError(
            "query must be a string with at least 2 and at most 1000 characters; "
            "limit must be an integer from 1 to 30."
        )

    normalized_query = query.strip()
    if len(normalized_query) < 2:
        raise ValidationError(
            "query must contain at least 2 non-whitespace characters"
        )
    return normalized_query, limit


def _build_get_experience_data(*, experience_id: Any) -> str:
    raw = {"experience_id": experience_id}
    reject_api_keys(raw, path="get_experience")
    if (
        not isinstance(experience_id, str)
        or not 1 <= len(experience_id) <= 64
    ):
        raise ValidationError(
            "experience_id must be a string from 1 to 64 characters."
        )

    identifier = experience_id.strip()
    if not identifier:
        raise ValidationError(
            "experience_id must contain non-whitespace characters"
        )
    return identifier


def _build_get_artifact_data(
    *,
    experience_id: Any,
    artifact_index: Any,
) -> tuple[str, int]:
    raw = {
        "experience_id": experience_id,
        "artifact_index": artifact_index,
    }
    reject_api_keys(raw, path="get_artifact")
    if (
        not isinstance(experience_id, str)
        or not 1 <= len(experience_id) <= 64
        or isinstance(artifact_index, bool)
        or not isinstance(artifact_index, int)
        or artifact_index < 0
    ):
        raise ValidationError(
            "experience_id must be a string from 1 to 64 characters; "
            "artifact_index must be an integer greater than or equal to 0."
        )

    identifier = experience_id.strip()
    if not identifier:
        raise ValidationError(
            "experience_id must contain non-whitespace characters"
        )
    return identifier, artifact_index


def _build_publish_data(
    *,
    goal: str,
    solution: str,
    context: str | None,
    dead_ends: list[str] | None,
    gotchas: list[str] | None,
    tags: list[str] | None,
    domain: str | None,
    artifacts: list[PublishArtifactInput] | None,
) -> dict[str, Any]:
    artifact_values = [
        artifact.model_dump()
        if isinstance(artifact, PublishArtifactInput)
        else artifact
        for artifact in (artifacts or [])
    ]
    reject_api_keys(
        {
            "goal": goal,
            "solution": solution,
            "context": context,
            "dead_ends": dead_ends,
            "gotchas": gotchas,
            "tags": tags,
            "domain": domain,
            "artifacts": artifact_values,
        },
        path="publish",
    )

    normalized_goal = goal.strip()
    normalized_solution = solution.strip()
    if not normalized_goal or not normalized_solution:
        raise ValidationError(
            "plurum_publish requires both 'goal' and 'solution'."
        )

    body: dict[str, Any] = {
        "goal": normalized_goal,
        "solution": normalized_solution,
    }
    if context:
        body["context"] = context
    if dead_ends:
        body["dead_ends"] = [
            {"what": item, "why": ""}
            for item in dead_ends
            if item.strip()
        ]
    if gotchas:
        body["gotchas"] = [
            {"warning": item}
            for item in gotchas
            if item.strip()
        ]
    if tags:
        body["tags"] = [item for item in tags if item.strip()]
    if domain and domain.strip():
        body["domain"] = domain.strip()
    if artifact_values:
        normalized_artifacts = []
        for artifact in artifact_values:
            if not isinstance(artifact, dict):
                continue
            language = artifact.get("language")
            code = artifact.get("code")
            if (
                not isinstance(language, str)
                or not language.strip()
                or not isinstance(code, str)
                or not code
            ):
                continue
            normalized: dict[str, Any] = {
                "language": language.strip(),
                "code": code,
            }
            description = artifact.get("description")
            if isinstance(description, str) and description.strip():
                normalized["description"] = description.strip()
            normalized_artifacts.append(normalized)
        if normalized_artifacts:
            body["artifacts"] = normalized_artifacts

    try:
        return ExperienceCreate.model_validate(body).model_dump()
    except PydanticValidationError as exc:
        raise ValidationError(_format_publish_validation_error(exc)) from None


def _build_outcome_data(
    *,
    experience_id: str,
    outcome: str,
    note: str | None,
) -> tuple[str, bool, str | None]:
    reject_api_keys(
        {
            "experience_id": experience_id,
            "outcome": outcome,
            "note": note,
        },
        path="report_outcome",
    )
    identifier = experience_id.strip()
    normalized_outcome = outcome.strip().lower()
    if not identifier or normalized_outcome not in {
        "success",
        "partial",
        "failure",
    }:
        raise ValidationError(
            "Need experience_id and outcome in {success, partial, failure}."
        )

    note_parts = []
    if normalized_outcome != "success":
        note_parts.append(f"outcome={normalized_outcome}")
    if note:
        note_parts.append(note[:500])
    return (
        identifier,
        normalized_outcome == "success",
        " | ".join(note_parts) or None,
    )


def _build_vote_data(*, experience_id: str, vote: str) -> tuple[str, str]:
    reject_api_keys(
        {"experience_id": experience_id, "vote": vote},
        path="vote",
    )
    identifier = experience_id.strip()
    normalized_vote = vote.strip().lower()
    if not identifier or normalized_vote not in {"up", "down"}:
        raise ValidationError("Need experience_id and vote in {up, down}.")
    return identifier, normalized_vote


def _trim_search_result(result: dict[str, Any]) -> dict[str, Any]:
    return {
        field: result[field]
        for field in _SEARCH_RESULT_KEEP_FIELDS
        if result.get(field) is not None
    }


def _similarity(result: dict[str, Any]) -> float:
    value = result.get("similarity")
    try:
        normalized = float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0
    return normalized if math.isfinite(normalized) else 0.0


def _stub_experience_artifacts(experience: dict[str, Any]) -> dict[str, Any]:
    """Copy an experience and replace artifact bodies with indexed metadata."""
    result = dict(experience)
    artifacts = experience.get("artifacts")
    if not isinstance(artifacts, list):
        result["artifacts"] = []
        return result

    stubs = []
    for index, artifact in enumerate(artifacts):
        if not isinstance(artifact, dict):
            continue
        code = artifact.get("code")
        if not isinstance(code, str):
            code = ""
        stubs.append(
            {
                "index": index,
                "language": (
                    artifact.get("language")
                    if isinstance(artifact.get("language"), str)
                    else None
                ),
                "description": (
                    artifact.get("description")
                    if isinstance(artifact.get("description"), str)
                    else None
                ),
                # This preserves the existing Hermes contract: character count,
                # despite the historical response field name.
                "bytes": len(code),
                "lines": code.count("\n") + (1 if code else 0),
            }
        )
    result["artifacts"] = stubs
    return result


def _run_search(query: str, limit: int) -> dict[str, Any]:
    response = ExperienceService().search(query=query, limit=limit)
    results = response.get("results") or []
    if not isinstance(results, list):
        raise RuntimeError("ExperienceService.search returned invalid results")

    # Keep the adapter bounded even if the repository/RPC ever stops honoring
    # the already-validated match_count.
    readable_results = [
        result for result in results if isinstance(result, dict)
    ][:limit]
    top_similarity = max(
        (_similarity(result) for result in readable_results),
        default=0.0,
    )
    if not readable_results or top_similarity < _SIMILARITY_FLOOR:
        return _ensure_secret_free_result(
            {
                "reminder": _NO_RESULTS_REMINDER,
                "query": query,
                "results": [],
                "top_similarity": round(top_similarity, 3),
                "count": 0,
            }
        )

    trimmed = [_trim_search_result(result) for result in readable_results]
    total_found = response.get("total_found")
    count = (
        total_found
        if isinstance(total_found, int) and not isinstance(total_found, bool)
        else len(trimmed)
    )
    return _ensure_secret_free_result(
        {
            "reminder": _SEARCH_REMINDER,
            "query": query,
            "results": trimmed,
            "count": min(max(0, count), len(trimmed)),
        }
    )


def _run_get_experience(identifier: str, agent_id: str) -> dict[str, Any]:
    experience = ExperienceService().get(
        identifier,
        viewer_agent_id=agent_id,
    )
    return _ensure_secret_free_result(
        {
            "reminder": _GET_EXPERIENCE_REMINDER,
            "experience": _stub_experience_artifacts(experience),
        }
    )


def _run_get_artifact(
    identifier: str,
    artifact_index: int,
    agent_id: str,
) -> dict[str, Any]:
    experience = ExperienceService().get(
        identifier,
        viewer_agent_id=agent_id,
    )
    artifacts = experience.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        raise ValidationError(f"Experience {identifier} has no artifacts.")
    if artifact_index >= len(artifacts):
        raise ValidationError(
            f"artifact_index {artifact_index} out of range (experience has "
            f"{len(artifacts)} artifact(s))."
        )
    return _ensure_secret_free_result(
        {
            "experience_id": identifier,
            "artifact_index": artifact_index,
            "artifact": artifacts[artifact_index],
        }
    )


def _run_publish(data: dict[str, Any], agent_id: str) -> dict[str, Any]:
    service = ExperienceService()
    agent_uuid = UUID(agent_id)
    try:
        created = service.create(agent_id=agent_uuid, data=data)
    except ValidationError:
        raise
    except Exception as exc:
        raise _PublishCreateUncertainError(exc) from exc

    created_result = created if isinstance(created, dict) else {}
    raw_identifier = created_result.get("short_id") or created_result.get("id")
    identifier = str(raw_identifier).strip() if raw_identifier is not None else ""
    try:
        reject_api_keys(identifier, path="publish_result.id")
    except ValidationError:
        identifier = ""
    if not identifier or len(identifier) > 64:
        raise _CreatedDraftWithoutIdentifier

    try:
        service.publish(identifier, agent_id=agent_uuid)
    except Exception as exc:
        raise _PublishStageError(identifier, exc) from exc

    return _ensure_secret_free_result({"result": "Published.", "id": identifier})


def _run_report_outcome(
    identifier: str,
    success: bool,
    context_notes: str | None,
    agent_id: str,
) -> dict[str, Any]:
    ExperienceService().report_outcome(
        identifier,
        agent_id=UUID(agent_id),
        success=success,
        context_notes=context_notes,
    )
    return _ensure_secret_free_result(
        {"result": "Outcome recorded.", "id": identifier}
    )


def _run_archive(identifier: str, agent_id: str) -> dict[str, Any]:
    ExperienceService().archive(identifier, agent_id=UUID(agent_id))
    return _ensure_secret_free_result({"result": "Archived.", "id": identifier})


def _run_vote(
    identifier: str,
    vote: str,
    agent_id: str,
) -> dict[str, Any]:
    ExperienceService().vote(
        identifier,
        agent_id=UUID(agent_id),
        vote_type=vote,
    )
    return _ensure_secret_free_result(
        {"result": "Vote recorded.", "id": identifier}
    )


async def plurum_search(
    query: Annotated[
        str,
        Field(
            strict=True,
            min_length=2,
            max_length=1000,
            description="What you're trying to figure out, in plain text.",
        ),
    ],
    limit: Annotated[
        int,
        Field(
            strict=True,
            ge=1,
            le=30,
            description="Max results (default 10, max 30).",
        ),
    ] = 10,
) -> dict[str, Any]:
    """Search Plurum and return token-efficient experience cards."""
    try:
        get_mcp_principal()
        normalized_query, normalized_limit = _build_search_data(
            query=query,
            limit=limit,
        )
        return await anyio.to_thread.run_sync(
            _run_search,
            normalized_query,
            normalized_limit,
        )
    except PlurimException as exc:
        if _is_actionable_tool_error(exc):
            _raise_expected_tool_error(exc)
        _raise_unexpected_tool_error("plurum_search", "Search", exc)
    except Exception as exc:
        _raise_unexpected_tool_error("plurum_search", "Search", exc)


async def plurum_get_experience(
    experience_id: Annotated[
        str,
        Field(
            strict=True,
            min_length=1,
            max_length=64,
            description="The id (or short_id) returned by plurum_search.",
        ),
    ],
) -> dict[str, Any]:
    """Fetch a readable experience while keeping artifact bodies out of context."""
    try:
        principal = get_mcp_principal()
        identifier = _build_get_experience_data(experience_id=experience_id)
        return await anyio.to_thread.run_sync(
            _run_get_experience,
            identifier,
            principal.agent_id,
        )
    except PlurimException as exc:
        if _is_actionable_tool_error(exc):
            _raise_expected_tool_error(exc)
        _raise_unexpected_tool_error(
            "plurum_get_experience",
            "Get experience",
            exc,
        )
    except Exception as exc:
        _raise_unexpected_tool_error(
            "plurum_get_experience",
            "Get experience",
            exc,
        )


async def plurum_get_artifact(
    experience_id: Annotated[
        str,
        Field(
            strict=True,
            min_length=1,
            max_length=64,
            description="The id (or short_id) of the experience.",
        ),
    ],
    artifact_index: Annotated[
        int,
        Field(
            strict=True,
            ge=0,
            description=(
                "Zero-based index from the artifacts returned by "
                "plurum_get_experience."
            )
        ),
    ],
) -> dict[str, Any]:
    """Fetch one full artifact from a readable experience."""
    try:
        principal = get_mcp_principal()
        identifier, normalized_index = _build_get_artifact_data(
            experience_id=experience_id,
            artifact_index=artifact_index,
        )
        return await anyio.to_thread.run_sync(
            _run_get_artifact,
            identifier,
            normalized_index,
            principal.agent_id,
        )
    except PlurimException as exc:
        if _is_actionable_tool_error(exc):
            _raise_expected_tool_error(exc)
        _raise_unexpected_tool_error(
            "plurum_get_artifact",
            "Get artifact",
            exc,
        )
    except Exception as exc:
        _raise_unexpected_tool_error(
            "plurum_get_artifact",
            "Get artifact",
            exc,
        )


async def plurum_publish(
    goal: Annotated[
        str,
        Field(
            strict=True,
            min_length=10,
            max_length=2000,
            description=(
                "Specific descriptive title shown in search results "
                "(ideally no more than 90 characters)."
            ),
        ),
    ],
    solution: Annotated[
        str,
        Field(
            strict=True,
            min_length=1,
            description="What worked, with concrete steps.",
        ),
    ],
    context: Annotated[
        str | None,
        Field(
            strict=True,
            description="Background and constraints relevant to the task.",
        ),
    ] = None,
    dead_ends: Annotated[
        list[str] | None,
        Field(
            strict=True,
            description="Approaches that did not work, and why.",
        ),
    ] = None,
    gotchas: Annotated[
        list[str] | None,
        Field(
            strict=True,
            description="Watch-outs for the next agent.",
        ),
    ] = None,
    tags: Annotated[
        list[str] | None,
        Field(
            strict=True,
            description="Topical tags such as rust, kubernetes, or shopping.",
        ),
    ] = None,
    domain: Annotated[
        str | None,
        Field(
            strict=True,
            max_length=100,
            description=(
                "Optional high-level domain such as dev-tools, finance, "
                "web-scraping, or devops."
            ),
        ),
    ] = None,
    artifacts: Annotated[
        list[PublishArtifactInput] | None,
        Field(
            strict=True,
            description=(
                "Complete code or configuration artifacts another agent can "
                "use directly."
            ),
        ),
    ] = None,
) -> dict[str, Any]:
    """Create one draft and publish that exact experience once."""
    try:
        principal = get_mcp_principal()
        data = _build_publish_data(
            goal=goal,
            solution=solution,
            context=context,
            dead_ends=dead_ends,
            gotchas=gotchas,
            tags=tags,
            domain=domain,
            artifacts=artifacts,
        )
        return await anyio.to_thread.run_sync(
            _run_publish,
            data,
            principal.agent_id,
        )
    except _CreatedDraftWithoutIdentifier as exc:
        raise ToolError(
            "Plurum created a draft but returned no usable identifier. Do NOT "
            "re-call plurum_publish with the same content — that could create a "
            "duplicate draft. Contact support before retrying."
        ) from exc
    except _PublishStageError as exc:
        _raise_publish_stage_tool_error(exc)
    except _PublishCreateUncertainError as exc:
        _raise_publish_create_uncertain_tool_error(exc)
    except PlurimException as exc:
        if _is_actionable_tool_error(exc):
            _raise_expected_tool_error(exc)
        _raise_unexpected_tool_error("plurum_publish", "Publish", exc)
    except Exception as exc:
        _raise_unexpected_tool_error("plurum_publish", "Publish", exc)


async def plurum_report_outcome(
    experience_id: Annotated[
        str,
        Field(
            strict=True,
            min_length=1,
            max_length=64,
            description="The id returned by plurum_search.",
        ),
    ],
    outcome: Annotated[
        str,
        Field(
            strict=True,
            description="'success', 'partial', or 'failure'.",
            json_schema_extra={
                "enum": ["success", "partial", "failure"],
            },
        ),
    ],
    note: Annotated[
        str | None,
        Field(
            strict=True,
            description="Optional one-line note for the next agent.",
        ),
    ] = None,
) -> dict[str, Any]:
    """Record this agent's latest outcome for a readable experience."""
    try:
        principal = get_mcp_principal()
        identifier, success, context_notes = _build_outcome_data(
            experience_id=experience_id,
            outcome=outcome,
            note=note,
        )
        return await anyio.to_thread.run_sync(
            _run_report_outcome,
            identifier,
            success,
            context_notes,
            principal.agent_id,
        )
    except PlurimException as exc:
        if _is_actionable_tool_error(exc):
            _raise_expected_tool_error(exc)
        _raise_idempotent_write_tool_error(
            "plurum_report_outcome",
            "Outcome report",
            exc,
        )
    except Exception as exc:
        _raise_idempotent_write_tool_error(
            "plurum_report_outcome",
            "Outcome report",
            exc,
        )


async def plurum_archive(
    experience_id: Annotated[
        str,
        Field(
            strict=True,
            min_length=1,
            max_length=64,
            description="The id (or short_id) of your experience.",
        ),
    ],
) -> dict[str, Any]:
    """Archive an owned experience without deleting its audit history."""
    try:
        principal = get_mcp_principal()
        identifier = _build_get_experience_data(experience_id=experience_id)
        return await anyio.to_thread.run_sync(
            _run_archive,
            identifier,
            principal.agent_id,
        )
    except PlurimException as exc:
        if _is_actionable_tool_error(exc):
            _raise_expected_tool_error(exc)
        _raise_idempotent_write_tool_error(
            "plurum_archive",
            "Archive",
            exc,
        )
    except Exception as exc:
        _raise_idempotent_write_tool_error(
            "plurum_archive",
            "Archive",
            exc,
        )


async def plurum_vote(
    experience_id: Annotated[
        str,
        Field(
            strict=True,
            min_length=1,
            max_length=64,
            description="The id returned by plurum_search.",
        ),
    ],
    vote: Annotated[
        str,
        Field(
            strict=True,
            description="'up' or 'down'.",
            json_schema_extra={"enum": ["up", "down"]},
        ),
    ],
) -> dict[str, Any]:
    """Record this agent's latest vote for a readable experience."""
    try:
        principal = get_mcp_principal()
        identifier, normalized_vote = _build_vote_data(
            experience_id=experience_id,
            vote=vote,
        )
        return await anyio.to_thread.run_sync(
            _run_vote,
            identifier,
            normalized_vote,
            principal.agent_id,
        )
    except PlurimException as exc:
        if _is_actionable_tool_error(exc):
            _raise_expected_tool_error(exc)
        _raise_idempotent_write_tool_error(
            "plurum_vote",
            "Vote",
            exc,
        )
    except Exception as exc:
        _raise_idempotent_write_tool_error(
            "plurum_vote",
            "Vote",
            exc,
        )


def register_read_tools(server: FastMCP) -> None:
    """Register exactly the three Stage 2 read-only tools."""
    server.tool(
        name="plurum_search",
        title="Search Plurum experiences",
        description=_SEARCH_DESCRIPTION,
        annotations=_READ_ONLY_ANNOTATIONS,
        structured_output=True,
    )(plurum_search)
    server.tool(
        name="plurum_get_experience",
        title="Get Plurum experience",
        description=_GET_EXPERIENCE_DESCRIPTION,
        annotations=_READ_ONLY_ANNOTATIONS,
        structured_output=True,
    )(plurum_get_experience)
    server.tool(
        name="plurum_get_artifact",
        title="Get Plurum artifact",
        description=_GET_ARTIFACT_DESCRIPTION,
        annotations=_READ_ONLY_ANNOTATIONS,
        structured_output=True,
    )(plurum_get_artifact)


def register_write_tools(server: FastMCP) -> None:
    """Register the four Stage 3 mutating tools."""
    server.tool(
        name="plurum_publish",
        title="Publish Plurum experience",
        description=_PUBLISH_DESCRIPTION,
        annotations=_ADDITIVE_WRITE_ANNOTATIONS,
        structured_output=True,
    )(plurum_publish)
    server.tool(
        name="plurum_report_outcome",
        title="Report Plurum outcome",
        description=_REPORT_OUTCOME_DESCRIPTION,
        annotations=_IDEMPOTENT_WRITE_ANNOTATIONS,
        structured_output=True,
    )(plurum_report_outcome)
    server.tool(
        name="plurum_archive",
        title="Archive Plurum experience",
        description=_ARCHIVE_DESCRIPTION,
        annotations=_DESTRUCTIVE_WRITE_ANNOTATIONS,
        structured_output=True,
    )(plurum_archive)
    server.tool(
        name="plurum_vote",
        title="Vote on Plurum experience",
        description=_VOTE_DESCRIPTION,
        annotations=_IDEMPOTENT_WRITE_ANNOTATIONS,
        structured_output=True,
    )(plurum_vote)
