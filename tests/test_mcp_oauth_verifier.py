"""Local cryptographic tests for the hosted MCP hybrid token verifier."""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from jwt.algorithms import RSAAlgorithm
from jwt.exceptions import (
    PyJWKClientConnectionError,
    PyJWKClientError,
)

from app.config import Settings
from app.core.exceptions import AuthenticationError
from app.mcp.token_verifier import PlurumMCPTokenVerifier, _BoundedPyJWKClient


OWNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
CLIENT_ID = "https://codex.example/oauth/client-A"
ISSUER = "https://project.supabase.co/auth/v1"
AUDIENCE = "https://mcp.plurum.ai/mcp"


class StaticSigningKeyClient:
    def __init__(self, key):
        self.key = key
        self.calls: list[str] = []
        self.thread_ids: list[int] = []

    def get_signing_key_from_jwt(self, token: str):
        self.calls.append(token)
        self.thread_ids.append(threading.get_ident())
        return SimpleNamespace(key=self.key)


class StubBindingResolver:
    def __init__(self, result=None, error: Exception | None = None):
        self.result = result
        self.error = error
        self.calls: list[tuple[str, str]] = []
        self.thread_ids: list[int] = []

    def resolve_agent(self, *, owner_user_id: str, client_id: str):
        self.calls.append((owner_user_id, client_id))
        self.thread_ids.append(threading.get_ident())
        if self.error is not None:
            raise self.error
        return self.result


@pytest.fixture(scope="module")
def rsa_private_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture(scope="module")
def other_rsa_private_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture(scope="module")
def ec_private_key():
    return ec.generate_private_key(ec.SECP256R1())


def _settings(**overrides) -> Settings:
    values = {
        "environment": "production",
        "supabase_url": "https://project.supabase.co",
        "supabase_db_url": "postgresql://localhost/test",
        "supabase_key": "test-key",
        "openai_api_key": "test-key",
        "mcp_oauth_enabled": True,
    }
    values.update(overrides)
    return Settings(**values)


def _claims(**overrides) -> dict:
    now = int(time.time())
    values = {
        "iss": ISSUER,
        "aud": AUDIENCE,
        "exp": now + 300,
        "iat": now,
        "sub": OWNER_ID,
        "user_id": OWNER_ID,
        "client_id": CLIENT_ID,
        "scope": "openid profile",
    }
    values.update(overrides)
    return values


def _signed_token(private_key, claims=None, *, algorithm="RS256", kid="test-key"):
    return jwt.encode(
        claims if claims is not None else _claims(),
        private_key,
        algorithm=algorithm,
        headers={"kid": kid},
    )


def _public_jwk(public_key, *, kid: str) -> dict:
    jwk = RSAAlgorithm.to_jwk(public_key, as_dict=True)
    jwk.update({"alg": "RS256", "kid": kid, "use": "sig"})
    return jwk


def _local_jwk_client(monkeypatch, *, clock, document, cache_size=256):
    client = _BoundedPyJWKClient(
        f"{ISSUER}/.well-known/jwks.json",
        cache_keys=False,
        cache_jwk_set=True,
        lifespan=300,
        timeout=5,
        refresh_cooldown_seconds=30,
        unknown_kid_cache_seconds=60,
        unknown_kid_cache_size=cache_size,
        clock=lambda: clock[0],
    )
    fetches: list[dict] = []

    def fetch_data():
        data = document[0]
        fetches.append(data)
        client.jwk_set_cache.put(data)
        return data

    monkeypatch.setattr(client, "fetch_data", fetch_data)
    return client, fetches


def _oauth_verifier(
    public_key,
    *,
    settings=None,
    binding_resolver=None,
    signing_key_client=None,
):
    resolver = binding_resolver or StubBindingResolver({"id": AGENT_ID, "is_active": True})
    signing_client = signing_key_client or StaticSigningKeyClient(public_key)
    verifier = PlurumMCPTokenVerifier(
        settings=settings or _settings(),
        api_key_validator=lambda _token: None,
        binding_resolver=resolver,
        jwk_client=signing_client,
    )
    return verifier, resolver, signing_client


