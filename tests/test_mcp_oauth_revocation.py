"""Disconnect orchestration and cryptography; provider/SQL live replay is a canary gate."""

from copy import deepcopy
from unittest.mock import MagicMock, patch
from uuid import UUID, uuid4

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from app.core.exceptions import PlurimException, ValidationError
from app.mcp.auth import MCPRequestCredentialGuard
from app.mcp.token_verifier import PlurumMCPTokenVerifier
from app.models.mcp_oauth import MCPOAuthDisconnectResult
from app.repositories.mcp_oauth_binding_repo import MCPOAuthBindingRepository
from app.services.mcp_oauth_binding_service import MCPOAuthBindingService
from app.services.mcp_oauth_grant_service import MCPOAuthGrantService, SupabaseOAuthGrants
from tests.test_mcp_oauth_bindings import OWNER_ID, OTHER_OWNER_ID, AGENT_ID, GRANT_ID
from tests.test_mcp_oauth_onboarding import _client as api_client
from tests.test_mcp_oauth_verifier import _settings, _claims, StaticSigningKeyClient
from tests.test_mcp_operational_transport import _invoke_asgi, _scope, _response

CLIENT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
OTHER_CLIENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
USER_TOKEN = "synthetic-user-session-for-revocation-tests"


class StateStore:
    """Stateful RPC double for exercising failures across operation boundaries."""

    def __init__(self):
        self.rows = {
            (OWNER_ID, CLIENT_ID): {
                "owner_user_id": OWNER_ID,
                "client_id": CLIENT_ID,
                "agent_id": AGENT_ID,
                "grant_id": GRANT_ID,
                "state": "active",
                "revoked_grant_id": None,
            }
        }
        self.fail_begin = self.fail_finish = False
        self.in_flight = False

    def get(self, *, owner_user_id, client_id):
        return deepcopy(self.rows.get((owner_user_id, client_id)))

    def list_by_owner(self, owner):
        return [deepcopy(row) for (user, _), row in self.rows.items() if user == owner]

    def begin_revocation(self, *, owner_user_id, client_id, expected_grant_id):
        if self.fail_begin:
            raise PlurimException("database unavailable")
        key = (owner_user_id, client_id)
        row = self.rows.get(key)
        if (
            row
            and row["grant_id"] != expected_grant_id
            and not (
                row["state"] in ("revoking", "revoked")
                and row["revoked_grant_id"] == expected_grant_id
            )
        ):
            raise PlurimException("connection changed", status_code=409)
        if self.in_flight:
            return {"claimed": False}
        if row is None:
            row = self.rows[key] = {
                "owner_user_id": owner_user_id,
                "client_id": client_id,
                "agent_id": None,
                "grant_id": str(uuid4()),
                "state": "revoking",
                "revoked_grant_id": None,
            }
        if row["state"] == "active":
            row["revoked_grant_id"] = row["grant_id"]
            row["grant_id"] = str(uuid4())
        row["state"] = "revoking"
        row["attempt_id"] = str(uuid4())
        return {"claimed": True, "attempt_id": row["attempt_id"]}

    def finish_revocation(self, *, owner_user_id, client_id, attempt_id, succeeded):
        if self.fail_finish:
            raise RuntimeError(USER_TOKEN)
        row = self.rows[(owner_user_id, client_id)]
        if row["attempt_id"] != attempt_id:
            return False
        row["state"] = "revoked" if succeeded else "revoking"
        if succeeded:
            row["agent_id"] = None
        return True


class GrantProvider:
    def __init__(self, store):
        self.store = store
        self.grants = {CLIENT_ID: "Codex", OTHER_CLIENT: "another app"}
        self.deletes = []
        self.failure = None

    def list_grants(self, token):
        assert token == USER_TOKEN
        if self.failure == "list":
            raise RuntimeError(USER_TOKEN)
        return self.grants.copy()

    def revoke_grant(self, token, client_id):
        assert token == USER_TOKEN
        assert self.store.rows[(OWNER_ID, client_id)]["state"] == "revoking"
        self.deletes.append(client_id)
        if self.failure == "before":
            raise TimeoutError(USER_TOKEN)
        if client_id not in self.grants:
            raise PlurimException("No active grant found", status_code=404)
        self.grants.pop(client_id)
        if self.failure == "after":
            raise TimeoutError(USER_TOKEN)


