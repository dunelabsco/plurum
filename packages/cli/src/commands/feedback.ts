/**
 * Feedback commands
 */

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { post } from "../utils/api.js";
import * as output from "../utils/output.js";

export function registerFeedbackCommands(program: Command): void {
  program
    .command("vote")
    .description("Vote on a blueprint")
    .argument("<slug>", "Blueprint slug")
    .argument("<type>", "Vote type: up or down")
    .action(async (slug: string, type: string) => {
      if (type !== "up" && type !== "down") {
        output.error("Vote type must be 'up' or 'down'");
        process.exit(1);
      }

      const spinner = ora("Submitting vote...").start();

      const result = await post<{ message: string }>(
        "/api/v1/feedback/votes",
        {
          blueprint_slug: slug,
          vote_type: type,
        },
        true
      );

      if (result.error) {
        spinner.fail(result.error);
        process.exit(1);
      }

      const emoji = type === "up" ? "👍" : "👎";
      spinner.succeed(`${emoji} Vote recorded for "${slug}"`);
    });

  program
    .command("report")
    .description("Report execution result for a blueprint")
    .argument("<slug>", "Blueprint slug")
    .option("--success", "Report successful execution")
    .option("--fail", "Report failed execution")
    .option("-t, --time <ms>", "Execution time in milliseconds")
    .option("-e, --error <message>", "Error message (for failures)")
    .option("-n, --notes <text>", "Additional context notes")
    .action(async (slug: string, options) => {
      if (!options.success && !options.fail) {
        output.error("Please specify --success or --fail");
        process.exit(1);
      }

      if (options.success && options.fail) {
        output.error("Cannot specify both --success and --fail");
        process.exit(1);
      }

      const success = options.success === true;
      const spinner = ora("Submitting execution report...").start();

      const body: Record<string, unknown> = {
        blueprint_slug: slug,
        success,
      };

      if (options.time) {
        body.execution_time_ms = parseInt(options.time, 10);
      }

      if (options.error) {
        body.error_message = options.error;
      }

      if (options.notes) {
        body.context_notes = options.notes;
      }

      const result = await post<{ message: string }>(
        "/api/v1/feedback/executions",
        body,
        true
      );

      if (result.error) {
        spinner.fail(result.error);
        process.exit(1);
      }

      const emoji = success ? "✅" : "❌";
      const status = success ? "success" : "failure";
      spinner.succeed(`${emoji} Execution ${status} reported for "${slug}"`);

      if (options.time) {
        console.log(chalk.dim(`  Duration: ${options.time}ms`));
      }

      console.log();
      console.log(chalk.dim("Thank you for helping improve blueprint quality!"));
    });
}
