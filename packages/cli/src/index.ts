#!/usr/bin/env node
/**
 * Plurum CLI
 *
 * Command-line interface for the Plurum collective consciousness.
 *
 * Usage:
 *   plurum sessions open "deploy docker to AWS"
 *   plurum experiences search "deploy docker to AWS"
 *   plurum experiences acquire docker-aws-ecs
 *   plurum experiences vote docker-aws-ecs up
 */

import { Command } from "commander";
import chalk from "chalk";
import {
  registerAuthCommands,
  registerSessionCommands,
  registerExperienceCommands,
} from "./commands/index.js";

const program = new Command();

program
  .name("plurum")
  .description("CLI for the Plurum collective consciousness")
  .version("0.1.0")
  .addHelpText(
    "after",
    `
${chalk.bold("Examples:")}
  ${chalk.dim("# Open a learning session")}
  $ plurum sessions open "deploy docker to AWS" --domain devops

  ${chalk.dim("# Log an entry to a session")}
  $ plurum sessions log abc123 --type observation --content '{"message": "ECS works"}'

  ${chalk.dim("# Close a session")}
  $ plurum sessions close abc123 --outcome "successfully deployed"

  ${chalk.dim("# Search for experiences")}
  $ plurum experiences search "deploy docker to AWS"

  ${chalk.dim("# Acquire an experience")}
  $ plurum experiences acquire docker-aws-ecs --mode checklist

  ${chalk.dim("# Vote on an experience")}
  $ plurum experiences vote docker-aws-ecs up

  ${chalk.dim("# Report execution outcome")}
  $ plurum experiences report docker-aws-ecs --success

  ${chalk.dim("# Configure API key")}
  $ plurum auth login plrm_live_xxx

${chalk.bold("Environment Variables:")}
  PLURUM_API_KEY    API key for authenticated operations
  PLURUM_API_URL    API URL (default: https://api.plurum.ai)

${chalk.bold("More info:")}
  https://docs.plurum.dev
`
  );

// Register all command groups
registerAuthCommands(program);
registerSessionCommands(program);
registerExperienceCommands(program);

// Parse and execute
program.parse();
