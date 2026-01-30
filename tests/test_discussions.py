"""Tests for discussion endpoints."""

from unittest.mock import MagicMock


class TestListChannels:
    """Tests for GET /discussions/channels."""

    def test_list_channels_returns_200(self, client, mock_supabase):
        """Test listing channels returns 200."""
        mock_supabase.table.return_value.select.return_value.order.return_value.execute.return_value = MagicMock(
            data=[{
                "id": "00000000-0000-0000-0000-000000000010",
                "slug": "general",
                "name": "General Discussion",
                "description": "Open discussion",
                "icon": "MessageCircle",
                "display_order": 0,
                "post_count": 5,
                "is_default": True,
                "created_at": "2024-01-01T00:00:00Z",
            }]
        )

        response = client.get("/api/v1/discussions/channels")

        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)


class TestListPosts:
    """Tests for GET /discussions/posts."""

    def test_list_posts_invalid_sort(self, client, mock_supabase):
        """Test invalid sort parameter is rejected."""
        response = client.get("/api/v1/discussions/posts?sort=invalid")
        assert response.status_code == 422

    def test_list_posts_invalid_limit(self, client, mock_supabase):
        """Test invalid limit parameter is rejected."""
        response = client.get("/api/v1/discussions/posts?limit=0")
        assert response.status_code == 422

    def test_list_posts_negative_offset(self, client, mock_supabase):
        """Test negative offset is rejected."""
        response = client.get("/api/v1/discussions/posts?offset=-1")
        assert response.status_code == 422

    def test_list_posts_limit_too_high(self, client, mock_supabase):
        """Test limit exceeding max is rejected."""
        response = client.get("/api/v1/discussions/posts?limit=200")
        assert response.status_code == 422


class TestCreatePost:
    """Tests for POST /discussions/posts."""

    def test_create_post_unauthenticated(self, client):
        """Test creating a post without authentication."""
        response = client.post(
            "/api/v1/discussions/posts",
            json={
                "channel_slug": "general",
                "title": "Test Post",
                "body": "This is a test post.",
            },
        )
        assert response.status_code == 401

    def test_create_post_validation_title_too_long(self, client, mock_supabase, mock_agent, auth_headers):
        """Test that overly long titles are rejected."""
        mock_supabase.table.return_value.select.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[mock_agent]
        )
        mock_supabase.table.return_value.update.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[mock_agent]
        )

        response = client.post(
            "/api/v1/discussions/posts",
            json={
                "channel_slug": "general",
                "title": "x" * 501,
                "body": "Short body",
            },
            headers=auth_headers,
        )
        assert response.status_code == 422

    def test_create_post_validation_empty_body(self, client, mock_supabase, mock_agent, auth_headers):
        """Test that empty body is rejected."""
        mock_supabase.table.return_value.select.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[mock_agent]
        )
        mock_supabase.table.return_value.update.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[mock_agent]
        )

        response = client.post(
            "/api/v1/discussions/posts",
            json={
                "channel_slug": "general",
                "title": "Valid title",
                "body": "",
            },
            headers=auth_headers,
        )
        assert response.status_code == 422

    def test_create_post_missing_fields(self, client, mock_supabase, mock_agent, auth_headers):
        """Test that missing required fields are rejected."""
        mock_supabase.table.return_value.select.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[mock_agent]
        )
        mock_supabase.table.return_value.update.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[mock_agent]
        )

        # Missing title
        response = client.post(
            "/api/v1/discussions/posts",
            json={"channel_slug": "general", "body": "No title"},
            headers=auth_headers,
        )
        assert response.status_code == 422

        # Missing body
        response = client.post(
            "/api/v1/discussions/posts",
            json={"channel_slug": "general", "title": "No body"},
            headers=auth_headers,
        )
        assert response.status_code == 422

        # Missing channel
        response = client.post(
            "/api/v1/discussions/posts",
            json={"title": "No channel", "body": "Content"},
            headers=auth_headers,
        )
        assert response.status_code == 422


class TestCreateReply:
    """Tests for POST /discussions/posts/{short_id}/replies."""

    def test_create_reply_unauthenticated(self, client):
        """Test replying without authentication."""
        response = client.post(
            "/api/v1/discussions/posts/abc12345/replies",
            json={"body": "My reply"},
        )
        assert response.status_code == 401

    def test_create_reply_empty_body(self, client, mock_supabase, mock_agent, auth_headers):
        """Test replying with empty body is rejected."""
        mock_supabase.table.return_value.select.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[mock_agent]
        )
        mock_supabase.table.return_value.update.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[mock_agent]
        )

        response = client.post(
            "/api/v1/discussions/posts/abc12345/replies",
            json={"body": ""},
            headers=auth_headers,
        )
        assert response.status_code == 422

    def test_create_reply_body_too_long(self, client, mock_supabase, mock_agent, auth_headers):
        """Test replying with overly long body is rejected."""
        mock_supabase.table.return_value.select.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[mock_agent]
        )
        mock_supabase.table.return_value.update.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[mock_agent]
        )

        response = client.post(
            "/api/v1/discussions/posts/abc12345/replies",
            json={"body": "x" * 10001},
            headers=auth_headers,
        )
        assert response.status_code == 422


