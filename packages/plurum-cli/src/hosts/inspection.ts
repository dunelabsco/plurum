import type {
  DesiredHostConfiguration,
  HostConfiguration,
  HostExecutableAttestation,
  HostExecutableChainEntry,
  HostId,
  HostInspection,
  HostInspectionAdapter,
  HostInspectionRequest,
  HostMarketplaceDescriptor,
  HostMcpDescriptor,
  HostMutationSupport,
  HostPluginDescriptor,
  HostStateSnapshot,
  ObservedSlot,
} from "./contracts.js";
import { HOST_IDS } from "./contracts.js";
import { HostError } from "./errors.js";
import {
  containsHostControlCharacter,
  containsHostSensitiveMaterial,
} from "./privacy.js";
import type { PlatformPathAdapter, SupportedOs } from "../system/contracts.js";

const MAX_CHAIN_ENTRIES = 16;
const MAX_PUBLIC_STRING = 4_096;
const OPAQUE_REVISION = /^[A-Za-z0-9._~:+@=-]{1,512}$/u;

type UnknownRecord = Record<string, unknown>;

function invalidObservation(): never {
  throw new HostError("invalid_host_observation");
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  let keys: string[];
  try {
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      return false;
    }
    keys = Object.keys(value);
  } catch {
    return false;
  }
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    return false;
  }
  return keys.length >= required.length;
}

function publicString(value: unknown, max = MAX_PUBLIC_STRING): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    containsHostControlCharacter(value) ||
    containsHostSensitiveMaterial(value)
  ) {
    return invalidObservation();
  }
  return value;
}

function revision(value: unknown): string {
  if (typeof value !== "string" || !OPAQUE_REVISION.test(value)) {
    return invalidObservation();
  }
  return value;
}

function comparable(path: string, os: SupportedOs): string {
  return os === "win32" ? path.toLowerCase() : path;
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

function safeAbsolutePath(
  value: unknown,
  paths: PlatformPathAdapter,
): string {
  const path = publicString(value, 32_767);
  const segments =
    paths.separator === "/" ? path.split("/") : path.split(/[\\/]/u);
  if (
    !paths.isAbsolute(path) ||
    segments.some((segment) => segment === "." || segment === "..") ||
    (paths.separator === "/" && path.startsWith("//")) ||
    (paths.separator === "\\" &&
      (path.startsWith("\\\\") ||
        path.toLowerCase().startsWith("\\\\?\\") ||
        path.toLowerCase().startsWith("\\\\.\\")))
  ) {
    return invalidObservation();
  }
  const normalized = paths.normalize(path);
  if (
    comparable(normalized, paths.separator === "\\" ? "win32" : "linux") !==
    comparable(path, paths.separator === "\\" ? "win32" : "linux")
  ) {
    return invalidObservation();
  }
  return path;
}

function chainEntry(
  input: unknown,
  request: HostInspectionRequest,
  paths: PlatformPathAdapter,
  os: SupportedOs,
): HostExecutableChainEntry {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "access",
      "binding",
      "kind",
      "link",
      "owner",
      "path",
      "revision",
    ])
  ) {
    return invalidObservation();
  }
  const path = safeAbsolutePath(input.path, paths);
  if (isWithin(request.excludedProjectDirectory, path, paths, os)) {
    return invalidObservation();
  }
  if (
    typeof input.kind !== "string" ||
    !["binary", "script", "shim"].includes(input.kind)
  ) {
    return invalidObservation();
  }
  if (
    typeof input.owner !== "string" ||
    !["current-user", "trusted-system"].includes(input.owner)
  ) {
    return invalidObservation();
  }
  if (
    input.access !== "not-broadly-writable" ||
    input.binding !== "canonical" ||
    typeof input.link !== "string" ||
    !["direct", "resolved-link", "approved-npm-shim"].includes(input.link)
  ) {
    return invalidObservation();
  }
  return Object.freeze({
    path,
    kind: input.kind as HostExecutableChainEntry["kind"],
    owner: input.owner as HostExecutableChainEntry["owner"],
    access: "not-broadly-writable",
    binding: "canonical",
    link: input.link as HostExecutableChainEntry["link"],
    revision: revision(input.revision),
  });
}

