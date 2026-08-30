"""Hosted MCP integration."""

from app.mcp.server import (
    create_mcp_application,
    create_mcp_oauth_metadata_application,
    get_mcp_oauth_metadata_path,
)

__all__ = [
    "create_mcp_application",
    "create_mcp_oauth_metadata_application",
    "get_mcp_oauth_metadata_path",
]
