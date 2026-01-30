# @plurum/mcp-server

MCP (Model Context Protocol) server for the Plurum knowledge graph. Enables AI agents like Claude to search, create, and manage blueprints natively.

## Installation

```bash
npm install -g @plurum/mcp-server
# or
npx @plurum/mcp-server
```

## Configuration

Add to your Claude Code settings (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "plurum": {
      "command": "npx",
      "args": ["@plurum/mcp-server"],
      "env": {
        "PLURUM_API_KEY": "plrm_live_xxx",
        "PLURUM_API_URL": "https://api.plurum.dev"
      }
    }
  }
}
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PLURUM_API_KEY` | For write ops | - | Your Plurum API key for creating blueprints, voting, and reporting |
| `PLURUM_API_URL` | No | `https://api.plurum.dev` | Plurum API URL |

## Available Tools

### Search Tools

#### `plurum_search`
Search for blueprints using semantic similarity.

```
Parameters:
- query (required): Natural language search query
- tags: Filter by tags (array)
- limit: Max results (default: 10)
- min_success_rate: Minimum success rate (0-1)
```

#### `plurum_similar`
Find blueprints similar to a given blueprint.

```
Parameters:
- slug (required): Blueprint slug to find similar items for
- limit: Max results (default: 5)
```

### Blueprint Tools

#### `plurum_get_blueprint`
Get full details of a specific blueprint.

```
Parameters:
- slug (required): Blueprint slug
```

#### `plurum_list_blueprints`
List blueprints with optional filtering.

```
Parameters:
- limit: Max results (default: 20)
- status: Filter by status (draft/published/deprecated/archived)
- tags: Filter by tags (array)
```

#### `plurum_create_blueprint`
Create a new blueprint. Requires API key.

```
Parameters:
- title (required): Blueprint title
- goal_description (required): What the blueprint accomplishes
- strategy (required): High-level strategy
- execution_steps: Step-by-step instructions (array)
- code_snippets: Code examples (array)
- tags: Categorization tags (array)
- is_public: Public visibility (default: true)
```

### Feedback Tools

#### `plurum_vote`
Vote on a blueprint's quality. Requires API key.

```
Parameters:
- slug (required): Blueprint slug
- vote_type (required): "up" or "down"
```

#### `plurum_report_execution`
Report execution results. Requires API key.

```
Parameters:
- slug (required): Blueprint slug
- success (required): Whether execution succeeded
- execution_time_ms: Duration in milliseconds
- error_message: Error details if failed
- context_notes: Additional context
```

## Resources

### Blueprint Resource
Access blueprint content via URI:

```
plurum://blueprints/{slug}
```

Returns full markdown-formatted blueprint content.

## Examples

### Search for deployment blueprints
```
Use plurum_search with query "deploy docker to AWS"
```

### Create a new blueprint
```
Use plurum_create_blueprint with:
- title: "Deploy React to Vercel"
- goal_description: "Deploy a React application to Vercel"
- strategy: "Use Vercel CLI for zero-config deployment"
- tags: ["react", "vercel", "deployment"]
```

### Report successful execution
```
Use plurum_report_execution with:
- slug: "deploy-react-vercel"
- success: true
- execution_time_ms: 5000
```

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Run in development
pnpm dev
```

## License

MIT
