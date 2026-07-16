"""Tests for rate limits shared by HTTP and hosted transports."""

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from limits import parse
from limits.storage import MemoryStorage
from pydantic import ValidationError
from starlette.requests import Request

from app.config import Settings, get_settings
from app.core.exceptions import RateLimitError
from app.core.rate_limiter import (
    EXPERIENCE_ARCHIVE_SCOPE,
    EXPERIENCE_CREATE_SCOPE,
    EXPERIENCE_FEEDBACK_SCOPE,
    EXPERIENCE_PUBLISH_SCOPE,
    EXPERIENCE_READ_SCOPE,
    EXPERIENCE_SEARCH_SCOPE,
    enforce_agent_rate_limit,
    get_agent_identifier,
    get_ip_rate_limit_key,
    limiter,
    rate_limit_exceeded_handler,
)


def _request(
    remote_address: str,
    headers: list[tuple[bytes, bytes]] | None = None,
) -> Request:
    return Request(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "https",
            "path": "/api/v1/agents/register",
            "raw_path": b"/api/v1/agents/register",
            "query_string": b"",
            "headers": headers or [],
            "client": (remote_address, 1234),
            "server": ("testserver", 443),
        }
    )


def test_rate_limit_identity_uses_ip_until_an_agent_is_authenticated():
    request = _request("203.0.113.9")

    assert get_agent_identifier(request) == "ip:203.0.113.9"

    request.state.agent = {"id": "00000000-0000-0000-0000-000000000001"}
    assert get_agent_identifier(request) == (
        "agent:00000000-0000-0000-0000-000000000001"
    )


def test_trusted_railway_proxy_uses_normalized_real_client_ip():
    request = _request(
        "100.64.0.2",
        [(b"x-real-ip", b"2001:0db8:0:0:0:0:0:1")],
    )

    assert get_agent_identifier(request) == "ip:2001:db8::1"


@pytest.mark.parametrize(
    ("remote_address", "headers", "expected"),
    [
        ("198.51.100.4", [(b"x-real-ip", b"203.0.113.9")], "ip:198.51.100.4"),
        ("100.64.0.2", [], "ip:100.64.0.2"),
        ("100.64.0.2", [(b"x-real-ip", b"not-an-ip")], "ip:100.64.0.2"),
        (
            "100.64.0.2",
            [(b"x-real-ip", b"203.0.113.9, 198.51.100.4")],
            "ip:100.64.0.2",
        ),
        (
            "100.64.0.2",
            [(b"x-real-ip", b"203.0.113.9"), (b"x-real-ip", b"198.51.100.4")],
            "ip:100.64.0.2",
        ),
    ],
)
def test_real_ip_header_is_ignored_unless_it_is_singular_valid_and_trusted(
    remote_address,
    headers,
    expected,
):
    assert get_agent_identifier(_request(remote_address, headers)) == expected


def test_registration_ip_key_ignores_authenticated_request_state():
    request = _request("2001:0db8:0:0:0:0:0:1")
    request.state.agent = {"id": "00000000-0000-0000-0000-000000000001"}

    assert get_ip_rate_limit_key(request) == "ip:2001:db8::1"


def test_owned_rest_rate_limit_handler_preserves_safe_response_shape():
    response = rate_limit_exceeded_handler(
        _request("203.0.113.9"),
        SimpleNamespace(detail="1 per 1 minute"),
    )

    assert response.status_code == 429
    assert json.loads(response.body) == {
        "error": "Rate limit exceeded: 1 per 1 minute"
    }


def test_process_local_limits_match_single_worker_container_contract():
    dockerfile = (Path(__file__).parents[1] / "Dockerfile").read_text()

    assert isinstance(limiter.limiter.storage, MemoryStorage)
    assert 'CMD ["uvicorn", "app.main:app"' in dockerfile
    assert '"--workers", "1"' in dockerfile
    assert '"--no-proxy-headers"' in dockerfile


@pytest.mark.parametrize(
    "field",
    [
        "rate_limit_experience_write",
        "rate_limit_feedback",
        "rate_limit_acquire",
        "rate_limit_session_write",
        "rate_limit_session_entry",
        "rate_limit_check_username",
        "rate_limit_register",
        "rate_limit_search",
        "rate_limit_read",
    ],
)
def test_invalid_rate_limit_configuration_fails_at_startup(field):
    with pytest.raises(ValidationError, match=field):
        Settings(**{field: "not-a-rate-limit"})


