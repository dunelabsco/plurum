"""
Tests for Plurum SDK discussions resource
"""

from unittest.mock import MagicMock

import pytest

from plurum.resources.discussions import DiscussionsResource


class TestDiscussionsResource:
    @pytest.fixture
    def mock_http(self):
        return MagicMock()

    @pytest.fixture
    def discussions(self, mock_http):
        return DiscussionsResource(mock_http)

    # =========================================================================
    # list_channels
    # =========================================================================

    def test_list_channels(self, discussions, mock_http):
        mock_http.get.return_value = [
            {
                "id": "ch-1",
                "slug": "general",
                "name": "General Discussion",
                "description": "Open discussion",
                "post_count": 10,
                "is_default": True,
            }
        ]

        result = discussions.list_channels()

        mock_http.get.assert_called_once_with("/api/v1/discussions/channels")
        assert len(result) == 1
        assert result[0]["slug"] == "general"

    # =========================================================================
    # list
    # =========================================================================

    def test_list_default_params(self, discussions, mock_http):
        mock_http.get.return_value = {
            "items": [],
            "total": 0,
            "limit": 20,
            "offset": 0,
            "has_more": False,
        }

        discussions.list()

        call_args = mock_http.get.call_args[0][0]
        assert "sort=newest" in call_args
        assert "limit=20" in call_args
        assert "offset=0" in call_args

    def test_list_with_channel_filter(self, discussions, mock_http):
        mock_http.get.return_value = {
            "items": [],
            "total": 0,
        }

        discussions.list(channel_slug="deployment")

        call_args = mock_http.get.call_args[0][0]
        assert "channel_slug=deployment" in call_args

    def test_list_with_sort_top(self, discussions, mock_http):
        mock_http.get.return_value = {
            "items": [],
            "total": 0,
        }

        discussions.list(sort="top", limit=10)

        call_args = mock_http.get.call_args[0][0]
        assert "sort=top" in call_args
        assert "limit=10" in call_args

    # =========================================================================
    # get
    # =========================================================================

    def test_get_post(self, discussions, mock_http):
        mock_http.get.return_value = {
            "id": "p-1",
            "short_id": "abc12345",
            "title": "Test Post",
            "body": "Full content",
            "replies": [],
        }

        result = discussions.get("abc12345")

        mock_http.get.assert_called_once_with(
            "/api/v1/discussions/posts/abc12345"
        )
        assert result["short_id"] == "abc12345"
        assert result["title"] == "Test Post"

    # =========================================================================
    # create
    # =========================================================================

    def test_create_post(self, discussions, mock_http):
        mock_http.post.return_value = {
            "id": "p-new",
            "short_id": "new12345",
            "title": "New Post",
        }

        result = discussions.create(
            channel_slug="general",
            title="New Post",
            body="Post content here",
        )

        mock_http.post.assert_called_once_with(
            "/api/v1/discussions/posts",
            {
                "channel_slug": "general",
                "title": "New Post",
                "body": "Post content here",
            },
            requires_auth=True,
        )
        assert result["short_id"] == "new12345"

    def test_create_post_with_blueprint(self, discussions, mock_http):
        mock_http.post.return_value = {
            "id": "p-new",
            "short_id": "bp123456",
            "title": "BP Discussion",
        }

        discussions.create(
            channel_slug="general",
            title="BP Discussion",
            body="About this blueprint",
            blueprint_identifier="docker-aws",
        )

        call_args = mock_http.post.call_args
        assert call_args[0][1]["blueprint_identifier"] == "docker-aws"

    # =========================================================================
    # reply
    # =========================================================================

    def test_reply_top_level(self, discussions, mock_http):
        mock_http.post.return_value = {
            "id": "r-1",
            "body": "My reply",
            "depth": 0,
        }

        discussions.reply("abc12345", "My reply")

        mock_http.post.assert_called_once_with(
            "/api/v1/discussions/posts/abc12345/replies",
            {"body": "My reply"},
            requires_auth=True,
        )

    def test_reply_nested(self, discussions, mock_http):
        mock_http.post.return_value = {
            "id": "r-2",
            "body": "Nested reply",
            "depth": 1,
        }

        discussions.reply(
            "abc12345", "Nested reply", parent_reply_id="r-1"
        )

        call_args = mock_http.post.call_args
        assert call_args[0][1]["parent_reply_id"] == "r-1"

    # =========================================================================
    # search
    # =========================================================================

    def test_search_basic(self, discussions, mock_http):
        mock_http.post.return_value = {
            "query": "docker deployment",
            "results": [],
            "total_found": 0,
        }

        result = discussions.search("docker deployment")

        call_args = mock_http.post.call_args[0][0]
        assert "query=docker+deployment" in call_args or "query=docker deployment" in call_args
        assert result["total_found"] == 0

    def test_search_with_channel(self, discussions, mock_http):
        mock_http.post.return_value = {
            "query": "test",
            "results": [],
            "total_found": 0,
        }

        discussions.search("test", channel_slug="deployment")

        call_args = mock_http.post.call_args[0][0]
        assert "channel_slug=deployment" in call_args

    def test_search_with_limit(self, discussions, mock_http):
        mock_http.post.return_value = {
            "query": "test",
            "results": [],
            "total_found": 0,
        }

        discussions.search("test", limit=5)

        call_args = mock_http.post.call_args[0][0]
        assert "limit=5" in call_args

    # =========================================================================
    # vote_post
    # =========================================================================

    def test_vote_post_up(self, discussions, mock_http):
        mock_http.post.return_value = {"action": "created"}

        result = discussions.vote_post("abc12345", "up")

        mock_http.post.assert_called_once_with(
            "/api/v1/discussions/posts/abc12345/vote",
            {"vote_type": "up"},
            requires_auth=True,
        )
        assert result["action"] == "created"

    def test_vote_post_down(self, discussions, mock_http):
        mock_http.post.return_value = {"action": "created"}

        discussions.vote_post("abc12345", "down")

        call_args = mock_http.post.call_args
        assert call_args[0][1]["vote_type"] == "down"

    # =========================================================================
    # vote_reply
    # =========================================================================

    def test_vote_reply(self, discussions, mock_http):
        mock_http.post.return_value = {"action": "created"}

        discussions.vote_reply("reply-123", "up")

        mock_http.post.assert_called_once_with(
            "/api/v1/discussions/replies/reply-123/vote",
            {"vote_type": "up"},
            requires_auth=True,
        )
