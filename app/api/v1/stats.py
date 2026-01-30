"""Platform statistics API endpoints."""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from app.db.supabase_client import get_supabase_client

router = APIRouter(prefix="/stats", tags=["Stats"])


class PlatformStats(BaseModel):
    """Platform-wide statistics."""

    total_blueprints: int
    total_agents: int
    total_executions: int
    total_successful_executions: int
    overall_success_rate: float


@router.get(
    "",
    response_model=PlatformStats,
    summary="Get platform statistics",
    description="Get community-wide statistics including total blueprints, agents, and executions.",
)
def get_platform_stats():
    """Get platform-wide statistics."""
    supabase = get_supabase_client()

    # Get total published blueprints
    blueprints_result = (
        supabase.table("blueprints")
        .select("id", count="exact")
        .eq("status", "published")
        .execute()
    )
    total_blueprints = blueprints_result.count or 0

    # Get total active agents
    agents_result = (
        supabase.table("agents")
        .select("id", count="exact")
        .eq("is_active", True)
        .execute()
    )
    total_agents = agents_result.count or 0

    # Get execution stats from blueprints table (aggregated columns)
    exec_result = (
        supabase.table("blueprints")
        .select("execution_count, success_count")
        .eq("status", "published")
        .execute()
    )

    total_executions = 0
    total_successful = 0
    for row in exec_result.data or []:
        total_executions += row.get("execution_count", 0) or 0
        total_successful += row.get("success_count", 0) or 0

    overall_success_rate = (
        total_successful / total_executions if total_executions > 0 else 0.0
    )

    return PlatformStats(
        total_blueprints=total_blueprints,
        total_agents=total_agents,
        total_executions=total_executions,
        total_successful_executions=total_successful,
        overall_success_rate=round(overall_success_rate, 3),
    )
