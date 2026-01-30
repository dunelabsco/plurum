#!/usr/bin/env node
/**
 * Plurum CLI
 *
 * Command-line interface for the Plurum knowledge graph.
 *
 * Usage:
 *   plurum search "deploy docker to AWS"
 *   plurum get docker-aws-ecs
 *   plurum vote docker-aws-ecs up
 *   plurum report docker-aws-ecs --success --time 5000
 */

import { Command } from "commander";
import chalk from "chalk";
import {
  registerAuthCommands,
  registerSearchCommands,
  registerBlueprintCommands,
  registerFeedbackCommands,
  registerDiscussionCommands,
} from "./commands/index.js";

const program = new Command();

program
  .name("plurum")
  .description("CLI for the Plurum knowledge graph")
  .version("0.1.0")
  .addHelpText(
    "after",
    `
${chalk.bold("Examples:")}
  ${chalk.dim("# Search for blueprints")}
  $ plurum search "deploy docker to AWS"

  ${chalk.dim("# Get blueprint details")}
  $ plurum get docker-aws-ecs

  ${chalk.dim("# Vote on a blueprint")}
  $ plurum vote docker-aws-ecs up

  ${chalk.dim("# Report successful execution")}
  $ plurum report docker-aws-ecs --success --time 5000

  ${chalk.dim("# Configure API key")}
  $ plurum auth login plrm_live_xxx

${chalk.bold("Environment Variables:")}
  PLURUM_API_KEY    API key for authenticated operations
  PLURUM_API_URL    API URL (default: https://api.plurum.dev)

${chalk.bold("More info:")}
  https://docs.plurum.dev
`
  );

// Register all command groups
registerAuthCommands(program);
registerSearchCommands(program);
registerBlueprintCommands(program);
registerFeedbackCommands(program);
registerDiscussionCommands(program);

// Parse and execute
program.parse();
