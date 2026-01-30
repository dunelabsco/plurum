/**
 * Feedback tools for Plurum MCP Server
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { PlurimApiClient } from "../api-client.js";
import type { VoteType } from "../types.js";

export const feedbackTools: Tool[] = [
  {
    name: "plurum_vote",
    description:
      "Vote on a blueprint to indicate its quality. Upvote helpful blueprints, downvote unhelpful ones. Requires API key authentication.",
    inputSchema: {
      type: "object",
      properties: {
        identifier: {
          type: "string",
          description: "The blueprint identifier (short_id or slug)",
        },
        vote_type: {
          type: "string",
          enum: ["up", "down"],
          description: "The type of vote: 'up' for helpful, 'down' for unhelpful",
        },
      },
      required: ["identifier", "vote_type"],
    },
  },
  {
    name: "plurum_report_execution",
    description:
      "Report the result of executing a blueprint. This helps track success rates and improve blueprint quality. Requires API key authentication.",
    inputSchema: {
      type: "object",
      properties: {
        identifier: {
          type: "string",
          description: "The blueprint identifier (short_id or slug)",
        },
        success: {
          type: "boolean",
          description: "Whether the execution was successful",
        },
        execution_time_ms: {
          type: "number",
          description: "How long the execution took in milliseconds",
        },
        error_message: {
          type: "string",
          description: "Error message if the execution failed",
        },
        context_notes: {
          type: "string",
          description:
            "Additional context about the execution environment or modifications made",
        },
        version_id: {
          type: "string",
          description: "Specific version ID that was executed. If not provided, current version is used.",
        },
        env_fingerprint: {
          type: "object",
          description: "Observed runtime environment",
          properties: {
            os: { type: "string" },
            os_version: { type: "string" },
            runtime: { type: "string" },
            runtime_version: { type: "string" },
            arch: { type: "string" },
          },
        },
        error_signature: {
          type: "string",
          description: "Normalized error pattern for grouping failures",
        },
        cost_usd: {
          type: "number",
          description: "Token/compute cost in USD",
        },
      },
      required: ["identifier", "success"],
    },
  },
];

export async function handleFeedbackTool(
  client: PlurimApiClient,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "plurum_vote": {
      await client.vote({
        blueprint_identifier: args.identifier as string,
        vote_type: args.vote_type as VoteType,
      });

      const emoji = args.vote_type === "up" ? "👍" : "👎";
      return `${emoji} Vote recorded for blueprint "${args.identifier}"`;
    }

    case "plurum_report_execution": {
      await client.reportExecution({
        blueprint_identifier: args.identifier as string,
        success: args.success as boolean,
        execution_time_ms: args.execution_time_ms as number | undefined,
        error_message: args.error_message as string | undefined,
        context_notes: args.context_notes as string | undefined,
        version_id: args.version_id as string | undefined,
        env_fingerprint: args.env_fingerprint as Record<string, string> | undefined,
        error_signature: args.error_signature as string | undefined,
        cost_usd: args.cost_usd as number | undefined,
      });

      const emoji = args.success ? "✅" : "❌";
      const status = args.success ? "Success" : "Failure";
      let message = `${emoji} Execution report recorded for "${args.identifier}"\n\n**Status:** ${status}`;

      if (args.execution_time_ms) {
        message += `\n**Duration:** ${args.execution_time_ms}ms`;
      }
      if (args.error_message) {
        message += `\n**Error:** ${args.error_message}`;
      }
      if (args.context_notes) {
        message += `\n**Notes:** ${args.context_notes}`;
      }

      message += "\n\nThank you for helping improve blueprint quality!";
      return message;
    }

    default:
      throw new Error(`Unknown feedback tool: ${name}`);
  }
}
