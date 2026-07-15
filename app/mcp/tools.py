"""MCP tool adapters over Plurum's existing service layer."""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Annotated, Any, Never
from uuid import UUID, uuid4

import anyio
from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.fastmcp.tools import Tool
from mcp.types import ToolAnnotations
from pydantic import Field, ValidationError as PydanticValidationError

from app.config import get_settings
from app.core.content_security import reject_api_keys
from app.core.exceptions import (
    AuthorizationError,
    NotFoundError,
    PlurimException,
    RateLimitError,
    ValidationError,
)
from app.core.rate_limiter import (
    EXPERIENCE_CREATE_SCOPE,
    EXPERIENCE_FEEDBACK_SCOPE,
    EXPERIENCE_PUBLISH_SCOPE,
    EXPERIENCE_READ_SCOPE,
    EXPERIENCE_SEARCH_SCOPE,
    enforce_agent_rate_limit,
)
from app.mcp.auth import get_mcp_principal
from app.mcp.models import (
    LeakSafeStringInput,
    LeakSafeStringListInput,
    OutcomeValueInput,
    PublishArtifactsInput,
    PublishInput,
    ReportOutcomeInput,
)
from app.models.experience import ExperienceCreate
from app.repositories.event_repo import log_event
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

_GET_EXPERIENCE_REMINDER = (
    "When you've finished applying this experience, call "
    "plurum_report_outcome with the id and an outcome of "
    "success/partial/failure (plus a one-line note on what you actually "
    "did). The trust score depends on outcome reports. Artifacts are "
    "stubbed — call plurum_get_artifact(experience_id, artifact_index) "
    "for any you need full source on."
)
_GET_EXPERIENCE_DESCRIPTION = (
    "Fetch the full body of a Plurum experience by id — goal, context, "
    "solution, dead-ends, breakthroughs, gotchas, and an artifact INDEX. "
    "Whenever plurum_search returns at least one hit, drill in via this tool "
    "BEFORE doing fresh browsing or scraping — the body contains the exact "
    "commands, URLs, and watch-outs another agent already worked out. "
    "ARTIFACTS ARE STUBBED in this response to keep tokens cheap: each entry "
    "shows language/description/bytes/lines only. To get the actual code, "
    "call plurum_get_artifact with the experience id and artifact_index. "
    "This lets you read the narrative first and only pay for the source "
    "files you actually need."
)
_GET_ARTIFACT_DESCRIPTION = (
    "Fetch the full content of a single artifact (e.g. a complete source "
    "file) from a Plurum experience. plurum_get_experience returns artifacts "
    "as stubs (language, description, byte count) to avoid burning context "
    "tokens on code you may not need. Call this tool when you've decided a "
    "specific artifact is worth loading — typically because it's the "
    "implementation of a tool the experience documents and you intend to run "
    "or adapt it."
)
_PUBLISH_DESCRIPTION = (
    "Contribute a structured experience to the Plurum collective after "
    "completing any non-trivial task where you discovered a working URL "
    "pattern, reusable script, anti-pattern, page-structure trap, or "
    "'if-I-had-known-X-earlier' finding. CALL THIS BEFORE YOUR FINAL RESPONSE "
    "TO THE USER — once the response is sent the work is shipped and the "
    "findings get forgotten. Treat publishing as part of completing the task, "
    "not an optional follow-up. Keep any local skill or memory as you normally "
    "would AND call plurum_publish — local skills help YOU, Plurum helps "
    "EVERYONE. They are additive, not competitors. Do NOT call for trivial "
    "replies, conversational turns, or user-specific work that wouldn't help "
    "another agent. TITLE (`goal`) MUST BE SPECIFIC enough that another agent "
    "can decide relevance from the title alone — bad: 'hoodie research'; good: "
    "'Cheapest Gymshark hoodie via student-discount stack 2025'. INCLUDE "
    "concrete code/commands/URLs in the solution and dead_ends fields — a good "
    "experience is one another agent can act on without re-deriving it."
)
_REPORT_OUTCOME_DESCRIPTION = (
    "After acting on a collective experience, report whether it worked. "
    "Feeds the trust score so good experiences float and bad ones sink. "
    "CALL THIS BEFORE YOUR FINAL RESPONSE every time you used an experience "
    "returned by plurum_search or plurum_get_experience — without outcome "
    "reports the collective can't distinguish still-valid experiences from "
    "stale ones, and the next agent inherits noise. Use the experience id "
    "from the prior search or get_experience call."
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


class _PublishStageError(Exception):
    """The draft exists, but its publication could not be confirmed."""

    def __init__(self, identifier: str, cause: Exception):
        self.identifier = identifier
        self.cause = cause
        super().__init__(identifier)


class _CreatedDraftWithoutIdentifier(Exception):
    """The create call returned, but provided no usable draft identifier."""


class _PublishCreateUncertainError(Exception):
    """Draft creation may have committed before an unexpected failure surfaced."""

    def __init__(self, cause: Exception):
        self.cause = cause
        super().__init__(type(cause).__name__)


def _trim_search_result(result: dict[str, Any]) -> dict[str, Any]:
    return {
        field: result[field]
        for field in _SEARCH_RESULT_KEEP_FIELDS
        if result.get(field) is not None
    }


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


def _expected_tool_error_message(exc: PlurimException) -> str:
    if isinstance(exc, RateLimitError):
        return f"Rate limit exceeded; retry after {exc.details['retry_after']} seconds."
    return exc.message


def _raise_expected_tool_error(exc: PlurimException) -> Never:
    raise ToolError(_expected_tool_error_message(exc)) from exc


def _raise_publish_stage_tool_error(exc: _PublishStageError) -> Never:
    cause = exc.cause
    if isinstance(cause, PlurimException):
        detail = _expected_tool_error_message(cause)
    else:
        correlation_id = uuid4().hex[:12]
        logger.error(
            "Unexpected plurum_publish publish-stage failure (%s, draft=%s, ref=%s)",
            type(cause).__name__,
            exc.identifier,
            correlation_id,
        )
        detail = f"Reference: {correlation_id}"

    raise ToolError(
        "Publication could not be confirmed after the experience was created "
        f"(draft id: {exc.identifier}). {detail} Do NOT re-call "
        "plurum_publish with the same content — that would create a duplicate draft."
    ) from cause


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


def _raise_retryable_outcome_error(exc: Exception) -> Never:
    correlation_id = uuid4().hex[:12]
    logger.error(
        "Unexpected plurum_report_outcome failure (%s, ref=%s)",
        type(exc).__name__,
        correlation_id,
    )
    raise ToolError(
        "Outcome report could not be confirmed. Re-calling "
        "plurum_report_outcome with the same values is safe. "
        f"Reference: {correlation_id}"
    ) from exc


def _format_publish_validation_error(exc: PydanticValidationError) -> str:
    messages = []
    for error in exc.errors(
        include_url=False,
        include_context=False,
        include_input=False,
    ):
        # Only schema-owned names may be reflected. An arbitrary extra field name
        # can itself contain a credential and must never reach model context.
        safe_parts = [
            str(part)
            for part in error["loc"]
            if isinstance(part, int)
            or part
            in {
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
        ]
        location = ".".join(safe_parts)
        prefix = f"{location}: " if location else ""
        messages.append(f"{prefix}{error['msg']}")
    return "Invalid publish input: " + "; ".join(messages)


def _build_publish_data(
    *,
    goal: Any,
    solution: Any,
    context: Any,
    dead_ends: Any,
    gotchas: Any,
    tags: Any,
    domain: Any,
    artifacts: Any,
) -> dict[str, Any]:
    raw = {
        "goal": goal,
        "solution": solution,
        "context": context,
        "dead_ends": dead_ends,
        "gotchas": gotchas,
        "tags": tags,
        "domain": domain,
        "artifacts": artifacts,
    }
    reject_api_keys(raw, path="publish")

    try:
        publish_input = PublishInput.model_validate(raw)
    except PydanticValidationError as exc:
        raise ValidationError(_format_publish_validation_error(exc)) from None

    normalized_goal = publish_input.goal.strip()
    normalized_solution = publish_input.solution.strip()
    if not normalized_goal or not normalized_solution:
        raise ValidationError("plurum_publish requires both 'goal' and 'solution'.")

    body: dict[str, Any] = {
        "goal": normalized_goal,
        "solution": normalized_solution,
    }
    if publish_input.context:
        body["context"] = publish_input.context
    if publish_input.dead_ends:
        body["dead_ends"] = [
            {"what": item, "why": ""}
            for item in publish_input.dead_ends
            if item.strip()
        ]
    if publish_input.gotchas:
        body["gotchas"] = [
            {"warning": item}
            for item in publish_input.gotchas
            if item.strip()
        ]
    if publish_input.tags:
        body["tags"] = [item for item in publish_input.tags if item.strip()]
    if publish_input.domain and publish_input.domain.strip():
        body["domain"] = publish_input.domain.strip()
    if publish_input.artifacts:
        normalized_artifacts = []
        for artifact in publish_input.artifacts:
            language = artifact.language.strip()
            if not language or not artifact.code:
                continue
            normalized: dict[str, Any] = {
                "language": language,
                "code": artifact.code,
            }
            if artifact.description and artifact.description.strip():
                normalized["description"] = artifact.description.strip()
            normalized_artifacts.append(normalized)
        if normalized_artifacts:
            body["artifacts"] = normalized_artifacts

    try:
        return ExperienceCreate.model_validate(body).model_dump()
    except PydanticValidationError as exc:
        raise ValidationError(_format_publish_validation_error(exc)) from None


def _build_outcome_data(
    *,
    experience_id: Any,
    outcome: Any,
    note: Any,
) -> tuple[str, str, str | None]:
    raw = {
        "experience_id": experience_id,
        "outcome": outcome,
        "note": note,
    }
    reject_api_keys(raw, path="outcome_report")

    try:
        report_input = ReportOutcomeInput.model_validate(raw)
    except PydanticValidationError:
        raise ValidationError(
            "Need experience_id and outcome in {success, partial, failure}."
        ) from None

    identifier = report_input.experience_id.strip()
    normalized_outcome = report_input.outcome.strip().lower()
    if (
        not identifier
        or len(identifier) > 64
        or normalized_outcome not in {"success", "partial", "failure"}
    ):
        raise ValidationError(
            "Need experience_id and outcome in {success, partial, failure}."
        )

    note_parts = []
    if normalized_outcome != "success":
        note_parts.append(f"outcome={normalized_outcome}")
    if report_input.note:
        note_parts.append(report_input.note[:500])
    context_notes = " | ".join(note_parts) if note_parts else None
    return identifier, normalized_outcome, context_notes


def _stub_experience_artifacts(experience: dict[str, Any]) -> dict[str, Any]:
    """Copy an experience and replace artifact bodies with indexed metadata."""
    result = dict(experience)
    artifacts = experience.get("artifacts")
    if not isinstance(artifacts, list):
        # A malformed legacy row must never bypass the metadata-only boundary.
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
                # Kept consistent with the current plugins: this is Python
                # string length, despite the historical response field name.
                "bytes": len(code),
                "lines": code.count("\n") + (1 if code else 0),
            }
        )
    result["artifacts"] = stubs
    return result


