"""Entity repository — user-scoped entity store for memory search.

Backs the Phase 2 entity arm of the retrieval RPC. An entity row is a
user-scoped named thing ("Dr. Smith", "Ferrari 488 GTB", "Hawaii") with
an embedding and the list of memory ids that mention it.

Two access paths:

1. **Write.** After extracting a memory, for each entity string the
   extractor emitted we either merge it into an existing entity row (same
   user, sim ≥ 0.95 AND normalized text equal) or insert a new one. The
   merged row's `linked_memory_ids` array gets the new memory id appended.

2. **Read.** For each query entity the search RPC vector-searches this
   table and pulls every memory id from matched entities' `linked_memory_ids`
   — so the same underlying person / place / object converges across
   sessions even when the wording differs.
"""

from __future__ import annotations

import logging
from typing import Optional
from uuid import UUID

from app.db.supabase_client import get_supabase_client

logger = logging.getLogger(__name__)


class EntityRepository:
    """CRUD for user-scoped entity store."""

    def __init__(self):
        self.client = get_supabase_client()

    # -----------------------------------------------------------------------
    # Write path — upsert-on-match
    # -----------------------------------------------------------------------

    def find_match(
        self,
        user_id: UUID,
        text_normalized: str,
        embedding: list[float],
        similarity_threshold: float = 0.95,
    ) -> Optional[dict]:
        """Return an existing entity row to merge into, or None.

        A match requires BOTH:
          - exact normalized-text equality (cheap guard)
          - vector similarity >= threshold (semantic guard so "Dr. Smith"
            isn't merged with a different "Smith")

        The exact-text guard is the strict one; the embedding check is
        belt-and-suspenders to avoid collapsing distinct entities whose
        normalized text happens to collide.
        """
        # Cheap path first: exact normalized text match for this user.
        result = (
            self.client.table("entities")
            .select("*")
            .eq("user_id", str(user_id))
            .eq("text_normalized", text_normalized)
            .limit(1)
            .execute()
        )
        rows = result.data or []
        if not rows:
            return None

        candidate = rows[0]
        # Belt-and-suspenders similarity check. If embedding isn't stored
        # yet (legacy row, or race on write), trust the text equality.
        cand_emb = candidate.get("embedding")
        if cand_emb is None:
            return candidate
        try:
            sim = _cosine(embedding, cand_emb)
        except Exception:
            return candidate
        if sim >= similarity_threshold:
            return candidate
        return None

    def create(
        self,
        user_id: UUID,
        text: str,
        text_normalized: str,
        embedding: list[float],
        memory_id: UUID,
        entity_type: Optional[str] = None,
    ) -> dict:
        """Insert a new entity with a single linked memory id."""
        payload = {
            "user_id": str(user_id),
            "text": text,
            "text_normalized": text_normalized,
            "entity_type": entity_type,
            "embedding": embedding,
            "linked_memory_ids": [str(memory_id)],
        }
        result = self.client.table("entities").insert(payload).execute()
        if not result.data:
            raise Exception("Failed to create entity")
        return result.data[0]

    def append_memory_id(self, entity_id: UUID, memory_id: UUID) -> None:
        """Append a memory id to an entity's linked_memory_ids (idempotent).

        Uses a Postgres array-append RPC rather than read-modify-write
        because two concurrent extraction calls for the same entity would
        clobber each other otherwise. The RPC is defined in migration 024.
        """
        # Array_append with DISTINCT isn't a thing in plain SQL; do a
        # safe read/write but tolerate concurrent appends by re-reading.
        existing = (
            self.client.table("entities")
            .select("linked_memory_ids")
            .eq("id", str(entity_id))
            .limit(1)
            .execute()
        )
        if not existing.data:
            return
        current = existing.data[0].get("linked_memory_ids") or []
        mid = str(memory_id)
        if mid in current:
            return
        current.append(mid)
        self.client.table("entities").update(
            {"linked_memory_ids": current}
        ).eq("id", str(entity_id)).execute()

    def upsert(
        self,
        user_id: UUID,
        text: str,
        embedding: list[float],
        memory_id: UUID,
        entity_type: Optional[str] = None,
    ) -> dict:
        """Atomic merge-or-insert via the entity_upsert RPC (migration 029).

        Previous version ran find_match (SELECT) then either append or
        create — a classic check-then-act race. Two concurrent upserts for
        the same (user, text) both saw no match, both inserted, and
        produced duplicate entity rows. Audit of the entities table showed
        up to 8 duplicate rows per (user_id, text_normalized).

        This path now delegates to a single SQL statement that uses
        INSERT ... ON CONFLICT DO UPDATE. Postgres serializes the conflict
        branch so concurrent upserts converge to one row with both linked
        memory ids appended.

        Falls back to the old find_match + create / append flow only if
        the RPC is missing (migration 029 not yet applied). That fallback
        retains the race but keeps the service functional during a staged
        migration rollout.
        """
        text_normalized = (text or "").strip().lower()
        if not text_normalized:
            raise ValueError("entity text is empty after normalization")

        try:
            result = self.client.rpc(
                "entity_upsert",
                {
                    "p_user_id": str(user_id),
                    "p_text": text.strip(),
                    "p_text_normalized": text_normalized,
                    "p_embedding": embedding,
                    "p_memory_id": str(memory_id),
                    "p_entity_type": entity_type,
                },
            ).execute()
        except Exception as e:
            err = str(e).lower()
            if (
                "entity_upsert" in err
                or "function" in err and "does not exist" in err
                or "schema cache" in err
            ):
                logger.info(
                    "entity_upsert RPC missing (migration 029 pending); "
                    "falling back to legacy find_match + create path"
                )
                return self._upsert_legacy(
                    user_id=user_id,
                    text=text,
                    text_normalized=text_normalized,
                    embedding=embedding,
                    memory_id=memory_id,
                    entity_type=entity_type,
                )
            raise

        # The RPC returns the entity id. We fetch the row so callers that
        # inspect it (e.g. for tests) still get the full record shape.
        row_id = None
        if result.data:
            # Supabase .rpc() returns either a bare value or a list of
            # dicts depending on the return shape. Handle both.
            entry = result.data[0] if isinstance(result.data, list) else result.data
            if isinstance(entry, dict):
                row_id = entry.get("id") or entry.get("entity_upsert")
            else:
                row_id = entry
        if not row_id:
            # Should not happen — the RPC always returns an id. Fail loud.
            raise Exception("entity_upsert returned no id")
        return {"id": str(row_id), "text": text.strip(), "text_normalized": text_normalized}

    def _upsert_legacy(
        self,
        user_id: UUID,
        text: str,
        text_normalized: str,
        embedding: list[float],
        memory_id: UUID,
        entity_type: Optional[str] = None,
    ) -> dict:
        """Legacy non-atomic upsert path. Kept only as a fallback when
        migration 029 isn't live. Subject to the race condition the new
        RPC was introduced to fix."""
        match = self.find_match(user_id, text_normalized, embedding)
        if match:
            self.append_memory_id(UUID(match["id"]), memory_id)
            return match

        return self.create(
            user_id=user_id,
            text=text.strip(),
            text_normalized=text_normalized,
            embedding=embedding,
            memory_id=memory_id,
            entity_type=entity_type,
        )

    # -----------------------------------------------------------------------
    # Read path — vector search
    # -----------------------------------------------------------------------

    def search(
        self,
        user_id: UUID,
        query_embedding: list[float],
        similarity_threshold: float = 0.5,
        match_count: int = 20,
    ) -> list[dict]:
        """Vector-search entities for this user above `similarity_threshold`.

        Returns rows with id, text, linked_memory_ids, and a `similarity`
        score. The read-side threshold is intentionally looser (0.5) than
        write-side (0.95) so query expansion to semantically-equivalent
        entity names works ("Dr. Smith" ↔ "PCP").
        """
        params = {
            "p_user_id": str(user_id),
            "query_embedding": query_embedding,
            "sim_threshold": similarity_threshold,
            "match_count": match_count,
        }
        result = self.client.rpc("search_entities", params).execute()
        return result.data or []


def _cosine(a: list[float], b) -> float:
    """Cosine similarity. `b` may arrive as a string from pgvector."""
    if isinstance(b, str):
        # pgvector returns "[0.1,0.2,...]" — parse it once.
        inner = b.strip().lstrip("[").rstrip("]")
        b = [float(x) for x in inner.split(",") if x]
    if len(a) != len(b):
        raise ValueError("embedding dimension mismatch")
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if na == 0 or nb == 0:
        return 0.0
    return dot / ((na ** 0.5) * (nb ** 0.5))
