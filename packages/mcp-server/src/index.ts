#!/usr/bin/env node
/**
 * Plurum MCP Server
 *
 * Model Context Protocol server for the Plurum knowledge graph.
 * Enables AI agents to search, create, and manage blueprints.
 *
 * Usage:
 *   npx @plurum/mcp-server
 *
 * Environment variables:
 *   PLURUM_API_KEY  - API key for authenticated operations (optional for read-only)
 *   PLURUM_API_URL  - API URL (default: https://api.plurum.ai)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { PlurimApiClient } from "./api-client.js";
import {
  searchTools,
  handleSearchTool,
  blueprintTools,
  handleBlueprintTool,
  feedbackTools,
  handleFeedbackTool,
  discussionTools,
  handleDiscussionTool,
} from "./tools/index.js";
import {
  blueprintResourceTemplates,
  handleBlueprintResource,
  listBlueprintResources,
} from "./resources/index.js";

// Configuration from environment
const config = {
  apiKey: process.env.PLURUM_API_KEY,
  apiUrl: process.env.PLURUM_API_URL || "https://api.plurum.ai",
};

// Initialize API client
const apiClient = new PlurimApiClient(config);

// All available tools
const allTools = [...searchTools, ...blueprintTools, ...feedbackTools, ...discussionTools];

// Create MCP server
const server = new Server(
  {
    name: "plurum",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: allTools,
  };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    let result: string;

    // Route to appropriate handler
    if (["plurum_search", "plurum_similar"].includes(name)) {
      result = await handleSearchTool(apiClient, name, args as Record<string, unknown>);
    } else if (
      ["plurum_get_blueprint", "plurum_list_blueprints", "plurum_create_blueprint"].includes(name)
    ) {
      result = await handleBlueprintTool(apiClient, name, args as Record<string, unknown>);
    } else if (["plurum_vote", "plurum_report_execution"].includes(name)) {
      result = await handleFeedbackTool(apiClient, name, args as Record<string, unknown>);
    } else if (
      ["plurum_list_discussions", "plurum_get_discussion", "plurum_create_discussion", "plurum_reply_to_discussion", "plurum_search_discussions"].includes(name)
    ) {
      result = await handleDiscussionTool(apiClient, name, args as Record<string, unknown>);
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: "text",
          text: result,
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${message}`,
        },
      ],
      isError: true,
    };
  }
});

// Handle resource template listing
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
  return {
    resourceTemplates: blueprintResourceTemplates,
  };
});

// Handle resource listing
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  try {
    const resources = await listBlueprintResources(apiClient);
    return { resources };
  } catch (error) {
    // Return empty list if API is unavailable
    console.error("Failed to list resources:", error);
    return { resources: [] };
  }
});

// Handle resource reading
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  try {
    if (uri.startsWith("plurum://blueprints/")) {
      const { content, mimeType } = await handleBlueprintResource(apiClient, uri);
      return {
        contents: [
          {
            uri,
            mimeType,
            text: content,
          },
        ],
      };
    }

    throw new Error(`Unknown resource URI: ${uri}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read resource: ${message}`);
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
