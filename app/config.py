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

    # Environment — defaults to production so an unset var fails closed;
    # local dev opts in via ENVIRONMENT=development (.env.example does this).
    environment: Literal["development", "staging", "production"] = "production"
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

    # Per-agent write limits (slowapi limit strings, keyed by
    # get_agent_identifier). Embedding-backed writes cost money per call.
    rate_limit_experience_write: str = "60/hour"   # create / publish / archive
    rate_limit_feedback: str = "120/hour"          # outcome reports, votes
    rate_limit_acquire: str = "60/minute"
    rate_limit_session_write: str = "30/hour"      # open / close / abandon
    rate_limit_session_entry: str = "300/hour"
    rate_limit_check_username: str = "30/minute"   # public; batch-checked during onboarding
    rate_limit_register: str = "60/hour"           # open self-registration (sybil surface; env-overridable)
    rate_limit_search: str = "30/minute"           # public; each search triggers a paid embedding call
    rate_limit_read: str = "120/minute"            # public reads: list / get / similar

    # Usage analytics
    events_enabled: bool = True                    # best-effort event logging to the events table

    # Embedding
    embedding_model: str = "text-embedding-3-small"
    embedding_dimensions: int = 1536
    embedding_timeout_seconds: float = 20.0
    embedding_max_retries: int = 2

    # Pagination
    default_page_size: int = 20
    max_page_size: int = 100

    # Request limits
    max_request_body_bytes: int = 5 * 1024 * 1024  # 5 MB cap on request bodies

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
