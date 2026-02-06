/**
 * Experience commands
 */

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { get, post } from "../utils/api.js";
import * as output from "../utils/output.js";

interface ExperienceSummary {
  id: string;
  short_id: string;
  slug: string;
  goal: string;
  domain: string;
  outcome: string;
  status: string;
  quality_score: number;
  usage_count: number;
  success_rate: number;
  upvotes: number;
  downvotes: number;
  created_at: string;
}

interface ExperienceDetail extends ExperienceSummary {
  strategy: string;
  steps: Array<{
    order: number;
    title: string;
    description: string;
    action_type: string;
    expected_outcome?: string;
  }>;
  code_snippets: Array<{
    language: string;
    code: string;
    filename?: string;
    description?: string;
    order: number;
  }>;
  tags: string[];
  source_session_id: string | null;
  updated_at: string;
}

interface SearchResult {
  experience: ExperienceSummary;
  similarity: number;
  match_reasons: string[];
}

interface SearchResponse {
  results: SearchResult[];
  total_found: number;
  query: string;
}

interface AcquireResponse {
  experience_id: string;
  mode: string;
  content: string;
  steps?: Array<{
    order: number;
    title: string;
    description: string;
  }>;
}

function formatOutcome(outcome: string): string {
  switch (outcome) {
    case "success":
      return chalk.green(outcome);
    case "partial":
      return chalk.yellow(outcome);
    case "failure":
      return chalk.red(outcome);
    default:
      return outcome;
  }
}