export function validateHostExecutableAttestation(
  input: unknown,
  request: HostInspectionRequest,
  paths: PlatformPathAdapter,
  os: SupportedOs,
): HostExecutableAttestation {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "chain",
      "launch",
      "resolvedPath",
      "revision",
      "sourcePath",
    ]) ||
    !Array.isArray(input.chain) ||
    input.chain.length === 0 ||
    input.chain.length > MAX_CHAIN_ENTRIES ||
    !isRecord(input.launch) ||
    !hasExactKeys(input.launch, ["argumentPrefix", "executable", "shell"]) ||
    !Array.isArray(input.launch.argumentPrefix) ||
    input.launch.shell !== false
  ) {
    return invalidObservation();
  }

  const sourcePath = safeAbsolutePath(input.sourcePath, paths);
  const resolvedPath = safeAbsolutePath(input.resolvedPath, paths);
  const launchExecutable = safeAbsolutePath(input.launch.executable, paths);
  if (
    [sourcePath, resolvedPath, launchExecutable].some((path) =>
      isWithin(request.excludedProjectDirectory, path, paths, os),
    )
  ) {
    return invalidObservation();
  }

  const chain = Object.freeze(
    input.chain.map((entry) => chainEntry(entry, request, paths, os)),
  );
  const seen = new Set<string>();
  for (const entry of chain) {
    const key = comparable(entry.path, os);
    if (seen.has(key)) {
      return invalidObservation();
    }
    seen.add(key);
  }
  if (
    comparable(chain[0]?.path ?? "", os) !== comparable(sourcePath, os) ||
    !seen.has(comparable(resolvedPath, os)) ||
    !seen.has(comparable(launchExecutable, os))
  ) {
    return invalidObservation();
  }

  const argumentPrefix = Object.freeze(
    input.launch.argumentPrefix.map((argument) => publicString(argument, 32_767)),
  );
  const windowsCommandShim =
    os === "win32" && /\.(?:cmd|bat)$/iu.test(sourcePath);
  if (os === "win32" && /\.(?:cmd|bat|ps1)$/iu.test(launchExecutable)) {
    return invalidObservation();
  }
  if (windowsCommandShim) {
    const source = chain[0];
    const resolved = chain.find(
      (entry) => comparable(entry.path, os) === comparable(resolvedPath, os),
    );
    const launcher = chain.find(
      (entry) =>
        comparable(entry.path, os) === comparable(launchExecutable, os),
    );
    if (
      source?.kind !== "shim" ||
      source.link !== "approved-npm-shim" ||
      resolved?.kind !== "script" ||
      !/\.(?:c?js|mjs)$/iu.test(resolvedPath) ||
      launcher?.kind !== "binary" ||
      argumentPrefix.length !== 1 ||
      comparable(argumentPrefix[0] ?? "", os) !== comparable(resolvedPath, os)
    ) {
      return invalidObservation();
    }
  } else {
    const source = chain[0];
    const resolved = chain.find(
      (entry) => comparable(entry.path, os) === comparable(resolvedPath, os),
    );
    const launcher = chain.find(
      (entry) =>
        comparable(entry.path, os) === comparable(launchExecutable, os),
    );
    if (resolved?.kind === "script") {
      const directScript =
        source?.kind === "script" &&
        comparable(source.path, os) === comparable(resolvedPath, os);
      const approvedShim =
        source?.kind === "shim" && source.link === "approved-npm-shim";
      if (
        launcher?.kind !== "binary" ||
        argumentPrefix.length !== 1 ||
        comparable(argumentPrefix[0] ?? "", os) !==
          comparable(resolvedPath, os) ||
        (!directScript && !approvedShim)
      ) {
        return invalidObservation();
      }
    } else if (
      resolved?.kind !== "binary" ||
      comparable(launchExecutable, os) !== comparable(resolvedPath, os) ||
      argumentPrefix.length !== 0
    ) {
      return invalidObservation();
    }
  }

  const result = Object.freeze({
    sourcePath,
    resolvedPath,
    revision: revision(input.revision),
    chain,
    launch: Object.freeze({
      executable: launchExecutable,
      argumentPrefix,
      shell: false,
    }),
  });
  return result;
}

