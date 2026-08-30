"""Application configuration and environment settings."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, model_validator
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
    api_key_length: int = Field(default=32, ge=32)

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

    # Hosted MCP transport security
    mcp_allowed_hosts: list[str] = [
        "mcp.plurum.ai",
        "mcp.plurum.ai:*",
        "api.plurum.ai",
        "api.plurum.ai:*",
    ]
    mcp_allowed_origins: list[str] = []
    # FastMCP emits structured results in both JSON content and
    # structuredContent, so the wire cap is intentionally above the request cap.
    mcp_max_response_body_bytes: int = 10 * 1024 * 1024
    mcp_enabled: bool = False

    # MCP OAuth is intentionally independent from the transport switch so a
    # deployment can keep API-key authentication while OAuth is canaried.
    mcp_oauth_enabled: bool = False
    mcp_oauth_resource_url: str = "https://mcp.plurum.ai/mcp"
    # Supabase's OAuth issuer is normally derived from SUPABASE_URL. An exact
    # override is available for canaries and self-hosted deployments.
    mcp_oauth_issuer_url: str | None = None
    mcp_oauth_max_bearer_token_bytes: int = Field(
        default=8 * 1024,
        ge=256,
        le=64 * 1024,
    )

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

    @property
    def is_development(self) -> bool:
        return self.environment == "development"

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def mcp_oauth_audience(self) -> str:
        """The exact JWT audience expected by the hosted MCP resource."""
        return self.mcp_oauth_resource_url

    @property
    def effective_mcp_oauth_issuer_url(self) -> str:
        """Return the explicit OAuth issuer or the Supabase project issuer."""
        if self.mcp_oauth_issuer_url is not None:
            return self.mcp_oauth_issuer_url
        return f"{self.supabase_url.rstrip('/')}/auth/v1"

    @model_validator(mode="after")
    def validate_mcp_oauth_endpoints(self) -> "Settings":
        """Reject ambiguous or insecure OAuth resource and issuer URLs."""
        allow_loopback_http = self.is_development
        _validate_oauth_endpoint(
            self.mcp_oauth_resource_url,
            field_name="mcp_oauth_resource_url",
            allow_loopback_http=allow_loopback_http,
        )
        _validate_oauth_endpoint(
            self.effective_mcp_oauth_issuer_url,
            field_name="mcp_oauth_issuer_url",
            allow_loopback_http=allow_loopback_http,
        )
        return self


def _validate_oauth_endpoint(
    value: str,
    *,
    field_name: str,
    allow_loopback_http: bool,
) -> None:
    """Validate an absolute OAuth endpoint without rewriting its identity."""
    if not value or any(
        character.isspace()
        or ord(character) < 0x20
        or ord(character) == 0x7F
        or character == "\\"
        for character in value
    ):
        raise ValueError(f"{field_name} must be an absolute HTTPS URL")

    parsed = urlsplit(value)
    try:
        parsed.port
    except ValueError:
        raise ValueError(
            f"{field_name} must be an absolute HTTPS URL"
        ) from None
    is_loopback = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    secure_scheme = parsed.scheme == "https" or (
        allow_loopback_http and parsed.scheme == "http" and is_loopback
    )
    if (
        not secure_scheme
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.netloc.endswith(":")
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError(f"{field_name} must be an absolute HTTPS URL")


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
