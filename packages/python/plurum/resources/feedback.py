"""
Feedback resource for the Plurum SDK
"""

from __future__ import annotations

from typing import Optional

from plurum._http import HttpClient, AsyncHttpClient
from plurum.types.feedback import VoteType


class FeedbackResource:
    """Synchronous resource for feedback operations"""

    def __init__(self, client: HttpClient):
        self._client = client

    def vote(self, blueprint_slug: str, vote_type: VoteType) -> dict:
        """
        Vote on a blueprint.

        Args:
            blueprint_slug: The slug of the blueprint to vote on
            vote_type: "up" for helpful, "down" for unhelpful

        Returns:
            Confirmation message
        """
        data = {"blueprint_slug": blueprint_slug, "vote_type": vote_type}
        return self._client.post("/api/v1/feedback/votes", data, requires_auth=True)

    def report_execution(
        self,
        blueprint_slug: str,
        success: bool,
        *,
        version_id: Optional[str] = None,
        execution_time_ms: Optional[int] = None,
        error_message: Optional[str] = None,
        context_notes: Optional[str] = None,
    ) -> dict:
        """
        Report the result of executing a blueprint.

        Args:
            blueprint_slug: The slug of the blueprint that was executed
            success: Whether the execution was successful
            version_id: Specific version that was executed
            execution_time_ms: How long the execution took
            error_message: Error details if failed
            context_notes: Additional context about the execution

        Returns:
            Confirmation message
        """
        data = {
            "blueprint_slug": blueprint_slug,
            "success": success,
        }
        if version_id:
            data["version_id"] = version_id
        if execution_time_ms is not None:
            data["execution_time_ms"] = execution_time_ms
        if error_message:
            data["error_message"] = error_message
        if context_notes:
            data["context_notes"] = context_notes

        return self._client.post("/api/v1/feedback/executions", data, requires_auth=True)


class AsyncFeedbackResource:
    """Asynchronous resource for feedback operations"""

    def __init__(self, client: AsyncHttpClient):
        self._client = client

    async def vote(self, blueprint_slug: str, vote_type: VoteType) -> dict:
        """Vote on a blueprint."""
        data = {"blueprint_slug": blueprint_slug, "vote_type": vote_type}
        return await self._client.post("/api/v1/feedback/votes", data, requires_auth=True)

    async def report_execution(
        self,
        blueprint_slug: str,
        success: bool,
        *,
        version_id: Optional[str] = None,
        execution_time_ms: Optional[int] = None,
        error_message: Optional[str] = None,
        context_notes: Optional[str] = None,
    ) -> dict:
        """Report the result of executing a blueprint."""
        data = {
            "blueprint_slug": blueprint_slug,
            "success": success,
        }
        if version_id:
            data["version_id"] = version_id
        if execution_time_ms is not None:
            data["execution_time_ms"] = execution_time_ms
        if error_message:
            data["error_message"] = error_message
        if context_notes:
            data["context_notes"] = context_notes

        return await self._client.post("/api/v1/feedback/executions", data, requires_auth=True)
