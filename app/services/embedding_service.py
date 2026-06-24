"""Embedding service for generating vector embeddings."""

from __future__ import annotations

import logging
import random
import time
from functools import lru_cache
from typing import Callable, TypeVar

from openai import (
    APIConnectionError,
    APITimeoutError,
    OpenAI,
    RateLimitError,
    InternalServerError,
)

from app.config import get_settings

logger = logging.getLogger(__name__)

T = TypeVar("T")

# Embeddings back experience publish/search and session topics; without retry,
# a single OpenAI hiccup would propagate as an HTTP 500 to the caller.
_RETRYABLE_EXCEPTIONS = (
    RateLimitError,
    APITimeoutError,
    APIConnectionError,
    InternalServerError,
)
_MAX_RETRIES = 5
_BASE_BACKOFF_SECONDS = 1.0
_MAX_BACKOFF_SECONDS = 30.0


def _with_retry(fn: Callable[[], T]) -> T:
    """Retry a zero-arg callable with exponential backoff + jitter on transient OpenAI errors."""
    for attempt in range(_MAX_RETRIES):
        try:
            return fn()
        except _RETRYABLE_EXCEPTIONS as e:
            if attempt == _MAX_RETRIES - 1:
                logger.warning(
                    "OpenAI embedding call failed after %d attempts: %s",
                    _MAX_RETRIES, e,
                )
                raise
            backoff = min(_BASE_BACKOFF_SECONDS * (2 ** attempt), _MAX_BACKOFF_SECONDS)
            jitter = random.uniform(0, backoff * 0.25)
            sleep_for = backoff + jitter
            logger.info(
                "OpenAI embedding transient error (attempt %d/%d): %s — retrying in %.2fs",
                attempt + 1, _MAX_RETRIES, type(e).__name__, sleep_for,
            )
            time.sleep(sleep_for)
    # unreachable
    raise RuntimeError("retry loop exited without return")


class EmbeddingService:
    """Service for generating text embeddings using OpenAI."""

    def __init__(self):
        settings = get_settings()
        # max_retries on the client covers HTTP-level retries (429, 5xx, network).
        # Our own _with_retry wraps logical failures and adds jitter + extended attempts.
        self.client = OpenAI(api_key=settings.openai_api_key, max_retries=3)
        self.model = settings.embedding_model
        self.dimensions = settings.embedding_dimensions

    def generate_embedding(self, text: str) -> list[float]:
        """Generate an embedding for a single text (retries on transient errors)."""
        def _call():
            response = self.client.embeddings.create(
                model=self.model,
                input=text,
                dimensions=self.dimensions,
            )
            return response.data[0].embedding
        return _with_retry(_call)

    def generate_embeddings(self, texts: list[str]) -> list[list[float]]:
        """Generate embeddings for multiple texts (retries on transient errors)."""
        if not texts:
            return []

        def _call():
            response = self.client.embeddings.create(
                model=self.model,
                input=texts,
                dimensions=self.dimensions,
            )
            # Sort by index to maintain order
            sorted_data = sorted(response.data, key=lambda x: x.index)
            return [item.embedding for item in sorted_data]
        return _with_retry(_call)

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
