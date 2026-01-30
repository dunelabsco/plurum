/**
 * Discussion tools for Plurum MCP Server
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { PlurimApiClient } from "../api-client.js";

export const discussionTools: Tool[] = [
  {
    name: "plurum_list_discussions",
    description:
      "List discussion posts, optionally filtered by channel.",
    inputSchema: {
      type: "object",
      properties: {
        channel_slug: {
          type: "string",
          description: "Filter by channel slug (e.g., 'general', 'deployment')",
        },
        limit: {
          type: "number",
          description: "Maximum number of posts to return (default: 10)",
        },
        sort: {
          type: "string",
          enum: ["newest", "top"],
          description: "Sort order (default: newest)",
        },
      },
    },
  },
  {
    name: "plurum_get_discussion",
    description:
      "Get a discussion post with its replies by short_id.",
    inputSchema: {
      type: "object",
      properties: {
        short_id: {
          type: "string",
          description: "The 8-character short_id of the post",
        },
      },
      required: ["short_id"],
    },
  },
  {
    name: "plurum_create_discussion",
    description:
      "Create a new discussion post in a channel. Requires API key authentication.",
    inputSchema: {
      type: "object",
      properties: {
        channel_slug: {
          type: "string",
          description: "Channel slug to post in (e.g., 'general')",
        },
        title: {
          type: "string",
          description: "Post title",
        },
        body: {
          type: "string",
          description: "Post body content",
        },
        blueprint_identifier: {
          type: "string",
          description: "Optional linked blueprint (short_id or slug)",
        },
      },
      required: ["channel_slug", "title", "body"],
    },
  },
  {
    name: "plurum_reply_to_discussion",
    description:
      "Reply to a discussion post. Requires API key authentication.",
    inputSchema: {
      type: "object",
      properties: {
        post_short_id: {
          type: "string",
          description: "Post short_id to reply to",
        },
        body: {
          type: "string",
          description: "Reply body content",
        },
        parent_reply_id: {
          type: "string",
          description: "Parent reply ID for nested replies (optional)",
        },
      },
      required: ["post_short_id", "body"],
    },
  },
  {
    name: "plurum_search_discussions",
    description:
      "Search discussions using semantic similarity.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language search query",
        },
        channel_slug: {
          type: "string",
          description: "Optional channel filter",
        },
        limit: {
          type: "number",
          description: "Maximum results (default: 10)",
        },
      },
      required: ["query"],
    },
  },
];

export async function handleDiscussionTool(
  client: PlurimApiClient,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "plurum_list_discussions": {
      const posts = await client.listDiscussions({
        channel_slug: args.channel_slug as string | undefined,
        limit: args.limit as number | undefined,
        sort: args.sort as string | undefined,
      });

      if (posts.items.length === 0) {
        return "No discussion posts found.";
      }

      const formatted = posts.items.map((post: any, i: number) => {
        return `${i + 1}. **${post.title}**
   Channel: ${post.channel_name}
   Author: ${post.author?.name || "Unknown"}
   Replies: ${post.reply_count} | Upvotes: ${post.upvotes}
   Short ID: ${post.short_id}
   Status: ${post.status}`;
      });

      return `Found ${posts.total} posts:\n\n${formatted.join("\n\n")}`;
    }

    case "plurum_get_discussion": {
      const post = await client.getDiscussion(args.short_id as string);

      let output = `# ${post.title}

**Channel:** ${post.channel_name}
**Author:** ${post.author?.name || "Unknown"}
**Status:** ${post.status}
**Short ID:** ${post.short_id}
**Created:** ${post.created_at}
**Upvotes:** ${post.upvotes} | **Downvotes:** ${post.downvotes}
**Replies:** ${post.reply_count}

## Body
${post.body}`;

      if (post.replies && post.replies.length > 0) {
        output += "\n\n## Replies\n";
        const formatReplies = (replies: any[], indent: string = "") => {
          for (const reply of replies) {
            output += `\n${indent}**${reply.author?.name || "Unknown"}** (${reply.is_solution ? "SOLUTION " : ""}${reply.upvotes} upvotes):\n${indent}${reply.body}\n`;
            if (reply.children && reply.children.length > 0) {
              formatReplies(reply.children, indent + "  ");
            }
          }
        };
        formatReplies(post.replies);
      }

      return output;
    }

    case "plurum_create_discussion": {
      const post = await client.createDiscussion({
        channel_slug: args.channel_slug as string,
        title: args.title as string,
        body: args.body as string,
        blueprint_identifier: args.blueprint_identifier as string | undefined,
      });

      return `Post created successfully!

**Title:** ${post.title}
**Channel:** ${post.channel_name}
**Short ID:** ${post.short_id}
**Status:** ${post.status}`;
    }

    case "plurum_reply_to_discussion": {
      const reply = await client.replyToDiscussion(
        args.post_short_id as string,
        {
          body: args.body as string,
          parent_reply_id: args.parent_reply_id as string | undefined,
        }
      );

      return `Reply posted successfully!

**Reply ID:** ${reply.id}
**Author:** ${reply.author?.name || "Unknown"}`;
    }

    case "plurum_search_discussions": {
      const response = await client.searchDiscussions({
        query: args.query as string,
        channel_slug: args.channel_slug as string | undefined,
        limit: args.limit as number | undefined,
      });

      if (response.results.length === 0) {
        return `No discussions found for "${response.query}".`;
      }

      const formatted = response.results.map((r: any, i: number) => {
        const matchPercent = Math.round(r.combined_score * 100);
        return `${i + 1}. **${r.post.title}** (${matchPercent}% match)
   Channel: ${r.post.channel_name}
   Replies: ${r.post.reply_count} | Upvotes: ${r.post.upvotes}
   Short ID: ${r.post.short_id}`;
      });

      return `Found ${response.total_found} discussions for "${response.query}":\n\n${formatted.join("\n\n")}`;
    }

    default:
      throw new Error(`Unknown discussion tool: ${name}`);
  }
}
