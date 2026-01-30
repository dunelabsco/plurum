/**
 * Discussion commands
 */

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { get, post } from "../utils/api.js";

interface PostSummary {
  short_id: string;
  slug: string;
  title: string;
  channel_name: string;
  status: string;
  reply_count: number;
  upvotes: number;
  author: { name: string; username?: string };
  created_at: string;
}

interface PostDetail extends PostSummary {
  body: string;
  downvotes: number;
  replies: Array<{
    id: string;
    body: string;
    author: { name: string; username?: string };
    upvotes: number;
    is_solution: boolean;
    depth: number;
    children: any[];
    created_at: string;
  }>;
}

interface PostListResponse {
  items: PostSummary[];
  total: number;
}

interface Channel {
  slug: string;
  name: string;
  description: string | null;
  post_count: number;
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function registerDiscussionCommands(program: Command): void {
  const discussions = program
    .command("discussions")
    .description("Manage discussions");

  discussions
    .command("channels")
    .description("List discussion channels")
    .action(async () => {
      const spinner = ora("Fetching channels...").start();
      const result = await get<Channel[]>("/api/v1/discussions/channels");

      if (result.error) {
        spinner.fail(result.error);
        process.exit(1);
      }

      spinner.stop();
      const channels = result.data!;

      if (channels.length === 0) {
        console.log(chalk.dim("No channels found."));
        return;
      }

      console.log(chalk.bold("\nDiscussion Channels\n"));
      for (const ch of channels) {
        console.log(
          `  ${chalk.cyan(ch.slug.padEnd(20))} ${ch.name} ${chalk.dim(`(${ch.post_count} posts)`)}`
        );
        if (ch.description) {
          console.log(`  ${" ".repeat(20)} ${chalk.dim(ch.description)}`);
        }
      }
      console.log();
    });

  discussions
    .command("list")
    .description("List discussion posts")
    .option("-c, --channel <slug>", "Filter by channel slug")
    .option("-s, --sort <order>", "Sort: newest or top", "newest")
    .option("-l, --limit <n>", "Maximum results", "20")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      const spinner = ora("Fetching posts...").start();

      const params = new URLSearchParams();
      if (options.channel) params.set("channel_slug", options.channel);
      params.set("sort", options.sort);
      params.set("limit", options.limit);

      const query = params.toString();
      const result = await get<PostListResponse>(
        `/api/v1/discussions/posts?${query}`
      );

      if (result.error) {
        spinner.fail(result.error);
        process.exit(1);
      }

      spinner.stop();
      const response = result.data!;

      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }

      if (response.items.length === 0) {
        console.log(chalk.dim("No posts found."));
        return;
      }

      console.log(chalk.bold(`\n${response.total} Discussion Posts\n`));

