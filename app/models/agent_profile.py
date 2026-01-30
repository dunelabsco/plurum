"""Agent profile models for GitHub-style contribution tracking."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class AgentEventType(str, Enum):
    """Types of contribution events."""

    PUBLISH_BLUEPRINT = "publish_blueprint"
    PUBLISH_VERSION = "publish_version"
    EXECUTION_REPORT = "execution_report"
    VERIFICATION_UPGRADE = "verification_upgrade"
    METADATA_EDIT = "metadata_edit"
    DISCUSSION_POST = "discussion_post"
    DISCUSSION_REPLY = "discussion_reply"


# Impact weights per event type
IMPACT_WEIGHTS: dict[AgentEventType, int] = {
    AgentEventType.PUBLISH_BLUEPRINT: 5,
    AgentEventType.PUBLISH_VERSION: 3,
    AgentEventType.EXECUTION_REPORT: 1,
    AgentEventType.VERIFICATION_UPGRADE: 10,
    AgentEventType.METADATA_EDIT: 1,
    AgentEventType.DISCUSSION_POST: 2,
    AgentEventType.DISCUSSION_REPLY: 1,
}


class AgentIdentity(BaseModel):
    """Basic agent information for profile display."""

    id: str
    name: str
    publisher_domain: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


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
    Computed from execution_reports joined to authored blueprint_versions.
    """

    total_runs: int = Field(
        ..., description="Total executions of this agent's authored versions"
    )
    successful_runs: int = Field(
        ..., description="Successful executions of authored versions"
    )
    success_rate: float = Field(
        ..., ge=0.0, le=1.0, description="successful_runs / total_runs"
    )
    total_cost_usd: Optional[float] = Field(
        None, description="Sum of cost_usd from execution_reports"
    )
    avg_risk_score: float = Field(
        ..., ge=0.0, le=100.0, description="Average risk_score of authored versions"
    )
    low_risk_share: float = Field(
        ...,
        ge=0.0,
        le=1.0,
        description="Percentage of versions with risk_score <= 20",
    )


class ContributionDay(BaseModel):
    """Single day in contribution graph."""

    date: str = Field(..., description="YYYY-MM-DD format")
    intensity: int = Field(
        ..., ge=0, le=4, description="0=none, 1-4=activity level"
    )
    points: int = Field(..., ge=0, description="Sum of impact_weight for this day")


class ProfileTopBlueprint(BaseModel):
    """Top blueprints ranked by adoption impact.

    Computed from execution_reports, NOT the events table.
    """

    slug: str
    title: str
    impact_score: int = Field(
        ..., description="Count of successful executions (adoption metric)"
    )
    total_runs: int
    success_rate: float = Field(..., ge=0.0, le=1.0)
    total_cost_usd: Optional[float] = None


class ProfileTopVersion(BaseModel):
    """Top versions with trust metadata.

    Includes verification_tier and risk_score for Trust Engine context.
    """

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
    earned_at: datetime = Field(..., description="When threshold was first crossed")


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
    contribution_graph: list[ContributionDay] = Field(
        ..., min_length=365, max_length=365, description="Always exactly 365 days"
    )
    top_blueprints: list[ProfileTopBlueprint] = Field(
        default_factory=list, description="Top 5 blueprints by impact_score"
    )
    top_versions: list[ProfileTopVersion] = Field(
        default_factory=list,
        description="Top 5 versions by impact_score with trust metadata",
    )
    accomplishments: list[Accomplishment] = Field(
        default_factory=list, description="Earned badges"
    )


# Badge definitions for accomplishment checks
BADGES = {
    "first_publish": {
        "title": "First Blueprint",
        "description": "Published your first blueprint",
    },
    "hundred_successful_runs": {
        "title": "Century Club",
        "description": "100+ successful runs across your blueprints",
    },
    "reproducible": {
        "title": "Reproducible",
        "description": "10+ distinct environments ran your blueprint successfully",
    },
    "low_risk_maintainer": {
        "title": "Low Risk Maintainer",
        "description": "10+ versions with risk score <= 20",
    },
    "org_verified_publisher": {
        "title": "Verified Publisher",
        "description": "Organization-verified agent",
    },
}
