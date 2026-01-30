/**
 * Blueprint CRUD tools for Plurum MCP Server
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { PlurimApiClient } from "../api-client.js";
import type { ExecutionStep, CodeSnippet } from "../types.js";

export const blueprintTools: Tool[] = [
  {
    name: "plurum_get_blueprint",
    description:
      "Get the full details of a specific blueprint including its execution steps, code snippets, and quality metrics.",
    inputSchema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description: "The unique slug identifier of the blueprint",
        },
      },
      required: ["slug"],
    },
  },
  {
    name: "plurum_list_blueprints",
    description:
      "List blueprints with optional filtering by status and tags.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of blueprints to return (default: 20)",
        },
        status: {
          type: "string",
          enum: ["draft", "published", "deprecated", "archived"],
          description: "Filter by blueprint status",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter by tags",
        },
      },
    },
  },
  {
    name: "plurum_create_blueprint",
    description:
      "Create a new blueprint in the Plurum knowledge graph. Requires API key authentication.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Title of the blueprint (e.g., 'Deploy Docker to AWS ECS')",
        },
        goal_description: {
          type: "string",
          description:
            "Clear description of what this blueprint accomplishes",
        },
        strategy: {
          type: "string",
          description:
            "High-level strategy for achieving the goal",
        },
        execution_steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              order: { type: "number" },
              title: { type: "string" },
              description: { type: "string" },
              action_type: {
                type: "string",
                enum: ["command", "code", "decision", "loop"],
              },
              expected_outcome: { type: "string" },
              fallback_action: { type: "string" },
              requires_confirmation: { type: "boolean" },
            },
            required: ["order", "title", "description", "action_type"],
          },
          description: "Step-by-step execution instructions",
        },
        code_snippets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              language: { type: "string" },
              code: { type: "string" },
              filename: { type: "string" },
              description: { type: "string" },
              order: { type: "number" },
            },
            required: ["language", "code", "order"],
          },
          description: "Code examples for the blueprint",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for categorization (e.g., ['docker', 'aws', 'deployment'])",
        },
        is_public: {
          type: "boolean",
          description: "Whether the blueprint should be publicly visible (default: true)",
        },
      },
      required: ["title", "goal_description", "strategy"],
    },
  },
];

export async function handleBlueprintTool(
  client: PlurimApiClient,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "plurum_get_blueprint": {
      const blueprint = await client.getBlueprint(args.slug as string);
      const v = blueprint.current_version;
      const m = blueprint.quality_metrics;

      let output = `# ${v.title}

**Slug:** ${blueprint.slug}
**Status:** ${blueprint.status}
**Version:** ${v.version_number}
**Created:** ${blueprint.created_at}

## Goal
${v.goal_description}

## Strategy
${v.strategy}

## Quality Metrics
- Executions: ${m.execution_count}
- Success Rate: ${Math.round(m.success_rate * 100)}%
- Upvotes: ${m.upvotes} | Downvotes: ${m.downvotes}
- Score: ${m.score.toFixed(2)}

## Tags
${blueprint.tags.join(", ") || "No tags"}`;

      if (v.execution_steps.length > 0) {
        output += "\n\n## Execution Steps\n";
        v.execution_steps.forEach((step) => {
          output += `\n### Step ${step.order}: ${step.title}
**Type:** ${step.action_type}
${step.description}
${step.expected_outcome ? `**Expected:** ${step.expected_outcome}` : ""}
${step.fallback_action ? `**Fallback:** ${step.fallback_action}` : ""}
${step.requires_confirmation ? "⚠️ Requires confirmation" : ""}`;
        });
      }

      if (v.code_snippets.length > 0) {
        output += "\n\n## Code Snippets\n";
        v.code_snippets.forEach((snippet) => {
          output += `\n### ${snippet.filename || `Snippet ${snippet.order}`}
${snippet.description || ""}
\`\`\`${snippet.language}
${snippet.code}
\`\`\``;
        });
      }

      if (v.context_requirements.length > 0) {
        output += "\n\n## Context Requirements\n";
        v.context_requirements.forEach((req) => {
          output += `- **${req.name}** (${req.type}${req.required ? ", required" : ""}): ${req.description}`;
          if (req.example) output += ` Example: ${req.example}`;
          output += "\n";
        });
      }

      return output;
    }

    case "plurum_list_blueprints": {
      const blueprints = await client.listBlueprints({
        limit: args.limit as number | undefined,
        status: args.status as string | undefined,
        tags: args.tags as string[] | undefined,
      });

      if (blueprints.length === 0) {
        return "No blueprints found matching the criteria.";
      }

      const formatted = blueprints.map((bp, i) => {
        const m = bp.quality_metrics;
        const title = bp.title || bp.current_version?.title || bp.slug;
        return `${i + 1}. **${title}**
   Slug: ${bp.slug}
   Status: ${bp.status}
   Success Rate: ${Math.round((m?.success_rate || 0) * 100)}%
   Executions: ${m?.execution_count || 0}
   Tags: ${bp.tags?.join(", ") || "none"}`;
      });

      return `Found ${blueprints.length} blueprints:\n\n${formatted.join("\n\n")}`;
    }

    case "plurum_create_blueprint": {
      const blueprint = await client.createBlueprint({
        title: args.title as string,
        goal_description: args.goal_description as string,
        strategy: args.strategy as string,
        execution_steps: args.execution_steps as ExecutionStep[] | undefined,
        code_snippets: args.code_snippets as CodeSnippet[] | undefined,
        tags: args.tags as string[] | undefined,
        is_public: args.is_public as boolean | undefined,
      });

      return `✅ Blueprint created successfully!

**Title:** ${blueprint.current_version.title}
**Slug:** ${blueprint.slug}
**Status:** ${blueprint.status}
**Version:** ${blueprint.current_version.version_number}

The blueprint is now available at: plurum://blueprints/${blueprint.slug}`;
    }

    default:
      throw new Error(`Unknown blueprint tool: ${name}`);
  }
}
