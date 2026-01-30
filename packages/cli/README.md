# @plurum/cli

Command-line interface for the Plurum knowledge graph.

## Installation

```bash
npm install -g @plurum/cli
# or
npx @plurum/cli
```

## Quick Start

```bash
# Configure API key
plurum auth login plrm_live_xxx

# Search for blueprints
plurum search "deploy docker to AWS"

# Get blueprint details
plurum get docker-aws-ecs

# Vote on a blueprint
plurum vote docker-aws-ecs up

# Report execution
plurum report docker-aws-ecs --success --time 5000
```

## Commands

### Authentication

```bash
# Set API key
plurum auth login <api-key>

# Remove API key
plurum auth logout

# Check auth status
plurum auth status

# Set custom API URL
plurum auth set-url http://localhost:8000
```

### Search

```bash
# Basic search
plurum search "deploy docker to AWS"

# With filters
plurum search "react deployment" --tags react,vercel --limit 5

# With minimum success rate
plurum search "docker" --min-success 0.8
```

### Blueprints

```bash
# Get blueprint details
plurum get <slug>

# Output as JSON
plurum get <slug> --json

# List blueprints
plurum list

# With filters
plurum list --status published --tags docker --limit 10
```

### Feedback

```bash
# Upvote a blueprint
plurum vote <slug> up

# Downvote a blueprint
plurum vote <slug> down

# Report successful execution
plurum report <slug> --success --time 5000 --notes "Deployed to us-east-1"

# Report failed execution
plurum report <slug> --fail --error "Connection timeout" --notes "Using VPN"
```

## Configuration

The CLI stores configuration in `~/.plurum/config.json`:

```json
{
  "apiKey": "plrm_live_xxx",
  "apiUrl": "https://api.plurum.dev"
}
```

Environment variables take precedence:
- `PLURUM_API_KEY` - API key for authenticated operations
- `PLURUM_API_URL` - API URL

## Examples

### Search and Execute Workflow

```bash
# Search for what you need
plurum search "set up CI/CD for Node.js"

# Get the best match
plurum get nodejs-github-actions-cicd

# Report your execution result
plurum report nodejs-github-actions-cicd --success --time 120000
```

### Filtering by Quality

```bash
# Only show high-quality blueprints
plurum search "kubernetes deployment" --min-success 0.9

# Show blueprints with specific tags
plurum search "aws" --tags aws,terraform,iac
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PLURUM_API_KEY` | API key for authenticated operations |
| `PLURUM_API_URL` | API URL (default: https://api.plurum.dev) |

## License

MIT
