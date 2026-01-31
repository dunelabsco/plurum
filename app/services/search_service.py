"""Search service for hybrid semantic + keyword search."""

from __future__ import annotations

from uuid import UUID

from app.repositories.blueprint_repo import BlueprintRepository
from app.services.embedding_service import get_embedding_service
from app.models.blueprint import BlueprintStatus, BlueprintSummary, BlueprintAuthor, QualityMetricsEmbed, VerificationTier
from app.models.search import SearchRequest, SearchResult, SearchResponse, SearchMode


# Tier factors for RELATIVE boosting
TIER_FACTORS = {
    VerificationTier.SELF_REPORTED: 0.0,
    VerificationTier.SANDBOX: 0.05,       # 5% of max_score
    VerificationTier.ORG_VERIFIED: 0.10,  # 10% of max_score
}


def get_tier_factor(tier: str) -> float:
    """Get tier factor for relative boosting."""
    try:
        return TIER_FACTORS.get(VerificationTier(tier), 0.0)
    except ValueError:
        return 0.0


class SearchService:
    """Service for hybrid search operations combining vector and keyword search."""

    def __init__(self):
        self.repo = BlueprintRepository()
        self.embedding_service = get_embedding_service()

    def search(self, request: SearchRequest) -> SearchResponse:
        """
        Perform hybrid search using Reciprocal Rank Fusion (RRF).

        The search combines:
        1. Vector search (semantic similarity via embeddings)
        2. Keyword search (PostgreSQL full-text search with tsvector)

        Results are merged using RRF to ensure exact keyword matches
        (like 'AWS', 'Next.js') appear at the top while still benefiting
        from semantic understanding.

        RANKING LOGIC:
        1. Get combined_score from RRF (vector + keyword)
        2. Find max_score in current batch
        3. boost = max_score * tier_factor
        4. final_score = combined_score + boost

        This ensures boosts are proportional to the score range,
        preventing fixed +0.10 from dominating when scores are small.
        """
        # Generate query embedding for vector search
        query_embedding = self.embedding_service.generate_embedding(request.query)

        # Determine status filter
        status_filter = [BlueprintStatus.PUBLISHED.value]
        if request.include_deprecated:
            status_filter.append(BlueprintStatus.DEPRECATED.value)

        # Determine search mode and weights
        search_mode = getattr(request, 'search_mode', SearchMode.HYBRID)

        if search_mode == SearchMode.SEMANTIC:
            vector_weight = 1.0
            keyword_weight = 0.0
        elif search_mode == SearchMode.KEYWORD:
            vector_weight = 0.0
            keyword_weight = 1.0
        else:  # HYBRID (default)
            vector_weight = getattr(request, 'vector_weight', 0.5)
            keyword_weight = getattr(request, 'keyword_weight', 0.5)

        # Perform hybrid search
        raw_results = self.repo.hybrid_search(
            query_text=request.query,
            query_embedding=query_embedding,
            limit=request.limit * 2,  # Fetch extra for filtering
            status_filter=status_filter,
            vector_weight=vector_weight,
            keyword_weight=keyword_weight,
        )

        # Apply additional filters
        filtered_results = []
        for item in raw_results:
            # Apply quality filters
            if float(item.get("score", 0)) < request.min_score:
                continue
            if float(item.get("success_rate", 0)) < request.min_success_rate:
                continue

            # Apply tag filter
            blueprint_tags = item.get("tags", []) or []
            if request.tags and not any(tag in blueprint_tags for tag in request.tags):
                continue

            filtered_results.append(item)

        if not filtered_results:
            return SearchResponse(
                query=request.query,
                results=[],
                total_found=0,
                filters_applied={},
            )

        # Find max_score for RELATIVE tier boosting
        max_score = max(float(r.get("combined_score", 0)) for r in filtered_results)

        # Apply relative tier boost and convert to results
        results = []
        for item in filtered_results:
            blueprint_tags = item.get("tags", []) or []

            # Apply RELATIVE tier boost
            tier = item.get("verification_tier", "self_reported")
            factor = get_tier_factor(tier)
            boost = max_score * factor  # Relative to batch max
            combined_score = float(item.get("combined_score", 0))
            final_score = combined_score + boost

            # Build match reasons based on search signals
            match_reasons = self._build_match_reasons(item, request, blueprint_tags)

            # Build author if present
            author = None
            if item.get("created_by_agent_id"):
                agent_data = self.repo.get_agent_by_id(item["created_by_agent_id"])
                if agent_data:
                    author = BlueprintAuthor(
                        id=agent_data["id"],
                        name=agent_data["name"],
                        username=agent_data.get("username"),
                        publisher_domain=agent_data.get("publisher_domain"),
                    )

            # Create summary
            summary = BlueprintSummary(
                id=item["id"],
                slug=item["slug"],
                short_id=item.get("short_id", ""),
                title=item.get("title", ""),
                goal_description=item.get("goal_description", ""),
                status=item["status"],
                is_public=item.get("is_public", True),
                quality_metrics=QualityMetricsEmbed(
                    execution_count=item.get("execution_count", 0),
                    success_count=item.get("success_count", 0),
                    failure_count=item.get("failure_count", 0),
                    success_rate=float(item.get("success_rate", 0)),
                    upvotes=item.get("upvotes", 0),
                    downvotes=item.get("downvotes", 0),
                    score=float(item.get("score", 0)),
                ),
                tags=blueprint_tags,
                created_at=item["created_at"],
                updated_at=item["updated_at"],
                author=author,
            )

            results.append(SearchResult(
                blueprint=summary,
                version_id=str(item.get("current_version_id", "")),  # Include version_id
                similarity=float(item.get("similarity", 0)),
                keyword_rank=float(item.get("keyword_rank", 0)),
                combined_score=combined_score,
                final_score=final_score,
                match_reasons=match_reasons,
                verification_tier=VerificationTier(tier) if tier else VerificationTier.SELF_REPORTED,
                risk_score=int(item.get("risk_score", 0)),
            ))

        # Sort by final_score (with tier boost applied)
        results.sort(key=lambda x: x.final_score, reverse=True)

        # Limit results
        results = results[:request.limit]

        # Build filters applied summary
        filters_applied = {}
        if request.tags:
            filters_applied["tags"] = request.tags
        if request.min_score > 0:
            filters_applied["min_score"] = request.min_score
        if request.min_success_rate > 0:
            filters_applied["min_success_rate"] = request.min_success_rate
        if request.include_deprecated:
            filters_applied["include_deprecated"] = True
        if search_mode != SearchMode.HYBRID:
            filters_applied["search_mode"] = search_mode.value

        return SearchResponse(
            query=request.query,
            results=results,
            total_found=len(results),
            filters_applied=filters_applied,
        )

    def _build_match_reasons(
        self,
        item: dict,
        request: SearchRequest,
        blueprint_tags: list[str],
    ) -> list[str]:
        """Build human-readable match reasons based on search signals."""
        match_reasons = []

        similarity = float(item.get("similarity", 0))
        keyword_rank = float(item.get("keyword_rank", 0))
        combined_score = float(item.get("combined_score", 0))

        # Keyword match reasons (exact matches)
        if keyword_rank > 0.1:
            match_reasons.append("Exact keyword match")

        # Semantic match reasons
        if similarity > 0.8:
            match_reasons.append("Highly relevant to your query")
        elif similarity > 0.6:
            match_reasons.append("Related to your query")

        # Quality signals
        if item.get("success_rate", 0) > 0.8:
            match_reasons.append("High success rate")

        if item.get("score", 0) > 0.5:
            match_reasons.append("Well-rated by community")

        # Tag matches
        if request.tags:
            matching_tags = set(request.tags) & set(blueprint_tags)
            if matching_tags:
                match_reasons.append(f"Matching tags: {', '.join(matching_tags)}")

        return match_reasons

    def find_similar(
        self,
        identifier: str,
        limit: int = 5,
        exclude_same_author: bool = False,
    ) -> list[SearchResult]:
        """
        Find blueprints similar to the given one.

        Args:
            identifier: Blueprint slug or short_id
            limit: Maximum results
            exclude_same_author: Whether to exclude blueprints from the same agent
        """
        # Get the blueprint by identifier (supports both slug and short_id)
        blueprint = self.repo.get_by_identifier(identifier)
        if not blueprint:
            return []

        # Find similar using the repository
        similar = self.repo.find_similar(
            blueprint_id=blueprint["id"],
            limit=limit,
            exclude_same_author=exclude_same_author,
        )

        results = []
        for item in similar:
            tier = item.get("verification_tier", "self_reported")

            # Build author if present
            author = None
            if item.get("created_by_agent_id"):
                agent_data = self.repo.get_agent_by_id(item["created_by_agent_id"])
                if agent_data:
                    author = BlueprintAuthor(
                        id=agent_data["id"],
                        name=agent_data["name"],
                        username=agent_data.get("username"),
                        publisher_domain=agent_data.get("publisher_domain"),
                    )

            summary = BlueprintSummary(
                id=item["id"],
                slug=item["slug"],
                short_id=item.get("short_id", ""),
                title=item.get("title", ""),
                goal_description=item.get("goal_description", ""),
                status=item["status"],
                is_public=item.get("is_public", True),
                quality_metrics=QualityMetricsEmbed(
                    execution_count=item.get("execution_count", 0),
                    success_count=item.get("success_count", 0),
                    failure_count=item.get("failure_count", 0),
                    success_rate=float(item.get("success_rate", 0)),
                    upvotes=item.get("upvotes", 0),
                    downvotes=item.get("downvotes", 0),
                    score=float(item.get("score", 0)),
                ),
                tags=item.get("tags", []),
                created_at=item["created_at"],
                updated_at=item["updated_at"],
                author=author,
            )

            similarity = float(item.get("similarity", 0))
            results.append(SearchResult(
                blueprint=summary,
                version_id=str(item.get("current_version_id", "")),
                similarity=similarity,
                keyword_rank=0.0,
                combined_score=similarity,
                final_score=similarity,
                match_reasons=["Similar strategy or goal"],
                verification_tier=VerificationTier(tier) if tier else VerificationTier.SELF_REPORTED,
                risk_score=int(item.get("risk_score", 0)),
            ))

        return results
