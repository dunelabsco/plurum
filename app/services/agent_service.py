"""Agent service for business logic."""

from __future__ import annotations

from typing import Optional
from uuid import UUID

from app.repositories.agent_repo import AgentRepository
from app.core.security import generate_api_key, hash_api_key, get_api_key_prefix
from app.core.exceptions import (
    AuthenticationError,
    AuthorizationError,
    DuplicateError,
    PlurimException,
)
from app.models.agent import (
    AgentCliRegisterRequest,
    AgentCliRegisterResponse,
    AgentCreate,
    AgentPublic,
    AgentRegisterResponse,
    AgentUpdate,
)
from app.services.username_suggester import generate_candidates, normalize_username


class AgentService:
    """Service for agent-related business logic."""

    def __init__(self):
        self.repo = AgentRepository()

    def check_username(self, username: str) -> dict:
        """Report whether a username is free and, if not, suggest alternatives."""
        import re
        normalized = normalize_username(username)
        valid = bool(normalized) and 3 <= len(normalized) <= 50 and bool(
            re.match(r"^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$", normalized)
        )
        taken = valid and self.repo.is_username_taken(normalized)
        if valid and not taken:
            return {"available": True, "suggestions": []}

        # Generate candidates seeded by the requested name, drop any already
        # taken in a single batched query, return the free ones.
        seed = normalized if normalized else ""
        candidates = generate_candidates(seed=seed, count=8)
        candidates = [c for c in candidates if c != normalized]
        taken_set = self.repo.find_taken_usernames(candidates)
        free = [c for c in candidates if c not in taken_set][:5]
        return {"available": False, "suggestions": free}

    def register(
        self,
        data: AgentCreate,
        owner_user_id: Optional[str] = None,
    ) -> AgentRegisterResponse:
        """
        Register a new agent and return API key.

        Args:
            data: Agent creation data
            owner_user_id: UUID of the Supabase user who owns this agent
        """
        # Check username uniqueness
        username = data.username.lower()
        if self.repo.is_username_taken(username):
            raise DuplicateError(f"Username '{username}' is already taken")

        # Generate API key
        api_key = generate_api_key()
        api_key_hash = hash_api_key(api_key)
        api_key_prefix = get_api_key_prefix(api_key)

        # Create agent
        agent = self.repo.create(
            name=data.name,
            username=username,
            api_key_hash=api_key_hash,
            api_key_prefix=api_key_prefix,
            owner_user_id=owner_user_id,
        )

        return AgentRegisterResponse(
            id=agent["id"],
            name=agent["name"],
            api_key=api_key,
            api_key_prefix=api_key_prefix,
        )

    def register_cli(
        self,
        data: AgentCliRegisterRequest,
    ) -> AgentCliRegisterResponse:
        """Create or replay a CLI registration without receiving its raw key."""
        result = self.repo.register_cli(
            protocol_version=data.protocol_version,
            registration_request_id=data.registration_request_id,
            name=data.name,
            username=data.username,
            api_key_hash=data.api_key_hash,
            api_key_prefix=data.api_key_prefix,
        )
        disposition = result["disposition"]
        if disposition in {"created", "replayed"}:
            return AgentCliRegisterResponse(
                agent_id=result["agent_id"],
                disposition=disposition,
            )

        if disposition in {
            "idempotency_conflict",
            "username_unavailable",
            "credential_conflict",
        }:
            raise PlurimException(
                "CLI registration conflict",
                status_code=409,
                details={"code": disposition},
            )

        raise PlurimException(
            "CLI registration is temporarily unavailable",
            status_code=503,
            details={"code": "registration_unavailable"},
        )

    def get_profile(self, agent_id: UUID) -> AgentPublic:
        """Get an agent's public profile."""
        agent = self.repo.get_by_id(agent_id)
        return AgentPublic(
            id=agent["id"],
            name=agent["name"],
            username=agent.get("username"),
            api_key_prefix=agent["api_key_prefix"],
            is_active=agent["is_active"],
            rate_limit_tier=agent["rate_limit_tier"],
            subscription_tier=agent["subscription_tier"],
            credits_balance=agent["credits_balance"],
            publisher_domain=agent.get("publisher_domain"),
            created_at=agent["created_at"],
            last_active_at=agent.get("last_active_at"),
        )

    def list_by_owner(self, owner_user_id: str) -> list[AgentPublic]:
        """List all agents owned by a user."""
        agents = self.repo.list_by_owner(owner_user_id)
        return [
            AgentPublic(
                id=agent["id"],
                name=agent["name"],
                username=agent.get("username"),
                api_key_prefix=agent["api_key_prefix"],
                is_active=agent["is_active"],
                rate_limit_tier=agent["rate_limit_tier"],
                subscription_tier=agent.get("subscription_tier", "free"),
                credits_balance=agent.get("credits_balance", 0),
                publisher_domain=agent.get("publisher_domain"),
                created_at=agent["created_at"],
                last_active_at=agent.get("last_active_at"),
            )
            for agent in agents
        ]

    def update(
        self,
        agent_id: UUID,
        data: AgentUpdate,
        owner_user_id: str,
    ) -> AgentPublic:
        """Update an agent's profile."""
        # Verify ownership
        agent = self.repo.get_by_id(agent_id)
        if agent.get("owner_user_id") != owner_user_id:
            raise AuthorizationError("You can only update your own agents")

        update_data = {}

        if data.name is not None:
            update_data["name"] = data.name

        if data.username is not None:
            username = data.username.lower()
            # Check uniqueness (excluding current agent)
            if self.repo.is_username_taken(username, exclude_agent_id=agent_id):
                raise DuplicateError(f"Username '{username}' is already taken")
            update_data["username"] = username

        if update_data:
            self.repo.update(agent_id, update_data)

        return self.get_profile(agent_id)

    def rotate_api_key(self, agent_id: UUID) -> AgentRegisterResponse:
        """Rotate an agent's API key."""
        agent = self.repo.get_by_id(agent_id)

        # Generate new API key
        api_key = generate_api_key()
        api_key_hash = hash_api_key(api_key)
        api_key_prefix = get_api_key_prefix(api_key)

        # Update agent
        self.repo.update_api_key(
            agent_id=agent_id,
            new_api_key_hash=api_key_hash,
            new_api_key_prefix=api_key_prefix,
        )

        return AgentRegisterResponse(
            id=agent["id"],
            name=agent["name"],
            api_key=api_key,
            api_key_prefix=api_key_prefix,
            message="API key rotated successfully. Old key is now invalid.",
        )

    def deactivate(self, agent_id: UUID) -> None:
        """Deactivate an agent."""
        self.repo.deactivate(agent_id)

    def claim_agent(self, api_key: str, owner_user_id: str) -> dict:
        """Claim an unclaimed agent using its API key."""
        api_key_hash = hash_api_key(api_key)
        agent = self.repo.get_by_api_key_hash(api_key_hash)

        if not agent:
            raise AuthenticationError("Invalid API key")

        if not agent.get("is_active", False):
            raise PlurimException("Agent is not active", status_code=400)

        if agent.get("owner_user_id"):
            raise DuplicateError("Agent is already claimed by another account")

        updated = self.repo.claim_agent(UUID(agent["id"]), owner_user_id)
        return updated

    def release_agent(self, agent_id: UUID, owner_user_id: str) -> dict:
        """Release a claimed agent back to unclaimed state."""
        agent = self.repo.get_by_id(agent_id)

        if agent.get("owner_user_id") != owner_user_id:
            raise AuthorizationError("You do not own this agent")

        updated = self.repo.release_agent(agent_id)
        return updated

    def rotate_api_key_as_owner(self, agent_id: UUID, owner_user_id: str) -> dict:
        """Rotate an agent's API key as its human owner."""
        agent = self.repo.get_by_id(agent_id)

        if agent.get("owner_user_id") != owner_user_id:
            raise AuthorizationError("You do not own this agent")

        new_api_key = generate_api_key()
        new_hash = hash_api_key(new_api_key)
        new_prefix = get_api_key_prefix(new_api_key)

        self.repo.update_api_key(agent_id, new_hash, new_prefix)

        return {
            "id": str(agent_id),
            "name": agent["name"],
            "api_key": new_api_key,
            "api_key_prefix": new_prefix,
            "message": "API key rotated successfully. Store this key — it won't be shown again.",
        }

    def get_overview(self, owner_user_id: str) -> dict:
        """Get dashboard overview for a human user's agents."""
        from app.repositories.session_repo import SessionRepository
        from app.repositories.experience_repo import ExperienceRepository

        agents = self.repo.list_by_owner(owner_user_id)
        agent_ids = [a["id"] for a in agents]

        if not agent_ids:
            return {
                "agents": [],
                "recent_sessions": [],
                "recent_experiences": [],
                "aggregate_stats": {
                    "total_sessions": 0,
                    "total_experiences": 0,
                    "overall_success_rate": 0.0,
                    "total_upvotes": 0,
                },
            }

        session_repo = SessionRepository()
        experience_repo = ExperienceRepository()

        agent_names = {a["id"]: a.get("name", "Unknown") for a in agents}

        # IMPORTANT: list_by_agent returns (list[dict], int) tuple
        all_sessions = []
        total_session_count = 0
        for aid in agent_ids:
            sessions, count = session_repo.list_by_agent(aid, limit=5)
            total_session_count += count
            for s in sessions:
                s["agent_name"] = agent_names.get(s.get("agent_id", aid), "Unknown")
            all_sessions.extend(sessions)
        all_sessions.sort(key=lambda s: s.get("started_at", ""), reverse=True)
        recent_sessions = all_sessions[:10]

        # Keep the recent feed capped; aggregate stats come from a separate
        # database query over the complete experience set.
        all_experiences = []
        for aid in agent_ids:
            items, _ = experience_repo.list_experiences(
                agent_id=aid,
                viewer_agent_id=aid,
                limit=5,
            )
            for e in items:
                e["agent_name"] = agent_names.get(e.get("agent_id", aid), "Unknown")
            all_experiences.extend(items)
        all_experiences.sort(key=lambda e: e.get("created_at", ""), reverse=True)
        recent_experiences = all_experiences[:10]

        experience_stats = experience_repo.get_agent_stats(agent_ids)
        total_sessions = total_session_count
        total_experiences = experience_stats["total_experiences"]
        successful_experiences = experience_stats["successful_experiences"]
        total_upvotes = experience_stats["total_upvotes"]
        overall_success_rate = (
            successful_experiences / total_experiences
            if total_experiences > 0
            else 0.0
        )

        return {
            "agents": [
                {
                    "id": a["id"],
                    "name": a["name"],
                    "username": a.get("username"),
                    "is_active": a.get("is_active", True),
                    "last_active_at": a.get("last_active_at"),
                }
                for a in agents
            ],
            "recent_sessions": [
                {
                    "id": s["id"],
                    "short_id": s.get("short_id", ""),
                    "agent_name": s.get("agent_name", "Unknown"),
                    "topic": s.get("topic", ""),
                    "status": s.get("status", ""),
                    "started_at": s.get("started_at", ""),
                }
                for s in recent_sessions
            ],
            "recent_experiences": [
                {
                    "id": e["id"],
                    "short_id": e.get("short_id", ""),
                    "agent_name": e.get("agent_name", "Unknown"),
                    "goal": e.get("goal", ""),
                    "status": e.get("status", ""),
                    "quality_score": e.get("quality_score", 0.0),
                    "created_at": e.get("created_at", ""),
                }
                for e in recent_experiences
            ],
            "aggregate_stats": {
                "total_sessions": total_sessions,
                "total_experiences": total_experiences,
                "overall_success_rate": round(overall_success_rate, 4),
                "total_upvotes": total_upvotes,
            },
        }
