"""Application configuration and environment settings."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    # Environment
    environment: Literal["development", "staging", "production"] = "development"
    debug: bool = False

    # Supabase
    supabase_url: str
    supabase_db_url: str
    supabase_key: str

    # OpenAI
    openai_api_key: str

    # API Configuration
    api_key_prefix: str = "plrm_live_"
    api_key_length: int = 32

    # Rate Limiting (requests per minute)
    rate_limit_standard: int = 100
    rate_limit_premium: int = 1000
    rate_limit_unlimited: int = 10000

    # Embedding
    embedding_model: str = "text-embedding-3-small"
    embedding_dimensions: int = 1536

    # Memory extraction LLM (the model that extracts durable facts from turns)
    # Override via PLURUM_EXTRACTION_MODEL env var if this specific id is unavailable.
    extraction_model: str = "gpt-5.4-mini"

    # Pagination
    default_page_size: int = 20
    max_page_size: int = 100

    # CORS
    allowed_origins: list[str] = ["http://localhost:3000"]

    # Pulse (real-time awareness)
    pulse_relevance_threshold: float = 0.6
    pulse_cooldown_seconds: int = 300
    pulse_max_pushes_per_minute: int = 10
    pulse_max_contributions_per_session: int = 5

    @property
    def is_development(self) -> bool:
        return self.environment == "development"

    @property
    def is_production(self) -> bool:
        return self.environment == "production"


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
