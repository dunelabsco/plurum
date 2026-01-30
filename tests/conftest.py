"""Pytest configuration and fixtures."""

import os
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient


# Set test environment variables before importing app
os.environ.setdefault("SUPABASE_URL", "https://test.supabase.co")
os.environ.setdefault("SUPABASE_DB_URL", "postgresql://test:test@localhost:5432/test")
os.environ.setdefault("SUPABASE_KEY", "test-key")
os.environ.setdefault("OPENAI_API_KEY", "sk-test")
os.environ.setdefault("ENVIRONMENT", "development")


@pytest.fixture
def mock_supabase():
    """Mock Supabase client."""
    with patch("app.db.supabase_client.create_client") as mock:
        client = MagicMock()
        mock.return_value = client
        yield client


@pytest.fixture
def mock_openai():
    """Mock OpenAI client."""
    with patch("app.services.embedding_service.OpenAI") as mock:
        client = MagicMock()
        # Mock embedding response
        embedding_response = MagicMock()
        embedding_response.data = [MagicMock(embedding=[0.1] * 1536, index=0)]
        client.embeddings.create.return_value = embedding_response
        mock.return_value = client
        yield client


@pytest.fixture
def client(mock_supabase, mock_openai):
    """Create test client with mocked dependencies."""
    from app.main import app

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def auth_headers():
    """Create authentication headers."""
    return {"Authorization": "Bearer plrm_live_test123456789"}


@pytest.fixture
def mock_agent():
    """Mock authenticated agent data."""
    return {
        "id": "00000000-0000-0000-0000-000000000001",
        "name": "test-agent",
        "api_key_hash": "test-hash",
        "api_key_prefix": "plrm_live_test...",
        "is_active": True,
        "rate_limit_tier": "standard",
        "subscription_tier": "free",
        "credits_balance": 0,
        "created_at": "2024-01-01T00:00:00Z",
        "updated_at": "2024-01-01T00:00:00Z",
        "last_active_at": None,
    }


@pytest.fixture
def sample_blueprint_create():
    """Sample blueprint creation data."""
    return {
        "title": "Deploy Python API to AWS Lambda",
        "goal_description": "Deploy a FastAPI application to AWS Lambda with API Gateway",
        "strategy": "Use AWS SAM CLI for local testing and deployment. Configure layers for dependencies.",
        "execution_steps": [
            {
                "order": 1,
                "title": "Install SAM CLI",
                "description": "Install AWS SAM CLI using pip or homebrew",
                "action_type": "command",
                "expected_outcome": "SAM CLI available in PATH",
            },
            {
                "order": 2,
                "title": "Create SAM template",
                "description": "Create template.yaml with Lambda and API Gateway config",
                "action_type": "code",
                "expected_outcome": "Valid SAM template file",
            },
        ],
        "code_snippets": [
            {
                "language": "yaml",
                "code": "AWSTemplateFormatVersion: '2010-09-09'\nTransform: AWS::Serverless-2016-10-31",
                "description": "SAM template header",
            }
        ],
        "context_requirements": {
            "tools": ["aws-cli", "sam-cli"],
            "permissions": ["lambda:CreateFunction", "apigateway:*"],
        },
        "tags": ["python", "aws", "deployment"],
    }
