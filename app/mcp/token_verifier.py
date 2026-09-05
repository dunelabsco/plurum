"""Hybrid API-key and Supabase OAuth verification for hosted MCP."""

from __future__ import annotations

import logging
import threading
from collections import OrderedDict
from collections.abc import Callable
from functools import partial
from time import monotonic
from typing import Any, Protocol
from uuid import UUID

import anyio
import jwt
from jwt import PyJWKClient
from jwt.exceptions import PyJWKClientConnectionError, PyJWKClientError, PyJWTError
from mcp.server.auth.provider import AccessToken

from app.config import Settings, get_settings
from app.core.exceptions import AuthenticationError
from app.core.security import validate_api_key
from app.services.mcp_oauth_binding_service import (
    MCP_OAUTH_CLIENT_ID_MAX_BYTES,
    MCPOAuthBindingService,
)


logger = logging.getLogger(__name__)

_ALLOWED_JWT_ALGORITHMS = frozenset({"RS256", "ES256"})
_JWKS_CACHE_SECONDS = 5 * 60
_JWKS_TIMEOUT_SECONDS = 5
_JWKS_REFRESH_COOLDOWN_SECONDS = 30
_UNKNOWN_KID_CACHE_SECONDS = 60
_UNKNOWN_KID_CACHE_SIZE = 256
_MAX_KID_BYTES = 256
_MAX_SCOPE_BYTES = 2048
_API_KEY_ISSUER = "plurum-api-key"
MCP_AGENT_ID_CLAIM = "plurum_agent_id"


class SigningKeyClient(Protocol):
    """Small injectable surface implemented by PyJWT's JWK client."""

    def get_signing_key_from_jwt(self, token: str) -> Any:
        ...


class OAuthBindingResolver(Protocol):
    """Small injectable surface implemented by the binding service."""

    def resolve_agent(self, *, owner_user_id: str, client_id: str, grant_id: str) -> dict | None:
        ...


class _BoundedPyJWKClient(PyJWKClient):
    """Bound attacker-controlled unknown-key refreshes while allowing rotation."""

    def __init__(
        self,
        uri: str,
        *,
        refresh_cooldown_seconds: float = _JWKS_REFRESH_COOLDOWN_SECONDS,
        unknown_kid_cache_seconds: float = _UNKNOWN_KID_CACHE_SECONDS,
        unknown_kid_cache_size: int = _UNKNOWN_KID_CACHE_SIZE,
        clock: Callable[[], float] = monotonic,
        **kwargs: Any,
    ) -> None:
        super().__init__(uri, **kwargs)
        if refresh_cooldown_seconds <= 0:
            raise ValueError("refresh_cooldown_seconds must be positive")
        if unknown_kid_cache_seconds <= 0:
            raise ValueError("unknown_kid_cache_seconds must be positive")
        if unknown_kid_cache_size < 1:
            raise ValueError("unknown_kid_cache_size must be positive")
        self._refresh_cooldown_seconds = refresh_cooldown_seconds
        self._unknown_kid_cache_seconds = unknown_kid_cache_seconds
        self._unknown_kid_cache_size = unknown_kid_cache_size
        self._clock = clock
        self._lookup_lock = threading.Lock()
        self._last_fetch_attempt_at: float | None = None
        self._unknown_kids: OrderedDict[str, float] = OrderedDict()

    def get_signing_key(self, kid: str):
        """Resolve a key with one serialized refresh per cooldown window."""
        with self._lookup_lock:
            now = self._clock()
            self._expire_unknown_kids(now)
            if kid in self._unknown_kids and self._refresh_is_throttled(now):
                raise PyJWKClientError("Unable to find a matching signing key")
            self._unknown_kids.pop(kid, None)

            has_cached_jwks = (
                self.jwk_set_cache is not None and self.jwk_set_cache.get() is not None
            )
            if not has_cached_jwks and self._refresh_is_throttled(now):
                self._remember_unknown_kid(kid, now)
                raise PyJWKClientError("Signing key lookup temporarily unavailable")

            try:
                signing_keys = self.get_signing_keys()
            except PyJWTError:
                if not has_cached_jwks:
                    self._last_fetch_attempt_at = self._clock()
                    self._remember_unknown_kid(kid, self._last_fetch_attempt_at)
                raise

            if not has_cached_jwks:
                self._last_fetch_attempt_at = self._clock()
                self._unknown_kids.clear()

            signing_key = self.match_kid(signing_keys, kid)
            if signing_key is not None:
                self._unknown_kids.pop(kid, None)
                return signing_key

            now = self._clock()
            if self._refresh_is_throttled(now):
                self._remember_unknown_kid(kid, now)
                raise PyJWKClientError("Unable to find a matching signing key")

            try:
                signing_keys = self.get_signing_keys(refresh=True)
            finally:
                self._last_fetch_attempt_at = self._clock()

            self._unknown_kids.clear()
            signing_key = self.match_kid(signing_keys, kid)
            if signing_key is not None:
                return signing_key

            self._remember_unknown_kid(kid, self._clock())
            raise PyJWKClientError("Unable to find a matching signing key")

    def _refresh_is_throttled(self, now: float) -> bool:
        return (
            self._last_fetch_attempt_at is not None
            and now - self._last_fetch_attempt_at < self._refresh_cooldown_seconds
        )

    def _expire_unknown_kids(self, now: float) -> None:
        while self._unknown_kids:
            _kid, expires_at = next(iter(self._unknown_kids.items()))
            if expires_at > now:
                break
            self._unknown_kids.popitem(last=False)

    def _remember_unknown_kid(self, kid: str, now: float) -> None:
        self._unknown_kids[kid] = now + self._unknown_kid_cache_seconds
        self._unknown_kids.move_to_end(kid)
        while len(self._unknown_kids) > self._unknown_kid_cache_size:
            self._unknown_kids.popitem(last=False)


