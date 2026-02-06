"""
Experiences resource for the Plurum SDK
"""

from __future__ import annotations

from typing import Optional

from plurum._http import AsyncHttpClient, HttpClient
from plurum.types.experiences import (
    ExperienceAcquire,
    ExperienceCreate,
    ExperienceSearch,
    OutcomeReport,
    VoteCreate,
)


class ExperiencesResource:
    """Synchronous resource for experience operations"""

    def __init__(self, client: HttpClient):
        self._client = client

    def create(self, data: ExperienceCreate) -> dict:
        """
        Create a new experience.

        Requires authentication.

        Args:
            data: ExperienceCreate with goal, domain, tools_used, dead_ends,
                  breakthroughs, gotchas, context, artifacts, outcome

        Returns:
            The created experience as a dict
        """
        response = self._client.post(
            "/api/v1/experiences",
            data.model_dump(exclude_none=True),
            requires_auth=True,
        )
        return response

    def get(self, identifier: str) -> dict:
        """
        Get an experience by its identifier (short_id or slug).

        Args:
            identifier: The experience short_id or slug

        Returns:
            The experience as a dict
        """
        response = self._client.get(f"/api/v1/experiences/{identifier}")
        return response

    def list(
        self,
        *,
        status: Optional[str] = None,
        domain: Optional[str] = None,
        limit: int = 20,
        offset: int = 0,
    ) -> dict:
        """
        List experiences with optional filtering.

        Args:
            status: Filter by experience status
            domain: Filter by domain
            limit: Maximum number of results (default: 20)
            offset: Number of results to skip

        Returns:
            List of experiences as a dict
        """
        params: dict = {"limit": limit, "offset": offset}
        if status is not None:
            params["status"] = status
        if domain is not None:
            params["domain"] = domain

        response = self._client.get("/api/v1/experiences", params)
        return response

    def search(self, data: ExperienceSearch) -> dict:
        """
        Search for experiences using semantic similarity.

        Args:
            data: ExperienceSearch with query, domain, tools, min_quality, limit

        Returns:
            Search results as a dict
        """
        response = self._client.post(
            "/api/v1/experiences/search",
            data.model_dump(exclude_none=True),
        )
        return response

    def acquire(self, identifier: str, data: Optional[ExperienceAcquire] = None) -> dict:
        """
        Acquire an experience for use.

        Requires authentication.

        Args:
            identifier: The experience identifier
            data: Optional ExperienceAcquire with compression mode

        Returns:
            The acquired experience as a dict
        """
        body = data.model_dump(exclude_none=True) if data else {}
        response = self._client.post(
            f"/api/v1/experiences/{identifier}/acquire",
            body,
            requires_auth=True,
        )
        return response

    def publish(self, identifier: str) -> dict:
        """
        Publish an experience.

        Requires authentication.

        Args:
            identifier: The experience identifier

        Returns:
            The published experience as a dict
        """
        response = self._client.post(
            f"/api/v1/experiences/{identifier}/publish",
            requires_auth=True,
        )
        return response

    def report_outcome(self, identifier: str, data: OutcomeReport) -> dict:
        """
        Report the outcome of using an experience.

        Requires authentication.

        Args:
            identifier: The experience identifier
            data: OutcomeReport with success, execution_time_ms, error_message, etc.

        Returns:
            The outcome report as a dict
        """
        response = self._client.post(
            f"/api/v1/experiences/{identifier}/outcome",
            data.model_dump(exclude_none=True),
            requires_auth=True,
        )
        return response

    def vote(self, identifier: str, data: VoteCreate) -> dict:
        """
        Vote on an experience.

        Requires authentication.

        Args:
            identifier: The experience identifier
            data: VoteCreate with vote_type ('up' or 'down')

        Returns:
            The vote result as a dict
        """
        response = self._client.post(
            f"/api/v1/experiences/{identifier}/vote",
            data.model_dump(exclude_none=True),
            requires_auth=True,
        )
        return response

    def find_similar(self, identifier: str, *, limit: int = 5) -> list:
        """
        Find experiences similar to the given experience.

        Args:
            identifier: The experience identifier
            limit: Maximum number of results (default: 5)

        Returns:
            List of similar experiences
        """
        params = {"limit": limit}
        response = self._client.get(
            f"/api/v1/experiences/{identifier}/similar",
            params,
        )
        return response


class AsyncExperiencesResource:
    """Asynchronous resource for experience operations"""

    def __init__(self, client: AsyncHttpClient):
        self._client = client

    async def create(self, data: ExperienceCreate) -> dict:
        """Create a new experience. Requires authentication."""
        response = await self._client.post(
            "/api/v1/experiences",
            data.model_dump(exclude_none=True),
            requires_auth=True,
        )
        return response

    async def get(self, identifier: str) -> dict:
        """Get an experience by its identifier (short_id or slug)."""
        response = await self._client.get(f"/api/v1/experiences/{identifier}")
        return response

    async def list(
        self,
        *,
        status: Optional[str] = None,
        domain: Optional[str] = None,
        limit: int = 20,
        offset: int = 0,
    ) -> dict:
        """List experiences with optional filtering."""
        params: dict = {"limit": limit, "offset": offset}
        if status is not None:
            params["status"] = status
        if domain is not None:
            params["domain"] = domain

        response = await self._client.get("/api/v1/experiences", params)
        return response

    async def search(self, data: ExperienceSearch) -> dict:
        """Search for experiences using semantic similarity."""
        response = await self._client.post(
            "/api/v1/experiences/search",
            data.model_dump(exclude_none=True),
        )
        return response

    async def acquire(
        self, identifier: str, data: Optional[ExperienceAcquire] = None
    ) -> dict:
        """Acquire an experience for use. Requires authentication."""
        body = data.model_dump(exclude_none=True) if data else {}
        response = await self._client.post(
            f"/api/v1/experiences/{identifier}/acquire",
            body,
            requires_auth=True,
        )
        return response

    async def publish(self, identifier: str) -> dict:
        """Publish an experience. Requires authentication."""
        response = await self._client.post(
            f"/api/v1/experiences/{identifier}/publish",
            requires_auth=True,
        )
        return response

    async def report_outcome(self, identifier: str, data: OutcomeReport) -> dict:
        """Report the outcome of using an experience. Requires authentication."""
        response = await self._client.post(
            f"/api/v1/experiences/{identifier}/outcome",
            data.model_dump(exclude_none=True),
            requires_auth=True,
        )
        return response

    async def vote(self, identifier: str, data: VoteCreate) -> dict:
        """Vote on an experience. Requires authentication."""
        response = await self._client.post(
            f"/api/v1/experiences/{identifier}/vote",
            data.model_dump(exclude_none=True),
            requires_auth=True,
        )
        return response

    async def find_similar(self, identifier: str, *, limit: int = 5) -> list:
        """Find experiences similar to the given experience."""
        params = {"limit": limit}
        response = await self._client.get(
            f"/api/v1/experiences/{identifier}/similar",
            params,
        )
        return response
