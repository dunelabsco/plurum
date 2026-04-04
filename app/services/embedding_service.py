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

    def generate_topic_embedding(
        self,
        topic: str,
        domain: str | None = None,
        tools: list[str] | None = None,
    ) -> list[float]:
        """
        Generate an embedding for a session topic.

        Used for matching sessions against experiences and other sessions.
        """
        parts = [f"Topic: {topic}"]

        if domain:
            parts.append(f"Domain: {domain}")
        if tools:
            parts.append(f"Tools: {', '.join(tools)}")

        combined_text = "\n".join(parts)
        return self.generate_embedding(combined_text[:8000])

    def generate_reasoning_embedding(
        self,
        goal: str,
        dead_ends: list[dict] | None = None,
        breakthroughs: list[dict] | None = None,
        gotchas: list[dict] | None = None,
        context: str | None = None,
        attempts: list[dict] | None = None,
        solution: str | None = None,
        tags: list[str] | None = None,
    ) -> list[float]:
        """
        Generate an embedding for an experience's reasoning content.

        This is the key difference from the old system: we embed the actual
        reasoning (dead ends, breakthroughs, gotchas) not just the title/goal.
        This means search finds experiences based on what was LEARNED,
        not just what was attempted.
        """
        parts = [f"Goal: {goal}"]

        if dead_ends:
            dead_end_texts = [f"Tried {d.get('what', '')} but {d.get('why', '')}" for d in dead_ends]
            parts.append(f"Dead ends: {'; '.join(dead_end_texts)}")

        if breakthroughs:
            breakthrough_texts = [f"{b.get('insight', '')}: {b.get('detail', '')}" for b in breakthroughs]
            parts.append(f"Breakthroughs: {'; '.join(breakthrough_texts)}")

        if gotchas:
            gotcha_texts = [g.get('warning', '') if isinstance(g, dict) else str(g) for g in gotchas]
            parts.append(f"Watch out for: {'; '.join(gotcha_texts)}")

        if attempts:
            attempt_texts = [
                f"{a.get('action', '')}: {a.get('outcome', '')}"
                + (f" (insight: {a['insight']})" if a.get('insight') else "")
                for a in attempts
            ]
            parts.append(f"Attempts: {'; '.join(attempt_texts)}")

        if solution:
            parts.append(f"Solution: {solution}")

        if context:
            parts.append(f"Context: {context}")

        if tags:
            parts.append(f"Tags: {', '.join(tags)}")

        combined_text = "\n".join(parts)

        # Truncate if too long (OpenAI has token limits)
        max_chars = 8000
        if len(combined_text) > max_chars:
            combined_text = combined_text[:max_chars]

        return self.generate_embedding(combined_text)


@lru_cache
def get_embedding_service() -> EmbeddingService:
    """Get cached embedding service instance."""
    return EmbeddingService()
