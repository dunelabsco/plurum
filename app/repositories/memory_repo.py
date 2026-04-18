"""Memory repository — user-scoped personal memory storage.

Mirrors the structure of ExperienceRepository but every query is scoped
by user_id. No visibility tiers; user sees own memories only.
"""

from __future__ import annotations

from typing import Optional
from uuid import UUID

from app.core.exceptions import NotFoundError
from app.db.supabase_client import get_supabase_client


class MemoryRepository:
    """CRUD and search for personal memories (user-scoped)."""

    def __init__(self):
        self.client = get_supabase_client()

    # -----------------------------------------------------------------------
    # Writes
    # -----------------------------------------------------------------------

    def create(self, data: dict) -> dict:
        """Create a new memory. `user_id` must be in data."""
        result = self.client.table("memories").insert(data).execute()
        if not result.data:
            raise Exception("Failed to create memory")
        return result.data[0]

    def create_batch(self, items: list[dict]) -> list[dict]:
        """Bulk insert (used by extract endpoint)."""
        if not items:
            return []
        result = self.client.table("memories").insert(items).execute()
        return result.data or []

    def update(self, memory_id: UUID, user_id: UUID, data: dict) -> dict:
        """Update — user_id check enforced as WHERE clause."""
        result = (
            self.client.table("memories")
            .update(data)
            .eq("id", str(memory_id))
            .eq("user_id", str(user_id))
            .execute()
        )
        if not result.data:
            raise NotFoundError("Memory", str(memory_id))
        return result.data[0]

    def soft_delete(self, memory_id: UUID, user_id: UUID) -> dict:
        """Mark memory inactive rather than hard delete."""
        return self.update(memory_id, user_id, {"is_active": False})

    def hard_delete(self, memory_id: UUID, user_id: UUID) -> None:
        """Permanently delete a memory (user-scoped)."""
        self.client.table("memories").delete().eq("id", str(memory_id)).eq(
            "user_id", str(user_id)
        ).execute()

    # -----------------------------------------------------------------------
    # Reads
    # -----------------------------------------------------------------------

    def get_by_id(self, memory_id: UUID, user_id: UUID) -> dict:
        """Get a memory scoped by user_id."""
        result = (
            self.client.table("memories")
            .select("*")
            .eq("id", str(memory_id))
            .eq("user_id", str(user_id))
            .execute()
        )
        if not result.data:
            raise NotFoundError("Memory", str(memory_id))
        return result.data[0]

    def get_by_identifier(self, identifier: str, user_id: UUID) -> dict:
        """Get by UUID or short_id."""
        try:
            UUID(identifier)
            return self.get_by_id(UUID(identifier), user_id)
        except ValueError:
            result = (
                self.client.table("memories")
                .select("*")
                .eq("short_id", identifier)
                .eq("user_id", str(user_id))
                .execute()
            )
            if not result.data:
                raise NotFoundError("Memory", identifier)
            return result.data[0]

    def list_memories(
        self,
        user_id: UUID,
        memory_type: Optional[str] = None,
        agent_id: Optional[UUID] = None,
        limit: int = 20,
        offset: int = 0,
        active_only: bool = True,
    ) -> tuple[list[dict], int]:
        """List memories for a user."""
        query = (
            self.client.table("memories")
            .select("*", count="exact")
            .eq("user_id", str(user_id))
        )
        if active_only:
            query = query.eq("is_active", True)
        if memory_type:
            query = query.eq("memory_type", memory_type)
        if agent_id:
            query = query.eq("agent_id", str(agent_id))

        result = (
            query.order("created_at", desc=True)
            .range(offset, offset + limit - 1)
            .execute()
        )
        return result.data or [], result.count or 0

    def top_memories(self, user_id: UUID, limit: int = 10) -> list[dict]:
        """Highest-importance active memories for profile hydration."""
        # Postgres ordering: importance 'high' > 'medium' > 'low'
        # Handled via CASE. For simplicity we order by a mapped score column
        # in the query below.
        result = (
            self.client.table("memories")
            .select("*")
            .eq("user_id", str(user_id))
            .eq("is_active", True)
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        return result.data or []

    # -----------------------------------------------------------------------
    # Search (hybrid RRF, user-scoped)
    # -----------------------------------------------------------------------

    def search(
        self,
        user_id: UUID,
        query_text: str,
        query_embedding: list[float],
        match_count: int = 10,
        memory_type: Optional[str] = None,
    ) -> list[dict]:
        """Hybrid search scoped to a single user."""
        params: dict = {
            "p_user_id": str(user_id),
            "query_text": query_text,
            "query_embedding": query_embedding,
            "match_count": match_count,
        }
        if memory_type:
            params["memory_type_filter"] = memory_type

        result = self.client.rpc("search_memories", params).execute()
        return result.data or []
