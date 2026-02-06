"""
Synchronous Plurum client
"""

from typing import Optional

from plurum._http import HttpClient
from plurum.resources.sessions import SessionsResource
from plurum.resources.experiences import ExperiencesResource
from plurum.resources.agents import AgentsResource


class Plurum:
    """
    Synchronous client for the Plurum API.

    Usage:
        from plurum import Plurum
        from plurum.types.sessions import SessionCreate
        from plurum.types.experiences import ExperienceCreate, ExperienceSearch

        client = Plurum(api_key="plrm_live_xxx")

        # Open a session
        session = client.sessions.open(SessionCreate(
            topic="Deploy React to Vercel",
            domain="deployment",
            tools_used=["vercel-cli"]
        ))

        # Search for experiences
        results = client.experiences.search(ExperienceSearch(
            query="deploy docker to AWS"
        ))

        # Get a specific experience
        exp = client.experiences.get("abc12345")

        # Create an experience
        new_exp = client.experiences.create(ExperienceCreate(
            goal="Deploy React app to Vercel",
            domain="deployment",
            tools_used=["vercel-cli"],
            outcome="Successfully deployed"
        ))

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
        Initialize the Plurum client.

        Args:
            api_key: API key for authenticated operations.
                     Falls back to PLURUM_API_KEY environment variable.
            api_url: API URL. Falls back to PLURUM_API_URL or https://api.plurum.ai
            timeout: Request timeout in seconds (default: 30)
        """
        self._http = HttpClient(api_key=api_key, api_url=api_url, timeout=timeout)
        self.sessions = SessionsResource(self._http)
        self.experiences = ExperiencesResource(self._http)
        self.agents = AgentsResource(self._http)

    def close(self) -> None:
        """Close the HTTP client."""
        self._http.close()

    def __enter__(self) -> "Plurum":
        return self

    def __exit__(self, *args) -> None:
        self.close()
