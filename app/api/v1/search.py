"""Search API endpoints."""

from typing import Annotated

from fastapi import APIRouter, Query

from app.services.search_service import SearchService
from app.models.search import SearchRequest, SearchResponse, SearchResult

router = APIRouter(prefix="/search", tags=["Search"])


@router.post(
    "",
    response_model=SearchResponse,
    summary="Semantic search",
    description="Search for blueprints using natural language. Uses semantic similarity + optional tag filtering.",
)
def search_blueprints(request: SearchRequest):
    """
    Search for blueprints using natural language.

    The search uses semantic similarity to find blueprints that match your query,
    even if they don't use the exact same words. You can also filter by tags,
    minimum quality score, and success rate.
    """
    service = SearchService()
    return service.search(request)


@router.get(
    "/similar/{slug}",
    response_model=list[SearchResult],
    summary="Find similar blueprints",
    description="Find blueprints similar to the given one.",
)
def find_similar_blueprints(
    slug: str,
    limit: Annotated[int, Query(ge=1, le=20)] = 5,
    exclude_same_author: bool = False,
):
    """
    Find blueprints similar to the given one.

    Uses the blueprint's embedding to find semantically similar blueprints.
    Useful for discovering related strategies.
    """
    service = SearchService()
    return service.find_similar(
        identifier=slug,
        limit=limit,
        exclude_same_author=exclude_same_author,
    )