@pytest.mark.parametrize(
    "field",
    ["rate_limit_standard", "rate_limit_premium", "rate_limit_unlimited"],
)
def test_non_positive_tier_limit_configuration_fails_at_startup(field):
    with pytest.raises(ValidationError, match=field):
        Settings(**{field: 0})


def test_invalid_trusted_proxy_network_fails_at_startup():
    with pytest.raises(ValidationError, match="rate_limit_trusted_proxy_networks"):
        Settings(rate_limit_trusted_proxy_networks=["not-a-network"])


def test_agent_rate_limit_returns_positive_retry_after():
    for _ in range(2):
        enforce_agent_rate_limit(
            agent_id="agent-one",
            rate_limit="2/minute",
            scope=EXPERIENCE_SEARCH_SCOPE,
        )

    with pytest.raises(RateLimitError) as exc_info:
        enforce_agent_rate_limit(
            agent_id="agent-one",
            rate_limit="2/minute",
            scope=EXPERIENCE_SEARCH_SCOPE,
        )

    assert exc_info.value.details["retry_after"] >= 1


def test_agent_rate_limits_are_independent_by_agent_and_scope():
    enforce_agent_rate_limit(
        agent_id="agent-one",
        rate_limit="1/minute",
        scope=EXPERIENCE_SEARCH_SCOPE,
    )
    enforce_agent_rate_limit(
        agent_id="agent-two",
        rate_limit="1/minute",
        scope=EXPERIENCE_SEARCH_SCOPE,
    )
    enforce_agent_rate_limit(
        agent_id="agent-one",
        rate_limit="1/minute",
        scope="another-scope",
    )

    with pytest.raises(RateLimitError):
        enforce_agent_rate_limit(
            agent_id="agent-one",
            rate_limit="1/minute",
            scope=EXPERIENCE_SEARCH_SCOPE,
        )


def test_experience_write_scopes_remain_independent():
    for scope in (
        EXPERIENCE_CREATE_SCOPE,
        EXPERIENCE_PUBLISH_SCOPE,
        EXPERIENCE_ARCHIVE_SCOPE,
    ):
        enforce_agent_rate_limit(
            agent_id="writer",
            rate_limit="1/hour",
            scope=scope,
        )

    for scope in (
        EXPERIENCE_CREATE_SCOPE,
        EXPERIENCE_PUBLISH_SCOPE,
        EXPERIENCE_ARCHIVE_SCOPE,
    ):
        with pytest.raises(RateLimitError):
            enforce_agent_rate_limit(
                agent_id="writer",
                rate_limit="1/hour",
                scope=scope,
            )


def test_rest_search_shares_agent_limit_while_anonymous_keeps_ip_key(
    client,
    mock_agent,
    auth_headers,
):
    search_limit = get_settings().rate_limit_search
    for _ in range(parse(search_limit).amount - 1):
        enforce_agent_rate_limit(
            agent_id=mock_agent["id"],
            rate_limit=search_limit,
            scope=EXPERIENCE_SEARCH_SCOPE,
        )

    search_result = {"query": "shared limit", "results": [], "total_found": 0}
    with (
        patch("app.core.security.validate_api_key", return_value=mock_agent),
        patch(
            "app.services.experience_service.ExperienceService.search",
            return_value=search_result,
        ),
    ):
        authenticated = client.post(
            "/api/v1/experiences/search",
            headers=auth_headers,
            json={"query": "shared limit"},
        )
        anonymous = client.post(
            "/api/v1/experiences/search",
            json={"query": "shared limit"},
        )

    assert authenticated.status_code == 200
    with pytest.raises(RateLimitError):
        enforce_agent_rate_limit(
            agent_id=mock_agent["id"],
            rate_limit=search_limit,
            scope=EXPERIENCE_SEARCH_SCOPE,
        )
    assert anonymous.status_code == 200


