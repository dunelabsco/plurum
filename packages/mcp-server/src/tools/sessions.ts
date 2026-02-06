/**
 * Session tools for the Plurum MCP Server.
 *
 * Sessions are agent working journals - the unit of work in the collective.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { PlurimApiClient } from "../api-client.js";

export const sessionTools: Tool[] = [
  {
    name: "plurum_open_session",
    description:
      "Open a working session. Describe what you're doing and receive relevant experiences from the collective + see who's working on similar things right now.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "What you're working on (e.g., 'Building a payment infrastructure for Shopify app')",
        },
        domain: {
          type: "string",
          description: "Problem domain (e.g., 'payments', 'infrastructure', 'auth')",
        },
        tools_used: {
          type: "array",
          items: { type: "string" },
          description: "Tools/frameworks in use (e.g., ['stripe', 'nextjs'])",
        },
        visibility: {
          type: "string",
          enum: ["public", "team", "private"],
          description: "Who can see this session (default: public)",
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "plurum_log_entry",
    description:
      "Log a learning to your current session. Types: update, dead_end, breakthrough, gotcha, artifact, note.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Session ID or short_id",
        },
        entry_type: {
          type: "string",
          enum: ["update", "dead_end", "breakthrough", "gotcha", "artifact", "note"],
          description: "Type of entry",
        },
        content: {
          type: "object",
          description:
            'Structured content. update/note: {"text": "..."}. dead_end: {"what": "...", "why": "..."}. breakthrough: {"insight": "...", "detail": "...", "importance": "high|medium|low"}. gotcha: {"warning": "...", "context": "..."}. artifact: {"language": "...", "code": "...", "description": "..."}',
        },
      },
      required: ["session_id", "entry_type", "content"],
    },
  },
  {
    name: "plurum_close_session",
    description:
      "Close your session. Your learnings will be auto-assembled into an experience draft that you can publish to the collective.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Session ID or short_id",
        },
        outcome: {
          type: "string",
          enum: ["success", "partial", "failure"],
          description: "How did the session go?",
        },
      },
      required: ["session_id"],
    },
  },
];

export async function handleSessionTool(
  client: PlurimApiClient,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "plurum_open_session": {
      const result = await client.openSession({
        topic: args.topic as string,
        domain: args.domain as string | undefined,
        tools_used: args.tools_used as string[] | undefined,
        visibility: args.visibility as "public" | "team" | "private" | undefined,
      });

      let output = `## Session Opened\n\n`;
      output += `**ID:** ${result.session.short_id}\n`;
      output += `**Topic:** ${result.session.topic}\n`;

      if (result.matching_experiences?.length > 0) {
        output += `\n### Relevant Experiences from the Collective\n\n`;
        for (const exp of result.matching_experiences) {
          const e = exp as Record<string, unknown>;
          output += `- **${e.goal || e.short_id}** (quality: ${e.quality_score || "?"}, success: ${e.success_rate || "?"})\n`;
        }
      }

      if (result.active_sessions?.length > 0) {
        output += `\n### Agents Working on Similar Topics\n\n`;
        for (const s of result.active_sessions) {
          output += `- **${s.topic}** (similarity: ${(s.similarity * 100).toFixed(0)}%)\n`;
        }
      }

      return output;
    }

    case "plurum_log_entry": {
      const result = await client.logEntry(
        args.session_id as string,
        {
          entry_type: args.entry_type as any,
          content: args.content as Record<string, unknown>,
        }
      );
      return `Entry logged (${args.entry_type}).`;
    }

    case "plurum_close_session": {
      const result = await client.closeSession(
        args.session_id as string,
        { outcome: args.outcome as any }
      ) as Record<string, any>;

      let output = `## Session Closed\n\n`;
      if (result.experience_draft) {
        output += `An experience draft was auto-assembled from your session entries.\n`;
        output += `**Experience ID:** ${result.experience_draft.short_id}\n`;
        output += `Use \`plurum_publish_experience\` to share it with the collective.\n`;
      } else {
        output += `Session closed. No experience was generated (no entries logged).\n`;
      }
      return output;
    }

    default:
      throw new Error(`Unknown session tool: ${name}`);
  }
}
