import logging
from unittest.mock import MagicMock, patch

from app.repositories import event_repo


def test_log_event_inserts_row():
    with patch.object(event_repo, "get_supabase_client") as mock_client:
        tbl = mock_client.return_value.table.return_value
        event_repo.log_event("search", agent_id="a1", query="hello",
                             metadata={"result_count": 3})
        row = tbl.insert.call_args[0][0]
        assert row["event_type"] == "search"
        assert row["agent_id"] == "a1"
        assert row["query"] == "hello"
        assert row["metadata"] == {"result_count": 3}
        tbl.insert.return_value.execute.assert_called_once()


def test_log_event_never_raises():
    # A failing client must not propagate — analytics is non-critical.
    with patch.object(event_repo, "get_supabase_client", side_effect=Exception("boom")):
        event_repo.log_event("search", agent_id="a1")  # no raise = pass


def test_log_event_swallows_settings_failure_without_reflecting_exception(caplog):
    secret = "plrm_live_event_settings_secret_123456789"
    caplog.set_level(logging.DEBUG, logger=event_repo.__name__)

    with patch.object(
        event_repo,
        "get_settings",
        side_effect=RuntimeError(f"provider included {secret}"),
    ):
        event_repo.log_event("search", agent_id="a1")

    assert "RuntimeError" in caplog.text
    assert secret not in caplog.text


def test_log_event_omits_detected_credentials_from_query_and_metadata():
    query_secret = "plrm_live_event_query_secret_123456789"
    metadata_secret = "sk-ant-abcdefghijklmnopqrstuvwxyz1234567890"

    with patch.object(event_repo, "get_supabase_client") as mock_client:
        table = mock_client.return_value.table.return_value
        event_repo.log_event(
            "search",
            agent_id="a1",
            query=f"debug {query_secret}",
            metadata={
                "channel": "mcp",
                "client": "codex",
                "nested": {"token": metadata_secret},
            },
        )

    row = table.insert.call_args.args[0]
    assert "query" not in row
    assert row["metadata"] == {"channel": "mcp", "client": "codex"}
    assert query_secret not in str(row)
    assert metadata_secret not in str(row)


def test_log_event_caps_stored_query_length():
    with patch.object(event_repo, "get_supabase_client") as mock_client:
        table = mock_client.return_value.table.return_value
        event_repo.log_event("search", query="q" * 2500)

    assert table.insert.call_args.args[0]["query"] == "q" * 2000


def test_log_event_respects_disabled_flag():
    with patch.object(event_repo, "get_supabase_client") as mock_client, \
         patch.object(event_repo, "get_settings",
                      return_value=MagicMock(events_enabled=False)):
        event_repo.log_event("search")
        mock_client.assert_not_called()
