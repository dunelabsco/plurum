import type { PlatformAdapter, PlatformPathAdapter } from "../system/contracts.js";
import { CredentialError } from "./errors.js";
import {
  LEGACY_CREDENTIAL_SOURCES,
  type LegacyCredentialSource,
} from "./legacy-reader-contracts.js";

export const LEGACY_CREDENTIAL_SOURCE_IDS = Object.freeze([
  ...LEGACY_CREDENTIAL_SOURCES,
]);

export type LegacyCredentialSourceId = LegacyCredentialSource;

export interface CredentialDiscoveryEnvironment {
  readonly HERMES_HOME?: string;
  readonly OPENCLAW_HOME?: string;
}

export interface LegacyCredentialPath {
  readonly source: LegacyCredentialSourceId;
  readonly path: string;
}

const PATH_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const TEST_RUN_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const MAX_PATH_CHARACTERS = 32_767;

function invalidPath(): never {
  throw new CredentialError("invalid_credential_path");
}

function hasRelativeSegment(
  value: string,
  separator: "/" | "\\",
): boolean {
  const segments =
    separator === "/" ? value.split("/") : value.split(/[\\/]/u);
  return segments.some((segment) => segment === "." || segment === "..");
}

function isWindowsAbsolutePath(value: string): boolean {
  const windowsValue = value.replaceAll("/", "\\");
  if (
    windowsValue.toLowerCase().startsWith("\\\\?\\") ||
    windowsValue.toLowerCase().startsWith("\\\\.\\")
  ) {
    return false;
  }
  /*
   * Credential sources must remain on a local volume whose filesystem,
   * owner SID, DACL, integrity label, file ID, and flush behavior can all be
   * attested by the native Windows authority. UNC and other network paths do
   * not satisfy that trust boundary.
   */
  return /^[A-Za-z]:\\/u.test(windowsValue);
}

