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


def test_log_event_respects_disabled_flag():
    with patch.object(event_repo, "get_supabase_client") as mock_client, \
         patch.object(event_repo, "get_settings",
                      return_value=MagicMock(events_enabled=False)):
        event_repo.log_event("search")
        mock_client.assert_not_called()
