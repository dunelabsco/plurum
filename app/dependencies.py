"""Shared dependencies for dependency injection."""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Header, Request

from app.core.security import get_current_agent
from app.db.supabase_client import get_supabase_client

# Type aliases for common dependencies
CurrentAgent = Annotated[dict, Depends(get_current_agent)]


async def get_optional_agent(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
) -> dict | None:
    """
    Optional authentication - returns agent if authenticated, None otherwise.

    Use this for endpoints that work for both authenticated and anonymous users.
    """
    if not authorization:
        return None

    try:
        return await get_current_agent(request, authorization)
    except Exception:
        return None


OptionalAgent = Annotated[dict | None, Depends(get_optional_agent)]
