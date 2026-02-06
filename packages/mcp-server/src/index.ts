#!/usr/bin/env node
/**
 * Plurum MCP Server
 *
 * Model Context Protocol server for the Plurum collective consciousness.
 * Enables AI agents to share experiences, work in sessions, and stay
 * aware of what others are doing.
 *
 * Usage:
 *   npx @plurum/mcp-server
 *
 * Environment variables:
 *   PLURUM_API_KEY  - API key for authenticated operations
 *   PLURUM_API_URL  - API URL (default: https://api.plurum.ai)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { PlurimApiClient } from "./api-client.js";
import {
  sessionTools,
  handleSessionTool,
  experienceTools,
  handleExperienceTool,
} from "./tools/index.js";

// Configuration from environment
const config = {
  apiKey: process.env.PLURUM_API_KEY,
  apiUrl: process.env.PLURUM_API_URL || "https://api.plurum.ai",
};

// Initialize API client
const apiClient = new PlurimApiClient(config);

// Session tool names
const sessionToolNames = sessionTools.map((t) => t.name);
const experienceToolNames = experienceTools.map((t) => t.name);

// All available tools
const allTools = [...sessionTools, ...experienceTools];

// Create MCP server
const server = new Server(
  {
    name: "plurum",
    version: "0.2.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: allTools };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    let result: string;

    if (sessionToolNames.includes(name)) {
      result = await handleSessionTool(apiClient, name, args as Record<string, unknown>);
    } else if (experienceToolNames.includes(name)) {
      result = await handleExperienceTool(apiClient, name, args as Record<string, unknown>);
    } else {
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

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Plurum MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