@pytest.mark.asyncio
async def test_prefixed_api_key_is_validated_in_worker_thread():
    caller_thread = threading.get_ident()
    validator_threads = []

    def validate(token):
        validator_threads.append(threading.get_ident())
        assert token == "plrm_live_temporary"
        return {"id": AGENT_ID, "is_active": True}

    verifier = PlurumMCPTokenVerifier(
        settings=_settings(mcp_oauth_enabled=False),
        api_key_validator=validate,
        binding_resolver=StubBindingResolver(),
        jwk_client=StaticSigningKeyClient(object()),
    )

    access_token = await verifier.verify_token("plrm_live_temporary")

    assert access_token is not None
    assert validator_threads and validator_threads[0] != caller_thread
    assert access_token.client_id == f"plurum-api-key:{AGENT_ID}"
    assert access_token.subject == AGENT_ID
    assert access_token.resource == AUDIENCE
    assert access_token.claims == {
        "plurum_agent_id": AGENT_ID,
        "iss": "plurum-api-key",
        "auth_method": "api_key",
    }


@pytest.mark.asyncio
async def test_bearer_size_is_checked_before_any_lookup():
    api_calls = []
    resolver = StubBindingResolver({"id": AGENT_ID, "is_active": True})
    signing_client = StaticSigningKeyClient(object())
    verifier = PlurumMCPTokenVerifier(
        settings=_settings(),
        api_key_validator=lambda token: api_calls.append(token),
        binding_resolver=resolver,
        jwk_client=signing_client,
    )
    oversized = "plrm_live_" + ("é" * 4096)

    assert await verifier.verify_token(oversized) is None
    assert api_calls == []
    assert resolver.calls == []
    assert signing_client.calls == []


@pytest.mark.asyncio
async def test_api_key_failures_are_sanitized_and_fail_closed(caplog):
    secret = "plrm_live_do-not-log-me"

    def fail(_token):
        raise RuntimeError(f"database failed for {secret}")

    verifier = PlurumMCPTokenVerifier(
        settings=_settings(),
        api_key_validator=fail,
        binding_resolver=StubBindingResolver(),
        jwk_client=StaticSigningKeyClient(object()),
    )

    assert await verifier.verify_token(secret) is None
    assert secret not in caplog.text
    assert "RuntimeError" in caplog.text


@pytest.mark.asyncio
async def test_expected_invalid_api_key_is_silent(caplog):
    def reject(_token):
        raise AuthenticationError()

    verifier = PlurumMCPTokenVerifier(
        settings=_settings(),
        api_key_validator=reject,
        binding_resolver=StubBindingResolver(),
        jwk_client=StaticSigningKeyClient(object()),
    )

    assert await verifier.verify_token("plrm_live_invalid") is None
    assert caplog.text == ""


@pytest.mark.asyncio
async def test_oauth_jwt_is_rejected_without_feature_flag(rsa_private_key):
    signing_client = StaticSigningKeyClient(rsa_private_key.public_key())
    verifier = PlurumMCPTokenVerifier(
        settings=_settings(mcp_oauth_enabled=False),
        binding_resolver=StubBindingResolver(),
        jwk_client=signing_client,
    )

    assert await verifier.verify_token(_signed_token(rsa_private_key)) is None
    assert signing_client.calls == []


@pytest.mark.asyncio
async def test_valid_rs256_oauth_token_resolves_exact_binding_each_time(
    rsa_private_key,
):
    caller_thread = threading.get_ident()
    verifier, resolver, signing_client = _oauth_verifier(rsa_private_key.public_key())
    claims = _claims()
    token = _signed_token(rsa_private_key, claims)

    first = await verifier.verify_token(token)
    second = await verifier.verify_token(token)

    assert first is not None and second is not None
    assert resolver.calls == [(OWNER_ID, CLIENT_ID), (OWNER_ID, CLIENT_ID)]
    assert all(thread_id != caller_thread for thread_id in resolver.thread_ids)
    assert all(thread_id != caller_thread for thread_id in signing_client.thread_ids)
    assert first.client_id == CLIENT_ID
    assert first.subject == OWNER_ID
    assert first.expires_at == claims["exp"]
    assert first.scopes == ["openid", "profile"]
    assert first.claims == {
        "plurum_agent_id": AGENT_ID,
        "iss": ISSUER,
        "auth_method": "oauth",
    }


@pytest.mark.asyncio
async def test_valid_es256_oauth_token_is_supported(ec_private_key):
    verifier, resolver, _ = _oauth_verifier(ec_private_key.public_key())

    access_token = await verifier.verify_token(_signed_token(ec_private_key, algorithm="ES256"))

    assert access_token is not None
    assert resolver.calls == [(OWNER_ID, CLIENT_ID)]


