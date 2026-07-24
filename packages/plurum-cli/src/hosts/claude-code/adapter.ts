import type {
  HostApplyRequest,
  HostConfiguration,
  HostExecutableAttestation,
  HostInspection,
  HostInspectionRequest,
  HostMcpDescriptor,
  HostMutationAdapter,
  HostMutationResult,
  HostRollbackRequest,
  ObservedSlot,
} from "../contracts.js";
import {
  discoverHostExecutable,
} from "../discovery.js";
import { HostError } from "../errors.js";
import {
  validateHostExecutableAttestation,
  validateHostInspection,
} from "../inspection.js";
import {
  containsHostControlCharacter,
  containsHostSensitiveMaterial,
} from "../privacy.js";
import {
  buildSafeHostProcessRequest,
} from "../process-policy.js";
import { parseCanonicalVersion } from "../version.js";
import type {
  PlatformAdapter,
} from "../../system/contracts.js";
import {
  copyUint8Array,
  intrinsicUint8ArrayByteLength,
} from "../../data/uint8-array.js";
import {
  snapshotHostApplyRequest,
  snapshotHostRollbackRequest,
} from "../../system/host-mutation-boundary.js";
import {
  claudeCodeApplyCommand,
  claudeCodeCommandSpecification,
  claudeCodeRollbackCommand,
} from "./commands.js";
import {
  CLAUDE_CODE_DESIRED_CONFIGURATION,
  CLAUDE_CODE_MCP_ENDPOINT,
  CLAUDE_CODE_MUTATION_SUPPORT,
} from "./configuration.js";
import {
  CLAUDE_CODE_MUTATION_COMMANDS,
} from "./contracts.js";
import type {
  ClaudeCodeAdapterDependencies,
  ClaudeCodeCommand,
  ClaudeCodeMcpEvidence,
  ClaudeCodeMutationCommand,
  ClaudeCodeProcessExecutionResult,
  ClaudeCodeStateEvidence,
} from "./contracts.js";
import {
  parseClaudeCodeMarketplaceListOutput,
  parseClaudeCodePluginListOutput,
} from "./output.js";

const HOST = "claude-code" as const;
const OPAQUE_REVISION = /^[A-Za-z0-9._~:+@=-]{1,512}$/u;
const VERSION_OUTPUT =
  /^([0-9]+\.[0-9]+\.[0-9]+)(?: \(Claude Code\))?\r?\n?$/u;
const MISMATCHED_MCP_ENDPOINT = "https://mismatched.invalid/" as const;
const CHILD_ENVIRONMENT_KEYS = Object.freeze([
  "APPDATA",
  "CLAUDE_CONFIG_DIR",
  "HOME",
  "LOCALAPPDATA",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
] as const);

type ProbeFailureReason =
  | "probe-failed"
  | "probe-timeout"
  | "probe-output-invalid"
  | "probe-output-too-large";

interface NormalizedCommandResult {
  readonly output: string;
  readonly stateRevision: string | null;
}

class ProbeFailure extends Error {
  constructor(readonly reason: ProbeFailureReason) {
    super("The Claude Code observation could not be verified.");
    this.name = "ProbeFailure";
  }
}

class NativeMutationPreconditionFailure extends Error {
  constructor() {
    super("The Claude Code mutation precondition changed.");
    this.name = "NativeMutationPreconditionFailure";
  }
}

function failProbe(reason: ProbeFailureReason): never {
  throw new ProbeFailure(reason);
}

function ownDataValue(object: object, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, key);
  } catch {
    return failProbe("probe-output-invalid");
  }
  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, "value") ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined
  ) {
    return failProbe("probe-output-invalid");
  }
  return descriptor.value;
}

function exactDataObject(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return failProbe("probe-output-invalid");
  }
  let prototype: object | null;
  let names: string[];
  let symbols: symbol[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    names = Object.getOwnPropertyNames(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return failProbe("probe-output-invalid");
  }
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    symbols.length !== 0 ||
    names.length !== keys.length ||
    names.some((name) => !keys.includes(name)) ||
    keys.some((key) => !names.includes(key))
  ) {
    return failProbe("probe-output-invalid");
  }
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of keys) {
    result[key] = ownDataValue(value, key);
  }
  return Object.freeze(result);
}

