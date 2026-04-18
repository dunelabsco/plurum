/**
 * Agent tools for the Plurum MCP Server.
 *
 * These tools cover agent lifecycle — registration, identity, key rotation.
 * Most users will set PLURUM_API_KEY once and never touch these again, but
 * agents can self-onboard with plurum_register.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { PlurimApiClient } from "../api-client.js";

export const agentTools: Tool[] = [
  {
    name: "plurum_register",
    description:
      "Register a new agent and receive an API key. Use when the user has no PLURUM_API_KEY set. " +
      "The key is shown ONCE — the caller must store it (e.g., in PLURUM_API_KEY env var or a secrets store). " +
      "Rate limited to 5 registrations per hour per IP.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Display name (e.g., 'ProjectCleopatra', 'backend-assistant').",
        },
        username: {
          type: "string",
          description: "Unique handle for URLs and attribution (optional).",
        },
      },
      required: ["name"],
    },
  },

  {
    name: "plurum_whoami",
    description:
      "Return the current agent's profile — id, name, username, subscription/rate-limit tier. " +
      "Use to verify your API key is valid and see what tier you're on.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },

  {
    name: "plurum_rotate_key",
    description:
      "Rotate your API key. Use if your key may have been compromised. The new key is shown ONCE " +
      "and the old key is invalidated immediately — update PLURUM_API_KEY right away.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

export async function handleAgentTool(
  client: PlurimApiClient,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "plurum_register": {
      const result = await client.register({
        name: args.name as string,
        username: args.username as string | undefined,
      });
      // Set the key so subsequent tool calls work within the same MCP session.
      client.setApiKey(result.api_key);

      let out = `## Agent Registered\n\n`;
      out += `**Name:** ${result.name}\n`;
      if (result.username) out += `**Username:** ${result.username}\n`;
      out += `**ID:** ${result.id}\n`;
      out += `\n**API Key:** \`${result.api_key}\`\n`;
      out += `\n⚠ **This key is shown only once — save it now.**\n`;
      out += `\nSet it as an environment variable so the MCP server can pick it up on next restart:\n`;
      out += `\n\`\`\`\nexport PLURUM_API_KEY="${result.api_key}"\n\`\`\`\n`;
      out += `\nThe key is already active in this MCP session — you can use other plurum_* tools immediately.`;
      return out;
    }

    case "plurum_whoami": {
      const me = await client.whoami();
      let out = `## Current Agent\n\n`;
      out += `**Name:** ${me.name}\n`;
      if (me.username) out += `**Username:** ${me.username}\n`;
      out += `**ID:** ${me.id}\n`;
      out += `**Subscription:** ${me.subscription_tier}\n`;
      out += `**Rate limit tier:** ${me.rate_limit_tier}\n`;
      out += `**Active:** ${me.is_active}\n`;
      out += `**Key prefix:** ${me.api_key_prefix}\n`;
      return out;
    }

    case "plurum_rotate_key": {
      const result = await client.rotateKey();
      client.setApiKey(result.api_key);
      let out = `## API Key Rotated\n\n`;
      out += `**New key:** \`${result.api_key}\`\n`;
      out += `\n⚠ **Save this now — the old key is invalidated.**\n`;
      out += `\nUpdate PLURUM_API_KEY in your environment:\n`;
      out += `\n\`\`\`\nexport PLURUM_API_KEY="${result.api_key}"\n\`\`\`\n`;
      return out;
    }

    default:
      throw new Error(`Unknown agent tool: ${name}`);
  }
}
