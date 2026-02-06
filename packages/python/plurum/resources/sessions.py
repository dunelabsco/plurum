"""
Sessions resource for the Plurum SDK
"""

from __future__ import annotations

from typing import Optional

from plurum._http import AsyncHttpClient, HttpClient
from plurum.types.sessions import (
    ContributionCreate,
    SessionClose,
    SessionCreate,
    SessionEntryCreate,
    SessionStatus,
)


class SessionsResource:
    """Synchronous resource for session operations"""

    def __init__(self, client: HttpClient):
        self._client = client

    def open(self, data: SessionCreate) -> dict:
        """
        Open a new session.

        Requires authentication.

        Args:
            data: SessionCreate with topic, domain, tools_used, visibility

        Returns:
            The created session as a dict
        """
        response = self._client.post(
            "/api/v1/sessions",
            data.model_dump(exclude_none=True),
            requires_auth=True,
        )
        return response

    def get(self, identifier: str) -> dict:
        """
        Get a session by its identifier (short_id or slug).

        Args:
            identifier: The session short_id or slug

        Returns:
            The session as a dict
        """
        response = self._client.get(f"/api/v1/sessions/{identifier}")
        return response

    def list(
        self,
        *,
        status: Optional[SessionStatus] = None,
        limit: int = 20,
        offset: int = 0,
    ) -> dict:
        """
        List sessions with optional filtering.

        Args:
            status: Filter by session status
            limit: Maximum number of results (default: 20)
            offset: Number of results to skip

        Returns:
            List of sessions as a dict
        """
        params: dict = {"limit": limit, "offset": offset}
        if status is not None:
            params["status"] = status.value

        response = self._client.get("/api/v1/sessions", params)
        return response

    def log_entry(self, session_id: str, data: SessionEntryCreate) -> dict:
        """
        Log an entry to a session.

        Requires authentication.

        Args:
            session_id: The session identifier
            data: SessionEntryCreate with entry_type and content

        Returns:
            The created entry as a dict
        """
        response = self._client.post(
            f"/api/v1/sessions/{session_id}/entries",
            data.model_dump(exclude_none=True),
            requires_auth=True,
        )
        return response

    def close(self, session_id: str, data: Optional[SessionClose] = None) -> dict:
        """
        Close a session.

        Requires authentication.

        Args:
            session_id: The session identifier
            data: Optional SessionClose with outcome

        Returns:
            The closed session as a dict
        """
        body = data.model_dump(exclude_none=True) if data else {}
        response = self._client.post(
            f"/api/v1/sessions/{session_id}/close",
            body,
            requires_auth=True,
        )
        return response

    def abandon(self, session_id: str) -> dict:
        """
        Abandon a session.

        Requires authentication.

        Args:
            session_id: The session identifier

        Returns:
            The abandoned session as a dict
        """
        response = self._client.post(
            f"/api/v1/sessions/{session_id}/abandon",
            requires_auth=True,
        )
        return response

    def contribute(self, session_id: str, data: ContributionCreate) -> dict:
        """
        Contribute to a session.

        Requires authentication.

        Args:
            session_id: The session identifier
            data: ContributionCreate with content and contribution_type

        Returns:
            The created contribution as a dict
        """
        response = self._client.post(
            f"/api/v1/sessions/{session_id}/contribute",
            data.model_dump(exclude_none=True),
            requires_auth=True,
        )
        return response

    def list_contributions(self, session_id: str) -> list:
        """
        List contributions for a session.

        Args:
            session_id: The session identifier

        Returns:
            List of contributions
        """
        response = self._client.get(
            f"/api/v1/sessions/{session_id}/contributions",
        )
        return response


class AsyncSessionsResource:
    """Asynchronous resource for session operations"""

    def __init__(self, client: AsyncHttpClient):
        self._client = client

    async def open(self, data: SessionCreate) -> dict:
        """Open a new session. Requires authentication."""
        response = await self._client.post(
            "/api/v1/sessions",
            data.model_dump(exclude_none=True),
            requires_auth=True,
        )
        return response

    async def get(self, identifier: str) -> dict:
        """Get a session by its identifier (short_id or slug)."""
        response = await self._client.get(f"/api/v1/sessions/{identifier}")
        return response

    async def list(
        self,
        *,
        status: Optional[SessionStatus] = None,
        limit: int = 20,
        offset: int = 0,
    ) -> dict:
        """List sessions with optional filtering."""
        params: dict = {"limit": limit, "offset": offset}
        if status is not None:
            params["status"] = status.value

        response = await self._client.get("/api/v1/sessions", params)
        return response

    async def log_entry(self, session_id: str, data: SessionEntryCreate) -> dict:
        """Log an entry to a session. Requires authentication."""
        response = await self._client.post(
            f"/api/v1/sessions/{session_id}/entries",
            data.model_dump(exclude_none=True),
            requires_auth=True,
        )
        return response

    async def close(
        self, session_id: str, data: Optional[SessionClose] = None
    ) -> dict:
        """Close a session. Requires authentication."""
        body = data.model_dump(exclude_none=True) if data else {}
        response = await self._client.post(
            f"/api/v1/sessions/{session_id}/close",
            body,
            requires_auth=True,
        )
        return response

    async def abandon(self, session_id: str) -> dict:
        """Abandon a session. Requires authentication."""
        response = await self._client.post(
            f"/api/v1/sessions/{session_id}/abandon",
            requires_auth=True,
        )
        return response

    async def contribute(self, session_id: str, data: ContributionCreate) -> dict:
        """Contribute to a session. Requires authentication."""
        response = await self._client.post(
            f"/api/v1/sessions/{session_id}/contribute",
            data.model_dump(exclude_none=True),
            requires_auth=True,
        )
        return response

    async def list_contributions(self, session_id: str) -> list:
        """List contributions for a session."""
        response = await self._client.get(
            f"/api/v1/sessions/{session_id}/contributions",
        )
        return response