function wipe(bytes: Uint8Array): void {
  try {
    Uint8Array.prototype.fill.call(bytes, 0);
  } catch {
    // Best effort only; fixed failures must remain non-reflective.
  }
}

function wipeUnknown(bytes: unknown): void {
  if (intrinsicUint8ArrayByteLength(bytes) === undefined) {
    return;
  }
  try {
    Uint8Array.prototype.fill.call(bytes, 0);
  } catch {
    // A detached or hostile buffer no longer exposes safely writable bytes.
  }
}

function copyBytes(value: unknown, maximum: number): Uint8Array {
  const byteLength = intrinsicUint8ArrayByteLength(value);
  if (byteLength === undefined) {
    return failProbe("probe-output-invalid");
  }
  if (byteLength > maximum) {
    return failProbe("probe-output-too-large");
  }
  const copy = copyUint8Array(value, byteLength);
  if (copy === undefined) {
    return failProbe("probe-output-invalid");
  }
  return copy;
}

function decodeOutput(bytes: Uint8Array): string {
  try {
    const output = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (containsHostSensitiveMaterial(output)) {
      return failProbe("probe-output-invalid");
    }
    return output;
  } catch (error) {
    if (error instanceof ProbeFailure) {
      throw error;
    }
    return failProbe("probe-output-invalid");
  } finally {
    wipe(bytes);
  }
}

function disposeCompletedProcessBuffers(value: object): void {
  for (const key of ["stdout", "stderr"] as const) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      continue;
    }
    if (
      descriptor !== undefined &&
      Object.hasOwn(descriptor, "value")
    ) {
      wipeUnknown(descriptor.value);
    }
  }
}

function normalizeProcessResult(
  raw: ClaudeCodeProcessExecutionResult,
  maximum: number,
): NormalizedCommandResult {
  const statusObject =
    raw === null || typeof raw !== "object"
      ? failProbe("probe-output-invalid")
      : raw;
  const status = ownDataValue(statusObject, "status");
  if (status === "timeout") {
    exactDataObject(raw, ["status"]);
    return failProbe("probe-timeout");
  }
  if (status === "output-too-large") {
    exactDataObject(raw, ["status"]);
    return failProbe("probe-output-too-large");
  }
  if (status === "failed") {
    exactDataObject(raw, ["status"]);
    return failProbe("probe-failed");
  }
  if (status === "precondition-failed") {
    exactDataObject(raw, ["status"]);
    throw new NativeMutationPreconditionFailure();
  }
  if (status !== "completed") {
    return failProbe("probe-output-invalid");
  }

  try {
    const result = exactDataObject(raw, [
      "status",
      "exitCode",
      "stdout",
      "stderr",
      "stateRevision",
    ]);
    if (
      !Number.isSafeInteger(result.exitCode) ||
      (result.exitCode as number) < 0 ||
      (result.exitCode as number) > 255
    ) {
      return failProbe("probe-output-invalid");
    }
    const stateRevision =
      result.stateRevision === null
        ? null
        : safeRevision(result.stateRevision);
    const rawStdout = result.stdout;
    const rawStderr = result.stderr;
    if (rawStdout === rawStderr) {
      return failProbe("probe-output-invalid");
    }
    let stdout: Uint8Array | undefined;
    let stderr: Uint8Array | undefined;
    try {
      stdout = copyBytes(rawStdout, maximum);
      stderr = copyBytes(rawStderr, maximum);
    } catch (error) {
      if (stdout !== undefined) {
        wipe(stdout);
      }
      if (stderr !== undefined) {
        wipe(stderr);
      }
      throw error;
    }
    if (stdout.byteLength + stderr.byteLength > maximum) {
      wipe(stdout);
      wipe(stderr);
      return failProbe("probe-output-too-large");
    }
    if (result.exitCode !== 0 || stderr.byteLength !== 0) {
      wipe(stdout);
      wipe(stderr);
      return failProbe("probe-failed");
    }
    wipe(stderr);
    return Object.freeze({
      output: decodeOutput(stdout),
      stateRevision,
    });
  } finally {
    disposeCompletedProcessBuffers(statusObject);
  }
}

function safeRevision(value: unknown): string {
  if (
    typeof value !== "string" ||
    !OPAQUE_REVISION.test(value) ||
    containsHostControlCharacter(value) ||
    containsHostSensitiveMaterial(value)
  ) {
    return failProbe("probe-output-invalid");
  }
  return value;
}