@pytest.fixture
def setup():
    store = StateStore()
    provider = GrantProvider(store)
    agents = MagicMock()
    agent = {
        "id": AGENT_ID,
        "owner_user_id": OWNER_ID,
        "is_active": True,
        "name": "my agent",
        "username": "my-agent",
        "api_key_hash": "private-hash",
    }
    agents.get_by_id.return_value = agent
    agents.list_by_owner.return_value = [agent]
    service = MCPOAuthGrantService(bindings=store, agents=agents, provider=provider)
    return store, provider, agents, service


def disconnect(service, *, client=CLIENT_ID, grant=GRANT_ID):
    return service.disconnect(
        owner_user_id=OWNER_ID, client_id=client, expected_grant_id=grant, user_token=USER_TOKEN
    )


def test_disconnect_blocks_first_revokes_exact_client_and_is_repeatable(setup):
    store, provider, _, service = setup
    other = deepcopy(store.rows[(OWNER_ID, CLIENT_ID)])
    other.update(client_id=OTHER_CLIENT)
    store.rows[(OWNER_ID, OTHER_CLIENT)] = deepcopy(other)
    store.rows[(OTHER_OWNER_ID, CLIENT_ID)] = {**other, "owner_user_id": OTHER_OWNER_ID}
    untouched = deepcopy(store.rows[(OTHER_OWNER_ID, CLIENT_ID)])
    assert disconnect(service).state == "disconnected"
    assert disconnect(service).state == "disconnected"
    assert provider.deletes == [CLIENT_ID]
    assert OTHER_CLIENT in provider.grants
    assert store.rows[(OWNER_ID, OTHER_CLIENT)] == other
    assert store.rows[(OTHER_OWNER_ID, CLIENT_ID)] == untouched
    assert store.rows[(OWNER_ID, CLIENT_ID)]["state"] == "revoked"


@pytest.mark.parametrize("missing", ["grant", "binding", "both"])
def test_disconnect_handles_missing_records(setup, missing):
    store, provider, _, service = setup
    if missing in ("grant", "both"):
        provider.grants.pop(CLIENT_ID)
    if missing in ("binding", "both"):
        store.rows.clear()
    assert (
        disconnect(service, grant=None if missing != "grant" else GRANT_ID).state == "disconnected"
    )


@pytest.mark.parametrize("failure", ["before", "after", "list"])
def test_provider_failure_keeps_access_blocked_and_retry_finishes(setup, failure, caplog):
    store, provider, _, service = setup
    provider.failure = failure
    assert disconnect(service).state == "revocation_pending"
    assert store.rows[(OWNER_ID, CLIENT_ID)]["state"] == "revoking"
    assert USER_TOKEN not in caplog.text
    provider.failure = None
    assert disconnect(service).state == "disconnected"


def test_provider_success_database_completion_failure_is_retryable(setup, caplog):
    store, provider, _, service = setup
    store.fail_finish = True
    assert disconnect(service).state == "revocation_pending"
    assert CLIENT_ID not in provider.grants
    assert store.rows[(OWNER_ID, CLIENT_ID)]["state"] == "revoking"
    assert USER_TOKEN not in caplog.text
    store.fail_finish = False
    assert disconnect(service).state == "disconnected"


def test_database_begin_failure_never_calls_provider_revoke(setup):
    store, provider, _, service = setup
    store.fail_begin = True
    with pytest.raises(PlurimException):
        disconnect(service)
    assert provider.deletes == []
    assert store.rows[(OWNER_ID, CLIENT_ID)]["state"] == "active"


def test_in_flight_revocation_does_not_start_a_second_provider_call(setup):
    store, provider, _, service = setup
    store.in_flight = True
    store.rows[(OWNER_ID, CLIENT_ID)]["state"] = "revoking"
    assert disconnect(service).state == "revocation_pending"
    assert provider.deletes == []


def test_stale_disconnect_cannot_revoke_a_new_connection(setup):
    store, provider, _, service = setup
    store.rows[(OWNER_ID, CLIENT_ID)]["grant_id"] = str(uuid4())
    with pytest.raises(PlurimException) as error:
        disconnect(service)
    assert error.value.status_code == 409
    assert provider.deletes == []


@pytest.mark.parametrize("client", ["", "x" * 2049, "é" * 1025, "bad\x00id", "bad\nid", USER_TOKEN])
def test_bad_identifiers_never_reach_provider(setup, client, caplog):
    _, provider, _, service = setup
    with pytest.raises(ValidationError):
        disconnect(service, client=client)
    assert provider.deletes == []
    assert USER_TOKEN not in caplog.text