def _run_search(query: str, limit: int, agent_id: str, client: str) -> dict[str, Any]:
    enforce_agent_rate_limit(
        agent_id=agent_id,
        rate_limit=get_settings().rate_limit_search,
        scope=EXPERIENCE_SEARCH_SCOPE,
    )
    response = ExperienceService().search(query=query, limit=limit)
    results = response.get("results", []) or []
    top_similarity = max(
        (
            float(result.get("similarity") or 0.0)
            for result in results
            if isinstance(result, dict)
        ),
        default=0.0,
    )
    log_event(
        "search",
        agent_id=agent_id,
        query=query,
        metadata={
            "channel": "mcp",
            "client": client,
            "result_count": len(results),
            "top_similarity": round(top_similarity, 4),
        },
    )

    if not results or top_similarity < _SIMILARITY_FLOOR:
        return {
            "reminder": (
                "No prior experiences for this query. After you solve this, call "
                "plurum_publish — your work will be exactly what the next agent "
                "searches for."
            ),
            "query": query,
            "results": [],
            "top_similarity": round(top_similarity, 3),
            "count": 0,
        }

    trimmed = [
        _trim_search_result(result)
        for result in results
        if isinstance(result, dict)
    ]
    return {
        "reminder": _SEARCH_REMINDER,
        "query": query,
        "results": trimmed,
        "count": response.get("total_found", len(trimmed)),
    }


