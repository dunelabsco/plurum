"""Blueprint service for business logic."""

from __future__ import annotations

import logging
from uuid import UUID

from app.repositories.blueprint_repo import BlueprintRepository
from app.repositories.contribution_repo import ContributionRepository
from app.services.embedding_service import get_embedding_service
from app.core.exceptions import NotFoundError, AuthorizationError, ValidationError
from app.models.agent_profile import AgentEventType

logger = logging.getLogger(__name__)
from app.models.blueprint import (
    BlueprintCreate,
    BlueprintUpdate,
    BlueprintDetail,
    BlueprintSummary,
    BlueprintVersion,
    BlueprintStatus,
    BlueprintStatusUpdate,
    BlueprintAuthor,
    QualityMetricsEmbed,
    VerificationTier,
    Permission,
    RiskFlag,
    EnvironmentConstraints,
    slugify,
)


def dedupe_preserve_order(xs: list[str]) -> list[str]:
    """
    Deduplicate list while preserving original order.

    Uses dict.fromkeys() which maintains insertion order in Python 3.7+.
    This ensures arrays are stable across requests.
    """
    return list(dict.fromkeys(xs))


def calculate_risk_score(permissions: list[str], risk_flags: list[str]) -> int:
    """
    Compute risk_score server-side with deduplication.

    Formula: 10 * len(unique_permissions) + 20 * len(unique_risk_flags)
    Clamped to 0-100.

    SECURITY: Uses order-preserving dedupe to prevent score inflation
    via duplicate entries while keeping arrays deterministic.
    """
    unique_permissions = dedupe_preserve_order(permissions)
    unique_flags = dedupe_preserve_order(risk_flags)
    score = 10 * len(unique_permissions) + 20 * len(unique_flags)
    return min(score, 100)


def validate_and_deduplicate_permissions(permissions: list[str]) -> list[str]:
    """Validate against Permission enum and deduplicate (order-preserving)."""
    valid = {p.value for p in Permission}
    invalid = [p for p in permissions if p not in valid]
    if invalid:
        raise ValidationError(f"Invalid permissions: {invalid}")
    return dedupe_preserve_order(permissions)


def validate_and_deduplicate_risk_flags(flags: list[str]) -> list[str]:
    """Validate against RiskFlag enum and deduplicate (order-preserving)."""
    valid = {f.value for f in RiskFlag}
    invalid = [f for f in flags if f not in valid]
    if invalid:
        raise ValidationError(f"Invalid risk_flags: {invalid}")
    return dedupe_preserve_order(flags)


