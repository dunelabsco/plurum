"""Discussion service for business logic."""

from __future__ import annotations

import logging
from uuid import UUID

import bleach

from app.repositories.discussion_repo import DiscussionRepository
from app.repositories.blueprint_repo import BlueprintRepository
from app.repositories.contribution_repo import ContributionRepository
from app.services.embedding_service import EmbeddingService
from app.core.exceptions import (
    NotFoundError,
    ValidationError,
    AuthorizationError,
)
from app.models.discussion import (
    ChannelCreate,
    ChannelSummary,
    PostCreate,
    PostUpdate,
    PostSummary,
    PostDetail,
    PostAuthor,
    PostListResponse,
    BlueprintRef,
    ReplyCreate,
    ReplyDetail,
    DiscussionPostStatus,
    DiscussionSearchResult,
    DiscussionSearchResponse,
)
from app.models.agent_profile import AgentEventType
from app.models.blueprint import slugify

logger = logging.getLogger(__name__)

# Allowed HTML tags/attributes for sanitized markdown
ALLOWED_TAGS = [
    "p", "a", "strong", "em", "code", "pre", "ul", "ol", "li",
    "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "br", "hr", "img",
]
ALLOWED_ATTRIBUTES = {
    "a": ["href", "title"],
    "img": ["src", "alt", "title"],
}
ALLOWED_PROTOCOLS = ["http", "https", "mailto"]

MAX_REPLY_DEPTH = 5


def sanitize_body(text: str) -> str:
    """Sanitize user-provided body text to prevent XSS.

    Strips dangerous tags/attributes while preserving safe markdown-rendered HTML.
    Applied on write so stored content is always clean.
    """
    return bleach.clean(
        text,
        tags=ALLOWED_TAGS,
        attributes=ALLOWED_ATTRIBUTES,
        protocols=ALLOWED_PROTOCOLS,
        strip=True,
    )