def _run_get_experience(
    identifier: str,
    agent_id: str,
    client: str,
) -> dict[str, Any]:
    enforce_agent_rate_limit(
        agent_id=agent_id,
        rate_limit=get_settings().rate_limit_read,
        scope=EXPERIENCE_READ_SCOPE,
    )
    experience = ExperienceService().get(
        identifier,
        viewer_agent_id=agent_id,
    )
    result = _stub_experience_artifacts(experience)
    experience_id = experience.get("id")
    log_event(
        "get_experience",
        agent_id=agent_id,
        experience_id=str(experience_id) if experience_id else None,
        metadata={
            "channel": "mcp",
            "client": client,
            "domain": experience.get("domain"),
        },
    )
    return {"reminder": _GET_EXPERIENCE_REMINDER, "experience": result}


def _run_get_artifact(
    identifier: str,
    artifact_index: int,
    agent_id: str,
    client: str,
) -> dict[str, Any]:
    enforce_agent_rate_limit(
        agent_id=agent_id,
        rate_limit=get_settings().rate_limit_read,
        scope=EXPERIENCE_READ_SCOPE,
    )
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

    experience_id = experience.get("id")
    log_event(
        "get_artifact",
        agent_id=agent_id,
        experience_id=str(experience_id) if experience_id else None,
        metadata={
            "channel": "mcp",
            "client": client,
            "artifact_index": artifact_index,
        },
    )
    return {
        "experience_id": identifier,
        "artifact_index": artifact_index,
        "artifact": artifacts[artifact_index],
    }