function hasUnsafeWindowsComponent(value: string): boolean {
  const windowsValue = value.replaceAll("/", "\\");
  const withoutDrive = /^[A-Za-z]:/u.test(windowsValue)
    ? windowsValue.slice(2)
    : windowsValue;
  if (withoutDrive.includes(":")) {
    return true;
  }

  const components = windowsValue
    .split("\\")
    .filter((component) => component !== "" && !/^[A-Za-z]:$/u.test(component));
  if (
    windowsValue.startsWith("\\\\") &&
    ["pipe", "mailslot", "ipc$"].includes(
      components[1]?.toLowerCase() ?? "",
    )
  ) {
    return true;
  }

  return components.some((component) => {
    if (
      component.endsWith(".") ||
      component.endsWith(" ") ||
      /[<>"|?*]/u.test(component)
    ) {
      return true;
    }
    const basename = component.split(".")[0]?.toUpperCase();
    return /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/u.test(
      basename ?? "",
    );
  });
}

function normalizeAbsolutePath(
  raw: string | undefined,
  paths: PlatformPathAdapter,
): string {
  if (
    raw === undefined ||
    raw.length === 0 ||
    raw.length > MAX_PATH_CHARACTERS ||
    raw !== raw.trim() ||
    PATH_CONTROL.test(raw) ||
    hasRelativeSegment(raw, paths.separator) ||
    (paths.separator === "/" && raw.startsWith("//")) ||
    (paths.separator === "\\" &&
      (!isWindowsAbsolutePath(raw) || hasUnsafeWindowsComponent(raw))) ||
    !paths.isAbsolute(raw)
  ) {
    return invalidPath();
  }

  const normalized = paths.normalize(raw);
  const root = paths.root(normalized);
  const isRoot =
    paths.separator === "\\"
      ? normalized.toLowerCase() === root.toLowerCase()
      : normalized === root;
  if (
    root === "" ||
    isRoot ||
    normalized.length === 0 ||
    normalized.length > MAX_PATH_CHARACTERS
  ) {
    return invalidPath();
  }
  return normalized;
}

function optionalOverride(
  raw: string | undefined,
  paths: PlatformPathAdapter,
): string | undefined {
  return raw === undefined || raw === ""
    ? undefined
    : normalizeAbsolutePath(raw, paths);
}

function strictDescendant(
  root: string,
  candidate: string,
  paths: PlatformPathAdapter,
): boolean {
  const relative = paths.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${paths.separator}`) &&
    !paths.isAbsolute(relative)
  );
}

function osHome(platform: PlatformAdapter): string {
  return normalizeAbsolutePath(
    platform.os === "win32"
      ? platform.environment.USERPROFILE
      : platform.environment.HOME,
    platform.paths,
  );
}

function hermesHome(
  platform: PlatformAdapter,
  discoveryEnvironment: CredentialDiscoveryEnvironment,
  home: string,
): string {
  const explicit = optionalOverride(
    discoveryEnvironment.HERMES_HOME,
    platform.paths,
  );
  if (explicit !== undefined) {
    return explicit;
  }
  if (platform.os !== "win32") {
    return normalizeAbsolutePath(
      platform.paths.join(home, ".hermes"),
      platform.paths,
    );
  }

  const localAppData =
    platform.environment.LOCALAPPDATA === undefined ||
    platform.environment.LOCALAPPDATA === ""
      ? normalizeAbsolutePath(
          platform.paths.join(home, "AppData", "Local"),
          platform.paths,
        )
      : normalizeAbsolutePath(
          platform.environment.LOCALAPPDATA,
          platform.paths,
        );
  return normalizeAbsolutePath(
    platform.paths.join(localAppData, "hermes"),
    platform.paths,
  );
}

function openClawHome(
  platform: PlatformAdapter,
  discoveryEnvironment: CredentialDiscoveryEnvironment,
  home: string,
): string {
  const base =
    optionalOverride(discoveryEnvironment.OPENCLAW_HOME, platform.paths) ??
    home;
  return normalizeAbsolutePath(
    platform.paths.join(base, ".openclaw"),
    platform.paths,
  );
}

function testRoot(platform: PlatformAdapter): string | undefined {
  const environment = platform.environment;
  const testValues = [
    environment.PLURUM_HOME,
    environment.PLURUM_TEST_ROOT,
    environment.PLURUM_TEST_RUN_ID,
  ];
  if (testValues.every((value) => value === undefined)) {
    return undefined;
  }
  if (
    testValues.some((value) => value === undefined) ||
    !TEST_RUN_ID.test(environment.PLURUM_TEST_RUN_ID ?? "")
  ) {
    return invalidPath();
  }
  const root = normalizeAbsolutePath(
    environment.PLURUM_TEST_ROOT,
    platform.paths,
  );
  const canonicalHome = normalizeAbsolutePath(
    environment.PLURUM_HOME,
    platform.paths,
  );
  if (!strictDescendant(root, canonicalHome, platform.paths)) {
    return invalidPath();
  }
  return root;
}

export function resolveLegacyCredentialPath(
  platform: PlatformAdapter,
  source: LegacyCredentialSourceId,
  discoveryEnvironment: CredentialDiscoveryEnvironment = {},
): LegacyCredentialPath {
  if (
    !LEGACY_CREDENTIAL_SOURCES.includes(source) ||
    platform.os === "unsupported" ||
    (platform.os === "win32" && platform.paths.separator !== "\\") ||
    (platform.os !== "win32" && platform.paths.separator !== "/")
  ) {
    return invalidPath();
  }

  const home = osHome(platform);
  const path =
    source === "hermes"
      ? normalizeAbsolutePath(
          platform.paths.join(
            hermesHome(platform, discoveryEnvironment, home),
            "plurum.json",
          ),
          platform.paths,
        )
      : source === "openclaw"
        ? normalizeAbsolutePath(
            platform.paths.join(
              openClawHome(platform, discoveryEnvironment, home),
              "plurum.json",
            ),
            platform.paths,
          )
        : normalizeAbsolutePath(
            platform.paths.join(home, ".plurum", "config.json"),
            platform.paths,
          );

  const root = testRoot(platform);
  if (root !== undefined && !strictDescendant(root, path, platform.paths)) {
    return invalidPath();
  }
  return Object.freeze({ source, path });
}

export function resolveLegacyCredentialPaths(
  platform: PlatformAdapter,
  discoveryEnvironment: CredentialDiscoveryEnvironment = {},
): readonly LegacyCredentialPath[] {
  return Object.freeze(
    LEGACY_CREDENTIAL_SOURCE_IDS.map((source) =>
      resolveLegacyCredentialPath(platform, source, discoveryEnvironment),
    ),
  );
}
