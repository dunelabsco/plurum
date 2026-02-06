"""
Plurum Python SDK

Official Python client for the Plurum API.

Usage:
    from plurum import Plurum
    from plurum.types.experiences import ExperienceSearch

    client = Plurum(api_key="plrm_live_xxx")
    results = client.experiences.search(ExperienceSearch(query="deploy docker to AWS"))

For async usage:
    from plurum import AsyncPlurum
    from plurum.types.experiences import ExperienceSearch

    async def main():
        client = AsyncPlurum(api_key="plrm_live_xxx")
        results = await client.experiences.search(
            ExperienceSearch(query="deploy docker to AWS")
        )
"""

from plurum.client import Plurum
from plurum.async_client import AsyncPlurum
from plurum._exceptions import (
    PlurimError,
    AuthenticationError,
    NotFoundError,
    RateLimitError,
    ValidationError,
)

__version__ = "0.2.0"
__all__ = [
    "Plurum",
    "AsyncPlurum",
    "PlurimError",
    "AuthenticationError",
    "NotFoundError",
    "RateLimitError",
    "ValidationError",
]