function normalizeMcpEvidence(
  value: unknown,
): ClaudeCodeMcpEvidence {
  const evidence =
    value === null || typeof value !== "object"
      ? failProbe("probe-output-invalid")
      : value;
  const object = exactDataObject(evidence, ["status"]);
  if (
    object.status !== "absent" &&
    object.status !== "ambiguous" &&
    object.status !== "exact" &&
    object.status !== "mismatched"
  ) {
    return failProbe("probe-output-invalid");
  }
  return Object.freeze({ status: object.status });
}

function mcpSlot(
  evidence: ClaudeCodeMcpEvidence,
): ObservedSlot<HostMcpDescriptor> {
  if (evidence.status === "absent" || evidence.status === "ambiguous") {
    return Object.freeze({ status: evidence.status });
  }
  return Object.freeze({
    status: "present",
    value: Object.freeze({
      name: "plurum",
      endpoint:
        evidence.status === "exact"
          ? CLAUDE_CODE_MCP_ENDPOINT
          : MISMATCHED_MCP_ENDPOINT,
    }),
  });
}

function normalizeStateEvidence(raw: unknown): ClaudeCodeStateEvidence {
  const evidence = exactDataObject(raw, [
    "revision",
    "pluginMcp",
    "directMcp",
  ]);
  return Object.freeze({
    revision: safeRevision(evidence.revision),
    pluginMcp: normalizeMcpEvidence(evidence.pluginMcp),
    directMcp: normalizeMcpEvidence(evidence.directMcp),
  });
}

function parentDirectory(
  path: string,
  separator: "/" | "\\",
): string {
  const index = path.lastIndexOf(separator);
  if (index <= 0) {
    return failProbe("probe-output-invalid");
  }
  if (separator === "\\" && index === 2 && path[1] === ":") {
    return path.slice(0, 3);
  }
  return path.slice(0, index);
}

function executablePath(
  executable: HostExecutableAttestation,
  platform: PlatformAdapter,
): string {
  const delimiter = platform.os === "win32" ? ";" : ":";
  const seen = new Set<string>();
  const directories: string[] = [];
  for (const entry of executable.chain) {
    if (entry.kind !== "binary") {
      continue;
    }
    const directory = parentDirectory(entry.path, platform.paths.separator);
    const key = platform.os === "win32" ? directory.toLowerCase() : directory;
    if (!seen.has(key)) {
      seen.add(key);
      directories.push(directory);
    }
  }
  if (directories.length === 0) {
    return failProbe("probe-output-invalid");
  }
  return directories.join(delimiter);
}

function childEnvironment(
  platform: PlatformAdapter,
  executable: HostExecutableAttestation,
  preferHttps: boolean,
  gitTimeoutMs: number | null,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    PATH: executablePath(executable, platform),
    NO_COLOR: "1",
  };
  const raw = platform.environment;
  for (const key of CHILD_ENVIRONMENT_KEYS) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(raw, key);
    } catch {
      return failProbe("probe-output-invalid");
    }
    if (descriptor === undefined) {
      continue;
    }
    if (
      !Object.hasOwn(descriptor, "value") ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      typeof descriptor.value !== "string"
    ) {
      return failProbe("probe-output-invalid");
    }
    environment[key] = descriptor.value;
  }
  if (
    (platform.os === "darwin" || platform.os === "linux") &&
    environment.HOME === undefined &&
    environment.CLAUDE_CONFIG_DIR === undefined
  ) {
    return failProbe("probe-output-invalid");
  }
  if (
    platform.os === "win32" &&
    environment.APPDATA === undefined &&
    environment.CLAUDE_CONFIG_DIR === undefined
  ) {
    return failProbe("probe-output-invalid");
  }
  if (preferHttps) {
    environment.CLAUDE_CODE_PLUGIN_PREFER_HTTPS = "1";
  }
  if (gitTimeoutMs !== null) {
    environment.CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS = String(gitTimeoutMs);
  }
  return Object.freeze(environment);
}

function platformEnvironmentValue(
  platform: PlatformAdapter,
  key: "PATH" | "PATHEXT",
): string | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(platform.environment, key);
  } catch {
    return failProbe("probe-output-invalid");
  }
  if (descriptor === undefined) {
    return undefined;
  }
  if (
    !Object.hasOwn(descriptor, "value") ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    typeof descriptor.value !== "string"
  ) {
    return failProbe("probe-output-invalid");
  }
  return descriptor.value;
}

