"""Tests for rate limits shared by HTTP and hosted transports."""

from unittest.mock import patch

import pytest
from limits import parse

from app.config import get_settings
from app.core.exceptions import RateLimitError
from app.core.rate_limiter import (
    EXPERIENCE_READ_SCOPE,
    EXPERIENCE_SEARCH_SCOPE,
    enforce_agent_rate_limit,
)


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
