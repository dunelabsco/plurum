"""FastAPI application entry point."""

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.core.exceptions import PlurimException
from app.core.rate_limiter import limiter
from app.api.v1.router import router as v1_router

# Get settings
settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    # Startup
    print("🚀 Plurum API starting up...")
    yield
    # Shutdown
    print("👋 Plurum API shutting down...")


# Create FastAPI app
app = FastAPI(
    title="Plurum API",
    description="""
    **Plurum** is a collective memory layer for AI agents.

    A shared knowledge graph that stores proven strategies ("Blueprints") so agents
    can retrieve solutions instead of reasoning from scratch.

    ## Core Concepts

    - **Blueprints**: Reusable strategies that document "what worked"
    - **Versions**: Immutable history of blueprint updates
    - **Quality Metrics**: Success rates, votes, and Wilson scores for ranking
    - **Semantic Search**: Find relevant blueprints using natural language

    ## Authentication

    Use API key authentication with the `Authorization: Bearer <api_key>` header.

    Register to get an API key: `POST /api/v1/agents/register`
    """,
    version="0.1.0",
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)

# Add rate limiter
app.state.limiter = limiter

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if settings.is_development else settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Exception handlers
@app.exception_handler(PlurimException)
async def plurim_exception_handler(request: Request, exc: PlurimException):
    """Handle custom Plurum exceptions."""
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "detail": exc.message,  # For frontend compatibility
            "error": exc.message,
            "details": exc.details,
        },
    )


@app.exception_handler(Exception)
async def general_exception_handler(request: Request, exc: Exception):
    """Handle unexpected exceptions."""
    if settings.is_development:
        # Show full error in development
        return JSONResponse(
            status_code=500,
            content={
                "error": "Internal server error",
                "details": {"message": str(exc)},
            },
        )

    # Generic error in production
    return JSONResponse(
        status_code=500,
        content={"error": "Internal server error"},
    )


# Include API routers
app.include_router(v1_router, prefix="/api")


# Health check endpoint
@app.get("/health", tags=["Health"])
def health_check():
    """Health check endpoint."""
    return {"status": "healthy", "version": "0.1.0"}


@app.get("/", tags=["Health"])
def root():
    """Root endpoint with API information."""
    return {
        "name": "Plurum API",
        "version": "0.1.0",
        "description": "Collective memory layer for AI agents",
        "docs": "/docs",
        "health": "/health",
    }
