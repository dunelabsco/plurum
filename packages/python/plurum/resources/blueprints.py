"""
Blueprints resource for the Plurum SDK
"""

from __future__ import annotations

from typing import Optional

from plurum._http import HttpClient, AsyncHttpClient
from plurum.types.blueprints import (
    BlueprintDetail,
    BlueprintSummary,
    BlueprintCreate,
    BlueprintUpdate,
    BlueprintStatus,
)
from plurum.types.search import SearchResponse, SearchResult


class BlueprintsResource:
    """Synchronous resource for blueprint operations"""

    def __init__(self, client: HttpClient):
        self._client = client

    def search(
        self,
        query: str,
        *,
        tags: Optional[list[str]] = None,
        limit: int = 10,
        min_success_rate: Optional[float] = None,
    ) -> SearchResponse:
        """
        Search for blueprints using semantic similarity.

        Args:
            query: Natural language search query
            tags: Filter by tags
            limit: Maximum number of results (default: 10)
            min_success_rate: Minimum success rate filter (0-1)

        Returns:
            SearchResponse with matching blueprints
        """
        data: dict = {"query": query, "limit": limit}
        if tags:
            data["tags"] = tags
        if min_success_rate is not None:
            data["min_success_rate"] = min_success_rate

        response = self._client.post("/api/v1/search", data)
        return SearchResponse.model_validate(response)

    def get(self, slug: str) -> BlueprintDetail:
        """
        Get a blueprint by its slug.

        Args:
            slug: The unique slug identifier

        Returns:
            BlueprintDetail with full blueprint data
        """
        response = self._client.get(f"/api/v1/blueprints/{slug}")
        return BlueprintDetail.model_validate(response)

    def list(
        self,
        *,
        limit: int = 20,
        offset: int = 0,
        status: Optional[BlueprintStatus] = None,
        tags: Optional[list[str]] = None,
    ) -> list[BlueprintSummary]:
        """
        List blueprints with optional filtering.

        Args:
            limit: Maximum number of results (default: 20)
            offset: Number of results to skip
            status: Filter by status
            tags: Filter by tags

        Returns:
            List of BlueprintSummary objects
        """
        params: dict = {"limit": limit, "offset": offset}
        if status:
            params["status"] = status
        if tags:
            params["tags"] = tags

        response = self._client.get("/api/v1/blueprints", params)
        return [BlueprintSummary.model_validate(bp) for bp in response]

    def create(
        self,
        title: str,
        goal_description: str,
        strategy: str,
        **kwargs,
    ) -> BlueprintDetail:
        """
        Create a new blueprint.

        Args:
            title: Blueprint title
            goal_description: What the blueprint accomplishes
            strategy: High-level strategy
            **kwargs: Additional fields (execution_steps, code_snippets, tags, etc.)

        Returns:
            The created BlueprintDetail
        """
        data = BlueprintCreate(
            title=title,
            goal_description=goal_description,
            strategy=strategy,
            **kwargs,
        )
        response = self._client.post(
            "/api/v1/blueprints",
            data.model_dump(exclude_none=True),
            requires_auth=True,
        )
        return BlueprintDetail.model_validate(response)

    def update(self, slug: str, **kwargs) -> BlueprintDetail:
        """
        Update an existing blueprint.

        Args:
            slug: The blueprint slug to update
            **kwargs: Fields to update

        Returns:
            The updated BlueprintDetail
        """
        data = BlueprintUpdate(**kwargs)
        response = self._client.put(
            f"/api/v1/blueprints/{slug}",
            data.model_dump(exclude_none=True),
            requires_auth=True,
        )
        return BlueprintDetail.model_validate(response)

    def similar(
        self,
        slug: str,
        *,
        limit: int = 5,
        exclude_same_author: bool = True,
    ) -> list[SearchResult]:
        """
        Find blueprints similar to the given blueprint.

        Args:
            slug: The blueprint slug to find similar items for
            limit: Maximum number of results (default: 5)
            exclude_same_author: Exclude blueprints by the same author

        Returns:
            List of SearchResult objects
        """
        params = {"limit": limit, "exclude_same_author": exclude_same_author}
        response = self._client.get(f"/api/v1/search/similar/{slug}", params)
        return [SearchResult.model_validate(r) for r in response]


class AsyncBlueprintsResource:
    """Asynchronous resource for blueprint operations"""

    def __init__(self, client: AsyncHttpClient):
        self._client = client

    async def search(
        self,
        query: str,
        *,
        tags: Optional[list[str]] = None,
        limit: int = 10,
        min_success_rate: Optional[float] = None,
    ) -> SearchResponse:
        """Search for blueprints using semantic similarity."""
        data: dict = {"query": query, "limit": limit}
        if tags:
            data["tags"] = tags
        if min_success_rate is not None:
            data["min_success_rate"] = min_success_rate

        response = await self._client.post("/api/v1/search", data)
        return SearchResponse.model_validate(response)

    async def get(self, slug: str) -> BlueprintDetail:
        """Get a blueprint by its slug."""
        response = await self._client.get(f"/api/v1/blueprints/{slug}")
        return BlueprintDetail.model_validate(response)

    async def list(
        self,
        *,
        limit: int = 20,
        offset: int = 0,
        status: Optional[BlueprintStatus] = None,
        tags: Optional[list[str]] = None,
    ) -> list[BlueprintSummary]:
        """List blueprints with optional filtering."""
        params: dict = {"limit": limit, "offset": offset}
        if status:
            params["status"] = status
        if tags:
            params["tags"] = tags

        response = await self._client.get("/api/v1/blueprints", params)
        return [BlueprintSummary.model_validate(bp) for bp in response]

    async def create(
        self,
        title: str,
        goal_description: str,
        strategy: str,
        **kwargs,
    ) -> BlueprintDetail:
        """Create a new blueprint."""
        data = BlueprintCreate(
            title=title,
            goal_description=goal_description,
            strategy=strategy,
            **kwargs,
        )
        response = await self._client.post(
            "/api/v1/blueprints",
            data.model_dump(exclude_none=True),
            requires_auth=True,
        )
        return BlueprintDetail.model_validate(response)

    async def update(self, slug: str, **kwargs) -> BlueprintDetail:
        """Update an existing blueprint."""
        data = BlueprintUpdate(**kwargs)
        response = await self._client.put(
            f"/api/v1/blueprints/{slug}",
            data.model_dump(exclude_none=True),
            requires_auth=True,
        )
        return BlueprintDetail.model_validate(response)

    async def similar(
        self,
        slug: str,
        *,
        limit: int = 5,
        exclude_same_author: bool = True,
    ) -> list[SearchResult]:
        """Find blueprints similar to the given blueprint."""
        params = {"limit": limit, "exclude_same_author": exclude_same_author}
        response = await self._client.get(f"/api/v1/search/similar/{slug}", params)
        return [SearchResult.model_validate(r) for r in response]
