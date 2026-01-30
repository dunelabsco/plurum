"""
Synchronous Plurum client
"""

from typing import Optional

from plurum._http import HttpClient
from plurum.resources.blueprints import BlueprintsResource
from plurum.resources.feedback import FeedbackResource
from plurum.resources.discussions import DiscussionsResource


class Plurum:
    """
    Synchronous client for the Plurum API.

    Usage:
        from plurum import Plurum

        client = Plurum(api_key="plrm_live_xxx")

        # Search for blueprints
        results = client.blueprints.search("deploy docker to AWS")

        # Get a specific blueprint
        blueprint = client.blueprints.get("docker-aws-ecs")

        # Create a blueprint
        new_bp = client.blueprints.create(
            title="Deploy React to Vercel",
            goal_description="Deploy a React app to Vercel",
            strategy="Use Vercel CLI for zero-config deployment",
            tags=["react", "vercel", "deployment"]
        )

        # Vote on a blueprint
        client.feedback.vote("docker-aws-ecs", "up")

        # Report execution
        client.feedback.report_execution(
            "docker-aws-ecs",
            success=True,
            execution_time_ms=5000
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
        Initialize the Plurum client.

        Args:
            api_key: API key for authenticated operations.
                     Falls back to PLURUM_API_KEY environment variable.
            api_url: API URL. Falls back to PLURUM_API_URL or https://api.plurum.ai
            timeout: Request timeout in seconds (default: 30)
        """
        self._http = HttpClient(api_key=api_key, api_url=api_url, timeout=timeout)
        self.blueprints = BlueprintsResource(self._http)
        self.feedback = FeedbackResource(self._http)
        self.discussions = DiscussionsResource(self._http)

    def close(self) -> None:
        """Close the HTTP client."""
        self._http.close()

    def __enter__(self) -> "Plurum":
        return self

    def __exit__(self, *args) -> None:
        self.close()
