"""Tag API endpoints."""

from fastapi import APIRouter

from app.repositories.blueprint_repo import BlueprintRepository
from app.models.tag import Tag

router = APIRouter(prefix="/tags", tags=["Tags"])


@router.get(
    "",
    response_model=list[Tag],
    summary="List tags",
    description="List all tags ordered by usage count.",
)
def list_tags(limit: int = 100):
    """
    List all available tags.

    Tags are ordered by usage count (most used first).
    """
    repo = BlueprintRepository()
    return repo.list_tags(limit=limit)
