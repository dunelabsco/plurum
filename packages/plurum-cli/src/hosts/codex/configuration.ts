import type {
  DesiredHostConfiguration,
  HostMutationSupport,
} from "../contracts.js";

export const CODEX_HOST = "codex" as const;
export const CODEX_MINIMUM_VERSION = "0.144.5";
export const CODEX_MARKETPLACE_NAME = "plurum" as const;
export const CODEX_MARKETPLACE_SOURCE =
  "https://github.com/dunelabsco/plurum.git";
export const CODEX_PLUGIN_ID = "plurum@plurum";
export const CODEX_PLUGIN_NAME = "plurum" as const;
export const CODEX_PLUGIN_SOURCE = CODEX_PLUGIN_ID;
export const CODEX_PLUGIN_VERSION = "0.1.0";
export const CODEX_PLUGIN_COMPATIBLE_MINIMUM = "0.1.0";
export const CODEX_PLUGIN_COMPATIBLE_MAXIMUM_EXCLUSIVE = "0.2.0";
export const CODEX_MCP_ENDPOINT = "https://mcp.plurum.ai/mcp";

export const CODEX_DESIRED_CONFIGURATION: DesiredHostConfiguration =
  Object.freeze({
    host: CODEX_HOST,
    minimumHostVersion: CODEX_MINIMUM_VERSION,
    marketplace: Object.freeze({
      name: CODEX_MARKETPLACE_NAME,
      source: CODEX_MARKETPLACE_SOURCE,
    }),
    plugin: Object.freeze({
      name: CODEX_PLUGIN_NAME,
      source: CODEX_PLUGIN_SOURCE,
      version: CODEX_PLUGIN_VERSION,
      compatibleMinimum: CODEX_PLUGIN_COMPATIBLE_MINIMUM,
      compatibleMaximumExclusive:
        CODEX_PLUGIN_COMPATIBLE_MAXIMUM_EXCLUSIVE,
    }),
    mcp: Object.freeze({
      name: CODEX_PLUGIN_NAME,
      endpoint: CODEX_MCP_ENDPOINT,
    }),
  });

/*
 * The documented Codex CLI can reversibly add/remove a marketplace and
 * install/remove a plugin. It has no plugin enable/disable command and no
 * exact historical-version restore. Marketplace upgrade is intentionally not
 * an automatic mutation because it can refresh installed caches without an
 * exact rollback operation.
 */
export const CODEX_MUTATION_SUPPORT: HostMutationSupport = Object.freeze({
  addMarketplace: true,
  removeMarketplace: true,
  installPlugin: true,
  removePlugin: true,
  updatePlugin: false,
  restorePlugin: false,
  enablePlugin: false,
  disablePlugin: false,
});