function marketplaceDescriptor(input: unknown): HostMarketplaceDescriptor {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["name", "source"]) ||
    input.name !== "plurum"
  ) {
    return invalidObservation();
  }
  return Object.freeze({
    name: "plurum",
    source: publicString(input.source),
  });
}

function pluginDescriptor(input: unknown): HostPluginDescriptor {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["enabled", "name", "source", "version"]) ||
    input.name !== "plurum" ||
    typeof input.enabled !== "boolean"
  ) {
    return invalidObservation();
  }
  return Object.freeze({
    name: "plurum",
    source: publicString(input.source),
    version: publicString(input.version, 128),
    enabled: input.enabled,
  });
}

function mcpDescriptor(input: unknown): HostMcpDescriptor {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["endpoint", "name"]) ||
    input.name !== "plurum"
  ) {
    return invalidObservation();
  }
  return Object.freeze({
    name: "plurum",
    endpoint: publicString(input.endpoint),
  });
}

function slot<Value>(
  input: unknown,
  copyValue: (value: unknown) => Value,
): ObservedSlot<Value> {
  if (!isRecord(input) || typeof input.status !== "string") {
    return invalidObservation();
  }
  if (input.status === "absent" || input.status === "ambiguous") {
    if (!hasExactKeys(input, ["status"])) {
      return invalidObservation();
    }
    return Object.freeze({ status: input.status });
  }
  if (
    input.status !== "present" ||
    !hasExactKeys(input, ["status", "value"])
  ) {
    return invalidObservation();
  }
  return Object.freeze({
    status: "present",
    value: copyValue(input.value),
  });
}

export function copyHostConfiguration(input: unknown): HostConfiguration {
  try {
    if (
      !isRecord(input) ||
      !hasExactKeys(input, [
        "directMcp",
        "marketplace",
        "plugin",
        "pluginMcp",
      ])
    ) {
      return invalidObservation();
    }
    return Object.freeze({
      marketplace: slot(input.marketplace, marketplaceDescriptor),
      plugin: slot(input.plugin, pluginDescriptor),
      pluginMcp: slot(input.pluginMcp, mcpDescriptor),
      directMcp: slot(input.directMcp, mcpDescriptor),
    });
  } catch (error) {
    if (error instanceof HostError) {
      throw error;
    }
    return invalidObservation();
  }
}

function stateSnapshot(input: unknown): HostStateSnapshot {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["configuration", "revision"])
  ) {
    return invalidObservation();
  }
  return Object.freeze({
    revision: revision(input.revision),
    configuration: copyHostConfiguration(input.configuration),
  });
}

function mutationSupport(input: unknown): HostMutationSupport {
  const keys = [
    "addMarketplace",
    "disablePlugin",
    "enablePlugin",
    "installPlugin",
    "removeMarketplace",
    "removePlugin",
    "restorePlugin",
    "updatePlugin",
  ] as const;
  if (
    !isRecord(input) ||
    !hasExactKeys(input, keys) ||
    keys.some((key) => typeof input[key] !== "boolean")
  ) {
    return invalidObservation();
  }
  return Object.freeze(
    Object.fromEntries(keys.map((key) => [key, input[key]])),
  ) as unknown as HostMutationSupport;
}

function isHostId(value: unknown): value is HostId {
  return typeof value === "string" && HOST_IDS.includes(value as HostId);
}

