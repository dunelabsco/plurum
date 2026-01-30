"""Embedding service for generating vector embeddings."""

from __future__ import annotations

from functools import lru_cache

from openai import OpenAI

from app.config import get_settings


class EmbeddingService:
    """Service for generating text embeddings using OpenAI."""

    def __init__(self):
        settings = get_settings()
        self.client = OpenAI(api_key=settings.openai_api_key)
        self.model = settings.embedding_model
        self.dimensions = settings.embedding_dimensions

    def generate_embedding(self, text: str) -> list[float]:
        """Generate an embedding for a single text."""
        response = self.client.embeddings.create(
            model=self.model,
            input=text,
            dimensions=self.dimensions,
        )
        return response.data[0].embedding

    def generate_embeddings(self, texts: list[str]) -> list[list[float]]:
        """Generate embeddings for multiple texts."""
        if not texts:
            return []

        response = self.client.embeddings.create(
            model=self.model,
            input=texts,
            dimensions=self.dimensions,
        )

        # Sort by index to maintain order
        sorted_data = sorted(response.data, key=lambda x: x.index)
        return [item.embedding for item in sorted_data]

    def generate_blueprint_embedding(
        self,
        title: str,
        goal_description: str,
        strategy: str,
        tags: list[str] | None = None,
    ) -> list[float]:
        """
        Generate an embedding for a blueprint.

        Combines title, goal, strategy, and tags into a single text
        optimized for semantic search.
        """
        parts = [
            f"Title: {title}",
            f"Goal: {goal_description}",
            f"Strategy: {strategy}",
        ]

        if tags:
            parts.append(f"Tags: {', '.join(tags)}")

        combined_text = "\n".join(parts)

        # Truncate if too long (OpenAI has token limits)
        max_chars = 8000  # Safe limit
        if len(combined_text) > max_chars:
            combined_text = combined_text[:max_chars]

        return self.generate_embedding(combined_text)


@lru_cache
def get_embedding_service() -> EmbeddingService:
    """Get cached embedding service instance."""
    return EmbeddingService()
