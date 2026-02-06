/**
 * Session commands
 */

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { get, post } from "../utils/api.js";
import * as output from "../utils/output.js";

interface SessionSummary {
  id: string;
  short_id: string;
  topic: string;
  domain: string;
  status: string;
  visibility: string;
  entry_count: number;
  created_at: string;
  updated_at: string;
}

interface SessionDetail extends SessionSummary {
  tools: string[];
  outcome: string | null;
  entries: Array<{
    id: string;
    entry_type: string;
    content: Record<string, unknown>;
    created_at: string;
  }>;
}

interface SessionEntry {
  id: string;
  entry_type: string;
  content: Record<string, unknown>;
  created_at: string;
}

interface SessionListResponse {
  items: SessionSummary[];
  total: number;
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

function formatSessionStatus(status: string): string {
  switch (status) {
    case "open":
      return chalk.green(status);
    case "closed":
      return chalk.blue(status);
    case "abandoned":
      return chalk.red(status);
    default:
      return status;
  }
}

export function registerSessionCommands(program: Command): void {
  const sessions = program
    .command("sessions")
    .description("Manage learning sessions");

  sessions
    .command("open")
    .description("Open a new session")
    .argument("<topic>", "Session topic")
    .option("-d, --domain <domain>", "Domain (e.g., devops, frontend)")
    .option("-t, --tools <tools>", "Tools used (comma-separated)")
    .option(
      "-v, --visibility <visibility>",
      "Visibility: public or private",
      "public"
    )
    .action(async (topic: string, options) => {
      const spinner = ora("Opening session...").start();

      const body: Record<string, unknown> = { topic };

      if (options.domain) {
        body.domain = options.domain;
      }

      if (options.tools) {
        body.tools = options.tools.split(",").map((t: string) => t.trim());
      }

      if (options.visibility) {
        body.visibility = options.visibility;
      }

      const result = await post<SessionDetail>(
        "/api/v1/sessions",
        body,
        true
      );

      if (result.error) {
        spinner.fail(result.error);
        process.exit(1);
      }

      const session = result.data!;
      spinner.succeed(`Session opened: ${chalk.cyan(session.short_id)}`);
      output.label("Topic", session.topic);
      if (session.domain) {
        output.label("Domain", session.domain);
      }
      output.label("Status", formatSessionStatus(session.status));
      console.log();
      console.log(
        chalk.dim(`Use 'plurum sessions log ${session.short_id}' to log entries`)
      );
    });

  sessions
    .command("list")
    .description("List my sessions")
    .option("-s, --status <status>", "Filter by status: open, closed, abandoned")
    .option("-l, --limit <n>", "Maximum results", "20")
    .action(async (options) => {
      const spinner = ora("Fetching sessions...").start();

      const params = new URLSearchParams();
      if (options.status) params.set("status", options.status);
      params.set("limit", options.limit);

      const query = params.toString();
      const result = await get<SessionListResponse>(
        `/api/v1/sessions?${query}`,
        true
      );

      if (result.error) {
        spinner.fail(result.error);
        process.exit(1);
      }

      spinner.stop();
      const response = result.data!;

      if (!response.items || response.items.length === 0) {
        output.info("No sessions found.");
        return;
      }

      console.log(chalk.bold(`\n${response.total} Sessions\n`));

      for (const [index, session] of response.items.entries()) {
        console.log(
          chalk.bold(`${index + 1}. ${session.topic}`)
        );
        output.label("ID", chalk.cyan(session.short_id));
        output.label("Status", formatSessionStatus(session.status));
        output.label("Domain", session.domain || chalk.dim("none"));
        output.label("Entries", String(session.entry_count));
        output.label("Created", formatTime(session.created_at));
        console.log();
      }
    });

  sessions
    .command("get")
    .description("Get session details")
    .argument("<id>", "Session ID or short_id")
    .option("--json", "Output as JSON")
    .action(async (id: string, options) => {
      const spinner = ora("Fetching session...").start();

      const result = await get<SessionDetail>(
        `/api/v1/sessions/${id}`,
        true
      );

      if (result.error) {
        spinner.fail(result.error);
        process.exit(1);
      }

      spinner.stop();
      const session = result.data!;

      if (options.json) {
        console.log(JSON.stringify(session, null, 2));
        return;
      }

      output.heading(session.topic);

      output.label("ID", chalk.cyan(session.short_id));
      output.label("Status", formatSessionStatus(session.status));
      output.label("Domain", session.domain || chalk.dim("none"));
      output.label("Visibility", session.visibility);
      if (session.tools && session.tools.length > 0) {
        output.label("Tools", session.tools.join(", "));
      }
      if (session.outcome) {
        output.label("Outcome", session.outcome);
      }
      output.label("Created", formatTime(session.created_at));
      output.label("Updated", formatTime(session.updated_at));

      if (session.entries && session.entries.length > 0) {
        console.log();
        output.divider();
        console.log();
        console.log(chalk.bold(`Entries (${session.entries.length})`));
        console.log();

        for (const entry of session.entries) {
          console.log(
            chalk.cyan(`[${entry.entry_type}]`) +
              " " +
              chalk.dim(formatTime(entry.created_at))
          );
          console.log(`  ${JSON.stringify(entry.content)}`);
          console.log();
        }
      }
    });

  sessions
    .command("log")
    .description("Log an entry to a session")
    .argument("<session_id>", "Session ID or short_id")
    .requiredOption("-t, --type <type>", "Entry type (e.g., observation, decision, error, result)")
    .requiredOption("-c, --content <json>", "Entry content as JSON string")
    .action(async (sessionId: string, options) => {
      let content: Record<string, unknown>;
      try {
        content = JSON.parse(options.content);
      } catch {
        output.error("Invalid JSON for --content. Example: '{\"message\": \"did X\"}'");
        process.exit(1);
      }

      const spinner = ora("Logging entry...").start();

      const result = await post<SessionEntry>(
        `/api/v1/sessions/${sessionId}/entries`,
        {
          entry_type: options.type,
          content,
        },
        true
      );

      if (result.error) {
        spinner.fail(result.error);
        process.exit(1);
      }

      const entry = result.data!;
      spinner.succeed(
        `Entry logged: ${chalk.cyan(entry.entry_type)} to session ${sessionId}`
      );
    });

  sessions
    .command("close")
    .description("Close a session")
    .argument("<session_id>", "Session ID or short_id")
    .option("-o, --outcome <outcome>", "Session outcome summary")
    .action(async (sessionId: string, options) => {
      const spinner = ora("Closing session...").start();

      const body: Record<string, unknown> = {};
      if (options.outcome) {
        body.outcome = options.outcome;
      }

      const result = await post<SessionDetail>(
        `/api/v1/sessions/${sessionId}/close`,
        body,
        true
      );

      if (result.error) {
        spinner.fail(result.error);
        process.exit(1);
      }

      const session = result.data!;
      spinner.succeed(
        `Session ${chalk.cyan(session.short_id)} closed`
      );
      if (session.outcome) {
        output.label("Outcome", session.outcome);
      }
    });

  sessions
    .command("abandon")
    .description("Abandon a session")
    .argument("<session_id>", "Session ID or short_id")
    .action(async (sessionId: string) => {
      const spinner = ora("Abandoning session...").start();

      const result = await post<SessionDetail>(
        `/api/v1/sessions/${sessionId}/abandon`,
        {},
        true
      );

      if (result.error) {
        spinner.fail(result.error);
        process.exit(1);
      }

      const session = result.data!;
      spinner.succeed(
        `Session ${chalk.cyan(session.short_id)} abandoned`
      );
    });
}
