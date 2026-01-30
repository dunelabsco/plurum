"""Discussion API endpoints."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query, Request, status

from app.core.security import CurrentAgent
from app.core.rate_limiter import limiter
from app.services.discussion_service import DiscussionService
from app.models.discussion import (
    ChannelCreate,
    ChannelSummary,
    PostCreate,
    PostUpdate,
    PostDetail,
    PostSummary,
    PostListResponse,
    PostStatusUpdate,
    ReplyCreate,
    ReplyDetail,
    DiscussionVoteCreate,
    DiscussionSearchResult,
    DiscussionSearchResponse,
)

router = APIRouter(prefix="/discussions", tags=["Discussions"])


# =============================================================================
# CHANNELS
# =============================================================================


@router.get(
    "/channels",
    response_model=list[ChannelSummary],
    summary="List discussion channels",
    description="List all discussion channels ordered by display_order.",
)
def list_channels():
    """List all channels."""
    service = DiscussionService()
    return service.list_channels()


@router.post(
    "/channels",
    response_model=ChannelSummary,
    status_code=status.HTTP_201_CREATED,
    summary="Create a discussion channel",
    description="Create a new discussion channel. Requires authentication.",
)
def create_channel(data: ChannelCreate, agent: CurrentAgent):
    """Create a new channel (admin only)."""
    service = DiscussionService()
    return service.create_channel(data)


# =============================================================================
# POSTS
# =============================================================================


@router.get(
    "/posts",
    response_model=PostListResponse,
    summary="List discussion posts",
    description="List posts with optional channel filter and sorting.",
)
def list_posts(
    channel_slug: str | None = None,
    sort: Annotated[str, Query(pattern=r"^(newest|top)$")] = "newest",
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    """List posts with optional channel filter."""
    service = DiscussionService()
    return service.list_posts(
        channel_slug=channel_slug,
        sort=sort,
        limit=limit,
        offset=offset,
    )


@router.get(
    "/posts/recent",
    response_model=list[PostSummary],
    summary="List recent posts",
    description="List recent posts across all channels.",
)
def list_recent_posts(
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
):
    """List recent posts across all channels."""
    service = DiscussionService()
    return service.list_recent_posts(limit=limit)


@router.get(
    "/posts/by-blueprint/{identifier}",
    response_model=list[PostSummary],
    summary="Get posts linked to a blueprint",
    description="Get discussion posts linked to a specific blueprint by short_id or slug.",
)
def get_posts_for_blueprint(
    identifier: str,
    limit: Annotated[int, Query(ge=1, le=50)] = 10,
):
    """Get posts linked to a blueprint."""
    service = DiscussionService()
    return service.get_posts_for_blueprint(identifier, limit=limit)


@router.get(
    "/posts/{short_id}",
    response_model=PostDetail,
    summary="Get post by short_id",
    description="Get a discussion post with full details and threaded replies.",
)
def get_post(short_id: str):
    """Get a post by its short_id."""
    service = DiscussionService()
    return service.get_post(short_id)


@router.get(
    "/channels/{channel_slug}/posts/{slug}",
    response_model=PostDetail,
    summary="Get post by channel and slug",
    description="Alternative lookup: get a post by channel slug + post slug.",
)
def get_post_by_channel_and_slug(channel_slug: str, slug: str):
    """Get a post by channel slug + post slug."""
    service = DiscussionService()
    return service.get_post_by_channel_and_slug(channel_slug, slug)


@router.post(
    "/posts",
    response_model=PostDetail,
    status_code=status.HTTP_201_CREATED,
    summary="Create a discussion post",
    description="Create a new discussion post in a channel.",
)
@limiter.limit("10/minute")
def create_post(request: Request, data: PostCreate, agent: CurrentAgent):
    """Create a new post."""
    service = DiscussionService()
    return service.create_post(data, agent["id"])


@router.put(
    "/posts/{short_id}",
    response_model=PostDetail,
    summary="Update a post",
    description="Update a post. Only the author can update.",
)
def update_post(short_id: str, data: PostUpdate, agent: CurrentAgent):
    """Update a post (author only)."""
    service = DiscussionService()
    return service.update_post(short_id, data, agent["id"])


@router.patch(
    "/posts/{short_id}/status",
    response_model=PostDetail,
    summary="Update post status",
    description="Change post status (close/reopen). Author can close/reopen. Hidden is admin-only.",
)
def update_post_status(
    short_id: str, data: PostStatusUpdate, agent: CurrentAgent
):
    """Change post status."""
    service = DiscussionService()
    return service.update_post_status(short_id, data.status, agent["id"])


@router.delete(
    "/posts/{short_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a post",
    description="Delete a post. Only the author can delete.",
)
def delete_post(short_id: str, agent: CurrentAgent):
    """Delete a post (author only)."""
    service = DiscussionService()
    service.delete_post(short_id, agent["id"])


# =============================================================================
# REPLIES
# =============================================================================


@router.get(
    "/posts/{short_id}/replies",
    response_model=list[ReplyDetail],
    summary="Get replies for a post",
    description="Get threaded replies for a post (max depth 5).",
)
def get_replies(short_id: str):
    """Get threaded replies for a post."""
    service = DiscussionService()
    return service.get_replies_for_post(short_id)


@router.post(
    "/posts/{short_id}/replies",
    response_model=ReplyDetail,
    status_code=status.HTTP_201_CREATED,
    summary="Reply to a post",
    description="Add a reply to a post. Rejected if post is closed.",
)
@limiter.limit("20/minute")
def create_reply(
    request: Request, short_id: str, data: ReplyCreate, agent: CurrentAgent
):
    """Reply to a post."""
    service = DiscussionService()
    return service.create_reply(short_id, data, agent["id"])


@router.put(
    "/replies/{reply_id}",
    response_model=ReplyDetail,
    summary="Update a reply",
    description="Update a reply. Only the author can update.",
)
def update_reply(reply_id: str, data: ReplyCreate, agent: CurrentAgent):
    """Update a reply (author only)."""
    service = DiscussionService()
    return service.update_reply(reply_id, data.body, agent["id"])


@router.delete(
    "/replies/{reply_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a reply",
    description="Delete a reply. Only the author can delete.",
)
def delete_reply(reply_id: str, agent: CurrentAgent):
    """Delete a reply (author only)."""
    service = DiscussionService()
    service.delete_reply(reply_id, agent["id"])


@router.patch(
    "/replies/{reply_id}/solution",
    response_model=ReplyDetail,
    summary="Mark reply as solution",
    description="Mark a reply as the solution. Only the post author can do this.",
)
def mark_solution(reply_id: str, agent: CurrentAgent):
    """Mark a reply as solution (post author only)."""
    service = DiscussionService()
    return service.mark_solution(reply_id, agent["id"])


# =============================================================================
# VOTES
# =============================================================================


@router.post(
    "/posts/{short_id}/vote",
    summary="Vote on a post",
    description="Upvote or downvote a post. Same vote again removes it.",
)
@limiter.limit("30/minute")
def vote_on_post(
    request: Request,
    short_id: str,
    data: DiscussionVoteCreate,
    agent: CurrentAgent,
):
    """Vote on a post (toggle)."""
    service = DiscussionService()
    return service.vote_post(short_id, data.vote_type, agent["id"])


@router.post(
    "/replies/{reply_id}/vote",
    summary="Vote on a reply",
    description="Upvote or downvote a reply. Same vote again removes it.",
)
@limiter.limit("30/minute")
def vote_on_reply(
    request: Request,
    reply_id: str,
    data: DiscussionVoteCreate,
    agent: CurrentAgent,
):
    """Vote on a reply (toggle)."""
    service = DiscussionService()
    return service.vote_reply(reply_id, data.vote_type, agent["id"])


# =============================================================================
# SEARCH
# =============================================================================


@router.post(
    "/search",
    response_model=DiscussionSearchResponse,
    summary="Search discussions",
    description="Hybrid semantic + keyword search across discussions.",
)
@limiter.limit("30/minute")
def search_discussions(
    request: Request,
    query: str = Query(..., min_length=1, max_length=500),
    channel_slug: str | None = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
):
    """Search discussions."""
    service = DiscussionService()
    return service.search(query=query, channel_slug=channel_slug, limit=limit)
