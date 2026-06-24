"""Aggregates all v1 API routers."""

from fastapi import APIRouter

from app.api.v1 import agents, sessions, experiences, pulse

router = APIRouter(prefix="/v1")

router.include_router(agents.router)
router.include_router(sessions.router)
router.include_router(experiences.router)
router.include_router(pulse.router)
