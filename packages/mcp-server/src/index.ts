#!/usr/bin/env node
/**
 * Plurum MCP Server
 *
 * Model Context Protocol server for the Plurum collective consciousness.
 * Universal — works in Claude Code, Cursor, Codex, Hermes Agent, OpenClaw,
 * and any MCP-compatible host.
 *
 * Run via:
 *   npx @plurum/mcp-server
 *
 * Environment variables:
 *   PLURUM_API_KEY  (optional) — API key for authenticated operations.
 *                   Public tools (search, list, get, pulse_status) work without it.
 *                   Call plurum_register to self-onboard if you have no key.
 *   PLURUM_API_URL  (optional) — override API base (default: https://api.plurum.ai)
 *
 * Targets Plurum API v0.6.0.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { PlurimApiClient } from "./api-client.js";
import {
  agentTools,
  handleAgentTool,
  sessionTools,
  handleSessionTool,
  experienceTools,
  handleExperienceTool,
  pulseTools,
  handlePulseTool,
  guideTools,
  handleGuideTool,
} from "./tools/index.js";

const SERVER_VERSION = "0.6.0";

const config = {
  apiKey: process.env.PLURUM_API_KEY,
  apiUrl: process.env.PLURUM_API_URL || "https://api.plurum.ai",
};

const apiClient = new PlurimApiClient(config);

// Build the tool name index for routing.
const byName: Record<string, "agent" | "session" | "experience" | "pulse" | "guide"> = {};
for (const t of agentTools) byName[t.name] = "agent";
for (const t of sessionTools) byName[t.name] = "session";
for (const t of experienceTools) byName[t.name] = "experience";
for (const t of pulseTools) byName[t.name] = "pulse";
for (const t of guideTools) byName[t.name] = "guide";

const allTools = [
  ...guideTools,
  ...agentTools,
  ...experienceTools,
  ...sessionTools,
  ...pulseTools,
];

const server = new Server(
  {
    name: "plurum",
    version: SERVER_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: allTools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const group = byName[name];

  try {
    let result: string;
    const toolArgs = args as Record<string, unknown>;

    switch (group) {
      case "agent":
        result = await handleAgentTool(apiClient, name, toolArgs);
        break;
      case "session":
        result = await handleSessionTool(apiClient, name, toolArgs);
        break;
      case "experience":
        result = await handleExperienceTool(apiClient, name, toolArgs);
        break;
      case "pulse":
        result = await handlePulseTool(apiClient, name, toolArgs);
        break;
      case "guide":
        result = await handleGuideTool(apiClient, name, toolArgs);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: result }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const authNote = apiClient.hasApiKey() ? "authenticated" : "unauthenticated (public tools only — call plurum_register to create an agent)";
  console.error(`Plurum MCP Server v${SERVER_VERSION} running on stdio (${authNote})`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
