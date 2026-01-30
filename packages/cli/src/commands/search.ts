/**
 * Search commands
 */

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { post } from "../utils/api.js";
import * as output from "../utils/output.js";

interface SearchResult {
  blueprint: {
    slug: string;
    tags: string[];
    current_version: {
      title: string;
      goal_description: string;
    };
    quality_metrics: {
      execution_count: number;
      success_rate: number;
      score: number;
    };
  };
  similarity: number;
  match_reasons: string[];
}

interface SearchResponse {
  results: SearchResult[];
  total_found: number;
  query: string;
}

export function registerSearchCommands(program: Command): void {
  program
    .command("search")
    .description("Search for blueprints using semantic similarity")
    .argument("<query>", "Natural language search query")
    .option("-t, --tags <tags>", "Filter by tags (comma-separated)")
    .option("-l, --limit <n>", "Maximum results", "10")
    .option("-m, --min-success <rate>", "Minimum success rate (0-1)")
    .action(async (query: string, options) => {
      const spinner = ora("Searching blueprints...").start();

      const body: Record<string, unknown> = {
        query,
        limit: parseInt(options.limit, 10),
      };

      if (options.tags) {
        body.tags = options.tags.split(",").map((t: string) => t.trim());
      }

      if (options.minSuccess) {
        body.min_success_rate = parseFloat(options.minSuccess);
      }

      const result = await post<SearchResponse>("/api/v1/search", body);

      if (result.error) {
        spinner.fail(result.error);
        process.exit(1);
      }

      const data = result.data!;
      spinner.succeed(`Found ${data.total_found} blueprints for "${data.query}"`);
      console.log();

      if (data.results.length === 0) {
        output.info("No blueprints matched your query. Try different keywords.");
        return;
      }

      for (const [index, r] of data.results.entries()) {
        const bp = r.blueprint;
        const m = bp.quality_metrics;

        console.log(
          chalk.bold(`${index + 1}. ${bp.current_version.title}`)
        );
        output.label("Slug", chalk.cyan(bp.slug));
        output.label("Match", chalk.green(output.formatPercent(r.similarity)));
        output.label(
          "Success Rate",
          output.formatPercent(m.success_rate) +
            chalk.dim(` (${m.execution_count} executions)`)
        );
        output.label("Score", output.formatScore(m.score));
        output.label("Tags", output.formatTags(bp.tags));

        if (r.match_reasons.length > 0) {
          output.label("Why", chalk.dim(r.match_reasons.join(", ")));
        }

        console.log();
      }

      console.log(
        chalk.dim(`Use 'plurum get <slug>' to view full blueprint details`)
      );
    });
}
