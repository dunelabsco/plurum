import {
  RUNTIME_ENVIRONMENT_KEYS,
  type ElevationState,
  type PlatformAdapter,
  type PlatformPathAdapter,
  type RuntimeEnvironment,
  type SupportedOs,
} from "./contracts.js";
import { CapabilityPolicyError } from "./errors.js";

const OWNED_PLATFORM_SNAPSHOTS = new WeakSet<PlatformAdapter>();
const SUPPORTED_OS = new Set<SupportedOs>([
  "darwin",
  "linux",
  "win32",
  "unsupported",
]);
const ELEVATION_STATES = new Set<ElevationState>([
  "standard",
  "elevated",
  "unknown",
]);
const MAX_PLATFORM_TEXT = 32_767;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

function invalid(): never {
  throw new CapabilityPolicyError("hosts", "platformSnapshot");
}

function safeText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PLATFORM_TEXT ||
    CONTROL.test(value)
  ) {
    return invalid();
  }
  return value;
}

function safeEnvironmentText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_PLATFORM_TEXT ||
    CONTROL.test(value)
  ) {
    return invalid();
  }
  return value;
}

function snapshotEnvironment(value: unknown): RuntimeEnvironment {
  if (value === null || typeof value !== "object") {
    return invalid();
  }
  const copied: Partial<Record<(typeof RUNTIME_ENVIRONMENT_KEYS)[number], string>> = {};
  for (const key of RUNTIME_ENVIRONMENT_KEYS) {
    let entry: unknown;
    try {
      entry = (value as Readonly<Record<string, unknown>>)[key];
    } catch {
      return invalid();
    }
    if (entry !== undefined) {
      copied[key] = safeEnvironmentText(entry);
    }
  }
  return Object.freeze(copied);
}

function snapshotPaths(value: unknown): PlatformPathAdapter {
  if (value === null || typeof value !== "object") {
    return invalid();
  }
  let separator: unknown;
  let isAbsolute: unknown;
  let normalize: unknown;
  let join: unknown;
  let relative: unknown;
  let root: unknown;
  try {
    const paths = value as PlatformPathAdapter;
    separator = paths.separator;
    isAbsolute = paths.isAbsolute;
    normalize = paths.normalize;
    join = paths.join;
    relative = paths.relative;
    root = paths.root;
  } catch {
    return invalid();
  }
  if (
    (separator !== "/" && separator !== "\\") ||
    typeof isAbsolute !== "function" ||
    typeof normalize !== "function" ||
    typeof join !== "function" ||
    typeof relative !== "function" ||
    typeof root !== "function"
  ) {
    return invalid();
  }
  const boundIsAbsolute = isAbsolute.bind(
    value,
  ) as PlatformPathAdapter["isAbsolute"];
  const boundNormalize = normalize.bind(
    value,
  ) as PlatformPathAdapter["normalize"];
  const boundJoin = join.bind(value) as PlatformPathAdapter["join"];
  const boundRelative = relative.bind(
    value,
  ) as PlatformPathAdapter["relative"];
  const boundRoot = root.bind(value) as PlatformPathAdapter["root"];
  return Object.freeze({
    separator,
    isAbsolute(path: string): boolean {
      return boundIsAbsolute(path);
    },
    normalize(path: string): string {
      return boundNormalize(path);
    },
    join(...parts: readonly string[]): string {
      return boundJoin(...parts);
    },
    relative(from: string, to: string): string {
      return boundRelative(from, to);
    },
    root(path: string): string {
      return boundRoot(path);
    },
  });
}

/*
 * Platform values are read once, synchronously, before any asynchronous host
 * inspection. The returned authority contains data properties and captured
 * path functions only, so later access cannot observe a different cwd or
 * environment from an accessor-backed or mutable source object.
 */
export function snapshotPlatformAdapter(value: PlatformAdapter): PlatformAdapter {
  if (
    value !== null &&
    typeof value === "object" &&
    OWNED_PLATFORM_SNAPSHOTS.has(value)
  ) {
    return value;
  }
  try {
    const os = value.os;
    const arch = value.arch;
    const cwd = value.cwd;
    const environment = value.environment;
    const elevation = value.elevation;
    const paths = value.paths;
    if (
      !SUPPORTED_OS.has(os) ||
      !ELEVATION_STATES.has(elevation)
    ) {
      return invalid();
    }
    const snapshot = Object.freeze({
      os,
      arch: safeText(arch),
      cwd: safeText(cwd),
      environment: snapshotEnvironment(environment),
      elevation,
      paths: snapshotPaths(paths),
    });
    OWNED_PLATFORM_SNAPSHOTS.add(snapshot);
    return snapshot;
  } catch (error) {
    if (error instanceof CapabilityPolicyError) {
      throw error;
    }
    return invalid();
  }
}
