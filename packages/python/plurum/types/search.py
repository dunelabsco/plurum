"""
Search type definitions
"""

from __future__ import annotations

from typing import Optional
from pydantic import BaseModel

from plurum.types.blueprints import BlueprintSummary, VerificationTier


class SearchResult(BaseModel):
    """A single search result with similarity score and version info"""

    blueprint: BlueprintSummary
    version_id: str  # Specific version for this result
    similarity: float
    match_reasons: list[str]
    final_score: float = 0.0
    # Version-specific Trust Engine fields
    verification_tier: VerificationTier = "self_reported"
    risk_score: int = 0


class SearchResponse(BaseModel):
    """Response from a search query"""

    results: list[SearchResult]
    total_found: int
    query: str
    filters_applied: dict[str, Optional[list[str] | float]]
