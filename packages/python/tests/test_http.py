"""
Tests for Plurum SDK HTTP client
"""

import os
from unittest.mock import MagicMock, patch

import httpx
import pytest

from plurum._http import HttpClient, AsyncHttpClient
from plurum._exceptions import (
    AuthenticationError,
    NotFoundError,
    RateLimitError,
    ValidationError,
    PlurimError,
)


class TestHttpClientInit:
    def test_default_api_url(self):
        client = HttpClient()
        assert client.api_url == "https://api.plurum.ai"

    def test_custom_api_url(self):
        client = HttpClient(api_url="http://localhost:8000")
        assert client.api_url == "http://localhost:8000"

    def test_strips_trailing_slash(self):
        client = HttpClient(api_url="http://localhost:8000/")
        assert client.api_url == "http://localhost:8000"

    def test_api_key_from_param(self):
        client = HttpClient(api_key="test_key")
        assert client.api_key == "test_key"

    def test_api_key_from_env(self, monkeypatch):
        monkeypatch.setenv("PLURUM_API_KEY", "env_key")
        client = HttpClient()
        assert client.api_key == "env_key"

    def test_api_key_param_takes_precedence(self, monkeypatch):
        monkeypatch.setenv("PLURUM_API_KEY", "env_key")
        client = HttpClient(api_key="param_key")
        assert client.api_key == "param_key"

    def test_default_timeout(self):
        client = HttpClient()
        assert client.timeout == 30.0

    def test_custom_timeout(self):
        client = HttpClient(timeout=60.0)
        assert client.timeout == 60.0


class TestHttpClientHeaders:
    def test_headers_without_auth(self):
        client = HttpClient()
        headers = client._headers(requires_auth=False)
        assert headers == {"Content-Type": "application/json"}
        assert "Authorization" not in headers

    def test_headers_with_auth(self):
        client = HttpClient(api_key="test_key")
        headers = client._headers(requires_auth=True)
        assert headers["Authorization"] == "Bearer test_key"
        assert headers["Content-Type"] == "application/json"

    def test_headers_auth_required_but_no_key(self):
        client = HttpClient()
        with pytest.raises(AuthenticationError) as exc_info:
            client._headers(requires_auth=True)
        assert "API key required" in str(exc_info.value)


class TestHttpClientErrorHandling:
    @pytest.fixture
    def client(self):
        return HttpClient(api_url="http://localhost:8000")

    def test_401_raises_authentication_error(self, client):
        response = MagicMock()
        response.status_code = 401
        with pytest.raises(AuthenticationError):
            client._handle_error(response)

    def test_404_raises_not_found_error(self, client):
        response = MagicMock()
        response.status_code = 404
        with pytest.raises(NotFoundError):
            client._handle_error(response)

    def test_429_raises_rate_limit_error(self, client):
        response = MagicMock()
        response.status_code = 429
        with pytest.raises(RateLimitError):
            client._handle_error(response)

    def test_422_raises_validation_error_with_detail(self, client):
        response = MagicMock()
        response.status_code = 422
        response.json.return_value = {"detail": "Title is required"}
        with pytest.raises(ValidationError) as exc_info:
            client._handle_error(response)
        assert "Title is required" in str(exc_info.value)

    def test_422_raises_validation_error_with_text_fallback(self, client):
        response = MagicMock()
        response.status_code = 422
        response.json.side_effect = Exception("JSON parse error")
        response.text = "Validation failed"
        with pytest.raises(ValidationError) as exc_info:
            client._handle_error(response)
        assert "Validation failed" in str(exc_info.value)

    def test_500_raises_plurim_error(self, client):
        response = MagicMock()
        response.status_code = 500
        response.text = "Internal Server Error"
        with pytest.raises(PlurimError) as exc_info:
            client._handle_error(response)
        assert exc_info.value.status_code == 500

    def test_200_does_not_raise(self, client):
        response = MagicMock()
        response.status_code = 200
        # Should not raise
        client._handle_error(response)


class TestHttpClientRequests:
    @pytest.fixture
    def mock_client(self):
        with patch("plurum._http.httpx.Client") as MockClient:
            mock_instance = MagicMock()
            MockClient.return_value = mock_instance
            client = HttpClient(api_url="http://localhost:8000", api_key="test_key")
            client._client = mock_instance
            yield client, mock_instance

    def test_get_request(self, mock_client):
        client, mock_httpx = mock_client
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"data": "test"}
        mock_httpx.get.return_value = mock_response

        result = client.get("/api/v1/test")

        mock_httpx.get.assert_called_once()
        assert result == {"data": "test"}

    def test_get_request_with_params(self, mock_client):
        client, mock_httpx = mock_client
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = []
        mock_httpx.get.return_value = mock_response

        client.get("/api/v1/blueprints", params={"limit": 10})

        call_args = mock_httpx.get.call_args
        assert call_args.kwargs["params"] == {"limit": 10}

    def test_post_request(self, mock_client):
        client, mock_httpx = mock_client
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"id": 1}
        mock_httpx.post.return_value = mock_response

        result = client.post("/api/v1/test", {"name": "test"})

        mock_httpx.post.assert_called_once()
        call_args = mock_httpx.post.call_args
        assert call_args.kwargs["json"] == {"name": "test"}
        assert result == {"id": 1}

    def test_post_request_with_auth(self, mock_client):
        client, mock_httpx = mock_client
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"id": 1}
        mock_httpx.post.return_value = mock_response

        client.post("/api/v1/test", {"name": "test"}, requires_auth=True)

        call_args = mock_httpx.post.call_args
        assert "Authorization" in call_args.kwargs["headers"]
        assert call_args.kwargs["headers"]["Authorization"] == "Bearer test_key"

    def test_put_request(self, mock_client):
        client, mock_httpx = mock_client
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"id": 1, "updated": True}
        mock_httpx.put.return_value = mock_response

        result = client.put("/api/v1/test/1", {"name": "updated"}, requires_auth=True)

        mock_httpx.put.assert_called_once()
        assert result == {"id": 1, "updated": True}

    def test_delete_request(self, mock_client):
        client, mock_httpx = mock_client
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"deleted": True}
        mock_httpx.delete.return_value = mock_response

        result = client.delete("/api/v1/test/1", requires_auth=True)

        mock_httpx.delete.assert_called_once()
        assert result == {"deleted": True}


class TestHttpClientContextManager:
    def test_context_manager_closes_client(self):
        # Import Plurum here to avoid module-level mock issues
        from plurum import Plurum

        with patch("plurum._http.httpx.Client") as MockClient:
            mock_instance = MagicMock()
            MockClient.return_value = mock_instance

            with Plurum() as client:
                pass

            mock_instance.close.assert_called_once()

    def test_close_method(self):
        with patch("plurum._http.httpx.Client") as MockClient:
            mock_instance = MagicMock()
            MockClient.return_value = mock_instance

            client = HttpClient()
            client.close()

            mock_instance.close.assert_called_once()
