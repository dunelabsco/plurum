/**
 * CLI configuration management
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const CONFIG_DIR = path.join(os.homedir(), ".plurum");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export interface Config {
  apiKey?: string;
  apiUrl?: string;
}

export function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadConfig(): Config {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const content = fs.readFileSync(CONFIG_FILE, "utf-8");
      return JSON.parse(content);
    }
  } catch {
    // Ignore errors, return empty config
  }
  return {};
}

export function saveConfig(config: Config): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function getApiKey(): string | undefined {
  // Priority: env var > config file
  return process.env.PLURUM_API_KEY || loadConfig().apiKey;
}

export function getApiUrl(): string {
  // Priority: env var > config file > default
  return (
    process.env.PLURUM_API_URL ||
    loadConfig().apiUrl ||
    "https://api.plurum.ai"
  );
}
