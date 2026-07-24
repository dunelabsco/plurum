"""Application configuration and environment settings."""

from __future__ import annotations

from functools import lru_cache
from ipaddress import ip_network
from typing import Literal

from limits import parse
from pydantic import Field, field_validator
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
    rate_limit_standard: int = Field(default=100, gt=0)
    rate_limit_premium: int = Field(default=1000, gt=0)
    rate_limit_unlimited: int = Field(default=10000, gt=0)

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
    rate_limit_trusted_proxy_networks: list[str] = ["100.0.0.0/8"]

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

    # Hosted MCP transport security. Host validation is enabled explicitly in
    # the MCP SDK; these defaults cover production plus local/test clients.
    mcp_allowed_hosts: list[str] = [
        "mcp.plurum.ai",
        "mcp.plurum.ai:*",
        "api.plurum.ai",
        "api.plurum.ai:*",
        "localhost:*",
        "127.0.0.1:*",
        "testserver",
    ]
    mcp_allowed_origins: list[str] = []

    # CORS
    allowed_origins: list[str] = ["http://localhost:3000"]

    # Pulse (real-time awareness)
    pulse_relevance_threshold: float = 0.6
    pulse_cooldown_seconds: int = 300
    pulse_max_pushes_per_minute: int = 10
    pulse_max_contributions_per_session: int = 5
    pulse_auth_timeout_seconds: float = 10.0
    pulse_max_message_bytes: int = 256 * 1024
    pulse_max_messages_per_minute: int = 60

    @field_validator(
        "rate_limit_experience_write",
        "rate_limit_feedback",
        "rate_limit_acquire",
        "rate_limit_session_write",
        "rate_limit_session_entry",
        "rate_limit_check_username",
        "rate_limit_register",
        "rate_limit_search",
        "rate_limit_read",
    )
    @classmethod
    def validate_rate_limit(cls, value: str) -> str:
        """Reject invalid limits at startup instead of silently disabling REST limits."""
        parse(value)
        return value

    @field_validator("rate_limit_trusted_proxy_networks")
    @classmethod
    def validate_trusted_proxy_networks(cls, values: list[str]) -> list[str]:
        """Reject invalid trusted-proxy CIDRs at startup."""
        for value in values:
            ip_network(value, strict=False)
        return values

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