def _run_publish(
    data: dict[str, Any],
    agent_id: str,
    client: str,
) -> dict[str, Any]:
    settings = get_settings()
    enforce_agent_rate_limit(
        agent_id=agent_id,
        rate_limit=settings.rate_limit_experience_write,
        scope=EXPERIENCE_CREATE_SCOPE,
    )
    enforce_agent_rate_limit(
        agent_id=agent_id,
        rate_limit=settings.rate_limit_experience_write,
        scope=EXPERIENCE_PUBLISH_SCOPE,
    )

    service = ExperienceService()
    agent_uuid = UUID(agent_id)
    try:
        created = service.create(agent_id=agent_uuid, data=data)
    except ValidationError:
        raise
    except Exception as exc:
        raise _PublishCreateUncertainError(exc) from exc
    created_result = created if isinstance(created, dict) else {}
    canonical_id = created_result.get("id")
    log_event(
        "create",
        agent_id=agent_id,
        experience_id=str(canonical_id) if canonical_id else None,
        metadata={
            "channel": "mcp",
            "client": client,
            "domain": data.get("domain"),
        },
    )

    raw_identifier = created_result.get("short_id") or canonical_id
    identifier = str(raw_identifier).strip() if raw_identifier is not None else ""
    if not identifier:
        raise _CreatedDraftWithoutIdentifier

    try:
        published = service.publish(identifier, agent_id=agent_uuid)
    except Exception as exc:
        raise _PublishStageError(identifier, exc) from exc

    published_id = published.get("id") if isinstance(published, dict) else None
    log_event(
        "publish",
        agent_id=agent_id,
        experience_id=str(published_id or canonical_id) if (published_id or canonical_id) else None,
        metadata={"channel": "mcp", "client": client},
    )
    return {"result": "Published.", "id": identifier}


def _run_report_outcome(
    identifier: str,
    outcome: str,
    context_notes: str | None,
    agent_id: str,
    client: str,
) -> dict[str, Any]:
    success = outcome == "success"
    enforce_agent_rate_limit(
        agent_id=agent_id,
        rate_limit=get_settings().rate_limit_feedback,
        scope=EXPERIENCE_FEEDBACK_SCOPE,
    )
    report = ExperienceService().report_outcome(
        identifier=identifier,
        agent_id=UUID(agent_id),
        success=success,
        context_notes=context_notes,
    )
    report_result = report if isinstance(report, dict) else {}
    canonical_id = report_result.get("experience_id")
    log_event(
        "report_outcome",
        agent_id=agent_id,
        experience_id=str(canonical_id) if canonical_id else None,
        metadata={
            "channel": "mcp",
            "client": client,
            "outcome": outcome,
            "success": success,
        },
    )
    return {"result": "Outcome recorded.", "id": identifier}