export function registerExperienceCommands(program: Command): void {
  const experiences = program
    .command("experiences")
    .description("Browse and manage experiences");

  experiences
    .command("search")
    .description("Search experiences using semantic similarity")
    .argument("<query>", "Natural language search query")
    .option("-d, --domain <domain>", "Filter by domain")
    .option("-l, --limit <n>", "Maximum results", "10")
    .option("-q, --min-quality <score>", "Minimum quality score (0-1)")
    .action(async (query: string, options) => {
      const spinner = ora("Searching experiences...").start();

      const body: Record<string, unknown> = {
        query,
        limit: parseInt(options.limit, 10),
      };

      if (options.domain) {
        body.domain = options.domain;
      }

      if (options.minQuality) {
        body.min_quality = parseFloat(options.minQuality);
      }

      const result = await post<SearchResponse>(
        "/api/v1/experiences/search",
        body
      );

      if (result.error) {
        spinner.fail(result.error);
        process.exit(1);
      }

      const data = result.data!;
      spinner.succeed(
        `Found ${data.total_found} experiences for "${data.query}"`
      );
      console.log();

      if (data.results.length === 0) {
        output.info("No experiences matched your query. Try different keywords.");
        return;
      }

      for (const [index, r] of data.results.entries()) {
        const exp = r.experience;

        console.log(chalk.bold(`${index + 1}. ${exp.goal}`));
        output.label("ID", chalk.cyan(exp.short_id || exp.slug));
        output.label("Domain", exp.domain || chalk.dim("none"));
        output.label("Match", chalk.green(output.formatPercent(r.similarity)));
        output.label("Outcome", formatOutcome(exp.outcome));
        output.label(
          "Quality",
          output.formatScore(exp.quality_score) +
            chalk.dim(` (${exp.usage_count} uses)`)
        );
        output.label(
          "Success Rate",
          output.formatPercent(exp.success_rate)
        );

        if (r.match_reasons.length > 0) {
          output.label("Why", chalk.dim(r.match_reasons.join(", ")));
        }

        console.log();
      }

      console.log(
        chalk.dim(
          `Use 'plurum experiences get <id>' for details, or 'plurum experiences acquire <id>' to acquire`
        )
      );
    });

  experiences
    .command("get")
    .description("Get full details of an experience")
    .argument("<identifier>", "Experience short_id or slug")
    .option("--json", "Output as JSON")
    .action(async (identifier: string, options) => {
      const spinner = ora("Fetching experience...").start();

      const result = await get<ExperienceDetail>(
        `/api/v1/experiences/${identifier}`
      );

      if (result.error) {
        spinner.fail(result.error);
        process.exit(1);
      }

      spinner.stop();
      const exp = result.data!;

      if (options.json) {
        console.log(JSON.stringify(exp, null, 2));
        return;
      }

      output.heading(exp.goal);

      output.label("ID", chalk.cyan(exp.short_id));
      if (exp.slug) {
        output.label("Slug", chalk.cyan(exp.slug));
      }
      output.label("Status", output.formatStatus(exp.status));
      output.label("Domain", exp.domain || chalk.dim("none"));
      output.label("Outcome", formatOutcome(exp.outcome));
      output.label("Tags", output.formatTags(exp.tags || []));

      console.log();
      output.divider();
      console.log();

      if (exp.strategy) {
        console.log(chalk.bold("Strategy"));
        console.log(exp.strategy);
        console.log();
      }

      console.log(chalk.bold("Quality Metrics"));
      output.label("Quality Score", output.formatScore(exp.quality_score));
      output.label("Usage Count", String(exp.usage_count));
      output.label("Success Rate", output.formatPercent(exp.success_rate));
      output.label("Upvotes", chalk.green(String(exp.upvotes)));
      output.label("Downvotes", chalk.red(String(exp.downvotes)));
      console.log();

      if (exp.steps && exp.steps.length > 0) {
        output.divider();
        console.log();
        console.log(chalk.bold("Steps"));
        console.log();

        for (const step of exp.steps) {
          console.log(
            chalk.cyan(`Step ${step.order}:`) + " " + chalk.bold(step.title)
          );
          console.log(chalk.dim(`  Type: ${step.action_type}`));
          console.log(`  ${step.description}`);
          if (step.expected_outcome) {
            console.log(chalk.dim(`  Expected: ${step.expected_outcome}`));
          }
          console.log();
        }
      }

      if (exp.code_snippets && exp.code_snippets.length > 0) {
        output.divider();
        console.log();
        console.log(chalk.bold("Code Snippets"));
        console.log();

        for (const snippet of exp.code_snippets) {
          console.log(
            chalk.cyan(snippet.filename || `Snippet ${snippet.order}`) +
              ` (${snippet.language})`
          );
          if (snippet.description) {
            console.log(chalk.dim(snippet.description));
          }
          console.log(chalk.dim("```" + snippet.language));
          console.log(snippet.code);
          console.log(chalk.dim("```"));
          console.log();
        }
      }
    });

  experiences
    .command("acquire")
    .description("Acquire an experience for use")
    .argument("<identifier>", "Experience short_id or slug")
    .option(
      "-m, --mode <mode>",
      "Acquisition mode: summary, checklist, decision_tree, full",
      "summary"
    )
    .action(async (identifier: string, options) => {
      const validModes = ["summary", "checklist", "decision_tree", "full"];
      if (!validModes.includes(options.mode)) {
        output.error(
          `Invalid mode '${options.mode}'. Choose from: ${validModes.join(", ")}`
        );
        process.exit(1);
      }

      const spinner = ora("Acquiring experience...").start();

      const result = await post<AcquireResponse>(
        `/api/v1/experiences/${identifier}/acquire`,
        { mode: options.mode },
        true
      );

      if (result.error) {
        spinner.fail(result.error);
        process.exit(1);
      }

      spinner.stop();
      const data = result.data!;

      output.heading(`Experience Acquired (${data.mode})`);

      if (data.content) {
        console.log(data.content);
        console.log();
      }

      if (data.steps && data.steps.length > 0) {
        for (const step of data.steps) {
          console.log(
            chalk.cyan(`${step.order}.`) + " " + chalk.bold(step.title)
          );
          console.log(`   ${step.description}`);
          console.log();
        }
      }
    });

  experiences
    .command("create")
    .description("Create a new experience")
    .requiredOption("-g, --goal <goal>", "Goal description")
    .requiredOption("-d, --domain <domain>", "Domain (e.g., devops, frontend)")
    .requiredOption(
      "-o, --outcome <outcome>",
      "Outcome: success, partial, failure"
    )
    .option("-s, --strategy <strategy>", "Strategy description")
    .option("-t, --tags <tags>", "Tags (comma-separated)")
    .option("--session <session_id>", "Source session ID")
    .action(async (options) => {
      const validOutcomes = ["success", "partial", "failure"];
      if (!validOutcomes.includes(options.outcome)) {
        output.error(
          `Invalid outcome '${options.outcome}'. Choose from: ${validOutcomes.join(", ")}`
        );
        process.exit(1);
      }

      const spinner = ora("Creating experience...").start();

      const body: Record<string, unknown> = {
        goal: options.goal,
        domain: options.domain,
        outcome: options.outcome,
      };

      if (options.strategy) {
        body.strategy = options.strategy;
      }

      if (options.tags) {
        body.tags = options.tags.split(",").map((t: string) => t.trim());
      }

      if (options.session) {
        body.source_session_id = options.session;
      }

      const result = await post<ExperienceDetail>(
        "/api/v1/experiences",
        body,
        true
      );

      if (result.error) {
        spinner.fail(result.error);
        process.exit(1);
      }

      const exp = result.data!;
      spinner.succeed(
        `Experience created: ${chalk.cyan(exp.short_id)}`
      );
      output.label("Goal", exp.goal);
      output.label("Domain", exp.domain);
      output.label("Status", output.formatStatus(exp.status));
      console.log();
      console.log(
        chalk.dim(
          `Use 'plurum experiences publish ${exp.short_id}' when ready to publish`
        )
      );
    });

  experiences
    .command("publish")
    .description("Publish a draft experience")
    .argument("<identifier>", "Experience short_id or slug")
    .action(async (identifier: string) => {
      const spinner = ora("Publishing experience...").start();

      const result = await post<ExperienceDetail>(
        `/api/v1/experiences/${identifier}/publish`,
        {},
        true
      );

      if (result.error) {
        spinner.fail(result.error);
        process.exit(1);
      }

      const exp = result.data!;
      spinner.succeed(
        `Experience ${chalk.cyan(exp.short_id)} published`
      );
    });

  experiences
    .command("vote")
    .description("Vote on an experience")
    .argument("<identifier>", "Experience short_id or slug")
    .argument("<type>", "Vote type: up or down")
    .action(async (identifier: string, type: string) => {
      if (type !== "up" && type !== "down") {
        output.error("Vote type must be 'up' or 'down'");
        process.exit(1);
      }

      const spinner = ora("Submitting vote...").start();

      const result = await post<{ message: string }>(
        `/api/v1/experiences/${identifier}/vote`,
        { vote_type: type },
        true
      );

      if (result.error) {
        spinner.fail(result.error);
        process.exit(1);
      }

      const icon = type === "up" ? "+" : "-";
      spinner.succeed(`[${icon}] Vote recorded for "${identifier}"`);
    });

  experiences
    .command("report")
    .description("Report execution outcome for an experience")
    .argument("<identifier>", "Experience short_id or slug")
    .option("--success", "Report successful execution")
    .option("--fail", "Report failed execution")
    .option("-e, --error <message>", "Error message (for failures)")
    .option("-n, --notes <text>", "Additional context notes")
    .action(async (identifier: string, options) => {
      if (!options.success && !options.fail) {
        output.error("Please specify --success or --fail");
        process.exit(1);
      }

      if (options.success && options.fail) {
        output.error("Cannot specify both --success and --fail");
        process.exit(1);
      }

      const success = options.success === true;
      const spinner = ora("Submitting report...").start();

      const body: Record<string, unknown> = { success };

      if (options.error) {
        body.error_message = options.error;
      }

      if (options.notes) {
        body.context_notes = options.notes;
      }

      const result = await post<{ message: string }>(
        `/api/v1/experiences/${identifier}/report`,
        body,
        true
      );

      if (result.error) {
        spinner.fail(result.error);
        process.exit(1);
      }

      const status = success ? "success" : "failure";
      spinner.succeed(`Execution ${status} reported for "${identifier}"`);

      console.log();
      console.log(
        chalk.dim("Thank you for helping improve experience quality!")
      );
    });
}
