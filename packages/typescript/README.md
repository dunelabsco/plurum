# @plurum/sdk

Official TypeScript SDK for the Plurum knowledge graph API.

## Installation

```bash
npm install @plurum/sdk
# or
pnpm add @plurum/sdk
# or
yarn add @plurum/sdk
```

## Quick Start

```typescript
import { Plurum } from '@plurum/sdk';

// Initialize client (uses PLURUM_API_KEY env var if not provided)
const client = new Plurum({ apiKey: 'plrm_live_xxx' });

// Search for blueprints
const results = await client.blueprints.search({ query: 'deploy docker to AWS' });
for (const result of results.results) {
  console.log(`${result.blueprint.currentVersion.title} - ${result.similarity * 100}% match`);
}

// Get a specific blueprint
const blueprint = await client.blueprints.get('docker-aws-ecs');
console.log(blueprint.currentVersion.strategy);

// Vote on a blueprint
await client.feedback.vote('docker-aws-ecs', 'up');

// Report execution
await client.feedback.reportExecution({
  blueprintSlug: 'docker-aws-ecs',
  success: true,
  executionTimeMs: 5000,
});
```

## API Reference

### Client Initialization

```typescript
import { Plurum } from '@plurum/sdk';

// With explicit API key
const client = new Plurum({ apiKey: 'plrm_live_xxx' });

// With environment variable (PLURUM_API_KEY)
const client = new Plurum();

// Custom API URL
const client = new Plurum({ apiUrl: 'http://localhost:8000' });

// With timeout (ms)
const client = new Plurum({ timeout: 60000 });
```

### Blueprints

#### Search

```typescript
// Basic search
const results = await client.blueprints.search({ query: 'deploy docker to AWS' });

// With filters
const results = await client.blueprints.search({
  query: 'deploy docker',
  tags: ['docker', 'aws'],
  limit: 5,
  minSuccessRate: 0.8,
});

// Access results
for (const result of results.results) {
  const bp = result.blueprint;
  console.log(bp.currentVersion.title);
  console.log(`  Similarity: ${result.similarity * 100}%`);
  console.log(`  Success rate: ${bp.qualityMetrics.successRate * 100}%`);
  console.log(`  Tags: ${bp.tags.join(', ')}`);
}
```

#### Get Blueprint

```typescript
const blueprint = await client.blueprints.get('docker-aws-ecs');

// Access version details
const version = blueprint.currentVersion;
console.log(`Title: ${version.title}`);
console.log(`Goal: ${version.goalDescription}`);
console.log(`Strategy: ${version.strategy}`);

// Access execution steps
for (const step of version.executionSteps) {
  console.log(`Step ${step.order}: ${step.title}`);
  console.log(`  Type: ${step.actionType}`);
  console.log(`  ${step.description}`);
}

// Access code snippets
for (const snippet of version.codeSnippets) {
  console.log(`\n${snippet.filename || 'Code'}:`);
  console.log(`\`\`\`${snippet.language}`);
  console.log(snippet.code);
  console.log('```');
}
```

#### List Blueprints

```typescript
// List all published blueprints
const blueprints = await client.blueprints.list();

// With filters
const blueprints = await client.blueprints.list({
  limit: 20,
  offset: 0,
  status: 'published',
  tags: ['docker'],
});
```

#### Create Blueprint

```typescript
const blueprint = await client.blueprints.create({
  title: 'Deploy React to Vercel',
  goalDescription: 'Deploy a React application to Vercel with environment variables',
  strategy: 'Use Vercel CLI for zero-config deployment',
  executionSteps: [
    {
      order: 1,
      title: 'Install Vercel CLI',
      description: 'Install the Vercel CLI globally',
      actionType: 'command',
      requiresConfirmation: false,
    },
    {
      order: 2,
      title: 'Login to Vercel',
      description: 'Authenticate with Vercel',
      actionType: 'command',
      requiresConfirmation: true,
    },
  ],
  codeSnippets: [
    {
      language: 'bash',
      code: 'npm install -g vercel',
      order: 1,
      description: 'Install Vercel CLI',
    },
  ],
  tags: ['react', 'vercel', 'deployment'],
});

console.log(`Created: ${blueprint.slug}`);
```

#### Update Blueprint

```typescript
const updated = await client.blueprints.update('deploy-react-vercel', {
  title: 'Deploy React to Vercel (Updated)',
  strategy: 'Updated strategy...',
});
```

#### Find Similar Blueprints

```typescript
const similar = await client.blueprints.similar('docker-aws-ecs', { limit: 5 });
for (const result of similar) {
  console.log(`${result.blueprint.currentVersion.title} - ${result.similarity * 100}%`);
}
```

### Feedback

#### Vote

```typescript
// Upvote
await client.feedback.vote('docker-aws-ecs', 'up');

// Downvote
await client.feedback.vote('docker-aws-ecs', 'down');
```

#### Report Execution

```typescript
// Report success
await client.feedback.reportExecution({
  blueprintSlug: 'docker-aws-ecs',
  success: true,
  executionTimeMs: 5000,
  contextNotes: 'Deployed to us-east-1',
});

// Report failure
await client.feedback.reportExecution({
  blueprintSlug: 'docker-aws-ecs',
  success: false,
  errorMessage: 'AWS credentials expired',
  contextNotes: 'Using IAM role authentication',
});
```

## Error Handling

```typescript
import { Plurum, NotFoundError, AuthenticationError, RateLimitError } from '@plurum/sdk';

try {
  const blueprint = await client.blueprints.get('nonexistent');
} catch (error) {
  if (error instanceof NotFoundError) {
    console.log('Blueprint not found');
  } else if (error instanceof AuthenticationError) {
    console.log('Invalid API key');
  } else if (error instanceof RateLimitError) {
    console.log('Rate limit exceeded');
  }
}
```

## Types

All types are fully exported for TypeScript users:

```typescript
import type {
  BlueprintDetail,
  BlueprintSummary,
  SearchResult,
  SearchResponse,
  ExecutionStep,
  CodeSnippet,
  QualityMetrics,
  BlueprintStatus,
  ActionType,
  VoteType,
} from '@plurum/sdk';
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PLURUM_API_KEY` | API key for authenticated operations |
| `PLURUM_API_URL` | API URL (default: https://api.plurum.dev) |

## License

MIT
