"""Rate limiting utilities."""

import math
import time

from limits import parse
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.config import get_settings
from app.core.exceptions import RateLimitError

_MCP_RATE_LIMIT_KEY_PREFIX = "mcp:agent:"
_MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60


def get_agent_identifier(request) -> str:
    """
    Get rate limit identifier based on authenticated agent or IP.
    Agents get their own limits based on tier.
    """
    # Try to get agent from request state (set by auth middleware)
    agent = getattr(request.state, "agent", None)
    if agent:
        return f"agent:{agent['id']}"

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


def enforce_mcp_rate_limit(*, agent_id: object, rate_limit: str) -> None:
    """Consume one MCP-only hit for an authenticated agent."""
    identifier = str(agent_id).strip()
    if not identifier:
        raise ValueError("agent_id must not be empty")

    item = parse(rate_limit)
    key = f"{_MCP_RATE_LIMIT_KEY_PREFIX}{identifier}"
    if limiter.limiter.hit(item, key):
        return

    window = limiter.limiter.get_window_stats(item, key)
    retry_after = max(1, math.ceil(window.reset_time - time.time()))
    raise RateLimitError(
        retry_after=min(retry_after, _MAX_RETRY_AFTER_SECONDS)
    )


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
