import { posix, win32 } from "node:path";
import process from "node:process";

import {
  RUNTIME_ENVIRONMENT_KEYS,
  type ElevationState,
  type PlatformAdapter,
  type PlatformPathAdapter,
  type RuntimeEnvironment,
  type RuntimeEnvironmentKey,
  type SupportedOs,
} from "../../system/contracts.js";

export function createPlatformPathAdapter(
  os: SupportedOs,
): PlatformPathAdapter {
  const implementation = os === "win32" ? win32 : posix;
  return Object.freeze({
    separator: implementation.sep as "/" | "\\",
    isAbsolute(path: string): boolean {
      return implementation.isAbsolute(path);
    },
    normalize(path: string): string {
      return implementation.normalize(path);
    },
    join(...parts: readonly string[]): string {
      return implementation.join(...parts);
    },
    relative(from: string, to: string): string {
      return implementation.relative(from, to);
    },
    root(path: string): string {
      return implementation.parse(path).root;
    },
  });
}

export function selectRuntimeEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
): RuntimeEnvironment {
  const selected: Partial<Record<RuntimeEnvironmentKey, string>> = {};
  for (const key of RUNTIME_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) {
      selected[key] = value;
    }
  }
  return Object.freeze(selected);
}

export function normalizeOs(platform: NodeJS.Platform): SupportedOs {
  return ["darwin", "linux", "win32"].includes(platform)
    ? (platform as SupportedOs)
    : "unsupported";
}

export function classifyElevation(input: {
  readonly os: SupportedOs;
  readonly uid: number | undefined;
  readonly euid: number | undefined;
  readonly gid: number | undefined;
  readonly egid: number | undefined;
  readonly rootGroupDetected: boolean | undefined;
  readonly sudoDetected: boolean;
}): ElevationState {
  if (input.sudoDetected) {
    return "elevated";
  }
  if (input.os !== "darwin" && input.os !== "linux") {
    return "unknown";
  }
  if (
    input.uid === undefined ||
    input.euid === undefined ||
    input.gid === undefined ||
    input.egid === undefined ||
    input.rootGroupDetected === undefined
  ) {
    return "unknown";
  }
  if (
    input.uid === 0 ||
    input.euid === 0 ||
    input.gid === 0 ||
    input.egid === 0 ||
    input.uid !== input.euid ||
    input.gid !== input.egid ||
    input.rootGroupDetected
  ) {
    return "elevated";
  }
  return "standard";
}

export function createNodePlatform(): PlatformAdapter {
  const os = normalizeOs(process.platform);
  const uid = process.getuid?.();
  const euid = process.geteuid?.();
  const gid = process.getgid?.();
  const egid = process.getegid?.();
  const groups = process.getgroups?.();
  return Object.freeze({
    os,
    arch: process.arch,
    cwd: process.cwd(),
    environment: selectRuntimeEnvironment(process.env),
    elevation: classifyElevation({
      os,
      uid,
      euid,
      gid,
      egid,
      rootGroupDetected: groups === undefined ? undefined : groups.includes(0),
      sudoDetected:
        process.env.SUDO_UID !== undefined || process.env.SUDO_USER !== undefined,
    }),
    paths: createPlatformPathAdapter(os),
  });
}