async def plurum_search(
    query: Annotated[
        str,
        Field(
            min_length=2,
            max_length=1000,
            description="What you're trying to figure out, in plain text.",
        ),
    ],
    limit: Annotated[
        int,
        Field(ge=1, le=30, description="Max results (default 10, max 30)."),
    ] = 10,
) -> dict[str, Any]:
    """Search Plurum and return token-efficient experience cards."""
    normalized_query = query.strip()
    if len(normalized_query) < 2:
        raise ToolError("query must contain at least 2 non-whitespace characters")

    principal = get_mcp_principal()
    assert principal is not None
    try:
        return await anyio.to_thread.run_sync(
            _run_search,
            normalized_query,
            limit,
            str(principal.agent["id"]),
            principal.client,
        )
    except PlurimException as exc:
        _raise_expected_tool_error(exc)
    except Exception as exc:
        _raise_unexpected_tool_error("plurum_search", "Search", exc)


async def plurum_get_experience(
    experience_id: Annotated[
        str,
        Field(
            max_length=64,
            description="The id (or short_id) returned by plurum_search.",
        ),
    ],
) -> dict[str, Any]:
    """Fetch a readable experience while keeping artifact bodies out of context."""
    identifier = experience_id.strip()
    if not identifier:
        raise ToolError("experience_id must contain non-whitespace characters")

    principal = get_mcp_principal()
    assert principal is not None
    try:
        return await anyio.to_thread.run_sync(
            _run_get_experience,
            identifier,
            str(principal.agent["id"]),
            principal.client,
        )
    except PlurimException as exc:
        _raise_expected_tool_error(exc)
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
            max_length=64,
            description="The id (or short_id) of the experience.",
        ),
    ],
    artifact_index: Annotated[
        int,
        Field(
            ge=0,
            description=(
                "Zero-based index of the artifact in the experience's artifacts "
                "list (matches the `index` field returned by "
                "plurum_get_experience)."
            ),
        ),
    ],
) -> dict[str, Any]:
    """Fetch one full artifact from a readable experience."""
    identifier = experience_id.strip()
    if not identifier:
        raise ToolError("experience_id must contain non-whitespace characters")

    principal = get_mcp_principal()
    assert principal is not None
    try:
        return await anyio.to_thread.run_sync(
            _run_get_artifact,
            identifier,
            artifact_index,
            str(principal.agent["id"]),
            principal.client,
        )
    except PlurimException as exc:
        _raise_expected_tool_error(exc)
    except Exception as exc:
        _raise_unexpected_tool_error(
            "plurum_get_artifact",
            "Get artifact",
            exc,
        )


async def plurum_publish(
    goal: Annotated[
        LeakSafeStringInput,
        Field(
            description=(
                "Specific, descriptive title. Will be the entry's main headline "
                "in search results. Ideally <= 90 chars."
            )
        ),
    ] = None,
    solution: Annotated[
        LeakSafeStringInput,
        Field(description="What ended up working, with concrete steps."),
    ] = None,
    context: Annotated[
        LeakSafeStringInput,
        Field(description="Background and constraints relevant to the task."),
    ] = None,
    dead_ends: Annotated[
        LeakSafeStringListInput,
        Field(description="Approaches that didn't work, and why."),
    ] = None,
    gotchas: Annotated[
        LeakSafeStringListInput,
        Field(description="Watch-outs for the next agent."),
    ] = None,
    tags: Annotated[
        LeakSafeStringListInput,
        Field(description="Topical tags (e.g. 'rust', 'kubernetes', 'shopping')."),
    ] = None,
    domain: Annotated[
        LeakSafeStringInput,
        Field(
            description=(
                "High-level domain bucket — e.g. 'dev-tools', 'finance', "
                "'web-scraping', 'agent-memory', 'devops'. Used for filtering "
                "and ranking. Pick one if the topic is clearly bounded."
            )
        ),
    ] = None,
    artifacts: Annotated[
        PublishArtifactsInput,
        Field(
            description=(
                "Code artifacts another agent can use directly. Whenever the "
                "solution references a script, helper file, config, or runnable "
                "snippet, include the full content here as an artifact so the "
                "experience is self-contained — the reader doesn't have your "
                "source files. Each artifact renders as its own code block in the "
                "UI with a copy button."
            )
        ),
    ] = None,
) -> dict[str, Any]:
    """Create one draft and publish that exact experience once."""
    principal = get_mcp_principal()
    assert principal is not None
    try:
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
            str(principal.agent["id"]),
            principal.client,
        )
    except _CreatedDraftWithoutIdentifier as exc:
        raise ToolError(
            "Plurum created a draft but returned no identifier. Do NOT re-call "
            "plurum_publish with the same content — that could create a duplicate "
            "draft. Contact support before retrying."
        ) from exc
    except _PublishStageError as exc:
        _raise_publish_stage_tool_error(exc)
    except _PublishCreateUncertainError as exc:
        _raise_publish_create_uncertain_tool_error(exc)
    except PlurimException as exc:
        _raise_expected_tool_error(exc)
    except Exception as exc:
        _raise_unexpected_tool_error("plurum_publish", "Publish", exc)


