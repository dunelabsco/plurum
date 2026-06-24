import re
from unittest.mock import MagicMock

from app.services.username_suggester import generate_candidates, normalize_username
from app.repositories.agent_repo import AgentRepository

USERNAME_RE = re.compile(r"^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$")


def test_candidates_all_valid_and_distinct():
    cands = generate_candidates(seed="hermes", count=6)
    assert len(cands) == 6
    assert len(set(cands)) == 6
    for c in cands:
        assert 3 <= len(c) <= 50
        assert USERNAME_RE.match(c), f"{c!r} violates username regex"


def test_candidates_seed_first():
    cands = generate_candidates(seed="hermes", count=6)
    assert cands[0] == "hermes"


def test_candidates_no_seed_still_valid():
    cands = generate_candidates(count=4)
    assert len(cands) == 4
    for c in cands:
        assert USERNAME_RE.match(c)


def test_normalize_username():
    assert normalize_username("  Hermes Bot!! ") == "hermes-bot"
    assert normalize_username("___") == ""
    assert normalize_username("A_b-9") == "a_b-9"


def test_find_taken_usernames_batches(mock_supabase):
    table = mock_supabase.table.return_value
    table.select.return_value.in_.return_value.execute.return_value = MagicMock(
        data=[{"username": "hermes"}, {"username": "swift-otter-12"}]
    )
    repo = AgentRepository()
    taken = repo.find_taken_usernames(["hermes", "Swift-Otter-12", "free-one-99"])
    assert taken == {"hermes", "swift-otter-12"}


def test_find_taken_usernames_empty_input_no_query():
    repo = AgentRepository()
    assert repo.find_taken_usernames([]) == set()


def test_check_username_available(client, mock_supabase):
    table = mock_supabase.table.return_value
    table.select.return_value.in_.return_value.execute.return_value = MagicMock(data=[])
    table.select.return_value.eq.return_value.execute.return_value = MagicMock(data=[])
    resp = client.get("/api/v1/agents/check-username", params={"username": "free-handle-9"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["available"] is True
    assert body["suggestions"] == []


def test_check_username_taken_returns_suggestions(client, mock_supabase):
    table = mock_supabase.table.return_value
    table.select.return_value.eq.return_value.execute.return_value = MagicMock(
        data=[{"id": "00000000-0000-0000-0000-000000000001"}]
    )
    table.select.return_value.in_.return_value.execute.return_value = MagicMock(data=[])
    resp = client.get("/api/v1/agents/check-username", params={"username": "hermes"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["available"] is False
    assert len(body["suggestions"]) >= 1
    assert "hermes" not in body["suggestions"]


def test_check_username_invalid_format(client, mock_supabase):
    table = mock_supabase.table.return_value
    table.select.return_value.in_.return_value.execute.return_value = MagicMock(data=[])
    resp = client.get("/api/v1/agents/check-username", params={"username": "no"})
    assert resp.status_code == 200
    assert resp.json()["available"] is False
