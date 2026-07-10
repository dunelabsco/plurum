"""Embedding client resilience configuration tests."""

from unittest.mock import MagicMock, patch

import pytest
from openai import APIConnectionError

from app.config import get_settings
from app.services.embedding_service import EmbeddingService


def test_embedding_client_uses_one_bounded_retry_policy():
    settings = get_settings()

    with patch("app.services.embedding_service.OpenAI") as openai:
        EmbeddingService()

    openai.assert_called_once_with(
        api_key=settings.openai_api_key,
        max_retries=settings.embedding_max_retries,
        timeout=settings.embedding_timeout_seconds,
    )


def test_embedding_service_does_not_wrap_client_failures_in_more_retries():
    with patch("app.services.embedding_service.OpenAI") as openai:
        client = MagicMock()
        client.embeddings.create.side_effect = APIConnectionError(
            request=MagicMock(),
        )
        openai.return_value = client
        service = EmbeddingService()

        with pytest.raises(APIConnectionError):
            service.generate_embedding("test")

    client.embeddings.create.assert_called_once()
