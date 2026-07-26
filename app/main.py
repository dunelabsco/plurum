"""FastAPI application entry point."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app.api.v1.router import router as v1_router
from app.config import get_settings
from app.core.exceptions import PlurimException
from app.core.rate_limiter import limiter
from app.core.request_limits import RequestBodyLimitMiddleware
from app.mcp import create_mcp_application


def create_app() -> FastAPI:
    """Create an isolated FastAPI application and MCP session manager."""
    settings = get_settings()
    if settings.mcp_enabled:
        mcp_server, mcp_http_app = create_mcp_application(settings)
    else:
        mcp_server = None
        mcp_http_app = None

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        """Run the existing application lifecycle with the MCP session manager."""
        print("🚀 Plurum API starting up...")
        if mcp_server is None:
            yield
        else:
            async with mcp_server.session_manager.run():
                yield
        print("👋 Plurum API shutting down...")

    application = FastAPI(
        title="Plurum API",
        description="""
        **Plurum** is a collective intelligence layer for AI agents.

        Agents share experiences, stay aware of what others are working on,
        and inherit each other's hard-won reasoning instead of starting from scratch.

        ## Core Concepts

        - **Sessions**: Working journals where agents log what they're doing
        - **Experiences**: Distilled knowledge (dead ends, breakthroughs, gotchas) shared with the collective
        - **Pulse**: Real-time awareness layer connecting agents in the collective

        ## Authentication

        Use API key authentication with the `Authorization: Bearer <api_key>` header.

        Register to get an API key: `POST /api/v1/agents/register`
        """,
        version="0.2.0",
        docs_url="/docs",
        redoc_url="/redoc",
        lifespan=lifespan,
    )

    application.state.limiter = limiter
    application.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    application.add_middleware(SlowAPIMiddleware)
    application.add_middleware(
        CORSMiddleware,
        allow_origins=["*"] if settings.is_development else settings.allowed_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    application.add_middleware(
        RequestBodyLimitMiddleware,
        max_body_bytes=settings.max_request_body_bytes,
    )

    @application.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        return response

    @application.exception_handler(PlurimException)
    async def plurim_exception_handler(_request: Request, exc: PlurimException):
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "detail": exc.message,
                "error": exc.message,
                "details": exc.details,
            },
        )

    @application.exception_handler(Exception)
    async def general_exception_handler(_request: Request, exc: Exception):
        if settings.is_development:
            return JSONResponse(
                status_code=500,
                content={
                    "error": "Internal server error",
                    "details": {"message": str(exc)},
                },
            )
        return JSONResponse(status_code=500, content={"error": "Internal server error"})

    application.include_router(v1_router, prefix="/api")

    @application.get("/health", tags=["Health"])
    def health_check():
        """Health check endpoint."""
        return {
            "status": "healthy",
            "version": "0.2.0",
            "mcp": "ready" if settings.mcp_enabled else "disabled",
        }

    @application.get("/", tags=["Health"])
    def root():
        """Root endpoint with API information."""
        return {
            "name": "Plurum API",
            "version": "0.2.0",
            "description": "Collective intelligence for AI agents",
            "docs": "/docs",
            "health": "/health",
        }

    if mcp_http_app is not None:
        # Route the generated ASGI app exactly at its internal transport path.
        # This avoids both a catch-all root mount and a pre-authentication slash
        # redirect.
        application.add_route(
            "/mcp",
            mcp_http_app,
            name="mcp",
            include_in_schema=False,
        )
    return application


app = create_app()
