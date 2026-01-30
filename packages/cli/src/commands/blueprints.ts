/**
 * Blueprint commands
 */

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { get, post } from "../utils/api.js";
import * as output from "../utils/output.js";

type VerificationTier = "self_reported" | "sandbox" | "org_verified";

interface BlueprintDetail {
  slug: string;
  status: string;
  is_public: boolean;
  tags: string[];
  quality_metrics: {
    execution_count: number;
    success_rate: number;
    upvotes: number;
    downvotes: number;
    score: number;
  };
  current_version: {
    version_number: number;
    title: string;
    goal_description: string;
    strategy: string;
    execution_steps: Array<{
      order: number;
      title: string;
      description: string;
      action_type: string;
      expected_outcome?: string;
      requires_confirmation: boolean;
    }>;
    code_snippets: Array<{
      language: string;
      code: string;
      filename?: string;
      description?: string;
      order: number;
    }>;
    // Trust Engine fields
    verification_tier: VerificationTier;
    risk_score: number;
    permissions_required: string[];
    risk_flags: string[];
  };
  created_at: string;
  updated_at: string;
}

interface BlueprintSummary {
  slug: string;
  status: string;
  tags: string[];
  current_version: {
    title: string;
    verification_tier?: VerificationTier;
    risk_score?: number;
  };
  quality_metrics: {
    execution_count: number;
    success_rate: number;
    score: number;
  };
}

function formatVerificationTier(tier: VerificationTier): string {
  switch (tier) {
    case "self_reported":
      return chalk.gray("Self-Reported");
    case "sandbox":
      return chalk.blue("Sandbox");
    case "org_verified":
      return chalk.green("Org Verified");
    default:
      return chalk.gray(tier);
  }
}

function formatRiskScore(score: number): string {
  if (score >= 70) {
    return chalk.red(`${score}/100 (High)`);
  } else if (score >= 40) {
    return chalk.yellow(`${score}/100 (Medium)`);
  } else {
    return chalk.green(`${score}/100 (Low)`);
  }
}

export function registerBlueprintCommands(program: Command): void {
  program
    .command("get")
    .description("Get full details of a blueprint")
    .argument("<slug>", "Blueprint slug")
    .option("--json", "Output as JSON")
    .action(async (slug: string, options) => {
      const spinner = ora("Fetching blueprint...").start();

      const result = await get<BlueprintDetail>(`/api/v1/blueprints/${slug}`);

      if (result.error) {
        spinner.fail(result.error);
        process.exit(1);
      }

      spinner.stop();
      const bp = result.data!;

      if (options.json) {
        console.log(JSON.stringify(bp, null, 2));
        return;
      }

      const v = bp.current_version;
      const m = bp.quality_metrics;

      output.heading(v.title);

      output.label("Slug", chalk.cyan(bp.slug));
      output.label("Status", output.formatStatus(bp.status));
      output.label("Version", String(v.version_number));
      output.label("Public", bp.is_public ? chalk.green("Yes") : chalk.yellow("No"));
      output.label("Tags", output.formatTags(bp.tags));
      // Trust Engine fields
      output.label("Verification", formatVerificationTier(v.verification_tier || "self_reported"));
      output.label("Risk Score", formatRiskScore(v.risk_score || 0));
      if (v.permissions_required && v.permissions_required.length > 0) {
        output.label("Permissions", v.permissions_required.join(", "));
      }
      if (v.risk_flags && v.risk_flags.length > 0) {
        output.label("Risk Flags", chalk.yellow(v.risk_flags.join(", ")));
      }

      console.log();
      output.divider();
      console.log();

      console.log(chalk.bold("Goal"));
      console.log(v.goal_description);
      console.log();

      console.log(chalk.bold("Strategy"));
      console.log(v.strategy);
      console.log();

      output.divider();
      console.log();

      console.log(chalk.bold("Quality Metrics"));
      output.label("Executions", String(m.execution_count));
      output.label("Success Rate", output.formatPercent(m.success_rate));
      output.label("Upvotes", chalk.green(String(m.upvotes)));
      output.label("Downvotes", chalk.red(String(m.downvotes)));
      output.label("Score", output.formatScore(m.score));
      console.log();

      if (v.execution_steps.length > 0) {
        output.divider();
        console.log();
        console.log(chalk.bold("Execution Steps"));
        console.log();

        for (const step of v.execution_steps) {
          console.log(
            chalk.cyan(`Step ${step.order}:`) + " " + chalk.bold(step.title)
          );
          console.log(chalk.dim(`  Type: ${step.action_type}`));
          console.log(`  ${step.description}`);
          if (step.expected_outcome) {
            console.log(chalk.dim(`  Expected: ${step.expected_outcome}`));
          }
          if (step.requires_confirmation) {
            console.log(chalk.yellow(`  ⚠ Requires confirmation`));
          }
          console.log();
        }
      }

      if (v.code_snippets.length > 0) {
        output.divider();
        console.log();
        console.log(chalk.bold("Code Snippets"));
        console.log();

        for (const snippet of v.code_snippets) {
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

  program
    .command("list")
    .description("List blueprints")
    .option("-l, --limit <n>", "Maximum results", "20")
    .option("-s, --status <status>", "Filter by status")
    .option("-t, --tags <tags>", "Filter by tags (comma-separated)")
    .action(async (options) => {
      const spinner = ora("Fetching blueprints...").start();

      let path = `/api/v1/blueprints?limit=${options.limit}`;
      if (options.status) path += `&status=${options.status}`;
      if (options.tags) {
        options.tags
          .split(",")
          .forEach((t: string) => (path += `&tags=${t.trim()}`));
      }

      const result = await get<BlueprintSummary[]>(path);

      if (result.error) {
        spinner.fail(result.error);
        process.exit(1);
      }

      const blueprints = result.data!;
      spinner.succeed(`Found ${blueprints.length} blueprints`);
      console.log();

      if (blueprints.length === 0) {
        output.info("No blueprints found.");
        return;
      }

      for (const [index, bp] of blueprints.entries()) {
        const m = bp.quality_metrics;

        console.log(
          chalk.bold(`${index + 1}. ${bp.current_version.title}`)
        );
        output.label("Slug", chalk.cyan(bp.slug));
        output.label("Status", output.formatStatus(bp.status));
        output.label(
          "Success Rate",
          output.formatPercent(m.success_rate) +
            chalk.dim(` (${m.execution_count} executions)`)
        );
        output.label("Tags", output.formatTags(bp.tags));
        console.log();
      }
    });
}
