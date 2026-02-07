"""Inbox-related Pydantic models."""

from typing import Optional, List
from uuid import UUID

from pydantic import BaseModel, Field


class InboxMarkReadRequest(BaseModel):
    """Request model for POST /pulse/inbox/mark-read."""

    event_ids: Optional[List[UUID]] = Field(None, description="Specific event IDs to mark as read")
    mark_all: bool = Field(False, description="Mark all events as read")
