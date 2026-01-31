"""Blueprint repository for database operations."""

from __future__ import annotations

from uuid import UUID

from app.db.supabase_client import get_supabase_client
from app.core.exceptions import NotFoundError, DuplicateError
from app.models.blueprint import BlueprintStatus


class BlueprintRepository:
    """Repository for blueprint database operations."""

    def __init__(self):
        self.client = get_supabase_client()

    # =========================================================================
    # BLUEPRINT OPERATIONS
    # =========================================================================

    def create_blueprint(
        self,
        slug: str,
        created_by_agent_id: UUID,
        is_public: bool = True,
    ) -> dict:
        """Create a new blueprint."""
        # Check for duplicate slug
        existing = self.get_by_slug(slug)
        if existing:
            raise DuplicateError("Blueprint", slug)

        data = {
            "slug": slug,
            "created_by_agent_id": str(created_by_agent_id),
            "is_public": is_public,
            "status": BlueprintStatus.PUBLISHED.value,
        }

        result = self.client.table("blueprints").insert(data).execute()

        if not result.data:
            raise Exception("Failed to create blueprint")

        return result.data[0]

    def get_by_id(self, blueprint_id: UUID) -> dict | None:
        """Get a blueprint by ID."""
        result = (
            self.client.table("blueprints")
            .select("*")
            .eq("id", str(blueprint_id))
            .execute()
        )
        return result.data[0] if result.data else None

    def get_by_slug(self, slug: str) -> dict | None:
        """Get a blueprint by slug."""
        result = (
            self.client.table("blueprints")
            .select("*")
            .eq("slug", slug)
            .execute()
        )
        return result.data[0] if result.data else None

    def get_by_short_id(self, short_id: str) -> dict | None:
        """Get a blueprint by short_id."""
        result = (
            self.client.table("blueprints")
            .select("*")
            .eq("short_id", short_id)
            .execute()
        )
        return result.data[0] if result.data else None

    def get_by_identifier(self, identifier: str) -> dict | None:
        """
        Get a blueprint by either short_id or slug.

        For hybrid URLs like /blueprints/{short_id}/{slug},
        this method tries short_id first (faster, 8 chars),
        then falls back to slug.
        """
        # Short IDs are exactly 8 characters
        if len(identifier) == 8:
            result = self.get_by_short_id(identifier)
            if result:
                return result

        # Fall back to slug lookup
        return self.get_by_slug(identifier)

    def get_by_slug_with_version(self, slug: str) -> dict | None:
        """Get a blueprint by slug with current version data."""
        # First get the blueprint
        blueprint = self.get_by_slug(slug)
        if not blueprint:
            return None

        # If there's a current version, fetch it
        if blueprint.get("current_version_id"):
            version = self.get_version_by_id(blueprint["current_version_id"])
            blueprint["current_version"] = version

        # Fetch tags
        blueprint["tags"] = self.get_blueprint_tags(blueprint["id"])

        # Fetch author info
        if blueprint.get("created_by_agent_id"):
            author = self.get_agent_by_id(blueprint["created_by_agent_id"])
            blueprint["author"] = author

        return blueprint

    def get_agent_by_id(self, agent_id: str | UUID) -> dict | None:
        """Get an agent by ID for author info."""
        result = (
            self.client.table("agents")
            .select("id, name, username, publisher_domain")
            .eq("id", str(agent_id))
            .execute()
        )
        return result.data[0] if result.data else None

    def list_blueprints(
        self,
        limit: int = 20,
        offset: int = 0,
        status: BlueprintStatus | None = None,
        created_by_agent_id: UUID | None = None,
        is_public: bool | None = None,
        tags: list[str] | None = None,
        order_by: str = "score",
        order_desc: bool = True,
    ) -> tuple[list[dict], int]:
        """List blueprints with filtering and pagination."""
        query = self.client.table("blueprints").select("*", count="exact")

        # Apply filters
        if status:
            query = query.eq("status", status.value)
        if created_by_agent_id:
            query = query.eq("created_by_agent_id", str(created_by_agent_id))
        if is_public is not None:
            query = query.eq("is_public", is_public)

        # Order
        query = query.order(order_by, desc=order_desc)

        # Pagination
        query = query.range(offset, offset + limit - 1)

        result = query.execute()

        blueprints = result.data or []
        if not blueprints:
            return blueprints, result.count or 0

        # Batch fetch versions (1 query instead of N)
        version_ids = [bp["current_version_id"] for bp in blueprints if bp.get("current_version_id")]
        versions_by_id = {}
        if version_ids:
            versions_result = (
                self.client.table("blueprint_versions")
                .select("id, title, goal_description")
                .in_("id", version_ids)
                .execute()
            )
            versions_by_id = {v["id"]: v for v in (versions_result.data or [])}

        # Batch fetch authors (1 query instead of N)
        agent_ids = list({bp["created_by_agent_id"] for bp in blueprints if bp.get("created_by_agent_id")})
        agents_by_id = {}
        if agent_ids:
            agents_result = (
                self.client.table("agents")
                .select("id, name, username, publisher_domain")
                .in_("id", agent_ids)
                .execute()
            )
            agents_by_id = {a["id"]: a for a in (agents_result.data or [])}

        # Batch fetch tags (2 queries instead of 2N)
        bp_ids = [bp["id"] for bp in blueprints]
        tags_by_bp = {}
        if bp_ids:
            bt_result = (
                self.client.table("blueprint_tags")
                .select("blueprint_id, tag_id")
                .in_("blueprint_id", bp_ids)
                .execute()
            )
            if bt_result.data:
                all_tag_ids = list({r["tag_id"] for r in bt_result.data})
                tags_result = (
                    self.client.table("tags")
                    .select("id, name")
                    .in_("id", all_tag_ids)
                    .execute()
                )
                tag_names = {t["id"]: t["name"] for t in (tags_result.data or [])}
                for r in bt_result.data:
                    bp_id = r["blueprint_id"]
                    tag_name = tag_names.get(r["tag_id"])
                    if tag_name:
                        tags_by_bp.setdefault(bp_id, []).append(tag_name)

        # Enrich blueprints with batched data
        for bp in blueprints:
            bp["tags"] = tags_by_bp.get(bp["id"], [])
            version = versions_by_id.get(bp.get("current_version_id"))
            if version:
                bp["title"] = version.get("title", "")
                bp["goal_description"] = version.get("goal_description", "")
            if bp.get("created_by_agent_id"):
                bp["author"] = agents_by_id.get(bp["created_by_agent_id"])

        # Filter by tags if specified (post-query filter)
        if tags:
            blueprints = [
                bp for bp in blueprints
                if any(tag in bp.get("tags", []) for tag in tags)
            ]

        return blueprints, result.count or 0

    def update_blueprint(self, blueprint_id: UUID, data: dict) -> dict:
        """Update a blueprint."""
        result = (
            self.client.table("blueprints")
            .update(data)
            .eq("id", str(blueprint_id))
            .execute()
        )

        if not result.data:
            raise NotFoundError("Blueprint", str(blueprint_id))

        return result.data[0]

    def update_status(self, slug: str, status: BlueprintStatus) -> dict:
        """Update a blueprint's status."""
        result = (
            self.client.table("blueprints")
            .update({"status": status.value})
            .eq("slug", slug)
            .execute()
        )

        if not result.data:
            raise NotFoundError("Blueprint", slug)

        return result.data[0]

    def delete_blueprint(self, blueprint_id: UUID) -> None:
        """Delete a blueprint (cascade deletes versions)."""
        self.client.table("blueprints").delete().eq("id", str(blueprint_id)).execute()

    # =========================================================================
    # VERSION OPERATIONS
    # =========================================================================

    def create_version(
        self,
        blueprint_id: UUID,
        version_number: int,
        title: str,
        goal_description: str,
        strategy: str,
        execution_steps: list[dict],
        code_snippets: list[dict],
        context_requirements: dict,
        embedding: list[float] | None,
        created_by_agent_id: UUID,
        # Trust Engine fields
        permissions_required: list[str] | None = None,
        risk_flags: list[str] | None = None,
        environment_constraints: dict | None = None,
        verification_tier: str = "self_reported",
        risk_score: int = 0,
    ) -> dict:
        """Create a new blueprint version."""
        data = {
            "blueprint_id": str(blueprint_id),
            "version_number": version_number,
            "title": title,
            "goal_description": goal_description,
            "strategy": strategy,
            "execution_steps": execution_steps,
            "code_snippets": code_snippets,
            "context_requirements": context_requirements,
            "created_by_agent_id": str(created_by_agent_id),
            # Trust Engine fields
            "verification_tier": verification_tier,
            "risk_score": risk_score,
            "permissions_required": permissions_required or [],
            "risk_flags": risk_flags or [],
            "environment_constraints": environment_constraints or {},
        }

        # Add embedding if provided
        if embedding:
            data["embedding"] = embedding

        result = self.client.table("blueprint_versions").insert(data).execute()

        if not result.data:
            raise Exception("Failed to create blueprint version")

        version = result.data[0]

        # Update blueprint's current_version_id
        self.update_blueprint(
            blueprint_id,
            {"current_version_id": version["id"]},
        )

        return version

    def get_version_by_id(self, version_id: str | UUID) -> dict | None:
        """Get a blueprint version by ID."""
        result = (
            self.client.table("blueprint_versions")
            .select("*")
            .eq("id", str(version_id))
            .execute()
        )
        return result.data[0] if result.data else None

    def get_latest_version(self, blueprint_id: UUID) -> dict | None:
        """Get the latest version of a blueprint."""
        result = (
            self.client.table("blueprint_versions")
            .select("*")
            .eq("blueprint_id", str(blueprint_id))
            .order("version_number", desc=True)
            .limit(1)
            .execute()
        )
        return result.data[0] if result.data else None

    def get_version_count(self, blueprint_id: UUID) -> int:
        """Get the number of versions for a blueprint."""
        result = (
            self.client.table("blueprint_versions")
            .select("id", count="exact")
            .eq("blueprint_id", str(blueprint_id))
            .execute()
        )
        return result.count or 0

    def list_versions(
        self,
        blueprint_id: UUID,
        limit: int = 20,
        offset: int = 0,
    ) -> list[dict]:
        """List all versions of a blueprint."""
        result = (
            self.client.table("blueprint_versions")
            .select("*")
            .eq("blueprint_id", str(blueprint_id))
            .order("version_number", desc=True)
            .range(offset, offset + limit - 1)
            .execute()
        )
        return result.data or []

    # =========================================================================
    # TAG OPERATIONS
    # =========================================================================

    def get_or_create_tag(self, name: str) -> dict:
        """Get a tag by name or create it if it doesn't exist."""
        result = (
            self.client.table("tags")
            .select("*")
            .eq("name", name.lower())
            .execute()
        )

        if result.data:
            return result.data[0]

        # Create new tag
        new_tag = self.client.table("tags").insert({"name": name.lower()}).execute()
        return new_tag.data[0]

    def get_blueprint_tags(self, blueprint_id: str | UUID) -> list[str]:
        """Get all tag names for a blueprint."""
        result = (
            self.client.table("blueprint_tags")
            .select("tag_id")
            .eq("blueprint_id", str(blueprint_id))
            .execute()
        )

        if not result.data:
            return []

        tag_ids = [r["tag_id"] for r in result.data]

        # Fetch tag names
        tags_result = (
            self.client.table("tags")
            .select("name")
            .in_("id", tag_ids)
            .execute()
        )

        return [t["name"] for t in tags_result.data] if tags_result.data else []

    def set_blueprint_tags(self, blueprint_id: UUID, tag_names: list[str]) -> None:
        """Set the tags for a blueprint (replaces existing)."""
        # Remove existing tags
        self.client.table("blueprint_tags").delete().eq(
            "blueprint_id", str(blueprint_id)
        ).execute()

        if not tag_names:
            return

        # Add new tags
        for tag_name in tag_names:
            tag = self.get_or_create_tag(tag_name)
            self.client.table("blueprint_tags").insert({
                "blueprint_id": str(blueprint_id),
                "tag_id": tag["id"],
            }).execute()

    def list_tags(self, limit: int = 100) -> list[dict]:
        """List all tags ordered by usage."""
        result = (
            self.client.table("tags")
            .select("*")
            .order("usage_count", desc=True)
            .limit(limit)
            .execute()
        )
        return result.data or []

    # =========================================================================
    # SEARCH OPERATIONS
    # =========================================================================

    def semantic_search(
        self,
        embedding: list[float],
        limit: int = 10,
        min_similarity: float = 0.5,
        status_filter: list[str] | None = None,
    ) -> list[dict]:
        """
        Perform semantic search using pgvector.

        Note: This requires a Supabase function for vector similarity search.
        """
        # Use Supabase RPC for vector similarity search
        params = {
            "query_embedding": embedding,
            "match_threshold": min_similarity,
            "match_count": limit,
        }

        if status_filter:
            params["status_filter"] = status_filter

        result = self.client.rpc("search_blueprints", params).execute()

        return result.data or []

    def hybrid_search(
        self,
        query_text: str,
        query_embedding: list[float],
        limit: int = 10,
        status_filter: list[str] | None = None,
        vector_weight: float = 0.5,
        keyword_weight: float = 0.5,
    ) -> list[dict]:
        """
        Perform hybrid search combining vector similarity and keyword matching.

        Uses Reciprocal Rank Fusion (RRF) to combine results from:
        1. Vector search (semantic similarity via embeddings)
        2. Keyword search (PostgreSQL full-text search)

        Args:
            query_text: The search query for keyword matching
            query_embedding: The vector embedding for semantic search
            limit: Maximum results to return
            status_filter: Blueprint statuses to include
            vector_weight: Weight for vector search in RRF (0-1)
            keyword_weight: Weight for keyword search in RRF (0-1)

        Returns:
            List of blueprints sorted by combined RRF score
        """
        params = {
            "query_text": query_text,
            "query_embedding": query_embedding,
            "match_count": limit,
            "vector_weight": vector_weight,
            "keyword_weight": keyword_weight,
        }

        if status_filter:
            params["status_filter"] = status_filter

        result = self.client.rpc("hybrid_search_blueprints", params).execute()

        return result.data or []

    def find_similar(
        self,
        blueprint_id: UUID,
        limit: int = 5,
        exclude_same_author: bool = False,
    ) -> list[dict]:
        """Find blueprints similar to a given blueprint."""
        # Get the blueprint's embedding
        blueprint = self.get_by_id(blueprint_id)
        if not blueprint or not blueprint.get("current_version_id"):
            return []

        version = self.get_version_by_id(blueprint["current_version_id"])
        if not version or not version.get("embedding"):
            return []

        # Search with the embedding
        params = {
            "query_embedding": version["embedding"],
            "match_threshold": 0.3,
            "match_count": limit + 1,  # +1 to exclude self
            "exclude_blueprint_id": str(blueprint_id),
        }

        if exclude_same_author:
            params["exclude_agent_id"] = blueprint["created_by_agent_id"]

        import logging
        logger = logging.getLogger(__name__)
        try:
            result = self.client.rpc("search_blueprints", params).execute()
            return result.data[:limit] if result.data else []
        except Exception as e:
            logger.error(f"find_similar RPC failed: {e}", exc_info=True)
            raise
