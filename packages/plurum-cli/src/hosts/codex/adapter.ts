import type {
  HostApplyRequest,
  HostConfiguration,
  HostExecutableAttestation,
  HostInspection,
  HostInspectionRequest,
  HostMarketplaceDescriptor,
  HostMcpDescriptor,
  HostMutationAdapter,
  HostMutationResult,
  HostPluginDescriptor,
  HostRollbackRequest,
  ObservedSlot,
} from "../contracts.js";
import { discoverHostExecutable } from "../discovery.js";
import { HostError } from "../errors.js";
import {
  validateHostExecutableAttestation,
  validateHostInspection,
} from "../inspection.js";
import {
  containsHostControlCharacter,
  containsHostSensitiveMaterial,
} from "../privacy.js";
import { buildSafeHostProcessRequest } from "../process-policy.js";
import { parseCanonicalVersion } from "../version.js";
import type { PlatformAdapter } from "../../system/contracts.js";
import {
  snapshotHostApplyRequest,
  snapshotHostRollbackRequest,
} from "../../system/host-mutation-boundary.js";
import { codexCommandSpecification } from "./commands.js";
import {
  CODEX_DESIRED_CONFIGURATION,
  CODEX_MARKETPLACE_NAME,
  CODEX_MARKETPLACE_SOURCE,
  CODEX_MCP_ENDPOINT,
  CODEX_MUTATION_SUPPORT,
  CODEX_PLUGIN_NAME,
  CODEX_PLUGIN_SOURCE,
} from "./configuration.js";
import type {
  CodexAdapterDependencies,
  CodexMutationCommand,
  CodexPluginEvidence,
  CodexProcessExecutionResult,
  CodexSlotEvidence,
  CodexStateEvidence,
} from "./contracts.js";

const HOST = "codex" as const;
const OPAQUE_REVISION = /^[A-Za-z0-9._~:+@=-]{1,512}$/u;
const MISMATCHED_MCP_ENDPOINT = "https://mismatched.invalid/" as const;
const MISMATCHED_MARKETPLACE_SOURCE =
  "https://mismatched.invalid/" as const;
const MISMATCHED_PLUGIN_SOURCE = "mismatched@invalid" as const;
const CHILD_ENVIRONMENT_KEYS = Object.freeze([
  "APPDATA",
  "CODEX_HOME",
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
  readonly stateRevision: string;
}

class ProbeFailure extends Error {
  constructor(readonly reason: ProbeFailureReason) {
    super("The Codex observation could not be verified.");
    this.name = "ProbeFailure";
  }
}

class NativeMutationPreconditionFailure extends Error {
  constructor() {
    super("The Codex mutation precondition changed.");
    this.name = "NativeMutationPreconditionFailure";
  }
}

function failProbe(reason: ProbeFailureReason): never {
  throw new ProbeFailure(reason);
}

function snapshotDataObject(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return failProbe("probe-output-invalid");
  }
  let prototype: object | null;
  let ownKeys: (string | symbol)[];
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    ownKeys = Reflect.ownKeys(value);
    for (const key of ownKeys) {
      if (typeof key !== "string") {
        return failProbe("probe-output-invalid");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        return failProbe("probe-output-invalid");
      }
      result[key] = descriptor.value;
    }
  } catch {
    return failProbe("probe-output-invalid");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return failProbe("probe-output-invalid");
  }
  return Object.freeze(result);
}

function exactSnapshot(
  snapshot: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  const names = Object.keys(snapshot);
  if (
    names.length !== keys.length ||
    names.some((name) => !keys.includes(name)) ||
    keys.some((key) => !Object.hasOwn(snapshot, key))
  ) {
    return failProbe("probe-output-invalid");
  }
  return snapshot;
}