      for (const post of response.items) {
        const author = post.author?.username
          ? `@${post.author.username}`
          : post.author?.name || "Unknown";

        console.log(
          `  ${chalk.cyan(post.short_id)} ${chalk.bold(post.title)}`
        );
        console.log(
          `  ${chalk.dim(post.channel_name)} | ${author} | ${chalk.dim(formatTime(post.created_at))} | ${post.reply_count} replies | ${post.upvotes} upvotes`
        );
        if (post.status !== "active") {
          console.log(`  Status: ${chalk.yellow(post.status)}`);
        }
        console.log();
      }
    });

  discussions
    .command("get")
    .description("Get a discussion post with replies")
    .argument("<short_id>", "Post short_id")
    .option("--json", "Output as JSON")
    .action(async (shortId: string, options) => {
      const spinner = ora("Fetching post...").start();
      const result = await get<PostDetail>(
        `/api/v1/discussions/posts/${shortId}`
      );

      if (result.error) {
        spinner.fail(result.error);
        process.exit(1);
      }

      spinner.stop();
      const post = result.data!;

      if (options.json) {
        console.log(JSON.stringify(post, null, 2));
        return;
      }

      const author = post.author?.username
        ? `@${post.author.username}`
        : post.author?.name || "Unknown";

      console.log(chalk.bold(`\n${post.title}\n`));
      console.log(
        `${chalk.dim("Channel:")} ${post.channel_name} | ${chalk.dim("Author:")} ${author} | ${chalk.dim("Status:")} ${post.status}`
      );
      console.log(
        `${chalk.dim("Upvotes:")} ${post.upvotes} | ${chalk.dim("Replies:")} ${post.reply_count} | ${chalk.dim("Created:")} ${formatTime(post.created_at)}`
      );
      console.log(`\n${post.body}\n`);

      if (post.replies && post.replies.length > 0) {
        console.log(chalk.bold("Replies:\n"));
        const printReplies = (replies: any[], indent: string = "  ") => {
          for (const reply of replies) {
            const rAuthor = reply.author?.username
              ? `@${reply.author.username}`
              : reply.author?.name || "Unknown";
            const solutionBadge = reply.is_solution
              ? chalk.green(" [SOLUTION]")
              : "";

            console.log(
              `${indent}${chalk.cyan(rAuthor)}${solutionBadge} ${chalk.dim(`(${reply.upvotes} upvotes, ${formatTime(reply.created_at)})`)}`
            );
            console.log(`${indent}${reply.body}\n`);

            if (reply.children && reply.children.length > 0) {
              printReplies(reply.children, indent + "  ");
            }
          }
        };
        printReplies(post.replies);
      }
    });

  discussions
    .command("create")
    .description("Create a new discussion post")
    .requiredOption("-c, --channel <slug>", "Channel slug")
    .requiredOption("-t, --title <title>", "Post title")
    .requiredOption("-b, --body <body>", "Post body")
    .option("--blueprint <identifier>", "Link to a blueprint (short_id or slug)")
    .action(async (options) => {
      const spinner = ora("Creating post...").start();

      const data: any = {
        channel_slug: options.channel,
        title: options.title,
        body: options.body,
      };
      if (options.blueprint) {
        data.blueprint_identifier = options.blueprint;
      }

      const result = await post<PostDetail>(
        "/api/v1/discussions/posts",
        data,
        true
      );

      if (result.error) {
        spinner.fail(result.error);
        process.exit(1);
      }

      const created = result.data!;
      spinner.succeed(
        `Post created: ${chalk.cyan(created.short_id)} - ${created.title}`
      );
    });

  discussions
    .command("reply")
    .description("Reply to a discussion post")
    .argument("<short_id>", "Post short_id")
    .requiredOption("-b, --body <body>", "Reply body")
    .option("-p, --parent <reply_id>", "Parent reply ID for nested reply")
    .action(async (shortId: string, options) => {
      const spinner = ora("Posting reply...").start();

      const data: any = { body: options.body };
      if (options.parent) {
        data.parent_reply_id = options.parent;
      }

      const result = await post<any>(
        `/api/v1/discussions/posts/${shortId}/replies`,
        data,
        true
      );

      if (result.error) {
        spinner.fail(result.error);
        process.exit(1);
      }

      spinner.succeed("Reply posted successfully");
    });

  discussions
    .command("search")
    .description("Search discussions")
    .argument("<query>", "Search query")
    .option("-c, --channel <slug>", "Filter by channel")
    .option("-l, --limit <n>", "Maximum results", "10")
    .action(async (query: string, options) => {
      const spinner = ora("Searching...").start();

      const params = new URLSearchParams();
      params.set("query", query);
      if (options.channel) params.set("channel_slug", options.channel);
      params.set("limit", options.limit);

      const result = await post<any>(
        `/api/v1/discussions/search?${params.toString()}`,
        {},
        false
      );

      if (result.error) {
        spinner.fail(result.error);
        process.exit(1);
      }

      spinner.stop();
      const response = result.data!;

      if (response.results.length === 0) {
        console.log(chalk.dim(`No discussions found for "${query}".`));
        return;
      }

      console.log(
        chalk.bold(`\nFound ${response.total_found} discussions:\n`)
      );

      for (const r of response.results) {
        const match = Math.round(r.combined_score * 100);
        console.log(
          `  ${chalk.cyan(r.post.short_id)} ${chalk.bold(r.post.title)} ${chalk.dim(`(${match}% match)`)}`
        );
        console.log(
          `  ${chalk.dim(r.post.channel_name)} | ${r.post.reply_count} replies | ${r.post.upvotes} upvotes`
        );
        console.log();
      }
    });
}
