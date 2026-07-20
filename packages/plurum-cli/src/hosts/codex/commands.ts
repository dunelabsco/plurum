import type {
  CodexMutationCommand,
} from "./contracts.js";

export interface CodexCommandSpecification {
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

const LOCAL_TIMEOUT_MS = 30_000;
const NETWORK_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

const SPECIFICATIONS: Readonly<
  Record<CodexMutationCommand, CodexCommandSpecification>
> = Object.freeze({
  "add-marketplace": Object.freeze({
    args: Object.freeze([
      "plugin",
      "marketplace",
      "add",
      "dunelabsco/plurum",
      "--json",
    ]),
    timeoutMs: NETWORK_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  }),
  "remove-marketplace": Object.freeze({
    args: Object.freeze([
      "plugin",
      "marketplace",
      "remove",
      "plurum",
      "--json",
    ]),
    timeoutMs: LOCAL_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  }),
  "install-plugin": Object.freeze({
    args: Object.freeze([
      "plugin",
      "add",
      "plurum@plurum",
      "--json",
    ]),
    timeoutMs: LOCAL_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  }),
  "uninstall-plugin": Object.freeze({
    args: Object.freeze([
      "plugin",
      "remove",
      "plurum@plurum",
      "--json",
    ]),
    timeoutMs: LOCAL_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  }),
});

export function codexCommandSpecification(
  command: CodexMutationCommand,
): CodexCommandSpecification {
  return SPECIFICATIONS[command];
}
