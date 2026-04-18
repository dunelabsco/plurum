"""Aggregates all v1 API routers."""

from fastapi import APIRouter

from app.api.v1 import agents, sessions, experiences, pulse, memories, profile

router = APIRouter(prefix="/v1")

router.include_router(agents.router)
router.include_router(sessions.router)
router.include_router(experiences.router)
router.include_router(pulse.router)
router.include_router(memories.router)
router.include_router(profile.router)