def test_listing_uses_only_owned_agents_and_safe_fields(setup):
    store, _, agents, service = setup
    connections = service.list_connections(owner_user_id=OWNER_ID, user_token=USER_TOKEN)
    chosen = next(c for c in connections if c.client_id == CLIENT_ID)
    assert chosen.agent_id == UUID(AGENT_ID)
    assert chosen.state == "connected"
    assert "api_key" not in chosen.model_dump_json()
    agents.list_by_owner.return_value[0]["owner_user_id"] = OTHER_OWNER_ID
    chosen = service.list_connections(owner_user_id=OWNER_ID, user_token=USER_TOKEN)[0]
    assert chosen.agent_id is None and chosen.agent_name is None
    assert chosen.state == "unbound"
    store.rows[(OWNER_ID, CLIENT_ID)]["state"] = "revoking"
    assert (
        service.list_connections(owner_user_id=OWNER_ID, user_token=USER_TOKEN)[0].state
        == "revocation_pending"
    )


def test_inactive_agent_does_not_prevent_disconnect(setup):
    _, _, agents, service = setup
    agents.list_by_owner.return_value[0]["is_active"] = False
    assert (
        service.list_connections(owner_user_id=OWNER_ID, user_token=USER_TOKEN)[0].agent_active
        is False
    )
    assert disconnect(service).state == "disconnected"


@pytest.mark.asyncio
async def test_old_signed_token_stays_rejected_after_reconnection(setup):
    store, _, agents, service = setup
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    binding_service = MCPOAuthBindingService(store, agents)
    verifier = PlurumMCPTokenVerifier(
        settings=_settings(),
        binding_resolver=binding_service,
        jwk_client=StaticSigningKeyClient(key.public_key()),
    )
    claims = _claims(sub=OWNER_ID, user_id=OWNER_ID, client_id=CLIENT_ID, plurum_grant_id=GRANT_ID)
    old = jwt.encode(claims, key, algorithm="RS256", headers={"kid": "test"})
    assert await verifier.verify_token(old) is not None
    assert disconnect(service).state == "disconnected"
    assert await verifier.verify_token(old) is None
    row = store.rows[(OWNER_ID, CLIENT_ID)]
    row.update(state="active", agent_id=AGENT_ID, grant_id=str(uuid4()))
    assert await verifier.verify_token(old) is None
    fresh = jwt.encode(
        {**claims, "plurum_grant_id": row["grant_id"]},
        key,
        algorithm="RS256",
        headers={"kid": "test"},
    )
    assert await verifier.verify_token(fresh) is not None


def test_provider_adapter_uses_verified_wire_contract_and_user_token():
    observed = []

    def provider(request):
        observed.append(request)
        assert request.headers["authorization"] == f"Bearer {USER_TOKEN}"
        assert request.url.path == "/auth/v1/user/oauth/grants"
        if request.method == "GET":
            return httpx.Response(
                200,
                json=[
                    {
                        "client": {"id": CLIENT_ID, "name": "Codex", "secret": "not-returned"},
                        "refresh_token": "not-returned",
                    }
                ],
            )
        assert request.method == "DELETE"
        assert dict(request.url.params) == {"client_id": CLIENT_ID}
        return httpx.Response(204)

    with httpx.Client(transport=httpx.MockTransport(provider)) as client:
        adapter = SupabaseOAuthGrants(settings=_settings(), client=client)
        assert adapter.list_grants(USER_TOKEN) == {CLIENT_ID: "Codex"}
        adapter.revoke_grant(USER_TOKEN, CLIENT_ID)
    assert len(observed) == 2


@pytest.mark.parametrize("status", [302, 400, 401, 404, 429, 500])
def test_provider_errors_never_count_as_revocation_or_reflect_diagnostics(status, caplog):
    with httpx.Client(
        transport=httpx.MockTransport(lambda _: httpx.Response(status, text=USER_TOKEN))
    ) as client:
        adapter = SupabaseOAuthGrants(settings=_settings(), client=client)
        with pytest.raises(PlurimException) as error:
            adapter.revoke_grant(USER_TOKEN, CLIENT_ID)
    assert USER_TOKEN not in str(error.value)
    assert USER_TOKEN not in caplog.text


@pytest.mark.parametrize("payload", [{}, [{"client": {}}], [{"client": {"id": CLIENT_ID}}] * 2])
def test_provider_listing_rejects_malformed_or_duplicate_grants(payload):
    with httpx.Client(
        transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload))
    ) as client:
        with pytest.raises(PlurimException):
            SupabaseOAuthGrants(settings=_settings(), client=client).list_grants(USER_TOKEN)