function sameExecutable(
  left: HostExecutableAttestation,
  right: HostExecutableAttestation,
): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function sameConfiguration(
  left: HostConfiguration,
  right: HostConfiguration,
): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function sameMcpEvidence(
  left: ClaudeCodeStateEvidence,
  right: ClaudeCodeStateEvidence,
): boolean {
  try {
    return (
      left.revision === right.revision &&
      JSON.stringify(left.pluginMcp) === JSON.stringify(right.pluginMcp) &&
      JSON.stringify(left.directMcp) === JSON.stringify(right.directMcp)
    );
  } catch {
    return false;
  }
}

async function reattest(
  dependencies: ClaudeCodeAdapterDependencies,
  executable: HostExecutableAttestation,
  request: HostInspectionRequest,
  platform: PlatformAdapter,
): Promise<HostExecutableAttestation> {
  let raw;
  try {
    raw = await dependencies.native.inspectCandidate({
      host: HOST,
      candidatePath: executable.sourcePath,
      excludedProjectDirectory: request.excludedProjectDirectory,
    });
  } catch {
    return failProbe("probe-failed");
  }
  const observation = exactDataObject(raw, ["status", "executable"]);
  if (observation.status !== "verified") {
    return failProbe("probe-failed");
  }
  let verified: HostExecutableAttestation;
  try {
    verified = validateHostExecutableAttestation(
      observation.executable,
      request,
      platform.paths,
      platform.os,
    );
  } catch {
    return failProbe("probe-output-invalid");
  }
  if (!sameExecutable(executable, verified)) {
    return failProbe("probe-failed");
  }
  return verified;
}

async function runCommand(
  dependencies: ClaudeCodeAdapterDependencies,
  platform: PlatformAdapter,
  request: HostInspectionRequest,
  executable: HostExecutableAttestation,
  command: ClaudeCodeCommand,
  expectedStateRevision: string | null,
): Promise<NormalizedCommandResult> {
  const verified = await reattest(
    dependencies,
    executable,
    request,
    platform,
  );
  const specification = claudeCodeCommandSpecification(command);
  let processRequest;
  try {
    processRequest = buildSafeHostProcessRequest(
      verified,
      specification.args,
      {
        host: HOST,
        neutralWorkingDirectory: dependencies.neutralWorkingDirectory,
        excludedProjectDirectory: request.excludedProjectDirectory,
        environment: childEnvironment(
          platform,
          verified,
          specification.preferHttps,
          specification.gitTimeoutMs,
        ),
        timeoutMs: specification.timeoutMs,
        maxOutputBytes: specification.maxOutputBytes,
      },
      platform.paths,
      platform.os,
    );
  } catch {
    return failProbe("probe-output-invalid");
  }

  let raw: ClaudeCodeProcessExecutionResult;
  try {
    raw = await dependencies.native.run(
      Object.freeze({
        kind: "claude-code-fixed-spawn",
        command,
        executable: verified,
        executableRevision: verified.revision,
        expectedStateRevision,
        excludedProjectDirectory: request.excludedProjectDirectory,
        process: processRequest,
      }),
    );
  } catch {
    return failProbe("probe-failed");
  }
  const result = normalizeProcessResult(raw, specification.maxOutputBytes);
  const mutation = CLAUDE_CODE_MUTATION_COMMANDS.includes(
    command as ClaudeCodeMutationCommand,
  );
  if (
    (mutation && expectedStateRevision === null) ||
    (!mutation && expectedStateRevision !== null) ||
    (mutation && result.stateRevision === null) ||
    (!mutation && result.stateRevision !== null) ||
    (result.stateRevision !== null &&
      result.stateRevision === expectedStateRevision)
  ) {
    return failProbe("probe-output-invalid");
  }
  return result;
}

async function observeStateEvidence(
  dependencies: ClaudeCodeAdapterDependencies,
  platform: PlatformAdapter,
  request: HostInspectionRequest,
  executable: HostExecutableAttestation,
): Promise<ClaudeCodeStateEvidence> {
  const reattested = await reattest(
    dependencies,
    executable,
    request,
    platform,
  );
  let rawEvidence: unknown;
  try {
    rawEvidence = await dependencies.native.observe({
      executable: reattested,
      executableRevision: reattested.revision,
      excludedProjectDirectory: request.excludedProjectDirectory,
      scope: "user",
    });
  } catch {
    return failProbe("probe-failed");
  }
  return normalizeStateEvidence(rawEvidence);
}

