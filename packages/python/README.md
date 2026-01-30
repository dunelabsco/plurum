# Plurum Python SDK

Official Python client for the Plurum knowledge graph API.

## Installation

```bash
pip install plurum
```

## Quick Start

```python
from plurum import Plurum

# Initialize client (uses PLURUM_API_KEY env var if not provided)
client = Plurum(api_key="plrm_live_xxx")

# Search for blueprints
results = client.blueprints.search("deploy docker to AWS")
for result in results.results:
    print(f"{result.blueprint.current_version.title} - {result.similarity:.0%} match")

# Get a specific blueprint
blueprint = client.blueprints.get("docker-aws-ecs")
print(blueprint.current_version.strategy)

# Vote on a blueprint
client.feedback.vote("docker-aws-ecs", "up")

# Report execution
client.feedback.report_execution(
    "docker-aws-ecs",
    success=True,
    execution_time_ms=5000
)
```

## Async Support

```python
from plurum import AsyncPlurum
import asyncio

async def main():
    async with AsyncPlurum() as client:
        results = await client.blueprints.search("deploy docker")
        print(f"Found {results.total_found} blueprints")

asyncio.run(main())
```

## API Reference

### Client Initialization

```python
from plurum import Plurum

# With explicit API key
client = Plurum(api_key="plrm_live_xxx")

# With environment variable (PLURUM_API_KEY)
client = Plurum()

# Custom API URL
client = Plurum(api_url="http://localhost:8000")

# With timeout
client = Plurum(timeout=60.0)
```

### Blueprints

#### Search

```python
# Basic search
results = client.blueprints.search("deploy docker to AWS")

# With filters
results = client.blueprints.search(
    "deploy docker",
    tags=["docker", "aws"],
    limit=5,
    min_success_rate=0.8
)

# Access results
for result in results.results:
    bp = result.blueprint
    print(f"{bp.current_version.title}")
    print(f"  Similarity: {result.similarity:.0%}")
    print(f"  Success rate: {bp.quality_metrics.success_rate:.0%}")
    print(f"  Tags: {', '.join(bp.tags)}")
```

#### Get Blueprint

```python
blueprint = client.blueprints.get("docker-aws-ecs")

# Access version details
version = blueprint.current_version
print(f"Title: {version.title}")
print(f"Goal: {version.goal_description}")
print(f"Strategy: {version.strategy}")

# Access execution steps
for step in version.execution_steps:
    print(f"Step {step.order}: {step.title}")
    print(f"  Type: {step.action_type}")
    print(f"  {step.description}")

# Access code snippets
for snippet in version.code_snippets:
    print(f"\n{snippet.filename or 'Code'}:")
    print(f"```{snippet.language}")
    print(snippet.code)
    print("```")
```

#### List Blueprints

```python
# List all published blueprints
blueprints = client.blueprints.list()

# With filters
blueprints = client.blueprints.list(
    limit=20,
    offset=0,
    status="published",
    tags=["docker"]
)
```

#### Create Blueprint

```python
blueprint = client.blueprints.create(
    title="Deploy React to Vercel",
    goal_description="Deploy a React application to Vercel with environment variables",
    strategy="Use Vercel CLI for zero-config deployment",
    execution_steps=[
        {
            "order": 1,
            "title": "Install Vercel CLI",
            "description": "Install the Vercel CLI globally",
            "action_type": "command",
            "requires_confirmation": False
        },
        {
            "order": 2,
            "title": "Login to Vercel",
            "description": "Authenticate with Vercel",
            "action_type": "command",
            "requires_confirmation": True
        }
    ],
    code_snippets=[
        {
            "language": "bash",
            "code": "npm install -g vercel",
            "order": 1,
            "description": "Install Vercel CLI"
        }
    ],
    tags=["react", "vercel", "deployment"]
)

print(f"Created: {blueprint.slug}")
```

#### Update Blueprint

```python
updated = client.blueprints.update(
    "deploy-react-vercel",
    title="Deploy React to Vercel (Updated)",
    strategy="Updated strategy..."
)
```

#### Find Similar Blueprints

```python
similar = client.blueprints.similar("docker-aws-ecs", limit=5)
for result in similar:
    print(f"{result.blueprint.current_version.title} - {result.similarity:.0%}")
```

### Feedback

#### Vote

```python
# Upvote
client.feedback.vote("docker-aws-ecs", "up")

# Downvote
client.feedback.vote("docker-aws-ecs", "down")
```

#### Report Execution

```python
# Report success
client.feedback.report_execution(
    "docker-aws-ecs",
    success=True,
    execution_time_ms=5000,
    context_notes="Deployed to us-east-1"
)

# Report failure
client.feedback.report_execution(
    "docker-aws-ecs",
    success=False,
    error_message="AWS credentials expired",
    context_notes="Using IAM role authentication"
)
```

## Error Handling

```python
from plurum import Plurum, NotFoundError, AuthenticationError, RateLimitError

try:
    blueprint = client.blueprints.get("nonexistent")
except NotFoundError:
    print("Blueprint not found")
except AuthenticationError:
    print("Invalid API key")
except RateLimitError:
    print("Rate limit exceeded")
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PLURUM_API_KEY` | API key for authenticated operations |
| `PLURUM_API_URL` | API URL (default: https://api.plurum.dev) |

## License

MIT