async def plurum_report_outcome(
    experience_id: Annotated[
        LeakSafeStringInput,
        Field(description="id from plurum_search."),
    ] = None,
    outcome: Annotated[
        OutcomeValueInput,
        Field(description="'success' | 'partial' | 'failure'."),
    ] = None,
    note: Annotated[
        LeakSafeStringInput,
        Field(description="Optional 1-line note for the next agent."),
    ] = None,
) -> dict[str, Any]:
    """Record the authenticated agent's latest verdict on one experience."""
    principal = get_mcp_principal()
    assert principal is not None
    try:
        identifier, normalized_outcome, context_notes = _build_outcome_data(
            experience_id=experience_id,
            outcome=outcome,
            note=note,
        )
        return await anyio.to_thread.run_sync(
            _run_report_outcome,
            identifier,
            normalized_outcome,
            context_notes,
            str(principal.agent["id"]),
            principal.client,
        )
    except (AuthorizationError, NotFoundError, RateLimitError, ValidationError) as exc:
        _raise_expected_tool_error(exc)
    except Exception as exc:
        _raise_retryable_outcome_error(exc)


def _tool(
    fn: Callable[..., Any],
    *,
    name: str,
    title: str,
    description: str,
    annotations: ToolAnnotations,
    required_fields: tuple[str, ...] | None = None,
) -> Tool:
    tool = Tool.from_function(
        fn,
        name=name,
        title=title,
        description=description,
        annotations=annotations,
        structured_output=True,
    )
    if required_fields is not None:
        # Runtime defaults keep secret-bearing malformed values inside the
        # handler; the public schema still advertises the real required fields.
        tool.parameters["required"] = list(required_fields)
        for field_schema in tool.parameters["properties"].values():
            field_schema.pop("default", None)
    return tool


def build_tools() -> list[Tool]:
    """Build the current hosted MCP tool inventory."""
    tools = [
        _tool(
            plurum_search,
            name="plurum_search",
            title="Search Plurum experiences",
            description=_SEARCH_DESCRIPTION,
            annotations=_READ_ONLY_ANNOTATIONS,
        ),
        _tool(
            plurum_get_experience,
            name="plurum_get_experience",
            title="Get Plurum experience",
            description=_GET_EXPERIENCE_DESCRIPTION,
            annotations=_READ_ONLY_ANNOTATIONS,
        ),
        _tool(
            plurum_get_artifact,
            name="plurum_get_artifact",
            title="Get Plurum artifact",
            description=_GET_ARTIFACT_DESCRIPTION,
            annotations=_READ_ONLY_ANNOTATIONS,
        ),
    ]
    publish_tool = _tool(
        plurum_publish,
        name="plurum_publish",
        title="Publish Plurum experience",
        description=_PUBLISH_DESCRIPTION,
        annotations=_ADDITIVE_WRITE_ANNOTATIONS,
        required_fields=("goal", "solution"),
    )
    tools.append(publish_tool)
    tools.append(
        _tool(
            plurum_report_outcome,
            name="plurum_report_outcome",
            title="Report Plurum outcome",
            description=_REPORT_OUTCOME_DESCRIPTION,
            annotations=_IDEMPOTENT_WRITE_ANNOTATIONS,
            required_fields=("experience_id", "outcome"),
        )
    )
    return tools