function exactDataObject(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  return exactSnapshot(snapshotDataObject(value), keys);
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

function normalizeProcessResult(
  raw: CodexProcessExecutionResult,
): NormalizedCommandResult {
  const snapshot = snapshotDataObject(raw);
  const status = snapshot.status;
  if (status === "timeout") {
    exactSnapshot(snapshot, ["status"]);
    return failProbe("probe-timeout");
  }
  if (status === "output-too-large") {
    exactSnapshot(snapshot, ["status"]);
    return failProbe("probe-output-too-large");
  }
  if (status === "failed") {
    exactSnapshot(snapshot, ["status"]);
    return failProbe("probe-failed");
  }
  if (status === "precondition-failed") {
    exactSnapshot(snapshot, ["status"]);
    throw new NativeMutationPreconditionFailure();
  }
  if (status !== "completed") {
    return failProbe("probe-output-invalid");
  }
  const result = exactSnapshot(snapshot, ["status", "stateRevision"]);
  return Object.freeze({
    stateRevision: safeRevision(result.stateRevision),
  });
}

function normalizeSlotEvidence(value: unknown): CodexSlotEvidence {
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

function normalizePluginEvidence(value: unknown): CodexPluginEvidence {
  const snapshot = snapshotDataObject(value);
  const status = snapshot.status;
  if (status === "absent" || status === "ambiguous") {
    exactSnapshot(snapshot, ["status"]);
    return Object.freeze({ status });
  }
  if (status !== "exact" && status !== "mismatched") {
    return failProbe("probe-output-invalid");
  }
  const object = exactSnapshot(snapshot, [
    "status",
    "version",
    "enabled",
  ]);
  if (typeof object.version !== "string" || typeof object.enabled !== "boolean") {
    return failProbe("probe-output-invalid");
  }
  let version: string;
  try {
    version = parseCanonicalVersion(object.version).canonical;
  } catch {
    return failProbe("probe-output-invalid");
  }
  if (version !== object.version) {
    return failProbe("probe-output-invalid");
  }
  return Object.freeze({ status, version, enabled: object.enabled });
}

function normalizeVersion(value: unknown): string {
  if (typeof value !== "string") {
    return failProbe("probe-output-invalid");
  }
  try {
    const version = parseCanonicalVersion(value).canonical;
    return version === value ? version : failProbe("probe-output-invalid");
  } catch {
    return failProbe("probe-output-invalid");
  }
}

function normalizeStateEvidence(raw: unknown): CodexStateEvidence {
  const evidence = exactDataObject(raw, [
    "revision",
    "version",
    "marketplace",
    "plugin",
    "pluginMcp",
    "directMcp",
  ]);
  return Object.freeze({
    revision: safeRevision(evidence.revision),
    version: normalizeVersion(evidence.version),
    marketplace: normalizeSlotEvidence(evidence.marketplace),
    plugin: normalizePluginEvidence(evidence.plugin),
    pluginMcp: normalizeSlotEvidence(evidence.pluginMcp),
    directMcp: normalizeSlotEvidence(evidence.directMcp),
  });
}

function mcpSlot(
  evidence: CodexSlotEvidence,
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
          ? CODEX_MCP_ENDPOINT
          : MISMATCHED_MCP_ENDPOINT,
    }),
  });
}

function marketplaceSlot(
  evidence: CodexSlotEvidence,
): ObservedSlot<HostMarketplaceDescriptor> {
  if (evidence.status === "absent" || evidence.status === "ambiguous") {
    return Object.freeze({ status: evidence.status });
  }
  return Object.freeze({
    status: "present",
    value: Object.freeze({
      name: CODEX_MARKETPLACE_NAME,
      source:
        evidence.status === "exact"
          ? CODEX_MARKETPLACE_SOURCE
          : MISMATCHED_MARKETPLACE_SOURCE,
    }),
  });
}

function pluginSlot(
  evidence: CodexPluginEvidence,
): ObservedSlot<HostPluginDescriptor> {
  if (evidence.status !== "exact" && evidence.status !== "mismatched") {
    return Object.freeze({ status: evidence.status });
  }
  return Object.freeze({
    status: "present",
    value: Object.freeze({
      name: CODEX_PLUGIN_NAME,
      source:
        evidence.status === "exact"
          ? CODEX_PLUGIN_SOURCE
          : MISMATCHED_PLUGIN_SOURCE,
      version: evidence.version,
      enabled: evidence.enabled,
    }),
  });
}

