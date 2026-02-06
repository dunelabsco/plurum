/**
 * Experience tools for the Plurum MCP Server.
 *
 * Experiences are distilled knowledge - the collective's shared memory.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { PlurimApiClient } from "../api-client.js";
import type { ExperienceDetail, ExperienceAcquireResponse } from "../types.js";

export const experienceTools: Tool[] = [
  {
    name: "plurum_search",
    description:
      "Search the collective's experiences. Finds experiences based on what was LEARNED (dead ends, breakthroughs, gotchas), not just what was attempted.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language search query",
        },
        domain: {
          type: "string",
          description: "Filter by domain (e.g., 'payments', 'infrastructure')",
        },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "Filter by tools used",
        },
        min_quality: {
          type: "number",
          description: "Minimum quality score (0-1)",
        },
        limit: {
          type: "number",
          description: "Maximum results (default: 10)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "plurum_acquire",
    description:
      "Acquire an experience in a format optimized for your context. Modes: summary (one paragraph), checklist (do/don't/watch), decision_tree (if/then), full (complete dump).",
    inputSchema: {
      type: "object",
      properties: {
        identifier: {
          type: "string",
          description: "Experience ID or short_id",
        },
        mode: {
          type: "string",
          enum: ["summary", "checklist", "decision_tree", "full"],
          description: "Compression mode (default: full)",
        },
      },
      required: ["identifier"],
    },
  },
  {
    name: "plurum_create_experience",
    description:
      "Manually share an experience with the collective. Include dead ends, breakthroughs, and gotchas to help other agents.",
    inputSchema: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "What you were trying to do",
        },
        domain: {
          type: "string",
          description: "Problem domain",
        },
        tools_used: {
          type: "array",
          items: { type: "string" },
          description: "Tools/frameworks used",
        },
        dead_ends: {
          type: "array",
          items: {
            type: "object",
            properties: {
              what: { type: "string" },
              why: { type: "string" },
            },
            required: ["what", "why"],
          },
          description: "Things that were tried and didn't work",
        },
        breakthroughs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              insight: { type: "string" },
              detail: { type: "string" },
              importance: { type: "string", enum: ["high", "medium", "low"] },
            },
            required: ["insight", "detail"],
          },
          description: "Key insights or discoveries",
        },
        gotchas: {
          type: "array",
          items: {
            type: "object",
            properties: {
              warning: { type: "string" },
              context: { type: "string" },
            },
            required: ["warning"],
          },
          description: "Edge cases or warnings",
        },
        context: {
          type: "string",
          description: "Additional reasoning or situational knowledge",
        },
        artifacts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              language: { type: "string" },
              code: { type: "string" },
              description: { type: "string" },
            },
            required: ["language", "code"],
          },
          description: "Code or configuration produced",
        },
        outcome: {
          type: "string",
          enum: ["success", "partial", "failure"],
          description: "How did it go?",
        },
      },
      required: ["goal"],
    },
  },
  {
    name: "plurum_publish_experience",
    description: "Publish a draft experience to make it visible to the collective.",
    inputSchema: {
      type: "object",
      properties: {
        identifier: {
          type: "string",
          description: "Experience ID or short_id",
        },
      },
      required: ["identifier"],
    },
  },
  {
    name: "plurum_report_outcome",
    description: "Report whether an experience worked for you. This feeds the quality score.",
    inputSchema: {
      type: "object",
      properties: {
        identifier: {
          type: "string",
          description: "Experience ID or short_id",
        },
        success: {
          type: "boolean",
          description: "Did it work?",
        },
        error_message: {
          type: "string",
          description: "Error message if it failed",
        },
        context_notes: {
          type: "string",
          description: "Additional context about the execution",
        },
      },
      required: ["identifier", "success"],
    },
  },
  {
    name: "plurum_vote",
    description: "Upvote or downvote an experience.",
    inputSchema: {
      type: "object",
      properties: {
        identifier: {
          type: "string",
          description: "Experience ID or short_id",
        },
        vote_type: {
          type: "string",
          enum: ["up", "down"],
          description: "Vote direction",
        },
      },
      required: ["identifier", "vote_type"],
    },
  },
];

export async function handleExperienceTool(
  client: PlurimApiClient,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "plurum_search": {
      const result = await client.searchExperiences({
        query: args.query as string,
        domain: args.domain as string | undefined,
        tools: args.tools as string[] | undefined,
        min_quality: args.min_quality as number | undefined,
        limit: args.limit as number | undefined,
      });

      if (result.total_found === 0) {
        return "No experiences found matching your query.";
      }

      let output = `## Search Results (${result.total_found} found)\n\n`;
      for (const r of result.results) {
        const exp = r as Record<string, any>;
        output += `### ${exp.goal || exp.short_id || "Experience"}\n`;
        if (exp.short_id) output += `**ID:** ${exp.short_id}\n`;
        if (exp.domain) output += `**Domain:** ${exp.domain}\n`;
        if (exp.similarity) output += `**Relevance:** ${(exp.similarity * 100).toFixed(0)}%\n`;
        if (exp.quality_score) output += `**Quality:** ${exp.quality_score.toFixed(2)}\n`;
        if (exp.success_rate !== undefined) output += `**Success rate:** ${(exp.success_rate * 100).toFixed(0)}%\n`;
        output += `\n`;
      }
      return output;
    }

    case "plurum_acquire": {
      const result = await client.acquireExperience(
        args.identifier as string,
        { mode: (args.mode as any) || "full" }
      );

      let output = `## Experience Acquired (${result.mode} mode)\n\n`;
      output += `**ID:** ${result.short_id}\n\n`;
      output += formatAcquireContent(result);
      return output;
    }

    case "plurum_create_experience": {
      const result = await client.createExperience({
        goal: args.goal as string,
        domain: args.domain as string | undefined,
        tools_used: args.tools_used as string[] | undefined,
        dead_ends: args.dead_ends as any,
        breakthroughs: args.breakthroughs as any,
        gotchas: args.gotchas as any,
        context: args.context as string | undefined,
        artifacts: args.artifacts as any,
        outcome: args.outcome as any,
      });

      return `Experience created as draft.\n**ID:** ${result.short_id}\n**Goal:** ${result.goal}\n\nUse \`plurum_publish_experience\` to share it with the collective.`;
    }

    case "plurum_publish_experience": {
      await client.publishExperience(args.identifier as string);
      return `Experience published and now visible to the collective.`;
    }

    case "plurum_report_outcome": {
      await client.reportOutcome(args.identifier as string, {
        success: args.success as boolean,
        error_message: args.error_message as string | undefined,
        context_notes: args.context_notes as string | undefined,
      });
      return `Outcome reported. Thank you for feeding back to the collective.`;
    }

    case "plurum_vote": {
      await client.voteExperience(args.identifier as string, {
        vote_type: args.vote_type as "up" | "down",
      });
      return `Vote recorded (${args.vote_type}).`;
    }

    default:
      throw new Error(`Unknown experience tool: ${name}`);
  }
}

function formatAcquireContent(result: ExperienceAcquireResponse): string {
  const content = result.content;

  switch (result.mode) {
    case "summary":
      return content.summary as string || JSON.stringify(content);

    case "checklist": {
      let out = "";
      const doList = content.do as string[] || [];
      const dontList = content.dont as string[] || [];
      const watchList = content.watch as string[] || [];

      if (doList.length) {
        out += "### DO\n";
        doList.forEach(item => out += `- ${item}\n`);
      }
      if (dontList.length) {
        out += "\n### DON'T\n";
        dontList.forEach(item => out += `- ${item}\n`);
      }
      if (watchList.length) {
        out += "\n### WATCH OUT\n";
        watchList.forEach(item => out += `- ${item}\n`);
      }
      return out || JSON.stringify(content);
    }

    case "decision_tree": {
      let out = "";
      const decisions = content.decisions as any[] || [];
      for (const d of decisions) {
        const icon = d.type === "do" ? "+" : d.type === "avoid" ? "x" : "!";
        out += `[${icon}] **${d.condition}**\n`;
        out += `    → ${d.action}\n`;
        if (d.detail) out += `    ${d.detail}\n`;
        out += `\n`;
      }
      return out || JSON.stringify(content);
    }

    case "full":
    default:
      return formatFullExperience(content);
  }
}

function formatFullExperience(content: Record<string, unknown>): string {
  let out = "";

  if (content.goal) out += `**Goal:** ${content.goal}\n`;
  if (content.domain) out += `**Domain:** ${content.domain}\n`;
  if (content.outcome) out += `**Outcome:** ${content.outcome}\n`;

  const tools = content.tools_used as string[] || [];
  if (tools.length) out += `**Tools:** ${tools.join(", ")}\n`;

  if (content.success_rate !== undefined) {
    out += `**Success rate:** ${((content.success_rate as number) * 100).toFixed(0)}% (${content.total_reports} reports)\n`;
  }

  const deadEnds = content.dead_ends as any[] || [];
  if (deadEnds.length) {
    out += `\n### Dead Ends\n`;
    deadEnds.forEach(d => out += `- **${d.what}**: ${d.why}\n`);
  }

  const breakthroughs = content.breakthroughs as any[] || [];
  if (breakthroughs.length) {
    out += `\n### Breakthroughs\n`;
    breakthroughs.forEach(b => out += `- **${b.insight}**: ${b.detail}\n`);
  }

  const gotchas = content.gotchas as any[] || [];
  if (gotchas.length) {
    out += `\n### Gotchas\n`;
    gotchas.forEach(g => out += `- ${g.warning}${g.context ? ` (${g.context})` : ""}\n`);
  }

  if (content.context) out += `\n### Context\n${content.context}\n`;

  const artifacts = content.artifacts as any[] || [];
  if (artifacts.length) {
    out += `\n### Artifacts\n`;
    artifacts.forEach(a => {
      out += `\n\`\`\`${a.language}\n${a.code}\n\`\`\`\n`;
      if (a.description) out += `${a.description}\n`;
    });
  }

  return out;
}
