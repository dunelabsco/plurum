/**
 * Output formatting utilities
 */

import chalk from "chalk";

export function success(message: string): void {
  console.log(chalk.green("✓"), message);
}

export function error(message: string): void {
  console.error(chalk.red("✗"), message);
}

export function warning(message: string): void {
  console.log(chalk.yellow("⚠"), message);
}

export function info(message: string): void {
  console.log(chalk.blue("ℹ"), message);
}

export function heading(text: string): void {
  console.log();
  console.log(chalk.bold.underline(text));
  console.log();
}

export function label(name: string, value: string): void {
  console.log(`  ${chalk.dim(name + ":")} ${value}`);
}

export function divider(): void {
  console.log(chalk.dim("─".repeat(50)));
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function formatTags(tags: string[]): string {
  if (tags.length === 0) return chalk.dim("none");
  return tags.map((t) => chalk.cyan(t)).join(", ");
}

export function formatStatus(status: string): string {
  switch (status) {
    case "published":
      return chalk.green(status);
    case "draft":
      return chalk.yellow(status);
    case "deprecated":
      return chalk.red(status);
    case "archived":
      return chalk.dim(status);
    default:
      return status;
  }
}

export function formatScore(score: number): string {
  if (score >= 0.7) return chalk.green(score.toFixed(2));
  if (score >= 0.4) return chalk.yellow(score.toFixed(2));
  return chalk.red(score.toFixed(2));
}