function parentDirectory(path: string, separator: "/" | "\\"): string {
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
  const directories: string[] = [];
  const seen = new Set<string>();
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
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    PATH: executablePath(executable, platform),
    NO_COLOR: "1",
  };
  for (const key of CHILD_ENVIRONMENT_KEYS) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(platform.environment, key);
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
    environment.CODEX_HOME === undefined
  ) {
    return failProbe("probe-output-invalid");
  }
  if (
    platform.os === "win32" &&
    environment.APPDATA === undefined &&
    environment.CODEX_HOME === undefined
  ) {
    return failProbe("probe-output-invalid");
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

async function reattest(
  dependencies: CodexAdapterDependencies,
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
  dependencies: CodexAdapterDependencies,
  platform: PlatformAdapter,
  request: HostInspectionRequest,
  executable: HostExecutableAttestation,
  command: CodexMutationCommand,
  expectedStateRevision: string,
): Promise<NormalizedCommandResult> {
  const verified = await reattest(
    dependencies,
    executable,
    request,
    platform,
  );
  const specification = codexCommandSpecification(command);
  let processRequest;
  try {
    processRequest = buildSafeHostProcessRequest(
      verified,
      specification.args,
      {
        host: HOST,
        neutralWorkingDirectory: dependencies.neutralWorkingDirectory,
        excludedProjectDirectory: request.excludedProjectDirectory,
        environment: childEnvironment(platform, verified),
        timeoutMs: specification.timeoutMs,
        maxOutputBytes: specification.maxOutputBytes,
      },
      platform.paths,
      platform.os,
    );
  } catch {
    return failProbe("probe-output-invalid");
  }

  let raw: CodexProcessExecutionResult;
  try {
    raw = await dependencies.native.run(
      Object.freeze({
        kind: "codex-fixed-spawn",
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
  const result = normalizeProcessResult(raw);
  if (result.stateRevision === expectedStateRevision) {
    return failProbe("probe-output-invalid");
  }
  return result;
}

async function observeStateEvidence(
  dependencies: CodexAdapterDependencies,
  platform: PlatformAdapter,
  request: HostInspectionRequest,
  executable: HostExecutableAttestation,
): Promise<CodexStateEvidence> {
  const verified = await reattest(
    dependencies,
    executable,
    request,
    platform,
  );
  let raw: unknown;
  try {
    raw = await dependencies.native.observe({
      executable: verified,
      executableRevision: verified.revision,
      excludedProjectDirectory: request.excludedProjectDirectory,
      scope: "user",
    });
  } catch {
    return failProbe("probe-failed");
  }
  return normalizeStateEvidence(raw);
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

function mutationCommand(request: HostApplyRequest): CodexMutationCommand | null {
  switch (request.action.kind) {
    case "add-marketplace":
      return "add-marketplace";
    case "install-plugin":
      return "install-plugin";
    case "enable-plugin":
    case "update-plugin":
      return null;
  }
}

function rollbackCommand(
  request: HostRollbackRequest,
): CodexMutationCommand | null {
  switch (request.action.rollback.kind) {
    case "remove-cli-created-marketplace":
      return "remove-marketplace";
    case "remove-cli-created-plugin":
      return "uninstall-plugin";
    case "restore-plugin-disabled":
    case "restore-plugin-version":
      return null;
  }
}

export function createCodexAdapter(
  dependencies: CodexAdapterDependencies,
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
          executableName: "codex",
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
      const evidence = await observeStateEvidence(
        dependencies,
        platform,
        request,
        executable,
      );
      return validateHostInspection(
        {
          host: HOST,
          status: "available",
          executable,
          version: evidence.version,
          state: {
            revision: evidence.revision,
            configuration: {
              marketplace: marketplaceSlot(evidence.marketplace),
              plugin: pluginSlot(evidence.plugin),
              pluginMcp: mcpSlot(evidence.pluginMcp),
              directMcp: mcpSlot(evidence.directMcp),
            },
          },
          mutationSupport: CODEX_MUTATION_SUPPORT,
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
      const command = mutationCommand(request);
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
        !sameConfiguration(before.state.configuration, request.expectedBefore)
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
      const command = rollbackCommand(request);
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
        !sameConfiguration(after.state.configuration, request.expectedAfter)
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

export { CODEX_DESIRED_CONFIGURATION };
