/**
 * Blueprint resources for Plurum MCP Server
 */

import type { Resource, ResourceTemplate } from "@modelcontextprotocol/sdk/types.js";
import type { PlurimApiClient } from "../api-client.js";

export const blueprintResourceTemplates: ResourceTemplate[] = [
  {
    uriTemplate: "plurum://blueprints/{slug}",
    name: "Plurum Blueprint",
    description: "A blueprint from the Plurum knowledge graph",
    mimeType: "text/markdown",
  },
];

export async function handleBlueprintResource(
  client: PlurimApiClient,
  uri: string
): Promise<{ content: string; mimeType: string }> {
  // Parse URI: plurum://blueprints/{slug}
  const match = uri.match(/^plurum:\/\/blueprints\/([^/]+)$/);
  if (!match) {
    throw new Error(`Invalid blueprint URI: ${uri}`);
  }

  const slug = match[1];
  const blueprint = await client.getBlueprint(slug);
  const v = blueprint.current_version;
  const m = blueprint.quality_metrics;

  let content = `# ${v.title}

**Slug:** \`${blueprint.slug}\`
**Status:** ${blueprint.status}
**Version:** ${v.version_number}
**Public:** ${blueprint.is_public ? "Yes" : "No"}
**Created:** ${blueprint.created_at}
**Updated:** ${blueprint.updated_at}

---

## Goal

${v.goal_description}

## Strategy

${v.strategy}

---

## Quality Metrics

| Metric | Value |
|--------|-------|
| Executions | ${m.execution_count} |
| Success Rate | ${Math.round(m.success_rate * 100)}% |
| Upvotes | ${m.upvotes} |
| Downvotes | ${m.downvotes} |
| Score | ${m.score.toFixed(2)} |

## Tags

${blueprint.tags.length > 0 ? blueprint.tags.map((t) => `\`${t}\``).join(" ") : "_No tags_"}

---`;

  if (v.context_requirements.length > 0) {
    content += `

## Context Requirements

| Name | Type | Required | Description |
|------|------|----------|-------------|
${v.context_requirements.map((r) => `| ${r.name} | ${r.type} | ${r.required ? "Yes" : "No"} | ${r.description}${r.example ? ` (e.g., ${r.example})` : ""} |`).join("\n")}
`;
  }

  if (v.execution_steps.length > 0) {
    content += `

## Execution Steps

${v.execution_steps
  .map(
    (step) => `### Step ${step.order}: ${step.title}

- **Action Type:** ${step.action_type}
- **Requires Confirmation:** ${step.requires_confirmation ? "Yes" : "No"}

${step.description}

${step.expected_outcome ? `**Expected Outcome:** ${step.expected_outcome}` : ""}
${step.fallback_action ? `**Fallback Action:** ${step.fallback_action}` : ""}`
  )
  .join("\n\n---\n\n")}
`;
  }

  if (v.code_snippets.length > 0) {
    content += `

## Code Snippets

${v.code_snippets
  .map(
    (snippet) => `### ${snippet.filename || `Snippet ${snippet.order}`}

${snippet.description ? `_${snippet.description}_\n` : ""}
\`\`\`${snippet.language}
${snippet.code}
\`\`\``
  )
  .join("\n\n")}
`;
  }

  return {
    content,
    mimeType: "text/markdown",
  };
}

export async function listBlueprintResources(
  client: PlurimApiClient,
  limit = 20
): Promise<Resource[]> {
  const blueprints = await client.listBlueprints({ limit, status: "published" });

  return blueprints.map((bp) => ({
    uri: `plurum://blueprints/${bp.slug}`,
    name: bp.title || bp.current_version?.title || bp.slug,
    description: bp.goal_description || bp.current_version?.goal_description || "",
    mimeType: "text/markdown",
  }));
}
