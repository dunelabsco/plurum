"""Search-related Pydantic models."""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field

from app.models.blueprint import BlueprintSummary, QualityMetricsEmbed, VerificationTier


class SearchMode(str, Enum):
    """Search mode for hybrid search."""

    HYBRID = "hybrid"      # Combined vector + keyword (default)
    SEMANTIC = "semantic"  # Vector search only
    KEYWORD = "keyword"    # Keyword search only


class SearchRequest(BaseModel):
    """Request model for hybrid search."""

    query: str = Field(..., min_length=2, max_length=1000, description="Natural language query")
    tags: list[str] = Field(default_factory=list, description="Filter by tags")
    min_score: float = Field(0.0, ge=0.0, le=1.0, description="Minimum quality score")
    min_success_rate: float = Field(0.0, ge=0.0, le=1.0, description="Minimum success rate")
    limit: int = Field(10, ge=1, le=50, description="Maximum results to return")
    include_deprecated: bool = Field(False, description="Include deprecated blueprints")

    # Hybrid search options
    search_mode: SearchMode = Field(
        SearchMode.HYBRID,
        description="Search mode: hybrid (default), semantic, or keyword"
    )
    vector_weight: float = Field(
        0.5, ge=0.0, le=1.0,
        description="Weight for vector search in hybrid mode (0-1)"
    )
    keyword_weight: float = Field(
        0.5, ge=0.0, le=1.0,
        description="Weight for keyword search in hybrid mode (0-1)"
    )


class SearchResult(BaseModel):
    """A single search result with relevance info."""

    blueprint: BlueprintSummary
    version_id: str = Field(..., description="Specific version used for this result")
    similarity: float = Field(0.0, ge=0.0, le=1.0, description="Semantic similarity score")
    keyword_rank: float = Field(0.0, ge=0.0, description="Keyword match rank (ts_rank)")
    combined_score: float = Field(0.0, ge=0.0, description="Combined RRF score")
    final_score: float = Field(0.0, ge=0.0, description="Final score after tier boosting")
    match_reasons: list[str] = Field(
        default_factory=list, description="Why this result matched"
    )
    # Version-specific Trust Engine fields
    verification_tier: VerificationTier = VerificationTier.SELF_REPORTED
    risk_score: int = 0


class SearchResponse(BaseModel):
    """Response model for search requests."""

    query: str
    results: list[SearchResult]
    total_found: int
    filters_applied: dict[str, str | int | float | bool | list] = Field(default_factory=dict)


class SimilarRequest(BaseModel):
    """Request model for finding similar blueprints."""

    limit: int = Field(5, ge=1, le=20)
    exclude_same_author: bool = False
