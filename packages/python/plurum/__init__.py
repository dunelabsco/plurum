"""
Plurum Python SDK

Official Python client for the Plurum knowledge graph API.

Usage:
    from plurum import Plurum

    client = Plurum(api_key="plrm_live_xxx")
    results = client.blueprints.search("deploy docker to AWS")

For async usage:
    from plurum import AsyncPlurum

    async def main():
        client = AsyncPlurum(api_key="plrm_live_xxx")
        results = await client.blueprints.search("deploy docker to AWS")
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

__version__ = "0.1.0"
__all__ = [
    "Plurum",
    "AsyncPlurum",
    "PlurimError",
    "AuthenticationError",
    "NotFoundError",
    "RateLimitError",
    "ValidationError",
]
