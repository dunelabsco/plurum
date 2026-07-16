"""Rate limiting utilities."""

import math
import time
from ipaddress import ip_address, ip_network

from limits import parse
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.requests import Request
from starlette.responses import JSONResponse

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


def get_client_ip(request: Request) -> str:
    """Return a normalized client IP without trusting caller-supplied headers."""
    remote_address = get_remote_address(request)
    try:
        remote_ip = ip_address(remote_address)
    except ValueError:
        return remote_address

    trusted_networks = get_settings().rate_limit_trusted_proxy_networks
    if any(remote_ip in ip_network(network, strict=False) for network in trusted_networks):
        real_ip_headers = request.headers.getlist("x-real-ip")
        if len(real_ip_headers) == 1 and "," not in real_ip_headers[0]:
            try:
                return str(ip_address(real_ip_headers[0].strip()))
            except ValueError:
                pass

    return str(remote_ip)


def get_ip_rate_limit_key(request: Request) -> str:
    """Return the rate-limit key for an unauthenticated client address."""
    return f"ip:{get_client_ip(request)}"


def get_agent_identifier(request: Request) -> str:
    """Prefer authenticated agent identity, otherwise use the safe client IP."""
    # Try to get agent from request state (set by auth middleware)
    agent = getattr(request.state, "agent", None)
    if agent:
        return get_agent_rate_limit_key(agent["id"])

    # Fall back to IP address for unauthenticated requests
    return get_ip_rate_limit_key(request)


def get_rate_limit_for_tier(tier: str) -> str:
    """Get rate limit string for a given tier."""
    settings = get_settings()

    limits = {
        "standard": f"{settings.rate_limit_standard}/minute",
        "premium": f"{settings.rate_limit_premium}/minute",
        "unlimited": f"{settings.rate_limit_unlimited}/minute",
    }

    return limits.get(tier, limits["standard"])


# SlowAPI defaults to process-local memory storage. Docker enforces one Uvicorn
# worker, and deployment must remain at one replica while using memory storage.
# Before adding workers or replicas, configure RATELIMIT_STORAGE_URL with a
# supported shared backend and install its driver so REST and hosted MCP calls
# continue to consume the same counters.
limiter = Limiter(key_func=get_agent_identifier)


def rate_limit_exceeded_handler(
    _request: Request,
    exc: RateLimitExceeded,
) -> JSONResponse:
    """Return the existing safe REST 429 shape without private SlowAPI APIs."""
    return JSONResponse(
        {"error": f"Rate limit exceeded: {exc.detail}"},
        status_code=429,
    )


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
