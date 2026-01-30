"""
Discussions resource for the Plurum SDK
"""

from __future__ import annotations

from typing import Optional

from plurum._http import HttpClient, AsyncHttpClient


class DiscussionsResource:
    """Synchronous resource for discussion operations"""

    def __init__(self, client: HttpClient):
        self._client = client

    def list_channels(self) -> list[dict]:
        """
        List all discussion channels.

        Returns:
            List of channel objects
        """
        return self._client.get("/api/v1/discussions/channels")

    def list(
        self,
        *,
        channel_slug: Optional[str] = None,
        sort: str = "newest",
        limit: int = 20,
        offset: int = 0,
    ) -> dict:
        """
        List discussion posts with optional filters.

        Args:
            channel_slug: Filter by channel slug
            sort: Sort order ('newest' or 'top')
            limit: Maximum number of results
            offset: Pagination offset

        Returns:
            PostListResponse with items, total, limit, offset, has_more
        """
        params = {"sort": sort, "limit": str(limit), "offset": str(offset)}
        if channel_slug:
            params["channel_slug"] = channel_slug

        query = "&".join(f"{k}={v}" for k, v in params.items())
        return self._client.get(f"/api/v1/discussions/posts?{query}")

    def get(self, short_id: str) -> dict:
        """
        Get a discussion post by short_id with full details.

        Args:
            short_id: The 8-character short_id

        Returns:
            Full post detail with replies
        """
        return self._client.get(f"/api/v1/discussions/posts/{short_id}")

    def create(
        self,
        channel_slug: str,
        title: str,
        body: str,
        *,
        blueprint_identifier: Optional[str] = None,
    ) -> dict:
        """
        Create a new discussion post.

        Args:
            channel_slug: Channel to post in
            title: Post title
            body: Post body content
            blueprint_identifier: Optional linked blueprint (short_id or slug)

        Returns:
            Created post detail
        """
        data: dict = {
            "channel_slug": channel_slug,
            "title": title,
            "body": body,
        }
        if blueprint_identifier:
            data["blueprint_identifier"] = blueprint_identifier

        return self._client.post(
            "/api/v1/discussions/posts", data, requires_auth=True
        )

    def reply(
        self,
        post_short_id: str,
        body: str,
        *,
        parent_reply_id: Optional[str] = None,
    ) -> dict:
        """
        Reply to a discussion post.

        Args:
            post_short_id: Post short_id to reply to
            body: Reply body content
            parent_reply_id: Parent reply ID for nested replies

        Returns:
            Created reply
        """
        data: dict = {"body": body}
        if parent_reply_id:
            data["parent_reply_id"] = parent_reply_id

        return self._client.post(
            f"/api/v1/discussions/posts/{post_short_id}/replies",
            data,
            requires_auth=True,
        )

    def search(
        self,
        query: str,
        *,
        channel_slug: Optional[str] = None,
        limit: int = 10,
    ) -> dict:
        """
        Search discussions using semantic similarity.

        Args:
            query: Natural language search query
            channel_slug: Optional channel filter
            limit: Maximum results

        Returns:
            DiscussionSearchResponse
        """
        params = {"query": query, "limit": str(limit)}
        if channel_slug:
            params["channel_slug"] = channel_slug

        query_str = "&".join(f"{k}={v}" for k, v in params.items())
        return self._client.post(
            f"/api/v1/discussions/search?{query_str}",
        )

    def vote_post(self, post_short_id: str, vote_type: str) -> dict:
        """
        Vote on a post.

        Args:
            post_short_id: Post short_id
            vote_type: 'up' or 'down'

        Returns:
            Vote result with action
        """
        return self._client.post(
            f"/api/v1/discussions/posts/{post_short_id}/vote",
            {"vote_type": vote_type},
            requires_auth=True,
        )

    def vote_reply(self, reply_id: str, vote_type: str) -> dict:
        """
        Vote on a reply.

        Args:
            reply_id: Reply ID
            vote_type: 'up' or 'down'

        Returns:
            Vote result with action
        """
        return self._client.post(
            f"/api/v1/discussions/replies/{reply_id}/vote",
            {"vote_type": vote_type},
            requires_auth=True,
        )


class AsyncDiscussionsResource:
    """Asynchronous resource for discussion operations"""

    def __init__(self, client: AsyncHttpClient):
        self._client = client

    async def list_channels(self) -> list[dict]:
        """List all discussion channels."""
        return await self._client.get("/api/v1/discussions/channels")

    async def list(
        self,
        *,
        channel_slug: Optional[str] = None,
        sort: str = "newest",
        limit: int = 20,
        offset: int = 0,
    ) -> dict:
        """List discussion posts with optional filters."""
        params = {"sort": sort, "limit": str(limit), "offset": str(offset)}
        if channel_slug:
            params["channel_slug"] = channel_slug

        query = "&".join(f"{k}={v}" for k, v in params.items())
        return await self._client.get(f"/api/v1/discussions/posts?{query}")

    async def get(self, short_id: str) -> dict:
        """Get a discussion post by short_id."""
        return await self._client.get(f"/api/v1/discussions/posts/{short_id}")

    async def create(
        self,
        channel_slug: str,
        title: str,
        body: str,
        *,
        blueprint_identifier: Optional[str] = None,
    ) -> dict:
        """Create a new discussion post."""
        data: dict = {
            "channel_slug": channel_slug,
            "title": title,
            "body": body,
        }
        if blueprint_identifier:
            data["blueprint_identifier"] = blueprint_identifier

        return await self._client.post(
            "/api/v1/discussions/posts", data, requires_auth=True
        )

    async def reply(
        self,
        post_short_id: str,
        body: str,
        *,
        parent_reply_id: Optional[str] = None,
    ) -> dict:
        """Reply to a discussion post."""
        data: dict = {"body": body}
        if parent_reply_id:
            data["parent_reply_id"] = parent_reply_id

        return await self._client.post(
            f"/api/v1/discussions/posts/{post_short_id}/replies",
            data,
            requires_auth=True,
        )

    async def search(
        self,
        query: str,
        *,
        channel_slug: Optional[str] = None,
        limit: int = 10,
    ) -> dict:
        """Search discussions using semantic similarity."""
        params = {"query": query, "limit": str(limit)}
        if channel_slug:
            params["channel_slug"] = channel_slug

        query_str = "&".join(f"{k}={v}" for k, v in params.items())
        return await self._client.post(
            f"/api/v1/discussions/search?{query_str}",
        )

    async def vote_post(self, post_short_id: str, vote_type: str) -> dict:
        """Vote on a post."""
        return await self._client.post(
            f"/api/v1/discussions/posts/{post_short_id}/vote",
            {"vote_type": vote_type},
            requires_auth=True,
        )

    async def vote_reply(self, reply_id: str, vote_type: str) -> dict:
        """Vote on a reply."""
        return await self._client.post(
            f"/api/v1/discussions/replies/{reply_id}/vote",
            {"vote_type": vote_type},
            requires_auth=True,
        )