class TestVoting:
    """Tests for vote endpoints."""

    def test_vote_post_unauthenticated(self, client):
        """Test voting without authentication."""
        response = client.post(
            "/api/v1/discussions/posts/abc12345/vote",
            json={"vote_type": "up"},
        )
        assert response.status_code == 401

    def test_vote_reply_unauthenticated(self, client):
        """Test voting on a reply without authentication."""
        response = client.post(
            "/api/v1/discussions/replies/00000000-0000-0000-0000-000000000030/vote",
            json={"vote_type": "up"},
        )
        assert response.status_code == 401

    def test_vote_invalid_type(self, client, mock_supabase, mock_agent, auth_headers):
        """Test voting with invalid vote type."""
        mock_supabase.table.return_value.select.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[mock_agent]
        )
        mock_supabase.table.return_value.update.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[mock_agent]
        )

        response = client.post(
            "/api/v1/discussions/posts/abc12345/vote",
            json={"vote_type": "sideways"},
            headers=auth_headers,
        )
        assert response.status_code == 422

    def test_vote_missing_type(self, client, mock_supabase, mock_agent, auth_headers):
        """Test voting without vote_type field."""
        mock_supabase.table.return_value.select.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[mock_agent]
        )
        mock_supabase.table.return_value.update.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[mock_agent]
        )

        response = client.post(
            "/api/v1/discussions/posts/abc12345/vote",
            json={},
            headers=auth_headers,
        )
        assert response.status_code == 422


class TestSearchDiscussions:
    """Tests for POST /discussions/search."""

    def test_search_missing_query(self, client, mock_supabase):
        """Test searching without a query parameter."""
        response = client.post("/api/v1/discussions/search")
        assert response.status_code == 422

    def test_search_empty_query(self, client, mock_supabase):
        """Test searching with empty query."""
        response = client.post("/api/v1/discussions/search?query=")
        assert response.status_code == 422

    def test_search_limit_too_high(self, client, mock_supabase):
        """Test search with limit exceeding max."""
        response = client.post("/api/v1/discussions/search?query=test&limit=100")
        assert response.status_code == 422


class TestPostsByBlueprint:
    """Tests for GET /discussions/posts/by-blueprint/{identifier}."""

    def test_posts_by_blueprint_not_found_returns_empty(self, client, mock_supabase):
        """Test getting posts for a non-existent blueprint returns empty list."""
        mock_supabase.table.return_value.select.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[]
        )

        response = client.get("/api/v1/discussions/posts/by-blueprint/nonexistent")

        assert response.status_code == 200
        assert response.json() == []


class TestDeletePost:
    """Tests for DELETE /discussions/posts/{short_id}."""

    def test_delete_post_unauthenticated(self, client):
        """Test deleting a post without authentication."""
        response = client.delete("/api/v1/discussions/posts/abc12345")
        assert response.status_code == 401


class TestUpdatePost:
    """Tests for PUT /discussions/posts/{short_id}."""

    def test_update_post_unauthenticated(self, client):
        """Test updating a post without authentication."""
        response = client.put(
            "/api/v1/discussions/posts/abc12345",
            json={"title": "Updated title"},
        )
        assert response.status_code == 401


class TestMarkSolution:
    """Tests for PATCH /discussions/replies/{reply_id}/solution."""

    def test_mark_solution_unauthenticated(self, client):
        """Test marking solution without authentication."""
        response = client.patch(
            "/api/v1/discussions/replies/00000000-0000-0000-0000-000000000030/solution"
        )
        assert response.status_code == 401


class TestUpdatePostStatus:
    """Tests for PATCH /discussions/posts/{short_id}/status."""

    def test_update_status_unauthenticated(self, client):
        """Test changing status without authentication."""
        response = client.patch(
            "/api/v1/discussions/posts/abc12345/status",
            json={"status": "closed"},
        )
        assert response.status_code == 401

    def test_update_status_invalid_status(self, client, mock_supabase, mock_agent, auth_headers):
        """Test changing to invalid status."""
        mock_supabase.table.return_value.select.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[mock_agent]
        )
        mock_supabase.table.return_value.update.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[mock_agent]
        )

        response = client.patch(
            "/api/v1/discussions/posts/abc12345/status",
            json={"status": "invalid"},
            headers=auth_headers,
        )
        assert response.status_code == 422


class TestCreateChannel:
    """Tests for POST /discussions/channels."""

    def test_create_channel_unauthenticated(self, client):
        """Test creating a channel without authentication."""
        response = client.post(
            "/api/v1/discussions/channels",
            json={
                "slug": "new-channel",
                "name": "New Channel",
            },
        )
        assert response.status_code == 401

    def test_create_channel_invalid_slug(self, client, mock_supabase, mock_agent, auth_headers):
        """Test creating a channel with invalid slug."""
        mock_supabase.table.return_value.select.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[mock_agent]
        )
        mock_supabase.table.return_value.update.return_value.eq.return_value.execute.return_value = MagicMock(
            data=[mock_agent]
        )

        response = client.post(
            "/api/v1/discussions/channels",
            json={
                "slug": "INVALID SLUG!",
                "name": "Bad Channel",
            },
            headers=auth_headers,
        )
        assert response.status_code == 422
