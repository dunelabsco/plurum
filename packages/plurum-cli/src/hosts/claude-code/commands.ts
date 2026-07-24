import type {
  HostActionKind,
  HostRollbackRecipe,
} from "../contracts.js";
import type {
  ClaudeCodeCommand,
  ClaudeCodeMutationCommand,
} from "./contracts.js";

export interface ClaudeCodeCommandSpecification {
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly preferHttps: boolean;
  readonly gitTimeoutMs: number | null;
}

const LOCAL_TIMEOUT_MS = 30_000;
const NETWORK_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

const SPECIFICATIONS: Readonly<
  Record<ClaudeCodeCommand, ClaudeCodeCommandSpecification>
> = Object.freeze({
  version: Object.freeze({
    args: Object.freeze(["--version"]),
    timeoutMs: LOCAL_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    preferHttps: false,
    gitTimeoutMs: null,
  }),
  "list-marketplaces": Object.freeze({
    args: Object.freeze(["plugin", "marketplace", "list", "--json"]),
    timeoutMs: LOCAL_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    preferHttps: false,
    gitTimeoutMs: null,
  }),
  "list-plugins": Object.freeze({
    args: Object.freeze(["plugin", "list", "--json"]),
    timeoutMs: LOCAL_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    preferHttps: false,
    gitTimeoutMs: null,
  }),
  "add-marketplace": Object.freeze({
    args: Object.freeze([
      "plugin",
      "marketplace",
      "add",
      "dunelabsco/plurum",
      "--scope",
      "user",
    ]),
    timeoutMs: NETWORK_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    preferHttps: true,
    gitTimeoutMs: 110_000,
  }),
  "remove-marketplace": Object.freeze({
    args: Object.freeze([
      "plugin",
      "marketplace",
      "remove",
      "plurum",
      "--scope",
      "user",
    ]),
    timeoutMs: LOCAL_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    preferHttps: false,
    gitTimeoutMs: null,
  }),
  "install-plugin": Object.freeze({
    args: Object.freeze([
      "plugin",
      "install",
      "plurum@plurum",
      "--scope",
      "user",
    ]),
    timeoutMs: NETWORK_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    preferHttps: true,
    gitTimeoutMs: 110_000,
  }),
  "uninstall-plugin": Object.freeze({
    args: Object.freeze([
      "plugin",
      "uninstall",
      "plurum@plurum",
      "--scope",
      "user",
    ]),
    timeoutMs: LOCAL_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    preferHttps: false,
    gitTimeoutMs: null,
  }),
  "update-plugin": Object.freeze({
    args: Object.freeze([
      "plugin",
      "update",
      "plurum@plurum",
      "--scope",
      "user",
    ]),
    timeoutMs: NETWORK_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    preferHttps: true,
    gitTimeoutMs: 110_000,
  }),
  "enable-plugin": Object.freeze({
    args: Object.freeze([
      "plugin",
      "enable",
      "plurum@plurum",
      "--scope",
      "user",
    ]),
    timeoutMs: LOCAL_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    preferHttps: false,
    gitTimeoutMs: null,
  }),
  "disable-plugin": Object.freeze({
    args: Object.freeze([
      "plugin",
      "disable",
      "plurum@plurum",
      "--scope",
      "user",
    ]),
    timeoutMs: LOCAL_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    preferHttps: false,
    gitTimeoutMs: null,
  }),
});

export function claudeCodeCommandSpecification(
  command: ClaudeCodeCommand,
): ClaudeCodeCommandSpecification {
  return SPECIFICATIONS[command];
}

export function claudeCodeApplyCommand(
  action: HostActionKind,
): ClaudeCodeMutationCommand | null {
  switch (action) {
    case "add-marketplace":
      return "add-marketplace";
    case "install-plugin":
      return "install-plugin";
    case "enable-plugin":
      return "enable-plugin";
    case "update-plugin":
      // No exact historical-version restore exists, so this never auto-runs.
      return null;
  }
}

export function claudeCodeRollbackCommand(
  rollback: HostRollbackRecipe["kind"],
): ClaudeCodeMutationCommand | null {
  switch (rollback) {
    case "remove-cli-created-marketplace":
      return "remove-marketplace";
    case "remove-cli-created-plugin":
      return "uninstall-plugin";
    case "restore-plugin-disabled":
      return "disable-plugin";
    case "restore-plugin-version":
      return null;
  }
}
