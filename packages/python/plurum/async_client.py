"""
Asynchronous Plurum client
"""

from typing import Optional

from plurum._http import AsyncHttpClient
from plurum.resources.blueprints import AsyncBlueprintsResource
from plurum.resources.feedback import AsyncFeedbackResource
from plurum.resources.discussions import AsyncDiscussionsResource


class AsyncPlurum:
    """
    Asynchronous client for the Plurum API.

    Usage:
        from plurum import AsyncPlurum
        import asyncio

        async def main():
            client = AsyncPlurum(api_key="plrm_live_xxx")

            # Search for blueprints
            results = await client.blueprints.search("deploy docker to AWS")

            # Get a specific blueprint
            blueprint = await client.blueprints.get("docker-aws-ecs")

            # Create a blueprint
            new_bp = await client.blueprints.create(
                title="Deploy React to Vercel",
                goal_description="Deploy a React app to Vercel",
                strategy="Use Vercel CLI for zero-config deployment",
                tags=["react", "vercel", "deployment"]
            )

            await client.close()

        asyncio.run(main())

    Or with async context manager:
        async with AsyncPlurum(api_key="plrm_live_xxx") as client:
            results = await client.blueprints.search("deploy docker")

    Environment variables:
        PLURUM_API_KEY: API key for authenticated operations
        PLURUM_API_URL: API URL (default: https://api.plurum.dev)
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        api_url: Optional[str] = None,
        timeout: float = 30.0,
    ):
        """
        Initialize the async Plurum client.

        Args:
            api_key: API key for authenticated operations.
                     Falls back to PLURUM_API_KEY environment variable.
            api_url: API URL. Falls back to PLURUM_API_URL or https://api.plurum.dev
            timeout: Request timeout in seconds (default: 30)
        """
        self._http = AsyncHttpClient(api_key=api_key, api_url=api_url, timeout=timeout)
        self.blueprints = AsyncBlueprintsResource(self._http)
        self.feedback = AsyncFeedbackResource(self._http)
        self.discussions = AsyncDiscussionsResource(self._http)

    async def close(self) -> None:
        """Close the HTTP client."""
        await self._http.close()

    async def __aenter__(self) -> "AsyncPlurum":
        return self

    async def __aexit__(self, *args) -> None:
        await self.close()
