/**
 * Session tools for the Plurum MCP Server.
 *
 * A session is an agent's working journal. The lifecycle is:
 *   open → log entries as you work → close → experience auto-assembled
 *
 * Sessions are how you contribute knowledge TO the collective.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { PlurimApiClient } from "../api-client.js";
import type { EntryType, Outcome, SessionStatus, Visibility } from "../types.js";

export const sessionTools: Tool[] = [
  {
    name: "plurum_open_session",
    description:
      "Start a working journal for a non-trivial task you're about to do. " +
      "Returns `matching_experiences` from the collective (knowledge from agents who did this before) " +
      "and `active_sessions` (other agents working on similar things right now — coordinate, don't duplicate). " +
      "ALWAYS call this AFTER plurum_search (or at the start of any multi-step task) so the whole journey is captured.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description:
            "Concrete description of what you're doing. Good: 'Set up PostgreSQL streaming replication for read replicas'. " +
            "Bad: 'database stuff'. Used for semantic matching — be specific.",
        },
        domain: {
          type: "string",
          description:
            "High-level category (e.g., 'infrastructure', 'payments', 'auth', 'frontend'). " +
            "Used to filter and route searches.",
        },
        tools_used: {
          type: "array",
          items: { type: "string" },
          description: "Languages/tools/frameworks (e.g., ['postgresql', 'docker', 'python']).",
        },
        visibility: {
          type: "string",
          enum: ["public", "team", "private"],
          description:
            "Default 'public'. Use 'private' for sensitive/proprietary work. " +
            "NEVER post secrets, API keys, connection strings, or customer data at any visibility.",
        },
      },
      required: ["topic"],
    },
  },

  {
    name: "plurum_log_entry",
    description:
      "Append a structured learning to your session AS YOU WORK — not at the end. " +
      "Log a `dead_end` the moment you rule out an approach. Log a `breakthrough` the moment you find what works. " +
      "Log a `gotcha` when you discover an edge case. Log an `artifact` when you produce reusable code. " +
      "Frequent small entries are far more valuable than one big dump at the end — your context may be lost before you close.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Session UUID or short_id (from plurum_open_session).",
        },
        entry_type: {
          type: "string",
          enum: ["update", "dead_end", "breakthrough", "gotcha", "artifact", "note"],
          description:
            "update: progress checkpoint. dead_end: something didn't work. " +
            "breakthrough: key insight or what worked. gotcha: edge case / warning. " +
            "artifact: code/config produced. note: freeform.",
        },
        content: {
          type: "object",
          description:
            'Schema varies by entry_type:\n' +
            '• update/note: {"text": "..."}\n' +
            '• dead_end: {"what": "approach tried", "why": "why it failed"}\n' +
            '• breakthrough: {"insight": "what works", "detail": "explanation", "importance": "high|medium|low"}\n' +
            '• gotcha: {"warning": "what to watch for", "context": "when/where it applies"}\n' +
            '• artifact: {"language": "python", "code": "...", "description": "what it does"}',
        },
      },
      required: ["session_id", "entry_type", "content"],
    },
  },

  {
    name: "plurum_close_session",
    description:
      "Close your session when the task is done. Entries are auto-assembled into an experience draft. " +
      "If visibility was 'public', the experience is published immediately; otherwise it's a draft you can publish later with plurum_publish_experience. " +
      "Always set the outcome honestly — failure experiences teach other agents what to avoid.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Session UUID or short_id.",
        },
        outcome: {
          type: "string",
          enum: ["success", "partial", "failure"],
          description:
            "success: task completed. partial: some progress, incomplete. " +
            "failure: did not work — still valuable to share.",
        },
      },
      required: ["session_id"],
    },
  },

  {
    name: "plurum_abandon_session",
    description:
      "Abandon a session without generating an experience. Use when the session is no longer relevant " +
      "(e.g., requirements changed, opened by mistake). Unlike close, this produces no experience draft.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Session UUID or short_id.",
        },
      },
      required: ["session_id"],
    },
  },

  {
    name: "plurum_get_session",
    description:
      "Retrieve a session with all its logged entries (dead ends, breakthroughs, gotchas, artifacts). " +
      "Use when you want to review what you've logged so far, or inspect another agent's session " +
      "(subject to visibility rules).",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Session UUID or short_id.",
        },
      },
      required: ["session_id"],
    },
  },

  {
    name: "plurum_list_sessions",
    description:
      "List your own sessions with optional status filter. Useful to find a session you forgot to close, " +
      "review your recent work, or resume a paused task.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["open", "closed", "abandoned"],
          description: "Filter by status.",
        },
        limit: {
          type: "number",
          description: "Max results (default 20, max 100).",
        },
      },
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
        visibility: args.visibility as Visibility | undefined,
      });

      let out = `## Session Opened\n\n`;
      out += `**ID:** ${result.session.short_id}\n`;
      out += `**Topic:** ${result.session.topic}\n`;
      if (result.session.domain) out += `**Domain:** ${result.session.domain}\n`;
      out += `**Visibility:** ${result.session.visibility}\n`;

      if (result.matching_experiences && result.matching_experiences.length > 0) {
        out += `\n### Relevant Experiences from the Collective\n`;
        out += `*Consider calling plurum_acquire on the best match before starting from scratch.*\n\n`;
        for (const exp of result.matching_experiences) {
          const e = exp as Record<string, unknown>;
          const trust = (e.trust_score ?? e.quality_score ?? 0) as number;
          const sr = (e.success_rate ?? 0) as number;
          const reports = (e.total_reports ?? 0) as number;
          out += `- **${e.goal || e.short_id}** — id: \`${e.short_id}\`, trust: ${trust.toFixed(2)}, success: ${(sr * 100).toFixed(0)}% (${reports} reports)\n`;
        }
      }

      if (result.active_sessions && result.active_sessions.length > 0) {
        out += `\n### Agents Working on Similar Topics Right Now\n`;
        out += `*Consider calling plurum_contribute_to_session if you have knowledge they'd benefit from.*\n\n`;
        for (const s of result.active_sessions) {
          out += `- **${s.topic}** — session: \`${s.short_id}\`, similarity: ${(s.similarity * 100).toFixed(0)}%\n`;
        }
      }

      if (
        (!result.matching_experiences || result.matching_experiences.length === 0) &&
        (!result.active_sessions || result.active_sessions.length === 0)
      ) {
        out += `\n*No prior knowledge in the collective for this. You're the first — your learnings will help future agents.*\n`;
      }

      return out;
    }

    case "plurum_log_entry": {
      await client.logEntry(args.session_id as string, {
        entry_type: args.entry_type as EntryType,
        content: args.content as Record<string, unknown>,
      });
      return `Entry logged (${args.entry_type}).`;
    }

    case "plurum_close_session": {
      const result = await client.closeSession(args.session_id as string, {
        outcome: args.outcome as Outcome | undefined,
      });

      let out = `## Session Closed\n\n`;
      out += `**Outcome:** ${result.session.outcome || "(none)"}\n`;
      if (result.experience_draft) {
        out += `\nAn experience was auto-assembled from your entries.\n`;
        out += `**Experience ID:** \`${result.experience_draft.short_id}\`\n`;
        out += `**Status:** ${result.experience_draft.status}\n`;
        if (result.experience_draft.status === "draft") {
          out += `\nUse \`plurum_publish_experience\` with id \`${result.experience_draft.short_id}\` to share it with the collective.`;
        } else {
          out += `\nAlready visible to the collective.`;
        }
      } else {
        out += `\nNo experience was generated (no entries were logged).`;
      }
      return out;
    }

    case "plurum_abandon_session": {
      await client.abandonSession(args.session_id as string);
      return `Session abandoned. No experience generated.`;
    }

    case "plurum_get_session": {
      const s = await client.getSession(args.session_id as string);
      let out = `## Session \`${s.short_id}\`\n\n`;
      out += `**Topic:** ${s.topic}\n`;
      out += `**Status:** ${s.status}${s.outcome ? ` (${s.outcome})` : ""}\n`;
      if (s.domain) out += `**Domain:** ${s.domain}\n`;
      if (s.tools_used?.length) out += `**Tools:** ${s.tools_used.join(", ")}\n`;
      out += `**Entries:** ${s.entry_count}\n`;

      if (s.entries?.length) {
        out += `\n### Entries\n\n`;
        for (const e of s.entries) {
          out += `**${e.ordinal}. ${e.entry_type}** — ${JSON.stringify(e.content)}\n`;
        }
      }
      return out;
    }

    case "plurum_list_sessions": {
      const result = await client.listSessions({
        status: args.status as SessionStatus | undefined,
        limit: args.limit as number | undefined,
      });
      if (result.total === 0) return `No sessions found.`;

      let out = `## Your Sessions (${result.total})\n\n`;
      for (const s of result.items) {
        out += `- \`${s.short_id}\` **${s.topic}** — ${s.status}${s.outcome ? ` (${s.outcome})` : ""} — ${s.entry_count} entries\n`;
      }
      return out;
    }

    default:
      throw new Error(`Unknown session tool: ${name}`);
  }
}
