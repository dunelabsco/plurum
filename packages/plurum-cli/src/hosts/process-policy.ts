import type {
  HostExecutableAttestation,
  HostId,
} from "./contracts.js";
import { HOST_IDS } from "./contracts.js";
import { HostError } from "./errors.js";
import {
  validateHostExecutableAttestation,
} from "./inspection.js";
import {
  containsHostControlCharacter,
  containsHostSensitiveMaterial,
} from "./privacy.js";
import type {
  PlatformPathAdapter,
  ProcessRequest,
  SupportedOs,
} from "../system/contracts.js";

const ALLOWED_ENVIRONMENT_KEYS = new Set([
  "APPDATA",
  "CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS",
  "CLAUDE_CODE_PLUGIN_PREFER_HTTPS",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "ComSpec",
  "HOME",
  "LOCALAPPDATA",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
]);
const PATH_ENVIRONMENT_KEYS = new Set([
  "APPDATA",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "HOME",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
]);
const WINDOWS_ONLY_ENVIRONMENT_KEYS = new Set([
  "ComSpec",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
]);
const WINDOWS_EXECUTABLE_EXTENSIONS = new Set([
  ".bat",
  ".cmd",
  ".com",
  ".exe",
]);
const MAX_PATH_ENTRIES = 256;
const MAX_PATHEXT_ENTRIES = 16;
export const MAX_HOST_PROCESS_TIMEOUT_MS = 120_000;
const WINDOWS_EXTENSION = /^\.[A-Za-z0-9]{1,16}$/u;
const REDACTION = new TextEncoder().encode("[REDACTED]");

export interface SafeHostProcessRequest extends ProcessRequest {
  readonly shell: false;
}

/*
 * This policy produces a defensive direct-spawn request snapshot; it does not
 * grant execution authority. The native semantic host adapter must re-attest
 * the executable chain, its parent directories, and the accepted environment
 * paths against `executable.revision` immediately before spawning.
 */
export interface HostProcessPolicy {
  readonly host: HostId;
  readonly neutralWorkingDirectory: string;
  readonly excludedProjectDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

function invalidRequest(): never {
  throw new HostError("invalid_host_process_request");
}

function comparable(value: string, os: SupportedOs): string {
  return os === "win32" ? value.toLowerCase() : value;
}

function safeAbsolute(
  value: unknown,
  paths: PlatformPathAdapter,
  os: SupportedOs,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 32_767 ||
    containsHostControlCharacter(value) ||
    containsHostSensitiveMaterial(value) ||
    !paths.isAbsolute(value)
  ) {
    return invalidRequest();
  }
  const segments =
    paths.separator === "/" ? value.split("/") : value.split(/[\\/]/u);
  if (
    segments.some((segment) => segment === "." || segment === "..") ||
    (paths.separator === "/" && value.startsWith("//")) ||
    (paths.separator === "\\" &&
      (value.startsWith("\\\\") ||
        value.toLowerCase().startsWith("\\\\?\\") ||
        value.toLowerCase().startsWith("\\\\.\\"))) ||
    comparable(paths.normalize(value), os) !== comparable(value, os)
  ) {
    return invalidRequest();
  }
  return value;
}