def test_rest_experience_get_shares_read_limit_with_hosted_transports(
    client,
    mock_agent,
    auth_headers,
):
    read_limit = get_settings().rate_limit_read
    for _ in range(parse(read_limit).amount - 1):
        enforce_agent_rate_limit(
            agent_id=mock_agent["id"],
            rate_limit=read_limit,
            scope=EXPERIENCE_READ_SCOPE,
        )

    experience = {
        "id": "10000000-0000-0000-0000-000000000001",
        "short_id": "read01",
        "domain": "testing",
    }
    with (
        patch("app.core.security.validate_api_key", return_value=mock_agent),
        patch(
            "app.services.experience_service.ExperienceService.get",
            return_value=experience,
        ),
    ):
        authenticated = client.get(
            "/api/v1/experiences/read01",
            headers=auth_headers,
        )
        anonymous = client.get("/api/v1/experiences/read01")

    assert authenticated.status_code == 200
    with pytest.raises(RateLimitError):
        enforce_agent_rate_limit(
            agent_id=mock_agent["id"],
            rate_limit=read_limit,
            scope=EXPERIENCE_READ_SCOPE,
        )
    assert anonymous.status_code == 200


def test_rest_experience_writes_share_their_hosted_operation_scopes(
    client,
    mock_agent,
    auth_headers,
):
    write_limit = get_settings().rate_limit_experience_write
    for scope in (
        EXPERIENCE_CREATE_SCOPE,
        EXPERIENCE_PUBLISH_SCOPE,
        EXPERIENCE_ARCHIVE_SCOPE,
    ):
        for _ in range(parse(write_limit).amount - 1):
            enforce_agent_rate_limit(
                agent_id=mock_agent["id"],
                rate_limit=write_limit,
                scope=scope,
            )

    experience = {
        "id": "10000000-0000-0000-0000-000000000001",
        "short_id": "write001",
        "goal": "Share one verified rate-limit behavior",
        "status": "draft",
    }
    with (
        patch("app.core.security.validate_api_key", return_value=mock_agent),
        patch(
            "app.services.experience_service.ExperienceService.create",
            return_value=experience,
        ),
        patch(
            "app.services.experience_service.ExperienceService.publish",
            return_value={**experience, "status": "published"},
        ),
        patch(
            "app.services.experience_service.ExperienceService.archive",
            return_value={**experience, "status": "archived"},
        ),
    ):
        created = client.post(
            "/api/v1/experiences",
            headers=auth_headers,
            json={
                "goal": "Share one verified rate-limit behavior",
                "solution": "Use one scope for each write operation.",
            },
        )
        published = client.post(
            "/api/v1/experiences/write001/publish",
            headers=auth_headers,
        )
        archived = client.post(
            "/api/v1/experiences/write001/archive",
            headers=auth_headers,
        )

    assert created.status_code == 201
    assert published.status_code == 200
    assert archived.status_code == 200
    for scope in (
        EXPERIENCE_CREATE_SCOPE,
        EXPERIENCE_PUBLISH_SCOPE,
        EXPERIENCE_ARCHIVE_SCOPE,
    ):
        with pytest.raises(RateLimitError):
            enforce_agent_rate_limit(
                agent_id=mock_agent["id"],
                rate_limit=write_limit,
                scope=scope,
            )


def test_rest_feedback_actions_share_scope_with_hosted_transport(
    client,
    mock_agent,
    auth_headers,
):
    feedback_limit = get_settings().rate_limit_feedback
    for _ in range(parse(feedback_limit).amount - 2):
        enforce_agent_rate_limit(
            agent_id=mock_agent["id"],
            rate_limit=feedback_limit,
            scope=EXPERIENCE_FEEDBACK_SCOPE,
        )

    report = {
        "id": "20000000-0000-0000-0000-000000000001",
        "experience_id": "10000000-0000-0000-0000-000000000001",
        "success": True,
    }
    vote = {
        "id": "30000000-0000-0000-0000-000000000001",
        "experience_id": "10000000-0000-0000-0000-000000000001",
        "vote_type": "up",
    }
    with (
        patch("app.core.security.validate_api_key", return_value=mock_agent),
        patch(
            "app.services.experience_service.ExperienceService.report_outcome",
            return_value=report,
        ),
        patch(
            "app.services.experience_service.ExperienceService.vote",
            return_value=vote,
        ),
    ):
        outcome_response = client.post(
            "/api/v1/experiences/outcome01/outcome",
            headers=auth_headers,
            json={"success": True},
        )
        vote_response = client.post(
            "/api/v1/experiences/outcome01/vote",
            headers=auth_headers,
            json={"vote_type": "up"},
        )

    assert outcome_response.status_code == 201
    assert vote_response.status_code == 200
    with pytest.raises(RateLimitError):
        enforce_agent_rate_limit(
            agent_id=mock_agent["id"],
            rate_limit=feedback_limit,
            scope=EXPERIENCE_FEEDBACK_SCOPE,
        )
