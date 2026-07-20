import type {
  HostExecutableAttestation,
  HostExecutableCandidateAdapter,
  HostId,
  HostInspection,
  HostInspectionRequest,
} from "./contracts.js";
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
  SupportedOs,
} from "../system/contracts.js";

const MAX_PATH_CHARACTERS = 32_767;
const MAX_PATH_ENTRIES = 256;
const MAX_PATHEXT_ENTRIES = 32;
const WINDOWS_EXTENSION = /^\.[A-Za-z0-9]{1,16}$/u;

type CandidateObservationSnapshot =
  | Readonly<{ status: "missing" }>
  | Readonly<{
      status: "blocked";
      reason:
        | "unsafe-shadow"
        | "unsafe-executable"
        | "unsupported-shim"
        | "unverifiable-executable";
    }>
  | Readonly<{
      status: "verified";
      executable: HostExecutableAttestation;
    }>;

export interface DiscoverHostExecutableInput {
  readonly host: HostId;
  readonly executableName: "claude" | "codex";
  readonly path: string | undefined;
  readonly pathExt?: string;
  readonly excludedProjectDirectory: string;
}

function invalidObservation(): never {
  throw new HostError("invalid_host_observation");
}

function comparable(value: string, os: SupportedOs): string {
  return os === "win32" ? value.toLowerCase() : value;
}

function hasUnsafeSegment(
  value: string,
  separator: "/" | "\\",
): boolean {
  const segments =
    separator === "/" ? value.split("/") : value.split(/[\\/]/u);
  return segments.some((segment) => segment === "." || segment === "..");
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

function safeAbsolute(
  value: unknown,
  paths: PlatformPathAdapter,
  os: SupportedOs,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PATH_CHARACTERS ||
    containsHostControlCharacter(value) ||
    containsHostSensitiveMaterial(value) ||
    !paths.isAbsolute(value) ||
    hasUnsafeSegment(value, paths.separator) ||
    (paths.separator === "/" && value.startsWith("//")) ||
    (paths.separator === "\\" &&
      (value.startsWith("\\\\") ||
        value.toLowerCase().startsWith("\\\\?\\") ||
        value.toLowerCase().startsWith("\\\\.\\"))) ||
    comparable(paths.normalize(value), os) !== comparable(value, os)
  ) {
    return invalidObservation();
  }
  return value;
}

function blocked(
  host: HostId,
  reason: Extract<HostInspection, { status: "blocked" }>["reason"],
  candidatePath?: string,
): Extract<HostInspection, { status: "blocked" }> {
  return Object.freeze({
    host,
    status: "blocked",
    reason,
    ...(candidatePath === undefined ? {} : { candidatePath }),
  });
}

function snapshotCandidateObservation(
  input: unknown,
): CandidateObservationSnapshot | null {
  try {
    if (
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.getOwnPropertySymbols(input).length !== 0
    ) {
      return null;
    }
    const value = input as Readonly<Record<string, unknown>>;
    const keys = Object.keys(value);
    const status = value.status;
    if (
      status === "missing" &&
      keys.length === 1 &&
      keys[0] === "status"
    ) {
      return Object.freeze({ status });
    }
    if (
      status === "blocked" &&
      keys.length === 2 &&
      keys.includes("status") &&
      keys.includes("reason") &&
      typeof value.reason === "string" &&
      [
        "unsafe-shadow",
        "unsafe-executable",
        "unsupported-shim",
        "unverifiable-executable",
      ].includes(value.reason)
    ) {
      return Object.freeze({
        status,
        reason: value.reason as Extract<
          CandidateObservationSnapshot,
          { status: "blocked" }
        >["reason"],
      });
    }
    if (
      status === "verified" &&
      keys.length === 2 &&
      keys.includes("status") &&
      keys.includes("executable")
    ) {
      return Object.freeze({
        status,
        executable: value.executable as HostExecutableAttestation,
      });
    }
    return null;
  } catch {
    return null;
  }
}

function windowsExtensions(pathExt: string | undefined): readonly string[] {
  const raw =
    pathExt === undefined || pathExt.length === 0
      ? [".COM", ".EXE", ".BAT", ".CMD"]
      : pathExt.split(";");
  if (
    raw.length === 0 ||
    raw.length > MAX_PATHEXT_ENTRIES ||
    raw.some((extension) => !WINDOWS_EXTENSION.test(extension))
  ) {
    return invalidObservation();
  }
  const normalized = raw.map((extension) => extension.toLowerCase());
  if (new Set(normalized).size !== normalized.length) {
    return invalidObservation();
  }
  return Object.freeze(normalized);
}

