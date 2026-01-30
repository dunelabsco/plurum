"""Discussion-related Pydantic models."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class DiscussionPostStatus(str, Enum):
    """Post status options."""

    ACTIVE = "active"
    CLOSED = "closed"
    HIDDEN = "hidden"


# =============================================================================
# REQUEST MODELS
# =============================================================================


class ChannelCreate(BaseModel):
    """Model for creating a discussion channel (admin only)."""

    slug: str = Field(
        ..., pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$", max_length=100
    )
    name: str = Field(..., min_length=1, max_length=200)
    description: str | None = None
    icon: str | None = None
    display_order: int = 0
    is_default: bool = False


class PostCreate(BaseModel):
    """Model for creating a discussion post."""

    channel_slug: str
    title: str = Field(..., min_length=1, max_length=500)
    body: str = Field(..., min_length=1, max_length=50000)
    blueprint_identifier: str | None = Field(
        None, description="Optional blueprint short_id or slug to link"
    )


class PostUpdate(BaseModel):
    """Model for updating a discussion post."""

    title: str | None = Field(None, min_length=1, max_length=500)
    body: str | None = Field(None, min_length=1, max_length=50000)


class ReplyCreate(BaseModel):
    """Model for creating a reply to a post."""

    body: str = Field(..., min_length=1, max_length=10000)
    parent_reply_id: str | None = Field(
        None, description="Parent reply ID for nested threading"
    )


class DiscussionVoteCreate(BaseModel):
    """Model for voting on a post or reply."""

    vote_type: str = Field(..., pattern=r"^(up|down)$")


class PostStatusUpdate(BaseModel):
    """Model for changing post status."""

    status: DiscussionPostStatus


# =============================================================================
# RESPONSE MODELS
# =============================================================================


class ChannelSummary(BaseModel):
    """Channel summary for listings."""

    id: str
    slug: str
    name: str
    description: str | None = None
    icon: str | None = None
    post_count: int = 0
    is_default: bool = False

    class Config:
        from_attributes = True


class PostAuthor(BaseModel):
    """Post/reply author info."""

    id: str
    name: str
    username: str | None = None

    class Config:
        from_attributes = True


class BlueprintRef(BaseModel):
    """Minimal blueprint reference for linked posts."""

    short_id: str
    slug: str
    title: str

    class Config:
        from_attributes = True


class PostSummary(BaseModel):
    """Post summary for listings (body truncated)."""

    id: str
    short_id: str
    slug: str
    channel_slug: str
    channel_name: str
    title: str
    body: str  # truncated to 300 chars by service
    status: DiscussionPostStatus
    reply_count: int = 0
    upvotes: int = 0
    downvotes: int = 0
    score: float = 0.0
    author: PostAuthor
    blueprint: BlueprintRef | None = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ReplyDetail(BaseModel):
    """Full reply with nested children."""

    id: str
    body: str
    author: PostAuthor
    upvotes: int = 0
    downvotes: int = 0
    score: float = 0.0
    is_solution: bool = False
    parent_reply_id: str | None = None
    depth: int = 0
    children: list[ReplyDetail] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class PostDetail(BaseModel):
    """Full post detail with replies."""

    id: str
    short_id: str
    slug: str
    channel_slug: str
    channel_name: str
    title: str
    body: str  # full content
    status: DiscussionPostStatus
    reply_count: int = 0
    upvotes: int = 0
    downvotes: int = 0
    score: float = 0.0
    author: PostAuthor
    blueprint: BlueprintRef | None = None
    replies: list[ReplyDetail] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class PostListResponse(BaseModel):
    """Paginated list of posts."""

    items: list[PostSummary]
    total: int
    limit: int
    offset: int
    has_more: bool

    class Config:
        from_attributes = True


class DiscussionSearchResult(BaseModel):
    """Single discussion search result."""

    post: PostSummary
    similarity: float = 0.0
    keyword_rank: float = 0.0
    combined_score: float = 0.0
    match_reasons: list[str] = Field(default_factory=list)


class DiscussionSearchResponse(BaseModel):
    """Search response with results."""

    query: str
    results: list[DiscussionSearchResult]
    total_found: int
