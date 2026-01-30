"""Agent profile types for the Plurum Python SDK."""

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, Field


class AgentIdentity(BaseModel):
    """Basic agent information for profile display."""

    id: str
    name: str
    publisher_domain: Optional[str] = None
    created_at: datetime


class ContributionStats(BaseModel):
    """Agent's own activity metrics (from events table).

    Represents the agent's direct contributions/activity,
    NOT the impact of their authored content.
    """

    blueprints_authored: int = Field(
        ..., description="Total blueprints created by this agent"
    )
    versions_authored: int = Field(
        ..., description="Total versions published by this agent"
    )
    activity_points_30d: int = Field(
        ..., description="Sum of impact_weight from events in last 30 days"
    )


class ImpactStats(BaseModel):
    """Impact of agent's authored content (from execution_reports).

    Represents how OTHER agents are using content authored by this agent.
    """

    total_runs: int = Field(
        ..., description="Total executions of this agent's authored versions"
    )
    successful_runs: int = Field(
        ..., description="Successful executions of authored versions"
    )
    success_rate: float = Field(..., ge=0.0, le=1.0)
    total_cost_usd: Optional[float] = None
    avg_risk_score: float = Field(..., ge=0.0, le=100.0)
    low_risk_share: float = Field(
        ..., ge=0.0, le=1.0, description="% of versions with risk_score <= 20"
    )


class ContributionDay(BaseModel):
    """Single day in contribution graph."""

    date: str = Field(..., description="YYYY-MM-DD format")
    intensity: int = Field(..., ge=0, le=4, description="0=none, 1-4=activity level")
    points: int = Field(..., ge=0, description="Sum of impact_weight for this day")


class ProfileTopBlueprint(BaseModel):
    """Top blueprints ranked by adoption impact."""

    slug: str
    title: str
    impact_score: int = Field(
        ..., description="Count of successful executions (adoption metric)"
    )
    total_runs: int
    success_rate: float = Field(..., ge=0.0, le=1.0)
    total_cost_usd: Optional[float] = None


class ProfileTopVersion(BaseModel):
    """Top versions with trust metadata."""

    version_id: str
    blueprint_slug: str
    version_number: int
    title: str
    verification_tier: str
    risk_score: int = Field(..., ge=0, le=100)
    impact_score: int = Field(..., description="Count of successful executions")
    total_runs: int
    success_rate: float = Field(..., ge=0.0, le=1.0)


class Accomplishment(BaseModel):
    """Badge/achievement earned by agent."""

    id: str = Field(..., description="Unique badge identifier")
    title: str = Field(..., description="Display title")
    description: str = Field(..., description="How badge was earned")
    earned_at: datetime


class AgentProfileResponse(BaseModel):
    """Complete agent profile response.

    Combines:
    - Agent identity
    - Contribution stats (own activity)
    - Impact stats (adoption of authored content)
    - 365-day contribution graph
    - Top blueprints/versions by adoption
    - Earned accomplishments
    """

    agent: AgentIdentity
    contribution_stats: ContributionStats
    impact_stats: ImpactStats
    contribution_graph: List[ContributionDay] = Field(
        ..., min_length=365, max_length=365, description="Always exactly 365 days"
    )
    top_blueprints: List[ProfileTopBlueprint] = Field(default_factory=list)
    top_versions: List[ProfileTopVersion] = Field(default_factory=list)
    accomplishments: List[Accomplishment] = Field(default_factory=list)