@pytest.mark.asyncio
async def test_symmetric_algorithm_is_rejected_before_key_lookup():
    signing_client = StaticSigningKeyClient(object())
    verifier, resolver, _ = _oauth_verifier(object(), signing_key_client=signing_client)
    token = _signed_token("a" * 32, algorithm="HS256")

    assert await verifier.verify_token(token) is None
    assert signing_client.calls == []
    assert resolver.calls == []


@pytest.mark.asyncio
async def test_invalid_signature_is_rejected_before_binding(
    rsa_private_key,
    other_rsa_private_key,
):
    verifier, resolver, _ = _oauth_verifier(rsa_private_key.public_key())

    assert await verifier.verify_token(_signed_token(other_rsa_private_key)) is None
    assert resolver.calls == []


def _without(claim: str):
    claims = _claims()
    claims.pop(claim)
    return claims


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "claims",
    [
        _without("exp"),
        _without("iat"),
        _without("sub"),
        _without("client_id"),
        _claims(iss="https://attacker.example/auth/v1"),
        _claims(aud="https://api.plurum.ai/mcp"),
        _claims(aud=[AUDIENCE]),
        _claims(exp=int(time.time()) - 1),
        _claims(exp=float(int(time.time()) + 300)),
        _claims(iat=float(int(time.time()))),
        _claims(iat=int(time.time()) + 60),
        _claims(nbf=int(time.time()) + 60),
        _claims(nbf="tomorrow"),
        _claims(sub=OWNER_ID.upper(), user_id=OWNER_ID.upper()),
        _claims(user_id="cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
        _claims(client_id=""),
        _claims(client_id="é" * 1025),
        _claims(client_id="client\x00id"),
        _claims(scope=["openid"]),
        _claims(scope="openid  profile"),
        _claims(scope='openid "profile"'),
        _claims(scope="openid pröfile"),
    ],
)
async def test_invalid_oauth_claims_fail_before_binding(rsa_private_key, claims):
    verifier, resolver, _ = _oauth_verifier(rsa_private_key.public_key())

    assert await verifier.verify_token(_signed_token(rsa_private_key, claims)) is None
    assert resolver.calls == []


@pytest.mark.asyncio
async def test_missing_scope_is_valid_and_maps_to_empty_scope_list(rsa_private_key):
    claims = _claims()
    claims.pop("scope")
    verifier, _, _ = _oauth_verifier(rsa_private_key.public_key())

    access_token = await verifier.verify_token(_signed_token(rsa_private_key, claims))

    assert access_token is not None
    assert access_token.scopes == []


@pytest.mark.asyncio
async def test_unbound_or_inactive_agent_is_rejected(rsa_private_key):
    token = _signed_token(rsa_private_key)
    for result in (None, {"id": AGENT_ID, "is_active": False}):
        resolver = StubBindingResolver(result)
        verifier, _, _ = _oauth_verifier(
            rsa_private_key.public_key(),
            binding_resolver=resolver,
        )

        assert await verifier.verify_token(token) is None


@pytest.mark.asyncio
async def test_binding_failures_are_sanitized_and_fail_closed(
    rsa_private_key,
    caplog,
):
    secret = "binding-secret"
    resolver = StubBindingResolver(error=RuntimeError(f"failed for {secret}"))
    verifier, _, _ = _oauth_verifier(rsa_private_key.public_key(), binding_resolver=resolver)

    assert await verifier.verify_token(_signed_token(rsa_private_key)) is None
    assert secret not in caplog.text
    assert "RuntimeError" in caplog.text


@pytest.mark.asyncio
async def test_jwks_connection_errors_are_sanitized(
    rsa_private_key,
    caplog,
):
    token = _signed_token(rsa_private_key)

    class FailingClient:
        def get_signing_key_from_jwt(self, _token):
            raise PyJWKClientConnectionError(f"network error for {token}")

    verifier, resolver, _ = _oauth_verifier(
        rsa_private_key.public_key(), signing_key_client=FailingClient()
    )

    assert await verifier.verify_token(token) is None
    assert token not in caplog.text
    assert "PyJWKClientConnectionError" in caplog.text
    assert resolver.calls == []


