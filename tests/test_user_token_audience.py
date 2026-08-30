"""Audience isolation tests for dashboard Supabase JWT authentication."""

from __future__ import annotations

import logging
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.core.exceptions import AuthenticationError
from app.core.security import get_current_user

NOW = 1_800_000_000
USER_ID = "11111111-2222-4333-8444-a55555555555"
SUPABASE_URL = "https://project.supabase.co"
WEB_ISSUER = f"{SUPABASE_URL}/auth/v1"
TOKEN = "signed-supabase-jwt"


def _claims(**overrides: object) -> dict[str, object]:
    claims: dict[str, object] = {
        "iss": WEB_ISSUER,
        "aud": "authenticated",
        "sub": USER_ID,
        "exp": NOW + 3600,
        "iat": NOW - 30,
    }
    claims.update(overrides)
    return claims


def _authenticate(claims_response: object) -> tuple[dict, MagicMock]:
    client = MagicMock()
    client.auth.get_claims.return_value = claims_response
    settings = SimpleNamespace(
        api_key_prefix="plrm_live_",
        supabase_url=f"{SUPABASE_URL}/",
    )

    with (
        patch("app.core.security.get_settings", return_value=settings),
        patch("app.db.supabase_client.get_supabase_client", return_value=client),
        patch("app.core.security.time.time", return_value=NOW),
    ):
        result = get_current_user(f"Bearer {TOKEN}")

    return result, client


def test_web_user_token_returns_only_canonical_identity() -> None:
    result, client = _authenticate({"claims": _claims()})

    assert result == {"id": USER_ID}
    client.auth.get_claims.assert_called_once_with(jwt=TOKEN)
    client.auth.get_user.assert_not_called()


@pytest.mark.parametrize(
    "claims",
    [
        _claims(iss="https://other.supabase.co/auth/v1"),
        _claims(iss=f"{WEB_ISSUER}/"),
        _claims(aud="https://mcp.plurum.ai/mcp"),
        _claims(aud=["authenticated"]),
        _claims(client_id="mcp-client"),
        _claims(client_id=None),
        _claims(sub="not-a-uuid"),
        _claims(sub=USER_ID.upper()),
        _claims(sub=None),
        _claims(exp=NOW - 61),
        _claims(exp=True),
        _claims(exp=None),
        _claims(iat=NOW + 61),
        _claims(iat=True),
        _claims(iat=None),
        _claims(iat=NOW + 3601),
        _claims(nbf=NOW + 61),
        _claims(nbf=True),
        _claims(nbf=NOW + 3601),
    ],
    ids=[
        "wrong-issuer",
        "nonexact-issuer",
        "mcp-audience",
        "audience-list",
        "client-id",
        "null-client-id",
        "malformed-subject",
        "noncanonical-subject",
        "missing-subject",
        "expired",
        "boolean-expiry",
        "missing-expiry",
        "future-issued-at",
        "boolean-issued-at",
        "missing-issued-at",
        "issued-after-expiry",
        "future-not-before",
        "boolean-not-before",
        "not-before-after-expiry",
    ],
)
def test_non_web_or_malformed_claims_are_rejected(claims: dict[str, object]) -> None:
    with pytest.raises(AuthenticationError) as exc_info:
        _authenticate({"claims": claims})

    assert exc_info.value.message == "Invalid or expired token"


@pytest.mark.parametrize(
    "claims",
    [
        _claims(exp=NOW - 60, iat=NOW - 3600),
        _claims(iat=NOW + 60, nbf=NOW + 60),
    ],
    ids=["expiry-skew", "issuance-and-not-before-skew"],
)
def test_numeric_dates_within_clock_skew_are_accepted(claims: dict[str, object]) -> None:
    result, _ = _authenticate({"claims": claims})

    assert result == {"id": USER_ID}


@pytest.mark.parametrize("claims_response", [None, {}, {"claims": None}])
def test_missing_verified_claims_are_rejected(claims_response: object) -> None:
    with pytest.raises(AuthenticationError) as exc_info:
        _authenticate(claims_response)

    assert exc_info.value.message == "Invalid or expired token"


def test_api_key_is_rejected_before_jwt_verification() -> None:
    client = MagicMock()
    settings = SimpleNamespace(api_key_prefix="plrm_live_", supabase_url=SUPABASE_URL)

    with (
        patch("app.core.security.get_settings", return_value=settings),
        patch("app.db.supabase_client.get_supabase_client", return_value=client),
        pytest.raises(AuthenticationError) as exc_info,
    ):
        get_current_user("Bearer plrm_live_not-a-user-token")

    assert exc_info.value.message == "Expected JWT token, got API key"
    client.auth.get_claims.assert_not_called()


def test_verifier_failure_logs_only_exception_type(caplog: pytest.LogCaptureFixture) -> None:
    client = MagicMock()
    client.auth.get_claims.side_effect = RuntimeError("secret-token-material")
    settings = SimpleNamespace(api_key_prefix="plrm_live_", supabase_url=SUPABASE_URL)

    with (
        patch("app.core.security.get_settings", return_value=settings),
        patch("app.db.supabase_client.get_supabase_client", return_value=client),
        caplog.at_level(logging.WARNING, logger="app.core.security"),
        pytest.raises(AuthenticationError) as exc_info,
    ):
        get_current_user(f"Bearer {TOKEN}")

    assert exc_info.value.message == "Invalid or expired token"
    assert "RuntimeError" in caplog.text
    assert "secret-token-material" not in caplog.text
    assert TOKEN not in caplog.text
