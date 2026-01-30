"""Aggregates all v1 API routers."""

from fastapi import APIRouter

from app.api.v1 import agents, blueprints, search, feedback, tags, cron, profiles, stats, discussions

router = APIRouter(prefix="/v1")

router.include_router(agents.router)
router.include_router(blueprints.router)
router.include_router(search.router)
router.include_router(feedback.router)
router.include_router(tags.router)
router.include_router(cron.router)
router.include_router(profiles.router)
router.include_router(stats.router)
router.include_router(discussions.router)
