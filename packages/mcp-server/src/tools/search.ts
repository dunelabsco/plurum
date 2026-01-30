/**
 * Search tools for Plurum MCP Server
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { PlurimApiClient } from "../api-client.js";

export const searchTools: Tool[] = [
  {
    name: "plurum_search",
    description:
      "Search for blueprints in the Plurum knowledge graph using semantic similarity. Returns matching blueprints with relevance scores.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural language search query describing what you want to accomplish (e.g., 'deploy docker container to AWS ECS')",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional tags to filter results (e.g., ['docker', 'aws'])",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (default: 10)",
        },
        min_success_rate: {
          type: "number",
          description:
            "Minimum success rate filter, 0-1 (e.g., 0.8 for 80% success rate)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "plurum_similar",
    description:
      "Find blueprints similar to a given blueprint. Useful for discovering related strategies.",
    inputSchema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description: "The slug of the blueprint to find similar items for",
        },
        limit: {
          type: "number",
          description: "Maximum number of similar blueprints to return (default: 5)",
        },
      },
      required: ["slug"],
    },
  },
];

export async function handleSearchTool(
  client: PlurimApiClient,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "plurum_search": {
      const results = await client.search({
        query: args.query as string,
        tags: args.tags as string[] | undefined,
        limit: args.limit as number | undefined,
        min_success_rate: args.min_success_rate as number | undefined,
      });

      if (results.results.length === 0) {
        return `No blueprints found for query: "${results.query}"`;
      }

      const formatted = results.results.map((r, i) => {
        const bp = r.blueprint;
        const metrics = bp.quality_metrics;
        // API returns title directly on blueprint for search results
        const title = bp.title || bp.current_version?.title || "Untitled";
        return `${i + 1}. **${title}**
   Slug: ${bp.slug}
   Match: ${Math.round(r.similarity * 100)}%
   Success Rate: ${Math.round((metrics?.success_rate || 0) * 100)}%
   Executions: ${metrics?.execution_count || 0}
   Score: ${(metrics?.score || 0).toFixed(2)}
   Tags: ${bp.tags?.join(", ") || "none"}
   ${r.match_reasons?.length > 0 ? `Why: ${r.match_reasons.join(", ")}` : ""}`;
      });

      return `Found ${results.total_found} blueprints for "${results.query}":\n\n${formatted.join("\n\n")}`;
    }

    case "plurum_similar": {
      const results = await client.getSimilar(args.slug as string, {
        limit: args.limit as number | undefined,
      });

      if (results.length === 0) {
        return `No similar blueprints found for: ${args.slug}`;
      }

      const formatted = results.map((r, i) => {
        const bp = r.blueprint;
        const metrics = bp.quality_metrics;
        const title = bp.title || bp.current_version?.title || "Untitled";
        return `${i + 1}. **${title}**
   Slug: ${bp.slug}
   Similarity: ${Math.round(r.similarity * 100)}%
   Success Rate: ${Math.round((metrics?.success_rate || 0) * 100)}%
   Tags: ${bp.tags?.join(", ") || "none"}`;
      });

      return `Similar blueprints to "${args.slug}":\n\n${formatted.join("\n\n")}`;
    }

    default:
      throw new Error(`Unknown search tool: ${name}`);
  }
}
