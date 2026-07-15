"""Rate limiting utilities."""

import math
import time

from limits import parse
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.config import get_settings
from app.core.exceptions import RateLimitError


EXPERIENCE_SEARCH_SCOPE = "experience-search"
EXPERIENCE_READ_SCOPE = "experience-read"
EXPERIENCE_CREATE_SCOPE = "experience-write:create"
EXPERIENCE_PUBLISH_SCOPE = "experience-write:publish"
EXPERIENCE_ARCHIVE_SCOPE = "experience-write:archive"
EXPERIENCE_FEEDBACK_SCOPE = "experience-feedback"


def get_agent_rate_limit_key(agent_id: object) -> str:
    """Return the limiter key shared by HTTP and non-HTTP agent calls."""
    identifier = str(agent_id).strip()
    if not identifier:
        raise ValueError("agent_id must not be empty")
    return f"agent:{identifier}"


def get_agent_identifier(request) -> str:
    """
    Get rate limit identifier based on authenticated agent or IP.
    Agents get their own limits based on tier.
    """
    # Try to get agent from request state (set by auth middleware)
    agent = getattr(request.state, "agent", None)
    if agent:
        return get_agent_rate_limit_key(agent["id"])

    # Fall back to IP address for unauthenticated requests
    return get_remote_address(request)


def get_rate_limit_for_tier(tier: str) -> str:
    """Get rate limit string for a given tier."""
    settings = get_settings()

    limits = {
        "standard": f"{settings.rate_limit_standard}/minute",
        "premium": f"{settings.rate_limit_premium}/minute",
        "unlimited": f"{settings.rate_limit_unlimited}/minute",
    }

    return limits.get(tier, limits["standard"])


# Create the limiter instance
limiter = Limiter(key_func=get_agent_identifier)


def enforce_agent_rate_limit(*, agent_id: object, rate_limit: str, scope: str) -> None:
    """Consume one shared limiter hit for an authenticated non-HTTP call."""
    item = parse(rate_limit)
    identifiers = (get_agent_rate_limit_key(agent_id), scope)
    if limiter.limiter.hit(item, *identifiers):
        return

    window = limiter.limiter.get_window_stats(item, *identifiers)
    retry_after = max(1, math.ceil(window.reset_time - time.time()))
    raise RateLimitError(retry_after=retry_after)


def rate_limit_by_tier(request):
    """
    Dynamic rate limit based on agent tier.
    Use as: @limiter.limit(rate_limit_by_tier)
    """
    agent = getattr(request.state, "agent", None)
    if agent:
        tier = agent.get("rate_limit_tier", "standard")
        return get_rate_limit_for_tier(tier)

    # Default for unauthenticated requests
    return "10/minute"