class BlueprintService:
    """Service for blueprint-related business logic."""

    def __init__(self):
        self.repo = BlueprintRepository()
        self.contribution_repo = ContributionRepository()
        self.embedding_service = get_embedding_service()

    def create(
        self,
        data: BlueprintCreate,
        agent_id: UUID,
    ) -> BlueprintDetail:
        """
        Create a new blueprint with initial version.

        SECURITY:
        - verification_tier is ALWAYS forced to 'self_reported'
        - risk_score is computed server-side from deduplicated inputs
        - permissions and risk_flags are validated against Enums
        """
        # Generate slug if not provided
        slug = data.slug or slugify(data.title)

        # Force verification_tier to self_reported
        verification_tier = VerificationTier.SELF_REPORTED

        # Validate and deduplicate inputs
        permissions = validate_and_deduplicate_permissions(
            data.permissions_required if data.permissions_required else []
        )
        risk_flags = validate_and_deduplicate_risk_flags(
            data.risk_flags if data.risk_flags else []
        )

        # Compute risk_score from deduplicated inputs
        risk_score = calculate_risk_score(permissions, risk_flags)

        # Create blueprint
        blueprint = self.repo.create_blueprint(
            slug=slug,
            created_by_agent_id=agent_id,
            is_public=data.is_public,
        )

        # Generate embedding
        embedding = self.embedding_service.generate_blueprint_embedding(
            title=data.title,
            goal_description=data.goal_description,
            strategy=data.strategy,
            tags=data.tags,
        )

        # Create initial version with server-controlled fields
        version = self.repo.create_version(
            blueprint_id=blueprint["id"],
            version_number=1,
            title=data.title,
            goal_description=data.goal_description,
            strategy=data.strategy,
            execution_steps=[step.model_dump() for step in data.execution_steps],
            code_snippets=[snippet.model_dump() for snippet in data.code_snippets],
            context_requirements=data.context_requirements.model_dump(),
            embedding=embedding,
            created_by_agent_id=agent_id,
            # Trust Engine fields
            permissions_required=permissions,
            risk_flags=risk_flags,
            environment_constraints=data.environment_constraints.model_dump() if data.environment_constraints else {},
            verification_tier=verification_tier.value,
            risk_score=risk_score,
        )

        # Set tags
        if data.tags:
            self.repo.set_blueprint_tags(blueprint["id"], data.tags)

        # Insert contribution event for blueprint creation
        try:
            self.contribution_repo.insert_event(
                agent_id=agent_id,
                event_type=AgentEventType.PUBLISH_BLUEPRINT,
                blueprint_id=blueprint["id"],
                version_id=version["id"],
            )
        except Exception as e:
            # Log but don't fail the create operation
            logger.warning(f"Failed to insert publish_blueprint event: {e}")

        # Return full detail
        return self.get_by_slug(slug)

    def get_by_slug(self, slug: str) -> BlueprintDetail:
        """Get a blueprint by slug with full details."""
        blueprint = self.repo.get_by_slug_with_version(slug)

        if not blueprint:
            raise NotFoundError("Blueprint", slug)

        return self._to_detail(blueprint)

    def get_by_identifier(self, identifier: str) -> BlueprintDetail:
        """
        Get a blueprint by short_id or slug.

        This method supports the hybrid URL structure where blueprints
        can be accessed by either their 8-character short_id or their
        human-readable slug.
        """
        blueprint = self.repo.get_by_identifier(identifier)

        if not blueprint:
            raise NotFoundError("Blueprint", identifier)

        # Enrich with version and tags
        if blueprint.get("current_version_id"):
            version = self.repo.get_version_by_id(blueprint["current_version_id"])
            blueprint["current_version"] = version

        blueprint["tags"] = self.repo.get_blueprint_tags(blueprint["id"])

        # Fetch author info
        if blueprint.get("created_by_agent_id"):
            author = self.repo.get_agent_by_id(blueprint["created_by_agent_id"])
            blueprint["author"] = author

        return self._to_detail(blueprint)

    def list(
        self,
        limit: int = 20,
        offset: int = 0,
        status: BlueprintStatus | None = None,
        created_by_agent_id: UUID | None = None,
        is_public: bool | None = None,
        tags: list[str] | None = None,
    ) -> tuple[list[BlueprintSummary], int]:
        """List blueprints with filtering."""
        blueprints, total = self.repo.list_blueprints(
            limit=limit,
            offset=offset,
            status=status,
            created_by_agent_id=created_by_agent_id,
            is_public=is_public,
            tags=tags,
        )

        summaries = [self._to_summary(bp) for bp in blueprints]
        return summaries, total

    def update(
        self,
        slug: str,
        data: BlueprintUpdate,
        agent_id: UUID,
    ) -> BlueprintDetail:
        """
        Update a blueprint (creates new version).

        SECURITY: Same protections as create.
        - verification_tier is ALWAYS forced to 'self_reported'
        - risk_score is computed server-side from deduplicated inputs
        """
        # Get existing blueprint
        blueprint = self.repo.get_by_slug(slug)
        if not blueprint:
            raise NotFoundError("Blueprint", slug)

        # Check ownership (only owner can update)
        if str(blueprint["created_by_agent_id"]) != str(agent_id):
            raise AuthorizationError("Only the blueprint owner can update it")

        # Force tier, validate and deduplicate inputs
        verification_tier = VerificationTier.SELF_REPORTED
        permissions = validate_and_deduplicate_permissions(
            data.permissions_required if data.permissions_required else []
        )
        risk_flags = validate_and_deduplicate_risk_flags(
            data.risk_flags if data.risk_flags else []
        )
        risk_score = calculate_risk_score(permissions, risk_flags)

        # Get current version number
        version_count = self.repo.get_version_count(blueprint["id"])

        # Generate new embedding
        embedding = self.embedding_service.generate_blueprint_embedding(
            title=data.title,
            goal_description=data.goal_description,
            strategy=data.strategy,
            tags=data.tags,
        )

        # Create new version with server-controlled fields
        version = self.repo.create_version(
            blueprint_id=blueprint["id"],
            version_number=version_count + 1,
            title=data.title,
            goal_description=data.goal_description,
            strategy=data.strategy,
            execution_steps=[step.model_dump() for step in data.execution_steps],
            code_snippets=[snippet.model_dump() for snippet in data.code_snippets],
            context_requirements=data.context_requirements.model_dump(),
            embedding=embedding,
            created_by_agent_id=agent_id,
            # Trust Engine fields
            permissions_required=permissions,
            risk_flags=risk_flags,
            environment_constraints=data.environment_constraints.model_dump() if data.environment_constraints else {},
            verification_tier=verification_tier.value,
            risk_score=risk_score,
        )

        # Update tags if provided
        if data.tags is not None:
            self.repo.set_blueprint_tags(blueprint["id"], data.tags)

        # Update is_public if provided
        if data.is_public is not None:
            self.repo.update_blueprint(blueprint["id"], {"is_public": data.is_public})

        # Insert contribution event for version creation
        try:
            self.contribution_repo.insert_event(
                agent_id=agent_id,
                event_type=AgentEventType.PUBLISH_VERSION,
                blueprint_id=blueprint["id"],
                version_id=version["id"],
            )
        except Exception as e:
            # Log but don't fail the update operation
            logger.warning(f"Failed to insert publish_version event: {e}")

        return self.get_by_slug(slug)

    def update_status(
        self,
        slug: str,
        data: BlueprintStatusUpdate,
        agent_id: UUID,
    ) -> BlueprintDetail:
        """Update a blueprint's status."""
        blueprint = self.repo.get_by_slug(slug)
        if not blueprint:
            raise NotFoundError("Blueprint", slug)

        # Check ownership
        if str(blueprint["created_by_agent_id"]) != str(agent_id):
            raise AuthorizationError("Only the blueprint owner can update its status")

        self.repo.update_status(slug, data.status)
        return self.get_by_slug(slug)

    def get_versions(
        self,
        slug: str,
        limit: int = 20,
        offset: int = 0,
    ) -> list[BlueprintVersion]:
        """Get version history for a blueprint."""
        blueprint = self.repo.get_by_slug(slug)
        if not blueprint:
            raise NotFoundError("Blueprint", slug)

        versions = self.repo.list_versions(
            blueprint_id=blueprint["id"],
            limit=limit,
            offset=offset,
        )

        return [self._to_version(v) for v in versions]

    def delete(self, slug: str, agent_id: UUID) -> None:
        """Delete a blueprint."""
        blueprint = self.repo.get_by_slug(slug)
        if not blueprint:
            raise NotFoundError("Blueprint", slug)

        # Check ownership
        if str(blueprint["created_by_agent_id"]) != str(agent_id):
            raise AuthorizationError("Only the blueprint owner can delete it")

        self.repo.delete_blueprint(blueprint["id"])

    def _to_summary(self, bp: dict) -> BlueprintSummary:
        """Convert database record to summary model."""
        # Build author if present
        author = None
        if bp.get("author"):
            author = BlueprintAuthor(
                id=bp["author"]["id"],
                name=bp["author"]["name"],
                username=bp["author"].get("username"),
                publisher_domain=bp["author"].get("publisher_domain"),
            )

        return BlueprintSummary(
            id=bp["id"],
            slug=bp["slug"],
            short_id=bp.get("short_id", ""),
            title=bp.get("title", ""),
            goal_description=bp.get("goal_description", ""),
            status=bp["status"],
            is_public=bp["is_public"],
            quality_metrics=QualityMetricsEmbed(
                execution_count=bp.get("execution_count", 0),
                success_count=bp.get("success_count", 0),
                failure_count=bp.get("failure_count", 0),
                success_rate=float(bp.get("success_rate", 0)),
                upvotes=bp.get("upvotes", 0),
                downvotes=bp.get("downvotes", 0),
                score=float(bp.get("score", 0)),
            ),
            tags=bp.get("tags", []),
            created_at=bp["created_at"],
            updated_at=bp["updated_at"],
            author=author,
        )

    def _to_detail(self, bp: dict) -> BlueprintDetail:
        """Convert database record to detail model."""
        current_version = None
        if bp.get("current_version"):
            current_version = self._to_version(bp["current_version"])

        # Build author if present
        author = None
        if bp.get("author"):
            author = BlueprintAuthor(
                id=bp["author"]["id"],
                name=bp["author"]["name"],
                username=bp["author"].get("username"),
                publisher_domain=bp["author"].get("publisher_domain"),
            )

        return BlueprintDetail(
            id=bp["id"],
            slug=bp["slug"],
            short_id=bp.get("short_id", ""),
            status=bp["status"],
            is_public=bp["is_public"],
            quality_metrics=QualityMetricsEmbed(
                execution_count=bp.get("execution_count", 0),
                success_count=bp.get("success_count", 0),
                failure_count=bp.get("failure_count", 0),
                success_rate=float(bp.get("success_rate", 0)),
                upvotes=bp.get("upvotes", 0),
                downvotes=bp.get("downvotes", 0),
                score=float(bp.get("score", 0)),
            ),
            tags=bp.get("tags", []),
            created_by_agent_id=bp["created_by_agent_id"],
            created_at=bp["created_at"],
            updated_at=bp["updated_at"],
            author=author,
            current_version=current_version,
        )

    def _to_version(self, v: dict) -> BlueprintVersion:
        """Convert database record to version model."""
        # Parse environment_constraints if present
        env_constraints = None
        if v.get("environment_constraints"):
            env_constraints = EnvironmentConstraints(**v["environment_constraints"])

        return BlueprintVersion(
            id=v["id"],
            blueprint_id=v["blueprint_id"],
            version_number=v["version_number"],
            title=v["title"],
            goal_description=v["goal_description"],
            strategy=v["strategy"],
            execution_steps=v.get("execution_steps", []),
            code_snippets=v.get("code_snippets", []),
            context_requirements=v.get("context_requirements", {}),
            created_by_agent_id=v["created_by_agent_id"],
            created_at=v["created_at"],
            # Trust Engine fields
            permissions_required=v.get("permissions_required", []),
            risk_flags=v.get("risk_flags", []),
            environment_constraints=env_constraints,
            verification_tier=VerificationTier(v.get("verification_tier", "self_reported")),
            risk_score=v.get("risk_score", 0),
            verified_at=v.get("verified_at"),
        )