class PlurumMCPTokenVerifier:
    """Validate both legacy Plurum API keys and bound Supabase OAuth JWTs."""

    def __init__(
        self,
        *,
        settings: Settings | None = None,
        api_key_validator: Callable[[str], dict] = validate_api_key,
        binding_resolver: OAuthBindingResolver | None = None,
        jwk_client: SigningKeyClient | None = None,
    ) -> None:
        self.settings = settings if settings is not None else get_settings()
        self._api_key_validator = api_key_validator
        self._binding_resolver = (
            binding_resolver if binding_resolver is not None else MCPOAuthBindingService()
        )
        self.jwks_url = (
            f"{self.settings.effective_mcp_oauth_issuer_url.rstrip('/')}" "/.well-known/jwks.json"
        )
        self._jwk_client = (
            jwk_client
            if jwk_client is not None
            else _BoundedPyJWKClient(
                self.jwks_url,
                cache_keys=False,
                cache_jwk_set=True,
                lifespan=_JWKS_CACHE_SECONDS,
                timeout=_JWKS_TIMEOUT_SECONDS,
            )
        )

    async def verify_token(self, token: str) -> AccessToken | None:
        """Return an MCP access token only after fail-closed verification."""
        if not _token_is_within_limit(
            token,
            max_bytes=self.settings.mcp_oauth_max_bearer_token_bytes,
        ):
            return None

        if self.settings.api_key_prefix and token.startswith(self.settings.api_key_prefix):
            return await self._verify_api_key(token)

        if not self.settings.mcp_oauth_enabled:
            return None
        return await self._verify_oauth_token(token)

    async def _verify_api_key(self, token: str) -> AccessToken | None:
        try:
            agent = await anyio.to_thread.run_sync(partial(self._api_key_validator, token))
        except AuthenticationError:
            return None
        except Exception as error:
            logger.error(
                "MCP API-key verification failed (%s)",
                type(error).__name__,
            )
            return None

        agent_id = _canonical_uuid(agent.get("id")) if isinstance(agent, dict) else None
        if agent_id is None or agent.get("is_active") is not True:
            return None

        return AccessToken(
            token=token,
            client_id=f"plurum-api-key:{agent_id}",
            scopes=[],
            resource=self.settings.mcp_oauth_audience,
            subject=agent_id,
            claims={
                MCP_AGENT_ID_CLAIM: agent_id,
                "iss": _API_KEY_ISSUER,
                "auth_method": "api_key",
            },
        )

    async def _verify_oauth_token(self, token: str) -> AccessToken | None:
        try:
            header = jwt.get_unverified_header(token)
        except PyJWTError:
            return None
        except Exception as error:
            logger.error(
                "MCP OAuth token header parsing failed (%s)",
                type(error).__name__,
            )
            return None

        algorithm = header.get("alg")
        key_id = header.get("kid")
        if algorithm not in _ALLOWED_JWT_ALGORITHMS or not _opaque_text_within_limit(
            key_id,
            max_bytes=_MAX_KID_BYTES,
        ):
            return None

        try:
            signing_key = await anyio.to_thread.run_sync(
                partial(self._jwk_client.get_signing_key_from_jwt, token)
            )
        except PyJWKClientConnectionError as error:
            logger.error(
                "MCP OAuth signing-key lookup failed (%s)",
                type(error).__name__,
            )
            return None
        except PyJWTError:
            return None
        except Exception as error:
            logger.error(
                "MCP OAuth signing-key lookup failed (%s)",
                type(error).__name__,
            )
            return None

        key = getattr(signing_key, "key", None)
        if key is None:
            return None

        try:
            claims = jwt.decode(
                token,
                key=key,
                algorithms=[algorithm],
                audience=self.settings.mcp_oauth_audience,
                issuer=self.settings.effective_mcp_oauth_issuer_url,
                leeway=0,
                options={
                    "require": [
                        "aud",
                        "client_id",
                        "exp",
                        "iat",
                        "iss",
                        "sub",
                    ],
                    "verify_signature": True,
                    "verify_aud": True,
                    "verify_exp": True,
                    "verify_iat": True,
                    "verify_iss": True,
                    "verify_nbf": True,
                },
            )
        except PyJWTError:
            return None
        except Exception as error:
            logger.error(
                "MCP OAuth token decoding failed (%s)",
                type(error).__name__,
            )
            return None

        verified = _validate_oauth_claims(
            claims,
            issuer=self.settings.effective_mcp_oauth_issuer_url,
            audience=self.settings.mcp_oauth_audience,
        )
        if verified is None:
            return None
        owner_user_id, client_id, expires_at, scopes = verified

        try:
            agent = await anyio.to_thread.run_sync(
                partial(
                    self._binding_resolver.resolve_agent,
                    owner_user_id=owner_user_id,
                    client_id=client_id,
                    grant_id=claims["plurum_grant_id"],
                )
            )
        except Exception as error:
            logger.error(
                "MCP OAuth binding resolution failed (%s)",
                type(error).__name__,
            )
            return None

        agent_id = _canonical_uuid(agent.get("id")) if isinstance(agent, dict) else None
        if agent_id is None or agent.get("is_active") is not True:
            return None

        return AccessToken(
            token=token,
            client_id=client_id,
            scopes=scopes,
            expires_at=expires_at,
            resource=self.settings.mcp_oauth_audience,
            subject=owner_user_id,
            claims={
                MCP_AGENT_ID_CLAIM: agent_id,
                "iss": self.settings.effective_mcp_oauth_issuer_url,
                "auth_method": "oauth",
            },
        )


