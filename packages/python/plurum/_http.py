"""
HTTP client wrapper for Plurum API
"""

from __future__ import annotations

import os
from typing import Any, Optional, TypeVar

import httpx

from plurum._exceptions import (
    AuthenticationError,
    NotFoundError,
    PlurimError,
    RateLimitError,
    ValidationError,
)

T = TypeVar("T")

DEFAULT_API_URL = "https://api.plurum.ai"
DEFAULT_TIMEOUT = 30.0


class HttpClient:
    """Synchronous HTTP client for Plurum API"""

    def __init__(
        self,
        api_key: Optional[str] = None,
        api_url: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
    ):
        self.api_key = api_key or os.environ.get("PLURUM_API_KEY")
        self.api_url = (api_url or os.environ.get("PLURUM_API_URL") or DEFAULT_API_URL).rstrip("/")
        self.timeout = timeout
        self._client = httpx.Client(timeout=timeout)

    def _headers(self, requires_auth: bool = False) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if requires_auth:
            if not self.api_key:
                raise AuthenticationError(
                    "API key required. Set PLURUM_API_KEY environment variable or pass api_key to client."
                )
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def _handle_error(self, response: httpx.Response) -> None:
        if response.status_code == 401:
            raise AuthenticationError()
        elif response.status_code == 404:
            raise NotFoundError()
        elif response.status_code == 429:
            raise RateLimitError()
        elif response.status_code == 422:
            try:
                detail = response.json().get("detail", response.text)
            except Exception:
                detail = response.text
            raise ValidationError(str(detail))
        elif response.status_code >= 400:
            raise PlurimError(
                f"API request failed: {response.text}",
                status_code=response.status_code,
            )

    def get(self, path: str, params: Optional[dict[str, Any]] = None) -> Any:
        response = self._client.get(
            f"{self.api_url}{path}",
            params=params,
            headers=self._headers(),
        )
        self._handle_error(response)
        return response.json()

    def post(
        self,
        path: str,
        data: Optional[dict[str, Any]] = None,
        requires_auth: bool = False,
    ) -> Any:
        response = self._client.post(
            f"{self.api_url}{path}",
            json=data,
            headers=self._headers(requires_auth),
        )
        self._handle_error(response)
        return response.json()

    def put(
        self,
        path: str,
        data: Optional[dict[str, Any]] = None,
        requires_auth: bool = False,
    ) -> Any:
        response = self._client.put(
            f"{self.api_url}{path}",
            json=data,
            headers=self._headers(requires_auth),
        )
        self._handle_error(response)
        return response.json()

    def delete(self, path: str, requires_auth: bool = False) -> Any:
        response = self._client.delete(
            f"{self.api_url}{path}",
            headers=self._headers(requires_auth),
        )
        self._handle_error(response)
        return response.json()

    def close(self) -> None:
        self._client.close()


class AsyncHttpClient:
    """Asynchronous HTTP client for Plurum API"""

    def __init__(
        self,
        api_key: Optional[str] = None,
        api_url: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
    ):
        self.api_key = api_key or os.environ.get("PLURUM_API_KEY")
        self.api_url = (api_url or os.environ.get("PLURUM_API_URL") or DEFAULT_API_URL).rstrip("/")
        self.timeout = timeout
        self._client = httpx.AsyncClient(timeout=timeout)

    def _headers(self, requires_auth: bool = False) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if requires_auth:
            if not self.api_key:
                raise AuthenticationError(
                    "API key required. Set PLURUM_API_KEY environment variable or pass api_key to client."
                )
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def _handle_error(self, response: httpx.Response) -> None:
        if response.status_code == 401:
            raise AuthenticationError()
        elif response.status_code == 404:
            raise NotFoundError()
        elif response.status_code == 429:
            raise RateLimitError()
        elif response.status_code == 422:
            try:
                detail = response.json().get("detail", response.text)
            except Exception:
                detail = response.text
            raise ValidationError(str(detail))
        elif response.status_code >= 400:
            raise PlurimError(
                f"API request failed: {response.text}",
                status_code=response.status_code,
            )

    async def get(self, path: str, params: Optional[dict[str, Any]] = None) -> Any:
        response = await self._client.get(
            f"{self.api_url}{path}",
            params=params,
            headers=self._headers(),
        )
        self._handle_error(response)
        return response.json()

    async def post(
        self,
        path: str,
        data: Optional[dict[str, Any]] = None,
        requires_auth: bool = False,
    ) -> Any:
        response = await self._client.post(
            f"{self.api_url}{path}",
            json=data,
            headers=self._headers(requires_auth),
        )
        self._handle_error(response)
        return response.json()

    async def put(
        self,
        path: str,
        data: Optional[dict[str, Any]] = None,
        requires_auth: bool = False,
    ) -> Any:
        response = await self._client.put(
            f"{self.api_url}{path}",
            json=data,
            headers=self._headers(requires_auth),
        )
        self._handle_error(response)
        return response.json()

    async def delete(self, path: str, requires_auth: bool = False) -> Any:
        response = await self._client.delete(
            f"{self.api_url}{path}",
            headers=self._headers(requires_auth),
        )
        self._handle_error(response)
        return response.json()

    async def close(self) -> None:
        await self._client.aclose()
