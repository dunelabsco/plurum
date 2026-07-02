"""API key authentication and security utilities."""

from __future__ import annotations

import hashlib
import logging
import secrets
from typing import Annotated, Optional

from fastapi import Depends, Header, Request

from app.config import get_settings
from app.core.exceptions import AuthenticationError

logger = logging.getLogger(__name__)


def generate_api_key() -> str:
    """Generate a new API key with the configured prefix."""
    settings = get_settings()
    random_part = secrets.token_urlsafe(settings.api_key_length)
    return f"{settings.api_key_prefix}{random_part}"


def hash_api_key(api_key: str) -> str:
    """Hash an API key using SHA256."""
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


async def get_current_agent(
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
        agent = await _validate_api_key(token)
        # Expose to the rate limiter key func (get_agent_identifier)
        request.state.agent = agent
        return agent
    else:
        # It's not an API key - reject for agent authentication
        raise AuthenticationError("Invalid API key format")


async def _validate_api_key(api_key: str) -> dict:
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


async def get_current_user(
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

    # Validate JWT with Supabase
    client = get_supabase_client()

    try:
        # Use Supabase to verify the JWT and get user
        user_response = client.auth.get_user(token)

        if not user_response or not user_response.user:
            raise AuthenticationError("Invalid or expired token")

        user = user_response.user

        return {
            "id": user.id,
            "email": user.email,
            "created_at": user.created_at,
        }

    except Exception as e:
        error_msg = str(e)
        if "Invalid" in error_msg or "expired" in error_msg.lower():
            raise AuthenticationError("Invalid or expired token")
        logger.warning("Token verification failed: %s", error_msg)
        raise AuthenticationError("Invalid or expired token")


async def get_optional_current_user(
    authorization: Annotated[str | None, Header()] = None,
) -> Optional[dict]:
    """
    Optional user authentication - returns None if no valid auth.
    Useful for endpoints that work with or without authentication.
    """
    if not authorization:
        return None

    try:
        return await get_current_user(authorization)
    except AuthenticationError:
        return None


async def get_optional_current_agent(
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
        return await get_current_agent(request, authorization)
    except AuthenticationError:
        return None


# Type aliases for dependency injection
CurrentAgent = Annotated[dict, Depends(get_current_agent)]
CurrentUser = Annotated[dict, Depends(get_current_user)]
OptionalCurrentUser = Annotated[Optional[dict], Depends(get_optional_current_user)]
OptionalAgent = Annotated[Optional[dict], Depends(get_optional_current_agent)]
