import type {
  DesiredHostConfiguration,
  HostMutationSupport,
} from "../contracts.js";

export const CLAUDE_CODE_HOST = "claude-code" as const;
export const CLAUDE_CODE_MINIMUM_VERSION = "2.1.212";
export const CLAUDE_CODE_MARKETPLACE_NAME = "plurum" as const;
export const CLAUDE_CODE_MARKETPLACE_SOURCE = "dunelabsco/plurum";
export const CLAUDE_CODE_PLUGIN_ID = "plurum@plurum";
export const CLAUDE_CODE_PLUGIN_NAME = "plurum" as const;
export const CLAUDE_CODE_PLUGIN_SOURCE = CLAUDE_CODE_PLUGIN_ID;
/*
 * Version 0.1.0 is the pre-helper scaffold. The first headersHelper-backed
 * package must have a distinct identity so stale static-userConfig installs
 * can never be classified as healthy.
 */
export const CLAUDE_CODE_PLUGIN_VERSION = "0.2.0";
export const CLAUDE_CODE_PLUGIN_COMPATIBLE_MINIMUM = "0.2.0";
export const CLAUDE_CODE_PLUGIN_COMPATIBLE_MAXIMUM_EXCLUSIVE = "0.3.0";
export const CLAUDE_CODE_MCP_ENDPOINT = "https://mcp.plurum.ai/mcp";

export const CLAUDE_CODE_DESIRED_CONFIGURATION: DesiredHostConfiguration =
  Object.freeze({
    host: CLAUDE_CODE_HOST,
    minimumHostVersion: CLAUDE_CODE_MINIMUM_VERSION,
    marketplace: Object.freeze({
      name: CLAUDE_CODE_MARKETPLACE_NAME,
      source: CLAUDE_CODE_MARKETPLACE_SOURCE,
    }),
    plugin: Object.freeze({
      name: CLAUDE_CODE_PLUGIN_NAME,
      source: CLAUDE_CODE_PLUGIN_SOURCE,
      version: CLAUDE_CODE_PLUGIN_VERSION,
      compatibleMinimum: CLAUDE_CODE_PLUGIN_COMPATIBLE_MINIMUM,
      compatibleMaximumExclusive:
        CLAUDE_CODE_PLUGIN_COMPATIBLE_MAXIMUM_EXCLUSIVE,
    }),
    mcp: Object.freeze({
      name: CLAUDE_CODE_PLUGIN_NAME,
      endpoint: CLAUDE_CODE_MCP_ENDPOINT,
    }),
  });

/*
 * Claude Code can remove a marketplace/plugin it created and restore disabled
 * state. Its supported CLI has no exact historical-version restore operation,
 * so a preexisting plugin update is intentionally not rollback-safe.
 */
export const CLAUDE_CODE_MUTATION_SUPPORT: HostMutationSupport = Object.freeze({
  addMarketplace: true,
  removeMarketplace: true,
  installPlugin: true,
  removePlugin: true,
  updatePlugin: true,
  restorePlugin: false,
  enablePlugin: true,
  disablePlugin: true,
});