function isWithin(
  root: string,
  candidate: string,
  paths: PlatformPathAdapter,
  os: SupportedOs,
): boolean {
  const relative = paths.relative(
    comparable(root, os),
    comparable(candidate, os),
  );
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${paths.separator}`) &&
      !paths.isAbsolute(relative))
  );
}

function isDirectParent(
  directory: string,
  child: string,
  paths: PlatformPathAdapter,
  os: SupportedOs,
): boolean {
  const relative = paths.relative(
    comparable(directory, os),
    comparable(child, os),
  );
  if (
    relative === "" ||
    relative === "." ||
    relative === ".." ||
    paths.isAbsolute(relative)
  ) {
    return false;
  }
  const segments =
    paths.separator === "/" ? relative.split("/") : relative.split(/[\\/]/u);
  return (
    segments.length === 1 &&
    segments[0] !== undefined &&
    segments[0].length > 0
  );
}

function safeEnvironmentPath(
  value: string,
  excluded: string,
  paths: PlatformPathAdapter,
  os: SupportedOs,
): string {
  const path = safeAbsolute(value, paths, os);
  if (isWithin(excluded, path, paths, os)) {
    return invalidRequest();
  }
  return path;
}

function safePathEnvironment(
  value: string,
  executable: HostExecutableAttestation,
  excluded: string,
  paths: PlatformPathAdapter,
  os: SupportedOs,
): string {
  const delimiter = os === "win32" ? ";" : ":";
  const rawEntries = value.split(delimiter);
  if (
    rawEntries.length === 0 ||
    rawEntries.length > MAX_PATH_ENTRIES
  ) {
    return invalidRequest();
  }

  const seen = new Set<string>();
  for (const rawEntry of rawEntries) {
    const entry = safeEnvironmentPath(rawEntry, excluded, paths, os);
    const key = comparable(entry, os);
    if (seen.has(key)) {
      return invalidRequest();
    }
    seen.add(key);
    if (
      !executable.chain.some(
        (chainEntry) =>
          chainEntry.kind === "binary" &&
          isDirectParent(entry, chainEntry.path, paths, os),
      )
    ) {
      return invalidRequest();
    }
  }
  return value;
}

function safeWindowsPathExt(value: string): string {
  const entries = value.split(";");
  if (
    entries.length === 0 ||
    entries.length > MAX_PATHEXT_ENTRIES ||
    entries.some((entry) => !WINDOWS_EXTENSION.test(entry))
  ) {
    return invalidRequest();
  }
  const normalized = entries.map((entry) => entry.toLowerCase());
  if (
    new Set(normalized).size !== normalized.length ||
    normalized.some((entry) => !WINDOWS_EXECUTABLE_EXTENSIONS.has(entry)) ||
    !normalized.includes(".exe")
  ) {
    return invalidRequest();
  }
  return value;
}

function safeEnvironment(
  input: Readonly<Record<string, string>>,
  executable: HostExecutableAttestation,
  excluded: string,
  paths: PlatformPathAdapter,
  os: SupportedOs,
): Readonly<Record<string, string>> {
  const copied: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (
      !ALLOWED_ENVIRONMENT_KEYS.has(name) ||
      name.toUpperCase() === "PLURUM_API_KEY" ||
      typeof value !== "string" ||
      (value.length === 0 && name !== "NO_COLOR") ||
      value.length > 32_767 ||
      containsHostControlCharacter(value) ||
      containsHostSensitiveMaterial(value) ||
      (os !== "win32" && WINDOWS_ONLY_ENVIRONMENT_KEYS.has(name))
    ) {
      return invalidRequest();
    }

    if (name === "PATH") {
      copied[name] = safePathEnvironment(
        value,
        executable,
        excluded,
        paths,
        os,
      );
    } else if (name === "PATHEXT") {
      if (os !== "win32") {
        return invalidRequest();
      }
      copied[name] = safeWindowsPathExt(value);
    } else if (name === "CLAUDE_CODE_PLUGIN_PREFER_HTTPS") {
      if (value !== "1") {
        return invalidRequest();
      }
      copied[name] = value;
    } else if (name === "CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS") {
      if (!/^[1-9][0-9]{3,5}$/u.test(value)) {
        return invalidRequest();
      }
      const timeout = Number(value);
      if (
        !Number.isSafeInteger(timeout) ||
        timeout < 1_000 ||
        timeout > MAX_HOST_PROCESS_TIMEOUT_MS
      ) {
        return invalidRequest();
      }
      copied[name] = value;
    } else if (PATH_ENVIRONMENT_KEYS.has(name)) {
      copied[name] = safeEnvironmentPath(value, excluded, paths, os);
    } else if (
      name === "ComSpec" ||
      name === "SystemRoot" ||
      name === "WINDIR"
    ) {
      if (os !== "win32") {
        return invalidRequest();
      }
      copied[name] = safeEnvironmentPath(value, excluded, paths, os);
    } else {
      copied[name] = value;
    }
  }

  if (os === "win32") {
    const systemRoot = copied.SystemRoot;
    const windowsDirectory = copied.WINDIR;
    if (
      systemRoot !== undefined &&
      windowsDirectory !== undefined &&
      comparable(systemRoot, os) !== comparable(windowsDirectory, os)
    ) {
      return invalidRequest();
    }
    const commandProcessor = copied.ComSpec;
    if (commandProcessor !== undefined) {
      const root = systemRoot ?? windowsDirectory;
      if (
        root === undefined ||
        comparable(commandProcessor, os) !==
          comparable(paths.join(root, "System32", "cmd.exe"), os)
      ) {
        return invalidRequest();
      }
    }
  }

  return Object.freeze(copied);
}

function safeArgument(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 32_767 ||
    containsHostControlCharacter(value) ||
    containsHostSensitiveMaterial(value)
  ) {
    return invalidRequest();
  }
  return value;
}

export function buildSafeHostProcessRequest(
  executable: HostExecutableAttestation,
  args: readonly string[],
  policy: HostProcessPolicy,
  paths: PlatformPathAdapter,
  os: SupportedOs,
): SafeHostProcessRequest {
  try {
    if (
      !HOST_IDS.includes(policy.host) ||
      (os !== "darwin" && os !== "linux" && os !== "win32") ||
      !Number.isSafeInteger(policy.timeoutMs) ||
      policy.timeoutMs < 100 ||
      policy.timeoutMs > MAX_HOST_PROCESS_TIMEOUT_MS ||
      !Number.isSafeInteger(policy.maxOutputBytes) ||
      policy.maxOutputBytes < 1 ||
      policy.maxOutputBytes > 1024 * 1024
    ) {
      return invalidRequest();
    }
    const excluded = safeAbsolute(policy.excludedProjectDirectory, paths, os);
    const normalizedExecutable = validateHostExecutableAttestation(
      executable,
      Object.freeze({
        host: policy.host,
        scope: "user",
        excludedProjectDirectory: excluded,
      }),
      paths,
      os,
    );
    const launch = safeAbsolute(
      normalizedExecutable.launch.executable,
      paths,
      os,
    );
    const neutral = safeAbsolute(policy.neutralWorkingDirectory, paths, os);
    if (isWithin(excluded, neutral, paths, os)) {
      return invalidRequest();
    }

    const copiedEnvironment = safeEnvironment(
      policy.environment,
      normalizedExecutable,
      excluded,
      paths,
      os,
    );
    const argumentPrefix =
      normalizedExecutable.launch.argumentPrefix.map(safeArgument);
    const operationArguments = args.map(safeArgument);
    return Object.freeze({
      executable: launch,
      args: Object.freeze([...argumentPrefix, ...operationArguments]),
      cwd: neutral,
      env: copiedEnvironment,
      timeoutMs: policy.timeoutMs,
      maxOutputBytes: policy.maxOutputBytes,
      shell: false,
    });
  } catch (error) {
    if (error instanceof HostError) {
      throw error;
    }
    return invalidRequest();
  }
}

function copyBytes(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new HostError("host_output_invalid");
  }
  return Uint8Array.prototype.slice.call(value) as Uint8Array;
}

function append(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left, 0);
  result.set(right, left.byteLength);
  return result;
}

function startsWith(
  haystack: Uint8Array,
  offset: number,
  needle: Uint8Array,
): boolean {
  if (offset + needle.byteLength > haystack.byteLength) {
    return false;
  }
  for (let index = 0; index < needle.byteLength; index += 1) {
    if (haystack[offset + index] !== needle[index]) {
      return false;
    }
  }
  return true;
}

/*
 * Exact sensitive byte sequences are removed before decoding or exposing a
 * child-output chunk. The longest-pattern tail is retained so a value split
 * across arbitrary process chunks cannot leak.
 */
export class StreamingHostOutputRedactor {
  readonly #patterns: Uint8Array[];
  readonly #maxPatternLength: number;
  readonly #maxOutputBytes: number;
  #pending = new Uint8Array();
  #receivedBytes = 0;
  #emittedBytes = 0;
  #closed = false;

  constructor(
    sensitiveValues: readonly Uint8Array[],
    maxOutputBytes: number,
  ) {
    if (
      sensitiveValues.length === 0 ||
      sensitiveValues.length > 32 ||
      !Number.isSafeInteger(maxOutputBytes) ||
      maxOutputBytes < 1 ||
      maxOutputBytes > 1024 * 1024
    ) {
      throw new HostError("invalid_host_process_request");
    }
    const patterns: Uint8Array[] = [];
    try {
      for (const value of sensitiveValues) {
        const copied = copyBytes(value);
        if (copied.byteLength < 8 || copied.byteLength > 512) {
          copied.fill(0);
          throw new HostError("invalid_host_process_request");
        }
        patterns.push(copied);
      }
    } catch (error) {
      for (const pattern of patterns) {
        pattern.fill(0);
      }
      if (error instanceof HostError) {
        throw error;
      }
      throw new HostError("invalid_host_process_request");
    }
    patterns.sort((left, right) => right.byteLength - left.byteLength);
    this.#patterns = patterns;
    this.#maxPatternLength = patterns[0]?.byteLength ?? 1;
    this.#maxOutputBytes = maxOutputBytes;
  }

  push(chunk: Uint8Array): Uint8Array {
    if (this.#closed) {
      throw new HostError("host_output_invalid");
    }
    if (
      !(chunk instanceof Uint8Array) ||
      chunk.byteLength > this.#maxOutputBytes - this.#receivedBytes
    ) {
      this.close();
      throw new HostError("host_output_too_large");
    }
    this.#receivedBytes += chunk.byteLength;
    const copied = copyBytes(chunk);
    let combined: Uint8Array;
    try {
      combined = append(this.#pending, copied);
    } finally {
      copied.fill(0);
      this.#pending.fill(0);
    }
    return this.#process(combined, false);
  }

  finish(): Uint8Array {
    if (this.#closed) {
      throw new HostError("host_output_invalid");
    }
    const combined = this.#pending;
    this.#pending = new Uint8Array();
    try {
      return this.#process(combined, true);
    } finally {
      this.close();
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#pending.fill(0);
    this.#pending = new Uint8Array();
    for (const pattern of this.#patterns) {
      pattern.fill(0);
    }
  }

  #process(combined: Uint8Array, final: boolean): Uint8Array {
    const safeStartLimit = final
      ? combined.byteLength
      : Math.max(0, combined.byteLength - (this.#maxPatternLength - 1));
    const output: number[] = [];
    let cursor = 0;
    try {
      while (cursor < safeStartLimit) {
        const pattern = this.#patterns.find((candidate) =>
          startsWith(combined, cursor, candidate),
        );
        if (pattern !== undefined) {
          output.push(...REDACTION);
          cursor += pattern.byteLength;
        } else {
          output.push(combined[cursor] ?? 0);
          cursor += 1;
        }
        if (this.#emittedBytes + output.length > this.#maxOutputBytes) {
          throw new HostError("host_output_too_large");
        }
      }
      const nextPending = combined.slice(cursor);
      this.#pending = nextPending;
      this.#emittedBytes += output.length;
      return new Uint8Array(output);
    } catch (error) {
      this.close();
      if (error instanceof HostError) {
        throw error;
      }
      throw new HostError("host_output_invalid");
    } finally {
      combined.fill(0);
    }
  }
}

export function decodeRedactedHostOutput(bytes: Uint8Array): string {
  const copied = copyBytes(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(copied);
  } catch {
    throw new HostError("host_output_invalid");
  } finally {
    copied.fill(0);
  }
}