def test_unknown_kids_share_one_refresh_window_and_bounded_negative_cache(
    monkeypatch,
    rsa_private_key,
):
    clock = [100.0]
    document = [{"keys": [_public_jwk(rsa_private_key.public_key(), kid="active-key")]}]
    client, fetches = _local_jwk_client(
        monkeypatch,
        clock=clock,
        document=document,
        cache_size=3,
    )

    for index in range(20):
        with pytest.raises(PyJWKClientError):
            client.get_signing_key(f"attacker-key-{index}")

    assert len(fetches) == 1
    assert len(client._unknown_kids) == 3

    clock[0] += 31
    with pytest.raises(PyJWKClientError):
        client.get_signing_key("attacker-key-after-cooldown")

    assert len(fetches) == 2


@pytest.mark.asyncio
async def test_unknown_kid_is_rejected_without_logging_attacker_input(
    monkeypatch,
    rsa_private_key,
    other_rsa_private_key,
    caplog,
):
    clock = [100.0]
    document = [{"keys": [_public_jwk(other_rsa_private_key.public_key(), kid="active-key")]}]
    client, _ = _local_jwk_client(
        monkeypatch,
        clock=clock,
        document=document,
    )
    verifier, resolver, _ = _oauth_verifier(
        rsa_private_key.public_key(),
        signing_key_client=client,
    )
    attacker_kid = "private-attacker-kid"

    assert await verifier.verify_token(_signed_token(rsa_private_key, kid=attacker_kid)) is None
    assert resolver.calls == []
    assert attacker_kid not in caplog.text
    assert caplog.text == ""


def test_unknown_kid_refresh_is_single_flight_across_threads(
    monkeypatch,
    rsa_private_key,
):
    clock = [100.0]
    document = [{"keys": [_public_jwk(rsa_private_key.public_key(), kid="active-key")]}]
    client, fetches = _local_jwk_client(
        monkeypatch,
        clock=clock,
        document=document,
    )
    assert client.get_signing_key("active-key").key is not None
    clock[0] += 31

    original_fetch = client.fetch_data

    def slow_fetch():
        time.sleep(0.02)
        return original_fetch()

    monkeypatch.setattr(client, "fetch_data", slow_fetch)
    ready = threading.Barrier(8)

    def lookup(index: int) -> None:
        ready.wait()
        with pytest.raises(PyJWKClientError):
            client.get_signing_key(f"concurrent-attacker-key-{index}")

    with ThreadPoolExecutor(max_workers=8) as executor:
        list(executor.map(lookup, range(8)))

    assert len(fetches) == 2


def test_new_rotated_kid_is_accepted_after_bounded_refresh_cooldown(
    monkeypatch,
    rsa_private_key,
    other_rsa_private_key,
):
    clock = [100.0]
    old_jwk = _public_jwk(rsa_private_key.public_key(), kid="old-key")
    new_jwk = _public_jwk(other_rsa_private_key.public_key(), kid="new-key")
    document = [{"keys": [old_jwk]}]
    client, fetches = _local_jwk_client(
        monkeypatch,
        clock=clock,
        document=document,
    )

    assert client.get_signing_key("old-key").key is not None
    with pytest.raises(PyJWKClientError):
        client.get_signing_key("new-key")

    document[0] = {"keys": [old_jwk, new_jwk]}
    clock[0] += 31

    assert client.get_signing_key("new-key").key is not None
    assert len(fetches) == 2


def test_jwks_outage_is_throttled_after_first_sanitized_failure(
    monkeypatch,
):
    clock = [100.0]
    client = _BoundedPyJWKClient(
        f"{ISSUER}/.well-known/jwks.json",
        cache_keys=False,
        cache_jwk_set=True,
        lifespan=300,
        timeout=5,
        refresh_cooldown_seconds=30,
        clock=lambda: clock[0],
    )
    fetches = []

    def unavailable():
        fetches.append(True)
        raise PyJWKClientConnectionError("private upstream diagnostic")

    monkeypatch.setattr(client, "fetch_data", unavailable)

    with pytest.raises(PyJWKClientConnectionError):
        client.get_signing_key("first-key")
    with pytest.raises(PyJWKClientError) as exc_info:
        client.get_signing_key("second-key")

    assert len(fetches) == 1
    assert "private upstream diagnostic" not in str(exc_info.value)


def test_default_jwks_client_uses_fixed_supabase_endpoint_timeout_and_cache():
    verifier = PlurumMCPTokenVerifier(
        settings=_settings(),
        binding_resolver=StubBindingResolver(),
    )

    assert verifier.jwks_url == f"{ISSUER}/.well-known/jwks.json"
    assert verifier._jwk_client.uri == verifier.jwks_url
    assert verifier._jwk_client.timeout == 5
    assert verifier._jwk_client.jwk_set_cache.lifespan == 300