@pytest.mark.parametrize(
    "name", [USER_TOKEN, "app eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2ln", "bad\x7fname"]
)
def test_provider_client_names_cannot_reflect_credentials(name):
    with httpx.Client(
        transport=httpx.MockTransport(
            lambda _: httpx.Response(200, json=[{"client": {"id": CLIENT_ID, "name": name}}])
        )
    ) as client:
        assert SupabaseOAuthGrants(settings=_settings(), client=client).list_grants(USER_TOKEN) == {
            CLIENT_ID: None
        }


@pytest.mark.parametrize("state,status", [("disconnected", 200), ("revocation_pending", 202)])
def test_disconnect_route_uses_exact_human_identity_and_sanitized_telemetry(state, status):
    with patch("app.api.v1.mcp_oauth.MCPOAuthGrantService") as factory, patch(
        "app.api.v1.mcp_oauth.log_event"
    ) as event, api_client(oauth_enabled=True, authenticated=True) as client:
        factory.return_value.disconnect.return_value = MCPOAuthDisconnectResult(state=state)
        response = client.post(
            "/api/v1/mcp/oauth/disconnect",
            json={"client_id": CLIENT_ID, "expected_grant_id": GRANT_ID},
            headers={"Authorization": f"Bearer {USER_TOKEN}"},
        )
    assert response.status_code == status
    factory.return_value.disconnect.assert_called_once_with(
        owner_user_id=OWNER_ID,
        client_id=CLIENT_ID,
        expected_grant_id=GRANT_ID,
        user_token=USER_TOKEN,
    )
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["referrer-policy"] == "no-referrer"
    event.assert_called_once_with("mcp_oauth_disconnect", metadata={"state": state})
    assert USER_TOKEN not in response.text


@pytest.mark.parametrize(
    "extra",
    [
        {"owner_user_id": OTHER_OWNER_ID},
        {"client_id": "x" * 2049},
        {"expected_grant_id": USER_TOKEN},
    ],
)
def test_disconnect_route_rejects_untrusted_fields_without_echoing_them(extra):
    with api_client(oauth_enabled=True, authenticated=True) as client:
        response = client.post(
            "/api/v1/mcp/oauth/disconnect",
            json={"client_id": CLIENT_ID, "expected_grant_id": GRANT_ID, **extra},
            headers={"Authorization": f"Bearer {USER_TOKEN}"},
        )
    assert response.status_code == 422
    assert USER_TOKEN not in response.text and OTHER_OWNER_ID not in response.text
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize(
    "path,method", [("connections", "get"), ("disconnect", "post"), ("binding-state", "post")]
)
def test_management_routes_require_auth_and_remain_disabled(path, method):
    with api_client(oauth_enabled=False) as client:
        assert getattr(client, method)(f"/api/v1/mcp/oauth/{path}").status_code == 404
    with api_client(oauth_enabled=True) as client:
        response = getattr(client, method)(
            f"/api/v1/mcp/oauth/{path}", headers={"Authorization": "Bearer plrm_live_not-human"}
        )
        assert response.status_code == 401


@pytest.mark.asyncio
@pytest.mark.parametrize("surround", ["", "prefix-"])
async def test_oauth_bearer_in_json_rpc_id_is_never_reflected(surround):
    import json

    async def downstream(*_):
        pytest.fail("secret-bearing request reached tools")

    payload = {"jsonrpc": "2.0", "id": surround + USER_TOKEN, "method": "tools/list"}
    sent = await _invoke_asgi(
        MCPRequestCredentialGuard(downstream),
        _scope(
            method="POST",
            path="/mcp",
            headers=[(b"authorization", f"Bearer {USER_TOKEN}".encode())],
        ),
        [{"type": "http.request", "body": json.dumps(payload).encode(), "more_body": False}],
    )
    status, _, body = _response(sent)
    assert status == 200 and json.loads(body)["id"] is None
    assert USER_TOKEN.encode() not in body


@pytest.mark.parametrize("code,status", [("40001", 409), ("42501", 403)])
def test_database_race_and_owner_rejections_are_sanitized(code, status, caplog):
    error = RuntimeError(USER_TOKEN)
    error.code = code
    client = MagicMock()
    client.rpc.side_effect = error
    with pytest.raises(PlurimException) as caught:
        MCPOAuthBindingRepository(client).begin_revocation(
            owner_user_id=OWNER_ID, client_id=CLIENT_ID, expected_grant_id=GRANT_ID
        )
    assert caught.value.status_code == status
    assert USER_TOKEN not in str(caught.value) and USER_TOKEN not in caplog.text