function parseVersion(output: string): string {
  const match = VERSION_OUTPUT.exec(output);
  const version = match?.[1];
  if (version === undefined) {
    return failProbe("probe-output-invalid");
  }
  try {
    return parseCanonicalVersion(version).canonical;
  } catch {
    return failProbe("probe-output-invalid");
  }
}

function unavailable(
  executable: HostExecutableAttestation,
  reason: ProbeFailureReason,
): HostInspection {
  return Object.freeze({
    host: HOST,
    status: "unavailable",
    reason,
    executable,
  });
}

export function createClaudeCodeAdapter(
  dependencies: ClaudeCodeAdapterDependencies,
  platform: PlatformAdapter,
): HostMutationAdapter {
  async function inspect(
    rawRequest: HostInspectionRequest,
  ): Promise<HostInspection> {
    let request: HostInspectionRequest;
    try {
      const record = exactDataObject(rawRequest, [
        "host",
        "scope",
        "excludedProjectDirectory",
      ]);
      if (
        record.host !== HOST ||
        record.scope !== "user" ||
        typeof record.excludedProjectDirectory !== "string" ||
        record.excludedProjectDirectory.length === 0 ||
        record.excludedProjectDirectory.length > 32_767 ||
        containsHostControlCharacter(record.excludedProjectDirectory) ||
        containsHostSensitiveMaterial(record.excludedProjectDirectory)
      ) {
        throw new ProbeFailure("probe-output-invalid");
      }
      request = Object.freeze({
        host: HOST,
        scope: "user",
        excludedProjectDirectory: record.excludedProjectDirectory,
      });
    } catch {
      return Object.freeze({
        host: HOST,
        status: "blocked",
        reason: "unverifiable-executable",
      });
    }
    if (
      platform.elevation !== "standard" ||
      (platform.os !== "darwin" &&
        platform.os !== "linux" &&
        platform.os !== "win32")
    ) {
      return Object.freeze({
        host: HOST,
        status: "blocked",
        reason: "unverifiable-executable",
      });
    }

    let discovery;
    try {
      const path = platformEnvironmentValue(platform, "PATH");
      const pathExt = platformEnvironmentValue(platform, "PATHEXT");
      discovery = await discoverHostExecutable(
        {
          host: HOST,
          executableName: "claude",
          path,
          ...(pathExt === undefined ? {} : { pathExt }),
          excludedProjectDirectory: request.excludedProjectDirectory,
        },
        dependencies.native,
        platform.paths,
        platform.os,
      );
    } catch {
      return Object.freeze({
        host: HOST,
        status: "blocked",
        reason: "unverifiable-executable",
      });
    }
    if (discovery.status !== "verified") {
      return discovery;
    }
    const executable = discovery.executable;

    try {
      const version = parseVersion(
        (
          await runCommand(
            dependencies,
            platform,
            request,
            executable,
            "version",
            null,
          )
        ).output,
      );
      const evidenceBefore = await observeStateEvidence(
        dependencies,
        platform,
        request,
        executable,
      );
      const marketplace = parseClaudeCodeMarketplaceListOutput(
        (
          await runCommand(
            dependencies,
            platform,
            request,
            executable,
            "list-marketplaces",
            null,
          )
        ).output,
      );
      const plugin = parseClaudeCodePluginListOutput(
        (
          await runCommand(
            dependencies,
            platform,
            request,
            executable,
            "list-plugins",
            null,
          )
        ).output,
      );
      const evidence = await observeStateEvidence(
        dependencies,
        platform,
        request,
        executable,
      );
      if (!sameMcpEvidence(evidenceBefore, evidence)) {
        return unavailable(executable, "probe-output-invalid");
      }

      return validateHostInspection(
        {
          host: HOST,
          status: "available",
          executable,
          version,
          state: {
            revision: evidence.revision,
            configuration: {
              marketplace,
              plugin,
              pluginMcp: mcpSlot(evidence.pluginMcp),
              directMcp: mcpSlot(evidence.directMcp),
            },
          },
          mutationSupport: CLAUDE_CODE_MUTATION_SUPPORT,
        },
        request,
        platform.paths,
        platform.os,
      );
    } catch (error) {
      if (error instanceof ProbeFailure) {
        return unavailable(executable, error.reason);
      }
      if (error instanceof HostError) {
        return unavailable(
          executable,
          error.code === "host_output_too_large"
            ? "probe-output-too-large"
            : "probe-output-invalid",
        );
      }
      return unavailable(executable, "probe-failed");
    }
  }

  async function apply(
    rawRequest: HostApplyRequest,
  ): Promise<HostMutationResult> {
    try {
      let request: HostApplyRequest;
      try {
        request = snapshotHostApplyRequest(rawRequest, HOST);
      } catch {
        return Object.freeze({ status: "failed" });
      }
      const command = claudeCodeApplyCommand(request.action.kind);
      if (command === null) {
        return Object.freeze({ status: "failed" });
      }
      const inspectionRequest = Object.freeze({
        host: HOST,
        scope: "user" as const,
        excludedProjectDirectory: platform.cwd,
      });
      const before = await inspect(inspectionRequest);
      if (
        before.status !== "available" ||
        before.executable.revision !== request.executableRevision ||
        before.state.revision !== request.expectedBeforeRevision ||
        !sameConfiguration(
          before.state.configuration,
          request.expectedBefore,
        )
      ) {
        return Object.freeze({ status: "precondition-failed" });
      }
      let mutation: NormalizedCommandResult;
      try {
        mutation = await runCommand(
          dependencies,
          platform,
          inspectionRequest,
          before.executable,
          command,
          before.state.revision,
        );
      } catch (error) {
        if (error instanceof NativeMutationPreconditionFailure) {
          return Object.freeze({ status: "precondition-failed" });
        }
        throw error;
      }
      const after = await inspect(inspectionRequest);
      if (
        after.status !== "available" ||
        !sameExecutable(after.executable, before.executable) ||
        after.state.revision === before.state.revision ||
        after.state.revision !== mutation.stateRevision ||
        !sameConfiguration(after.state.configuration, request.action.after)
      ) {
        return Object.freeze({ status: "failed" });
      }
      return Object.freeze({
        status: "changed",
        stateRevision: after.state.revision,
      });
    } catch {
      return Object.freeze({ status: "failed" });
    }
  }

  async function rollback(
    rawRequest: HostRollbackRequest,
  ): Promise<HostMutationResult> {
    try {
      let request: HostRollbackRequest;
      try {
        request = snapshotHostRollbackRequest(rawRequest, HOST);
      } catch {
        return Object.freeze({ status: "failed" });
      }
      const command = claudeCodeRollbackCommand(
        request.action.rollback.kind,
      );
      if (command === null) {
        return Object.freeze({ status: "failed" });
      }
      const inspectionRequest = Object.freeze({
        host: HOST,
        scope: "user" as const,
        excludedProjectDirectory: platform.cwd,
      });
      const after = await inspect(inspectionRequest);
      if (
        after.status !== "available" ||
        after.executable.revision !== request.executableRevision ||
        after.state.revision !== request.expectedAfterRevision ||
        !sameConfiguration(
          after.state.configuration,
          request.expectedAfter,
        )
      ) {
        return Object.freeze({ status: "precondition-failed" });
      }
      let mutation: NormalizedCommandResult;
      try {
        mutation = await runCommand(
          dependencies,
          platform,
          inspectionRequest,
          after.executable,
          command,
          after.state.revision,
        );
      } catch (error) {
        if (error instanceof NativeMutationPreconditionFailure) {
          return Object.freeze({ status: "precondition-failed" });
        }
        throw error;
      }
      const restored = await inspect(inspectionRequest);
      if (
        restored.status !== "available" ||
        !sameExecutable(restored.executable, after.executable) ||
        restored.state.revision === after.state.revision ||
        restored.state.revision !== mutation.stateRevision ||
        !sameConfiguration(
          restored.state.configuration,
          request.action.before,
        )
      ) {
        return Object.freeze({ status: "failed" });
      }
      return Object.freeze({
        status: "changed",
        stateRevision: restored.state.revision,
      });
    } catch {
      return Object.freeze({ status: "failed" });
    }
  }

  return Object.freeze({ inspect, apply, rollback });
}

export {
  CLAUDE_CODE_DESIRED_CONFIGURATION,
};
