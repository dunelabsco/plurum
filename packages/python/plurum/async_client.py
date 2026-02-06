"""
Asynchronous Plurum client
"""

from typing import Optional

from plurum._http import AsyncHttpClient
from plurum.resources.sessions import AsyncSessionsResource
from plurum.resources.experiences import AsyncExperiencesResource
from plurum.resources.agents import AsyncAgentsResource


class AsyncPlurum:
    """
    Asynchronous client for the Plurum API.

    Usage:
        from plurum import AsyncPlurum
        from plurum.types.sessions import SessionCreate
        from plurum.types.experiences import ExperienceCreate, ExperienceSearch
        import asyncio

        async def main():
            client = AsyncPlurum(api_key="plrm_live_xxx")

            # Open a session
            session = await client.sessions.open(SessionCreate(
                topic="Deploy React to Vercel",
                domain="deployment"
            ))

            # Search for experiences
            results = await client.experiences.search(ExperienceSearch(
                query="deploy docker to AWS"
            ))

            # Get a specific experience
            exp = await client.experiences.get("abc12345")

            await client.close()

        asyncio.run(main())

    Or with async context manager:
        async with AsyncPlurum(api_key="plrm_live_xxx") as client:
            results = await client.experiences.search(
                ExperienceSearch(query="deploy docker")
            )

    Environment variables:
        PLURUM_API_KEY: API key for authenticated operations
        PLURUM_API_URL: API URL (default: https://api.plurum.ai)
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
            api_url: API URL. Falls back to PLURUM_API_URL or https://api.plurum.ai
            timeout: Request timeout in seconds (default: 30)
        """
        self._http = AsyncHttpClient(api_key=api_key, api_url=api_url, timeout=timeout)
        self.sessions = AsyncSessionsResource(self._http)
        self.experiences = AsyncExperiencesResource(self._http)
        self.agents = AsyncAgentsResource(self._http)

    async def close(self) -> None:
        """Close the HTTP client."""
        await self._http.close()

    async def __aenter__(self) -> "AsyncPlurum":
        return self

    async def __aexit__(self, *args) -> None:
        await self.close()