function executableCandidates(
  directory: string,
  name: "claude" | "codex",
  pathExt: string | undefined,
  paths: PlatformPathAdapter,
  os: SupportedOs,
): readonly string[] {
  if (os !== "win32") {
    return Object.freeze([paths.join(directory, name)]);
  }
  return Object.freeze(
    windowsExtensions(pathExt).map((extension) =>
      paths.join(directory, `${name}${extension}`),
    ),
  );
}

function pathEntries(
  rawPath: string | undefined,
  os: SupportedOs,
): readonly string[] {
  if (
    rawPath === undefined ||
    rawPath.length === 0 ||
    rawPath.length > MAX_PATH_CHARACTERS ||
    containsHostControlCharacter(rawPath) ||
    containsHostSensitiveMaterial(rawPath)
  ) {
    return invalidObservation();
  }
  const delimiter = os === "win32" ? ";" : ":";
  const entries = rawPath.split(delimiter);
  if (entries.length === 0 || entries.length > MAX_PATH_ENTRIES) {
    return invalidObservation();
  }
  return Object.freeze(entries);
}

export async function discoverHostExecutable(
  input: DiscoverHostExecutableInput,
  adapter: HostExecutableCandidateAdapter,
  paths: PlatformPathAdapter,
  os: SupportedOs,
): Promise<
  | Readonly<{ host: HostId; status: "absent" }>
  | Extract<HostInspection, { status: "blocked" }>
  | Readonly<{
      host: HostId;
      status: "verified";
      executable: HostExecutableAttestation;
    }>
> {
  if (
    (input.host === "claude-code" && input.executableName !== "claude") ||
    (input.host === "codex" && input.executableName !== "codex") ||
    (os !== "darwin" && os !== "linux" && os !== "win32")
  ) {
    return invalidObservation();
  }
  const excluded = safeAbsolute(
    input.excludedProjectDirectory,
    paths,
    os,
  );
  let entries: readonly string[];
  try {
    entries = pathEntries(input.path, os);
  } catch {
    return blocked(input.host, "unsafe-path-entry");
  }

  for (const rawDirectory of entries) {
    let directory: string;
    try {
      directory = safeAbsolute(rawDirectory, paths, os);
    } catch {
      return blocked(input.host, "unsafe-path-entry");
    }
    if (isWithin(excluded, directory, paths, os)) {
      return blocked(input.host, "unsafe-path-entry", directory);
    }
    let candidates: readonly string[];
    try {
      candidates = executableCandidates(
        directory,
        input.executableName,
        input.pathExt,
        paths,
        os,
      );
    } catch {
      return blocked(input.host, "unsafe-path-entry");
    }
    for (const candidatePath of candidates) {
      const request = Object.freeze({
        host: input.host,
        candidatePath,
        excludedProjectDirectory: excluded,
      });
      let rawObservation;
      try {
        rawObservation = await adapter.inspectCandidate(request);
      } catch {
        return blocked(input.host, "unverifiable-executable", candidatePath);
      }
      const observation = snapshotCandidateObservation(rawObservation);
      if (observation === null) {
        return blocked(input.host, "unverifiable-executable", candidatePath);
      }
      if (observation.status === "missing") {
        continue;
      }
      if (observation.status === "blocked") {
        return blocked(input.host, observation.reason, candidatePath);
      }
      const inspectionRequest: HostInspectionRequest = Object.freeze({
        host: input.host,
        scope: "user",
        excludedProjectDirectory: excluded,
      });
      let executable: HostExecutableAttestation;
      try {
        executable = validateHostExecutableAttestation(
          observation.executable,
          inspectionRequest,
          paths,
          os,
        );
      } catch {
        return blocked(input.host, "unverifiable-executable", candidatePath);
      }
      if (
        comparable(executable.sourcePath, os) !==
        comparable(candidatePath, os)
      ) {
        return blocked(input.host, "unverifiable-executable", candidatePath);
      }
      return Object.freeze({
        host: input.host,
        status: "verified",
        executable,
      });
    }
  }
  return Object.freeze({ host: input.host, status: "absent" });
}