export function validateHostInspection(
  input: unknown,
  request: HostInspectionRequest,
  paths: PlatformPathAdapter,
  os: SupportedOs,
): HostInspection {
  try {
    if (
      !isRecord(input) ||
      !isHostId(input.host) ||
      input.host !== request.host ||
      typeof input.status !== "string"
    ) {
      return invalidObservation();
    }
    if (input.status === "absent") {
      if (!hasExactKeys(input, ["host", "status"])) {
        return invalidObservation();
      }
      return Object.freeze({ host: input.host, status: "absent" });
    }
    if (input.status === "blocked") {
      if (
        !hasExactKeys(input, ["host", "reason", "status"], ["candidatePath"]) ||
        typeof input.reason !== "string" ||
        ![
          "ambiguous-executable",
          "unsafe-executable",
          "unsafe-path-entry",
          "unsafe-shadow",
          "unsupported-shim",
          "unverifiable-executable",
        ].includes(input.reason)
      ) {
        return invalidObservation();
      }
      const candidatePath =
        input.candidatePath === undefined
          ? undefined
          : safeAbsolutePath(input.candidatePath, paths);
      return Object.freeze({
        host: input.host,
        status: "blocked",
        reason: input.reason as Extract<
          HostInspection,
          { status: "blocked" }
        >["reason"],
        ...(candidatePath === undefined ? {} : { candidatePath }),
      });
    }
    if (input.status === "unavailable") {
      if (
        !hasExactKeys(input, ["executable", "host", "reason", "status"]) ||
        typeof input.reason !== "string" ||
        ![
          "probe-failed",
          "probe-output-invalid",
          "probe-output-too-large",
          "probe-timeout",
        ].includes(input.reason)
      ) {
        return invalidObservation();
      }
      return Object.freeze({
        host: input.host,
        status: "unavailable",
        reason: input.reason as Extract<
          HostInspection,
          { status: "unavailable" }
        >["reason"],
        executable: validateHostExecutableAttestation(
          input.executable,
          request,
          paths,
          os,
        ),
      });
    }
    if (
      input.status !== "available" ||
      !hasExactKeys(input, [
        "executable",
        "host",
        "mutationSupport",
        "state",
        "status",
        "version",
      ])
    ) {
      return invalidObservation();
    }
    return Object.freeze({
      host: input.host,
      status: "available",
      executable: validateHostExecutableAttestation(
        input.executable,
        request,
        paths,
        os,
      ),
      version: publicString(input.version, 128),
      state: stateSnapshot(input.state),
      mutationSupport: mutationSupport(input.mutationSupport),
    });
  } catch (error) {
    if (error instanceof HostError) {
      throw error;
    }
    return invalidObservation();
  }
}

export async function inspectSelectedHosts(
  hosts: readonly HostId[],
  adapters: Readonly<Record<HostId, HostInspectionAdapter>>,
  excludedProjectDirectory: string,
  paths: PlatformPathAdapter,
  os: SupportedOs,
): Promise<readonly HostInspection[]> {
  const excluded = safeAbsolutePath(excludedProjectDirectory, paths);
  if (new Set(hosts).size !== hosts.length) {
    return invalidObservation();
  }
  const results: HostInspection[] = [];
  for (const host of hosts) {
    if (!isHostId(host)) {
      return invalidObservation();
    }
    const request = Object.freeze({
      host,
      scope: "user" as const,
      excludedProjectDirectory: excluded,
    });
    const observed = await adapters[host].inspect(request);
    results.push(validateHostInspection(observed, request, paths, os));
  }
  return Object.freeze(results);
}

/*
 * Kept here so host-specific adapters can validate their desired constants
 * through the same secret-free string boundary before passing them to planning.
 */
export function copyDesiredHostConfiguration(
  input: DesiredHostConfiguration,
): DesiredHostConfiguration {
  if (
    !isHostId(input.host) ||
    input.marketplace.name !== "plurum" ||
    input.plugin.name !== "plurum" ||
    input.mcp.name !== "plurum"
  ) {
    return invalidObservation();
  }
  return Object.freeze({
    host: input.host,
    minimumHostVersion: publicString(input.minimumHostVersion, 128),
    marketplace: marketplaceDescriptor(input.marketplace),
    plugin: Object.freeze({
      name: "plurum",
      source: publicString(input.plugin.source),
      version: publicString(input.plugin.version, 128),
      compatibleMinimum: publicString(
        input.plugin.compatibleMinimum,
        128,
      ),
      compatibleMaximumExclusive: publicString(
        input.plugin.compatibleMaximumExclusive,
        128,
      ),
    }),
    mcp: mcpDescriptor(input.mcp),
  });
}
