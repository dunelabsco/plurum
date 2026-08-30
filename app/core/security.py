"""API key authentication and security utilities."""

from __future__ import annotations

import hashlib
import logging
import secrets
import time
from collections.abc import Mapping
from typing import Annotated, Optional
from uuid import UUID

from fastapi import Depends, Header, Request

from app.config import get_settings
from app.core.exceptions import AuthenticationError

logger = logging.getLogger(__name__)

_USER_TOKEN_CLOCK_SKEW_SECONDS = 60
_INVALID_USER_TOKEN_MESSAGE = "Invalid or expired token"


def generate_api_key() -> str:
    """Generate a new API key with the configured prefix."""
    settings = get_settings()
    random_part = secrets.token_urlsafe(settings.api_key_length)
    return f"{settings.api_key_prefix}{random_part}"


def hash_api_key(api_key: str) -> str:
    """Create a lookup digest for a server-generated, high-entropy API key."""
    # API keys contain at least 256 bits of CSPRNG entropy. SHA-256 is used as
    # a deterministic database fingerprint here, not as a password KDF.
    return hashlib.sha256(api_key.encode()).hexdigest()


def verify_api_key(api_key: str, hashed_key: str) -> bool:
    """Verify an API key against its hash."""
    return secrets.compare_digest(hash_api_key(api_key), hashed_key)


def get_api_key_prefix(api_key: str) -> str:
    """Extract the prefix from an API key for identification."""
    # Return first 16 chars total (fits in varchar(20))
    return api_key[:16] + "..."


def extract_bearer_token(authorization: str | None) -> str:
    """Extract token from Authorization header."""
    if not authorization:
        raise AuthenticationError("Missing Authorization header")

    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise AuthenticationError("Invalid Authorization header format. Use: Bearer <token>")

    return parts[1]


def get_current_agent(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
) -> dict:
    """
    Dependency that extracts and validates the API key from the request.
    Returns the agent data if valid.
    """
    token = extract_bearer_token(authorization)
    settings = get_settings()

    # Check if it's an API key (starts with prefix) or a JWT
    if token.startswith(settings.api_key_prefix):
        # It's an API key - validate against database
        agent = validate_api_key(token)
        # Expose to the rate limiter key func (get_agent_identifier)
        request.state.agent = agent
        return agent
    else:
        # It's not an API key - reject for agent authentication
        raise AuthenticationError("Invalid API key format")


def validate_api_key(api_key: str) -> dict:
    """Validate an API key and return the agent."""
    from app.db.supabase_client import get_supabase_client

    settings = get_settings()

    # Validate prefix
    if not api_key.startswith(settings.api_key_prefix):
        raise AuthenticationError("Invalid API key format")

    # Hash the key and look up in database
    key_hash = hash_api_key(api_key)

    client = get_supabase_client()
    result = client.table("agents").select("*").eq("api_key_hash", key_hash).execute()

    if not result.data:
        raise AuthenticationError("Invalid API key")

    agent = result.data[0]

    if not agent.get("is_active"):
        raise AuthenticationError("API key has been deactivated")

    # Update last_active_at
    client.table("agents").update({"last_active_at": "now()"}).eq("id", agent["id"]).execute()

    return agent


def get_current_user(
    authorization: Annotated[str | None, Header()] = None,
) -> dict:
    """
    Dependency that validates a Supabase JWT and returns the user data.
    Used for human authentication (web dashboard).
    """
    from app.db.supabase_client import get_supabase_client

    token = extract_bearer_token(authorization)
    settings = get_settings()

    # If it looks like an API key, reject it
    if token.startswith(settings.api_key_prefix):
        raise AuthenticationError("Expected JWT token, got API key")

    # Validate the signature first, then constrain the token to the ordinary
    # Supabase web-user audience. MCP OAuth tokens are valid Supabase JWTs too,
    # but must never authenticate dashboard ownership routes.
    client = get_supabase_client()

    try:
        claims_response = client.auth.get_claims(jwt=token)
        claims = claims_response.get("claims") if claims_response else None
        user_id = _validate_web_user_claims(
            claims,
            expected_issuer=f"{settings.supabase_url.rstrip('/')}/auth/v1",
        )
    except AuthenticationError:
        raise
    except Exception as exc:
        logger.warning("Token verification failed (%s)", type(exc).__name__)
        raise AuthenticationError(_INVALID_USER_TOKEN_MESSAGE) from None

    return {"id": user_id}


def _validate_web_user_claims(
    claims: object,
    *,
    expected_issuer: str,
    now: int | None = None,
) -> str:
    """Return a canonical web-user id from a verified Supabase JWT payload."""
    if not isinstance(claims, Mapping):
        raise AuthenticationError(_INVALID_USER_TOKEN_MESSAGE)

    if (
        claims.get("iss") != expected_issuer
        or claims.get("aud") != "authenticated"
        or "client_id" in claims
    ):
        raise AuthenticationError(_INVALID_USER_TOKEN_MESSAGE)

    subject = claims.get("sub")
    if not isinstance(subject, str):
        raise AuthenticationError(_INVALID_USER_TOKEN_MESSAGE)
    try:
        canonical_subject = str(UUID(subject))
    except (ValueError, AttributeError):
        raise AuthenticationError(_INVALID_USER_TOKEN_MESSAGE) from None
    if subject != canonical_subject:
        raise AuthenticationError(_INVALID_USER_TOKEN_MESSAGE)

    current_time = int(time.time()) if now is None else now
    expires_at = claims.get("exp")
    issued_at = claims.get("iat")
    not_before = claims.get("nbf")

    if not _is_numeric_date(expires_at) or not _is_numeric_date(issued_at):
        raise AuthenticationError(_INVALID_USER_TOKEN_MESSAGE)
    if expires_at < current_time - _USER_TOKEN_CLOCK_SKEW_SECONDS:
        raise AuthenticationError(_INVALID_USER_TOKEN_MESSAGE)
    if issued_at > current_time + _USER_TOKEN_CLOCK_SKEW_SECONDS or issued_at > expires_at:
        raise AuthenticationError(_INVALID_USER_TOKEN_MESSAGE)
    if not_before is not None and (
        not _is_numeric_date(not_before)
        or not_before > current_time + _USER_TOKEN_CLOCK_SKEW_SECONDS
        or not_before > expires_at
    ):
        raise AuthenticationError(_INVALID_USER_TOKEN_MESSAGE)

    return canonical_subject


def _is_numeric_date(value: object) -> bool:
    """Accept the integer NumericDate representation emitted by Supabase."""
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def get_optional_current_user(
    authorization: Annotated[str | None, Header()] = None,
) -> Optional[dict]:
    """
    Optional user authentication - returns None if no valid auth.
    Useful for endpoints that work with or without authentication.
    """
    if not authorization:
        return None

    try:
        return get_current_user(authorization)
    except AuthenticationError:
        return None


def get_optional_current_agent(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
) -> Optional[dict]:
    """
    Optional agent authentication - returns None if no valid auth.
    Useful for public endpoints that work with or without authentication.
    """
    if not authorization:
        return None

    try:
        return get_current_agent(request, authorization)
    except AuthenticationError:
        return None


# Type aliases for dependency injection
CurrentAgent = Annotated[dict, Depends(get_current_agent)]
CurrentUser = Annotated[dict, Depends(get_current_user)]
OptionalCurrentUser = Annotated[Optional[dict], Depends(get_optional_current_user)]
OptionalAgent = Annotated[Optional[dict], Depends(get_optional_current_agent)]