def _token_is_within_limit(value: object, *, max_bytes: int) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        return len(value.encode("utf-8")) <= max_bytes
    except UnicodeEncodeError:
        return False


def _opaque_text_within_limit(value: object, *, max_bytes: int) -> bool:
    if not isinstance(value, str) or not value or "\x00" in value:
        return False
    try:
        return len(value.encode("utf-8")) <= max_bytes
    except UnicodeEncodeError:
        return False


def _canonical_uuid(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = UUID(value)
    except ValueError:
        return None
    canonical = str(parsed)
    return canonical if value == canonical else None


def _validate_oauth_claims(
    claims: dict[str, Any],
    *,
    issuer: str,
    audience: str,
) -> tuple[str, str, int, list[str]] | None:
    if claims.get("iss") != issuer or claims.get("aud") != audience:
        return None

    expires_at = claims.get("exp")
    issued_at = claims.get("iat")
    not_before = claims.get("nbf")
    if not _is_integer_timestamp(expires_at) or not _is_integer_timestamp(issued_at):
        return None
    if not_before is not None and not _is_integer_timestamp(not_before):
        return None

    owner_user_id = _canonical_uuid(claims.get("sub"))
    if owner_user_id is None:
        return None
    if "user_id" in claims and claims.get("user_id") != owner_user_id:
        return None
    if _canonical_uuid(claims.get("plurum_grant_id")) is None:
        return None

    client_id = claims.get("client_id")
    if not _opaque_text_within_limit(
        client_id,
        max_bytes=MCP_OAUTH_CLIENT_ID_MAX_BYTES,
    ):
        return None

    scopes = _parse_scope(claims.get("scope"))
    if scopes is None:
        return None
    return owner_user_id, client_id, expires_at, scopes


def _parse_scope(value: object) -> list[str] | None:
    if value is None or value == "":
        return []
    if not isinstance(value, str):
        return None
    try:
        encoded = value.encode("ascii")
    except UnicodeEncodeError:
        return None
    if len(encoded) > _MAX_SCOPE_BYTES:
        return None

    scopes = value.split(" ")
    if any(
        not scope or not all(_scope_character_is_safe(character) for character in scope)
        for scope in scopes
    ):
        return None
    return scopes


def _scope_character_is_safe(character: str) -> bool:
    codepoint = ord(character)
    return codepoint == 0x21 or 0x23 <= codepoint <= 0x5B or 0x5D <= codepoint <= 0x7E


def _is_integer_timestamp(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)