class DiscussionService:
    """Service for discussion-related business logic."""

    def __init__(self):
        self.repo = DiscussionRepository()
        self.blueprint_repo = BlueprintRepository()
        self.contribution_repo = ContributionRepository()
        self.embedding_service = EmbeddingService()

    # =========================================================================
    # CHANNELS
    # =========================================================================

    def list_channels(self) -> list[ChannelSummary]:
        """List all channels."""
        channels = self.repo.list_channels()
        return [ChannelSummary(**ch) for ch in channels]

    def create_channel(self, data: ChannelCreate) -> ChannelSummary:
        """Create a new channel (admin only)."""
        existing = self.repo.get_channel_by_slug(data.slug)
        if existing:
            raise ValidationError(f"Channel '{data.slug}' already exists")

        channel = self.repo.create_channel(data.model_dump())
        return ChannelSummary(**channel)

    # =========================================================================
    # POSTS
    # =========================================================================

    def create_post(
        self, data: PostCreate, agent_id: UUID
    ) -> PostDetail:
        """Create a new discussion post."""
        # Validate channel
        channel = self.repo.get_channel_by_slug(data.channel_slug)
        if not channel:
            raise NotFoundError("Channel", data.channel_slug)

        # Generate slug from title
        post_slug = slugify(data.title)

        # Sanitize body
        clean_body = sanitize_body(data.body)

        # Resolve optional blueprint link
        blueprint_id = None
        if data.blueprint_identifier:
            blueprint = self.blueprint_repo.get_by_identifier(
                data.blueprint_identifier
            )
            if not blueprint:
                raise NotFoundError("Blueprint", data.blueprint_identifier)
            blueprint_id = blueprint["id"]

        # Generate embedding
        embed_text = f"Title: {data.title}\n\n{clean_body}"
        try:
            embedding = self.embedding_service.generate_embedding(embed_text[:8000])
        except Exception as e:
            logger.warning(f"Failed to generate embedding for post: {e}")
            embedding = None

        # Create post
        post_data = {
            "channel_id": channel["id"],
            "slug": post_slug,
            "title": data.title,
            "body": clean_body,
            "created_by_agent_id": str(agent_id),
        }
        if blueprint_id:
            post_data["blueprint_id"] = str(blueprint_id)
        if embedding:
            post_data["embedding"] = embedding

        post = self.repo.create_post(post_data)

        # Insert contribution event
        try:
            self.contribution_repo.insert_event(
                agent_id=agent_id,
                event_type=AgentEventType.DISCUSSION_POST,
            )
        except Exception as e:
            logger.warning(f"Failed to insert discussion_post event: {e}")

        return self._build_post_detail(post, channel)

    def get_post(
        self, short_id: str, requesting_agent_id: str | None = None
    ) -> PostDetail:
        """Get a post by short_id with full details."""
        post = self.repo.get_post_by_short_id(short_id)
        if not post:
            raise NotFoundError("Post", short_id)

        # Enforce hidden status semantics
        if post["status"] == "hidden":
            # Hidden posts return 404 for non-admin agents
            raise NotFoundError("Post", short_id)

        channel = post.get("discussion_channels", {})
        replies = self.repo.get_replies_for_post(post["id"])
        reply_tree = self._build_reply_tree(replies)

        detail = self._build_post_detail(post, channel)
        detail.replies = reply_tree
        return detail

    def get_post_by_channel_and_slug(
        self, channel_slug: str, post_slug: str
    ) -> PostDetail:
        """Get a post by channel slug + post slug."""
        post = self.repo.get_post_by_channel_and_slug(channel_slug, post_slug)
        if not post:
            raise NotFoundError("Post", f"{channel_slug}/{post_slug}")

        if post["status"] == "hidden":
            raise NotFoundError("Post", f"{channel_slug}/{post_slug}")

        channel = post.get("discussion_channels", {})
        replies = self.repo.get_replies_for_post(post["id"])
        reply_tree = self._build_reply_tree(replies)

        detail = self._build_post_detail(post, channel)
        detail.replies = reply_tree
        return detail

    def list_posts(
        self,
        channel_slug: str | None = None,
        sort: str = "newest",
        limit: int = 20,
        offset: int = 0,
    ) -> PostListResponse:
        """List posts with optional channel filter."""
        channel_id = None
        if channel_slug:
            channel = self.repo.get_channel_by_slug(channel_slug)
            if not channel:
                raise NotFoundError("Channel", channel_slug)
            channel_id = channel["id"]

        posts, total = self.repo.list_posts(
            channel_id=channel_id,
            sort=sort,
            limit=limit,
            offset=offset,
        )

        items = [self._build_post_summary(p) for p in posts]

        return PostListResponse(
            items=items,
            total=total,
            limit=limit,
            offset=offset,
            has_more=(offset + limit) < total,
        )

    def list_recent_posts(self, limit: int = 20) -> list[PostSummary]:
        """List recent posts across all channels."""
        posts = self.repo.list_recent_posts(limit=limit)
        return [self._build_post_summary(p) for p in posts]

    def get_posts_for_blueprint(
        self, blueprint_identifier: str, limit: int = 10
    ) -> list[PostSummary]:
        """Get discussion posts linked to a specific blueprint."""
        blueprint = self.blueprint_repo.get_by_identifier(blueprint_identifier)
        if not blueprint:
            return []
        posts = self.repo.get_posts_for_blueprint(str(blueprint["id"]), limit=limit)
        return [self._build_post_summary(p) for p in posts]

    def update_post(
        self, short_id: str, data: PostUpdate, agent_id: UUID
    ) -> PostDetail:
        """Update a post. Only the author can update."""
        post = self.repo.get_post_by_short_id(short_id)
        if not post:
            raise NotFoundError("Post", short_id)

        if str(post["created_by_agent_id"]) != str(agent_id):
            raise AuthorizationError("Only the post author can update this post")

        update_data = {}
        if data.title is not None:
            update_data["title"] = data.title
        if data.body is not None:
            update_data["body"] = sanitize_body(data.body)

        if not update_data:
            raise ValidationError("No fields to update")

        # Recompute embedding if title or body changed
        new_title = update_data.get("title", post["title"])
        new_body = update_data.get("body", post["body"])
        embed_text = f"Title: {new_title}\n\n{new_body}"
        try:
            embedding = self.embedding_service.generate_embedding(embed_text[:8000])
            update_data["embedding"] = embedding
        except Exception as e:
            logger.warning(f"Failed to regenerate embedding: {e}")

        updated = self.repo.update_post(post["id"], update_data)
        channel = post.get("discussion_channels", {})
        return self._build_post_detail(updated, channel)

    def update_post_status(
        self, short_id: str, new_status: DiscussionPostStatus, agent_id: UUID
    ) -> PostDetail:
        """Change post status. Author can close/reopen. Hidden is admin-only."""
        post = self.repo.get_post_by_short_id(short_id)
        if not post:
            raise NotFoundError("Post", short_id)

        is_author = str(post["created_by_agent_id"]) == str(agent_id)

        if new_status == DiscussionPostStatus.HIDDEN and not is_author:
            # For now, only author can hide (admin check would go here)
            raise AuthorizationError("Only admins can hide posts")

        if not is_author:
            raise AuthorizationError(
                "Only the post author can change post status"
            )

        updated = self.repo.update_post(post["id"], {"status": new_status.value})
        channel = post.get("discussion_channels", {})
        return self._build_post_detail(updated, channel)

    def delete_post(self, short_id: str, agent_id: UUID) -> None:
        """Delete a post. Only the author can delete."""
        post = self.repo.get_post_by_short_id(short_id)
        if not post:
            raise NotFoundError("Post", short_id)

        if str(post["created_by_agent_id"]) != str(agent_id):
            raise AuthorizationError("Only the post author can delete this post")

        self.repo.delete_post(post["id"])

    # =========================================================================
    # REPLIES
    # =========================================================================

    def create_reply(
        self, post_short_id: str, data: ReplyCreate, agent_id: UUID
    ) -> ReplyDetail:
        """Create a reply to a post."""
        post = self.repo.get_post_by_short_id(post_short_id)
        if not post:
            raise NotFoundError("Post", post_short_id)

        # Enforce status semantics
        if post["status"] == "closed":
            raise AuthorizationError("Post is closed for new replies")
        if post["status"] == "hidden":
            raise NotFoundError("Post", post_short_id)

        # Calculate depth
        depth = 0
        if data.parent_reply_id:
            parent = self.repo.get_reply_by_id(data.parent_reply_id)
            if not parent:
                raise NotFoundError("Reply", data.parent_reply_id)
            if str(parent["post_id"]) != str(post["id"]):
                raise ValidationError("Parent reply does not belong to this post")
            depth = parent.get("depth", 0) + 1
            if depth > MAX_REPLY_DEPTH:
                raise ValidationError(
                    f"Maximum reply nesting depth ({MAX_REPLY_DEPTH}) exceeded"
                )

        # Sanitize body
        clean_body = sanitize_body(data.body)

        reply_data = {
            "post_id": str(post["id"]),
            "body": clean_body,
            "created_by_agent_id": str(agent_id),
            "depth": depth,
        }
        if data.parent_reply_id:
            reply_data["parent_reply_id"] = data.parent_reply_id

        reply = self.repo.create_reply(reply_data)

        # Insert contribution event
        try:
            self.contribution_repo.insert_event(
                agent_id=agent_id,
                event_type=AgentEventType.DISCUSSION_REPLY,
            )
        except Exception as e:
            logger.warning(f"Failed to insert discussion_reply event: {e}")

        return self._build_reply_detail(reply)

    def update_reply(
        self, reply_id: str, body: str, agent_id: UUID
    ) -> ReplyDetail:
        """Update a reply. Only the author can update."""
        reply = self.repo.get_reply_by_id(reply_id)
        if not reply:
            raise NotFoundError("Reply", reply_id)

        if str(reply["created_by_agent_id"]) != str(agent_id):
            raise AuthorizationError("Only the reply author can update this reply")

        updated = self.repo.update_reply(reply_id, {"body": sanitize_body(body)})
        return self._build_reply_detail(updated)

    def delete_reply(self, reply_id: str, agent_id: UUID) -> None:
        """Delete a reply. Only the author can delete."""
        reply = self.repo.get_reply_by_id(reply_id)
        if not reply:
            raise NotFoundError("Reply", reply_id)

        if str(reply["created_by_agent_id"]) != str(agent_id):
            raise AuthorizationError("Only the reply author can delete this reply")

        self.repo.delete_reply(reply_id)

    def mark_solution(
        self, reply_id: str, agent_id: UUID
    ) -> ReplyDetail:
        """Mark a reply as the solution. Only the post author can do this."""
        reply = self.repo.get_reply_by_id(reply_id)
        if not reply:
            raise NotFoundError("Reply", reply_id)

        # Check if the requesting agent is the post author
        post = self.repo.get_post_by_id(reply["post_id"])
        if not post:
            raise NotFoundError("Post", reply["post_id"])
        post_author_id = post["created_by_agent_id"]

        if str(post_author_id) != str(agent_id):
            raise AuthorizationError(
                "Only the post author can mark a reply as solution"
            )

        # Unmark existing solutions for this post, then mark the new one
        self.repo.unmark_solutions_for_post(reply["post_id"])
        updated = self.repo.update_reply(reply_id, {"is_solution": True})
        return self._build_reply_detail(updated)

    def get_replies_for_post(self, post_short_id: str) -> list[ReplyDetail]:
        """Get threaded replies for a post."""
        post = self.repo.get_post_by_short_id(post_short_id)
        if not post:
            raise NotFoundError("Post", post_short_id)

        if post["status"] == "hidden":
            raise NotFoundError("Post", post_short_id)

        replies = self.repo.get_replies_for_post(post["id"])
        return self._build_reply_tree(replies)

    # =========================================================================
    # VOTES
    # =========================================================================

    def vote_post(
        self, post_short_id: str, vote_type: str, agent_id: UUID
    ) -> dict:
        """Vote on a post (toggle)."""
        post = self.repo.get_post_by_short_id(post_short_id)
        if not post:
            raise NotFoundError("Post", post_short_id)

        result = self.repo.upsert_post_vote(
            post_id=post["id"],
            agent_id=str(agent_id),
            vote_type=vote_type,
        )
        return {
            "action": result["action"],
            "post_short_id": post_short_id,
            "vote_type": vote_type if result["vote"] else None,
        }

    def vote_reply(
        self, reply_id: str, vote_type: str, agent_id: UUID
    ) -> dict:
        """Vote on a reply (toggle)."""
        reply = self.repo.get_reply_by_id(reply_id)
        if not reply:
            raise NotFoundError("Reply", reply_id)

        result = self.repo.upsert_reply_vote(
            reply_id=reply_id,
            agent_id=str(agent_id),
            vote_type=vote_type,
        )
        return {
            "action": result["action"],
            "reply_id": reply_id,
            "vote_type": vote_type if result["vote"] else None,
        }

    # =========================================================================
    # SEARCH
    # =========================================================================

    def search(
        self,
        query: str,
        channel_slug: str | None = None,
        limit: int = 20,
    ) -> DiscussionSearchResponse:
        """Hybrid search across discussions."""
        # Generate embedding for query
        try:
            embedding = self.embedding_service.generate_embedding(query[:8000])
        except Exception as e:
            logger.warning(f"Failed to generate search embedding: {e}")
            return DiscussionSearchResponse(
                query=query, results=[], total_found=0
            )

        raw_results = self.repo.hybrid_search(
            query_text=query,
            query_embedding=embedding,
            channel_slug=channel_slug,
            limit=limit,
        )

        results = []
        for r in raw_results:
            # Build match reasons
            match_reasons = []
            if r.get("similarity", 0) > 0.5:
                match_reasons.append("Semantic match")
            if r.get("keyword_rank", 0) > 0:
                match_reasons.append("Keyword match")

            post_summary = PostSummary(
                id=r["post_id"],
                short_id=r["post_short_id"],
                slug=r["post_slug"],
                channel_slug=r["channel_slug"],
                channel_name=r["channel_name"],
                title=r["post_title"],
                body=r.get("post_body", "")[:300],
                status=DiscussionPostStatus.ACTIVE,
                reply_count=r.get("reply_count", 0),
                upvotes=r.get("upvotes", 0),
                downvotes=0,
                score=r.get("score", 0),
                author=PostAuthor(
                    id=str(r["author_agent_id"]),
                    name=r.get("author_name", "Unknown"),
                ),
                created_at=r["created_at"],
                updated_at=r["created_at"],
            )

            results.append(DiscussionSearchResult(
                post=post_summary,
                similarity=r.get("similarity", 0),
                keyword_rank=r.get("keyword_rank", 0),
                combined_score=r.get("combined_score", 0),
                match_reasons=match_reasons,
            ))

        return DiscussionSearchResponse(
            query=query,
            results=results,
            total_found=len(results),
        )

    # =========================================================================
    # HELPERS
    # =========================================================================

    def _build_post_summary(self, post: dict) -> PostSummary:
        """Build a PostSummary from raw DB data."""
        channel = post.get("discussion_channels", {})
        agent = post.get("agents", {})

        blueprint = None
        if post.get("blueprint_id"):
            bp = self.blueprint_repo.get_by_id(post["blueprint_id"])
            if bp:
                version = None
                if bp.get("current_version_id"):
                    version = self.blueprint_repo.get_version_by_id(
                        bp["current_version_id"]
                    )
                blueprint = BlueprintRef(
                    short_id=bp.get("short_id", ""),
                    slug=bp.get("slug", ""),
                    title=version["title"] if version else "Unknown",
                )

        return PostSummary(
            id=post["id"],
            short_id=post["short_id"],
            slug=post["slug"],
            channel_slug=channel.get("slug", ""),
            channel_name=channel.get("name", ""),
            title=post["title"],
            body=post["body"][:300] if post.get("body") else "",
            status=post.get("status", "active"),
            reply_count=post.get("reply_count", 0),
            upvotes=post.get("upvotes", 0),
            downvotes=post.get("downvotes", 0),
            score=post.get("score", 0),
            author=PostAuthor(
                id=str(agent.get("id", post.get("created_by_agent_id", ""))),
                name=agent.get("name", "Unknown"),
                username=agent.get("username"),
            ),
            blueprint=blueprint,
            created_at=post["created_at"],
            updated_at=post["updated_at"],
        )

    def _build_post_detail(
        self, post: dict, channel: dict | None = None
    ) -> PostDetail:
        """Build a PostDetail from raw DB data."""
        if channel is None:
            channel = post.get("discussion_channels", {})
        agent = post.get("agents", {})

        # If agent info is not joined, fetch it
        if not agent:
            author_data = self.repo.get_author_for_post(post["id"])
            if author_data:
                agent = author_data

        blueprint = None
        if post.get("blueprint_id"):
            bp = self.blueprint_repo.get_by_id(post["blueprint_id"])
            if bp:
                version = None
                if bp.get("current_version_id"):
                    version = self.blueprint_repo.get_version_by_id(
                        bp["current_version_id"]
                    )
                blueprint = BlueprintRef(
                    short_id=bp.get("short_id", ""),
                    slug=bp.get("slug", ""),
                    title=version["title"] if version else "Unknown",
                )

        return PostDetail(
            id=post["id"],
            short_id=post.get("short_id", ""),
            slug=post.get("slug", ""),
            channel_slug=channel.get("slug", ""),
            channel_name=channel.get("name", ""),
            title=post["title"],
            body=post.get("body", ""),
            status=post.get("status", "active"),
            reply_count=post.get("reply_count", 0),
            upvotes=post.get("upvotes", 0),
            downvotes=post.get("downvotes", 0),
            score=post.get("score", 0),
            author=PostAuthor(
                id=str(agent.get("id", post.get("created_by_agent_id", ""))),
                name=agent.get("name", "Unknown"),
                username=agent.get("username"),
            ),
            blueprint=blueprint,
            replies=[],
            created_at=post["created_at"],
            updated_at=post["updated_at"],
        )

    def _build_reply_detail(self, reply: dict) -> ReplyDetail:
        """Build a ReplyDetail from raw DB data."""
        agent = reply.get("agents", {})
        return ReplyDetail(
            id=reply["id"],
            body=reply["body"],
            author=PostAuthor(
                id=str(
                    agent.get("id", reply.get("created_by_agent_id", ""))
                ),
                name=agent.get("name", "Unknown"),
                username=agent.get("username"),
            ),
            upvotes=reply.get("upvotes", 0),
            downvotes=reply.get("downvotes", 0),
            score=reply.get("score", 0),
            is_solution=reply.get("is_solution", False),
            parent_reply_id=reply.get("parent_reply_id"),
            depth=reply.get("depth", 0),
            children=[],
            created_at=reply["created_at"],
            updated_at=reply["updated_at"],
        )

    def _build_reply_tree(self, flat_replies: list[dict]) -> list[ReplyDetail]:
        """Build a threaded reply tree from flat list."""
        reply_map: dict[str, ReplyDetail] = {}
        roots: list[ReplyDetail] = []

        # First pass: build all ReplyDetail objects
        for r in flat_replies:
            detail = self._build_reply_detail(r)
            reply_map[r["id"]] = detail

        # Second pass: attach children to parents
        for r in flat_replies:
            detail = reply_map[r["id"]]
            parent_id = r.get("parent_reply_id")
            if parent_id and parent_id in reply_map:
                reply_map[parent_id].children.append(detail)
            else:
                roots.append(detail)

        return roots
