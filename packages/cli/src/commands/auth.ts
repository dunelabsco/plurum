/**
 * Auth commands
 */

import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, saveConfig, getApiKey, getApiUrl } from "../config.js";
import * as output from "../utils/output.js";

export function registerAuthCommands(program: Command): void {
  const auth = program.command("auth").description("Manage authentication");

  auth
    .command("login")
    .description("Configure API key")
    .argument("<api-key>", "Your Plurum API key (starts with plrm_)")
    .action((apiKey: string) => {
      if (!apiKey.startsWith("plrm_")) {
        output.error("Invalid API key format. Keys should start with 'plrm_'");
        process.exit(1);
      }

      const config = loadConfig();
      config.apiKey = apiKey;
      saveConfig(config);

      output.success("API key saved successfully!");
      console.log();
      console.log(
        chalk.dim("  Config location: ~/.plurum/config.json")
      );
      console.log(
        chalk.dim("  You can also set the PLURUM_API_KEY environment variable")
      );
    });

  auth
    .command("logout")
    .description("Remove saved API key")
    .action(() => {
      const config = loadConfig();
      delete config.apiKey;
      saveConfig(config);
      output.success("API key removed.");
    });

  auth
    .command("status")
    .description("Show current authentication status")
    .action(() => {
      const apiKey = getApiKey();
      const apiUrl = getApiUrl();

      output.heading("Authentication Status");

      if (apiKey) {
        const maskedKey =
          apiKey.substring(0, 10) + "..." + apiKey.substring(apiKey.length - 4);
        output.label("API Key", chalk.green(maskedKey));
        output.label(
          "Source",
          process.env.PLURUM_API_KEY ? "Environment variable" : "Config file"
        );
      } else {
        output.label("API Key", chalk.yellow("Not configured"));
      }

      output.label("API URL", apiUrl);
    });

  auth
    .command("set-url")
    .description("Set custom API URL")
    .argument("<url>", "API URL (e.g., http://localhost:8000)")
    .action((url: string) => {
      const config = loadConfig();
      config.apiUrl = url;
      saveConfig(config);
      output.success(`API URL set to: ${url}`);
    });
}
