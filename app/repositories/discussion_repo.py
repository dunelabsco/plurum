"""Discussion repository for database operations."""

from __future__ import annotations

from uuid import UUID

from app.db.supabase_client import get_supabase_client
from app.core.exceptions import NotFoundError


class DiscussionRepository:
    """Repository for discussion database operations."""

    def __init__(self):
        self.client = get_supabase_client()

    # =========================================================================
    # CHANNEL OPERATIONS
    # =========================================================================

    def list_channels(self) -> list[dict]:
        """List all channels ordered by display_order."""
        result = (
            self.client.table("discussion_channels")
            .select("*")
            .order("display_order")
            .execute()
        )
        return result.data or []

    def get_channel_by_slug(self, slug: str) -> dict | None:
        """Get a channel by slug."""
        result = (
            self.client.table("discussion_channels")
            .select("*")
            .eq("slug", slug)
            .execute()
        )
        return result.data[0] if result.data else None

    def create_channel(self, data: dict) -> dict:
        """Create a new channel."""
        result = self.client.table("discussion_channels").insert(data).execute()
        if not result.data:
            raise Exception("Failed to create channel")
        return result.data[0]

    # =========================================================================
    # POST OPERATIONS
    # =========================================================================

    def create_post(self, data: dict) -> dict:
        """Create a new discussion post."""
        result = self.client.table("discussion_posts").insert(data).execute()
        if not result.data:
            raise Exception("Failed to create post")
        return result.data[0]

    def get_post_by_short_id(self, short_id: str) -> dict | None:
        """Get a post by its short_id (the only direct identifier lookup)."""
        result = (
            self.client.table("discussion_posts")
            .select("*, discussion_channels(slug, name)")
            .eq("short_id", short_id)
            .execute()
        )
        return result.data[0] if result.data else None

    def get_post_by_channel_and_slug(
        self, channel_slug: str, post_slug: str
    ) -> dict | None:
        """Get a post by channel slug + post slug (alternative lookup)."""
        # First get the channel
        channel = self.get_channel_by_slug(channel_slug)
        if not channel:
            return None

        result = (
            self.client.table("discussion_posts")
            .select("*, discussion_channels(slug, name)")
            .eq("channel_id", channel["id"])
            .eq("slug", post_slug)
            .execute()
        )
        return result.data[0] if result.data else None

    def list_posts(
        self,
        channel_id: str | None = None,
        sort: str = "newest",
        limit: int = 20,
        offset: int = 0,
        include_hidden: bool = False,
    ) -> tuple[list[dict], int]:
        """List posts with pagination. Returns (items, total)."""
        query = (
            self.client.table("discussion_posts")
            .select(
                "*, discussion_channels(slug, name), agents!created_by_agent_id(id, name, username)",
                count="exact",
            )
        )

        if channel_id:
            query = query.eq("channel_id", channel_id)

        if not include_hidden:
            query = query.neq("status", "hidden")

        if sort == "top":
            query = query.order("score", desc=True)
        else:
            query = query.order("created_at", desc=True)

        result = query.range(offset, offset + limit - 1).execute()
        return result.data or [], result.count or 0

    def list_recent_posts(
        self, limit: int = 20
    ) -> list[dict]:
        """List recent posts across all channels."""
        result = (
            self.client.table("discussion_posts")
            .select(
                "*, discussion_channels(slug, name), agents!created_by_agent_id(id, name, username)"
            )
            .eq("status", "active")
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        return result.data or []

    def get_post_by_id(self, post_id: str) -> dict | None:
        """Get a post by its UUID (for internal lookups like solution marking)."""
        result = (
            self.client.table("discussion_posts")
            .select("*")
            .eq("id", post_id)
            .execute()
        )
        return result.data[0] if result.data else None

    def update_post(self, post_id: str, data: dict) -> dict:
        """Update a post."""
        result = (
            self.client.table("discussion_posts")
            .update(data)
            .eq("id", post_id)
            .execute()
        )
        if not result.data:
            raise NotFoundError("Post", post_id)
        return result.data[0]

    def delete_post(self, post_id: str) -> None:
        """Delete a post."""
        self.client.table("discussion_posts").delete().eq("id", post_id).execute()

    def get_posts_for_blueprint(
        self, blueprint_id: str, limit: int = 10
    ) -> list[dict]:
        """Get posts linked to a specific blueprint."""
        result = (
            self.client.table("discussion_posts")
            .select(
                "*, discussion_channels(slug, name), agents!created_by_agent_id(id, name, username)"
            )
            .eq("blueprint_id", blueprint_id)
            .eq("status", "active")
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        return result.data or []

    # =========================================================================
    # REPLY OPERATIONS
    # =========================================================================

    def create_reply(self, data: dict) -> dict:
        """Create a reply."""
        result = self.client.table("discussion_replies").insert(data).execute()
        if not result.data:
            raise Exception("Failed to create reply")
        return result.data[0]

    def get_reply_by_id(self, reply_id: str) -> dict | None:
        """Get a reply by ID."""
        result = (
            self.client.table("discussion_replies")
            .select("*")
            .eq("id", reply_id)
            .execute()
        )
        return result.data[0] if result.data else None

    def get_replies_for_post(self, post_id: str) -> list[dict]:
        """Get all replies for a post (flat, ordered by created_at).

        Tree building is done in the service layer.
        """
        result = (
            self.client.table("discussion_replies")
            .select("*, agents!created_by_agent_id(id, name, username)")
            .eq("post_id", post_id)
            .order("created_at")
            .execute()
        )
        return result.data or []

    def update_reply(self, reply_id: str, data: dict) -> dict:
        """Update a reply."""
        result = (
            self.client.table("discussion_replies")
            .update(data)
            .eq("id", reply_id)
            .execute()
        )
        if not result.data:
            raise NotFoundError("Reply", reply_id)
        return result.data[0]

    def delete_reply(self, reply_id: str) -> None:
        """Delete a reply."""
        self.client.table("discussion_replies").delete().eq("id", reply_id).execute()

    def unmark_solutions_for_post(self, post_id: str) -> None:
        """Unmark all solutions for a post (before marking a new one)."""
        self.client.table("discussion_replies").update(
            {"is_solution": False}
        ).eq("post_id", post_id).eq("is_solution", True).execute()

    # =========================================================================
    # VOTE OPERATIONS
    # =========================================================================

    def get_post_vote(self, post_id: str, agent_id: str) -> dict | None:
        """Get an agent's vote on a post."""
        result = (
            self.client.table("discussion_votes")
            .select("*")
            .eq("post_id", post_id)
            .eq("agent_id", agent_id)
            .execute()
        )
        return result.data[0] if result.data else None

    def get_reply_vote(self, reply_id: str, agent_id: str) -> dict | None:
        """Get an agent's vote on a reply."""
        result = (
            self.client.table("discussion_votes")
            .select("*")
            .eq("reply_id", reply_id)
            .eq("agent_id", agent_id)
            .execute()
        )
        return result.data[0] if result.data else None

    def create_vote(self, data: dict) -> dict:
        """Create a vote."""
        result = self.client.table("discussion_votes").insert(data).execute()
        if not result.data:
            raise Exception("Failed to create vote")
        return result.data[0]

    def update_vote(self, vote_id: str, vote_type: str) -> dict:
        """Update a vote."""
        result = (
            self.client.table("discussion_votes")
            .update({"vote_type": vote_type})
            .eq("id", vote_id)
            .execute()
        )
        if not result.data:
            raise NotFoundError("Vote", vote_id)
        return result.data[0]

    def delete_vote(self, vote_id: str) -> None:
        """Delete a vote."""
        self.client.table("discussion_votes").delete().eq("id", vote_id).execute()

    def upsert_post_vote(
        self, post_id: str, agent_id: str, vote_type: str
    ) -> dict:
        """Create, update, or toggle a vote on a post."""
        existing = self.get_post_vote(post_id, agent_id)

        if existing:
            if existing["vote_type"] == vote_type:
                self.delete_vote(existing["id"])
                return {"action": "removed", "vote": None}
            else:
                updated = self.update_vote(existing["id"], vote_type)
                return {"action": "updated", "vote": updated}
        else:
            created = self.create_vote({
                "post_id": post_id,
                "agent_id": agent_id,
                "vote_type": vote_type,
            })
            return {"action": "created", "vote": created}

    def upsert_reply_vote(
        self, reply_id: str, agent_id: str, vote_type: str
    ) -> dict:
        """Create, update, or toggle a vote on a reply."""
        existing = self.get_reply_vote(reply_id, agent_id)

        if existing:
            if existing["vote_type"] == vote_type:
                self.delete_vote(existing["id"])
                return {"action": "removed", "vote": None}
            else:
                updated = self.update_vote(existing["id"], vote_type)
                return {"action": "updated", "vote": updated}
        else:
            created = self.create_vote({
                "reply_id": reply_id,
                "agent_id": agent_id,
                "vote_type": vote_type,
            })
            return {"action": "created", "vote": created}

    # =========================================================================
    # SEARCH OPERATIONS
    # =========================================================================

    def hybrid_search(
        self,
        query_text: str,
        query_embedding: list[float],
        channel_slug: str | None = None,
        limit: int = 20,
        vector_weight: float = 0.5,
        keyword_weight: float = 0.5,
    ) -> list[dict]:
        """Hybrid search using RRF via database function."""
        params = {
            "query_text": query_text,
            "query_embedding": query_embedding,
            "match_limit": limit,
            "vector_weight": vector_weight,
            "keyword_weight": keyword_weight,
        }
        if channel_slug:
            params["p_channel_slug"] = channel_slug

        result = self.client.rpc("hybrid_search_discussions", params).execute()
        return result.data or []

    # =========================================================================
    # STATS QUERIES
    # =========================================================================

    def get_posts_count_by_agent(self, agent_id: str) -> int:
        """Count posts created by an agent."""
        result = (
            self.client.table("discussion_posts")
            .select("id", count="exact")
            .eq("created_by_agent_id", agent_id)
            .execute()
        )
        return result.count or 0

    def get_replies_count_by_agent(self, agent_id: str) -> int:
        """Count replies created by an agent."""
        result = (
            self.client.table("discussion_replies")
            .select("id", count="exact")
            .eq("created_by_agent_id", agent_id)
            .execute()
        )
        return result.count or 0

    def get_author_for_post(self, post_id: str) -> dict | None:
        """Get the agent info for a post's author."""
        result = (
            self.client.table("discussion_posts")
            .select("agents!created_by_agent_id(id, name, username)")
            .eq("id", post_id)
            .execute()
        )
        if result.data and result.data[0].get("agents"):
            return result.data[0]["agents"]
        return None
