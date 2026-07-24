import type {
  PlatformAdapter,
  PlatformPathAdapter,
} from "../system/contracts.js";
import { CredentialError } from "./errors.js";

export interface CredentialLocations {
  readonly directory: string;
  readonly credentials: string;
  readonly setupLock: string;
  readonly credentialTransaction: string;
}

type CredentialPlatform = Pick<
  PlatformAdapter,
  "os" | "environment" | "paths"
>;

const PATH_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const TEST_RUN_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const MAX_PATH_CHARACTERS = 32_767;

function invalidPath(): never {
  throw new CredentialError("invalid_credential_path");
}

function hasParentSegment(value: string, separator: "/" | "\\"): boolean {
  const segments =
    separator === "/" ? value.split("/") : value.split(/[\\/]/u);
  return segments.some((segment) => segment === "." || segment === "..");
}

function isWindowsRootedPath(value: string): boolean {
  const windowsValue = value.replaceAll("/", "\\");
  if (
    windowsValue.toLowerCase().startsWith("\\\\?\\") ||
    windowsValue.toLowerCase().startsWith("\\\\.\\")
  ) {
    return false;
  }
  const driveAbsolute = /^[A-Za-z]:\\/u.test(windowsValue);
  const uncAbsolute = /^\\\\[^\\]+\\[^\\]+(?:\\|$)/u.test(windowsValue);
  return driveAbsolute || uncAbsolute;
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

function normalizeAbsoluteBase(
  raw: string | undefined,
  paths: PlatformPathAdapter,
): string {
  if (
    raw === undefined ||
    raw.length === 0 ||
    raw.length > MAX_PATH_CHARACTERS ||
    raw !== raw.trim() ||
    PATH_CONTROL.test(raw) ||
    hasParentSegment(raw, paths.separator) ||
    (paths.separator === "/" && raw.startsWith("//")) ||
    (paths.separator === "\\" &&
      (!isWindowsRootedPath(raw) || hasUnsafeWindowsComponent(raw))) ||
    !paths.isAbsolute(raw)
  ) {
    return invalidPath();
  }

  const normalized = paths.normalize(raw);
  const root = paths.root(normalized);
  const samePath =
    paths.separator === "\\"
      ? normalized.toLowerCase() === root.toLowerCase()
      : normalized === root;
  if (root === "" || samePath) {
    return invalidPath();
  }
  return normalized;
}

function isStrictDescendant(
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

function locationsAt(
  directory: string,
  paths: PlatformPathAdapter,
): CredentialLocations {
  return Object.freeze({
    directory,
    credentials: paths.join(directory, "credentials.json"),
    setupLock: paths.join(directory, "setup.lock"),
    credentialTransaction: paths.join(
      directory,
      "credentials-transaction.json",
    ),
  });
}

export function resolveCredentialLocations(
  platform: CredentialPlatform,
): CredentialLocations {
  if (
    platform.os === "unsupported" ||
    (platform.os === "win32" && platform.paths.separator !== "\\") ||
    (platform.os !== "win32" && platform.paths.separator !== "/")
  ) {
    return invalidPath();
  }

  const environment = platform.environment;
  const testValues = [
    environment.PLURUM_HOME,
    environment.PLURUM_TEST_ROOT,
    environment.PLURUM_TEST_RUN_ID,
  ];
  if (testValues.some((value) => value !== undefined)) {
    if (
      testValues.some((value) => value === undefined) ||
      !TEST_RUN_ID.test(environment.PLURUM_TEST_RUN_ID ?? "")
    ) {
      return invalidPath();
    }
    const root = normalizeAbsoluteBase(
      environment.PLURUM_TEST_ROOT,
      platform.paths,
    );
    const directory = normalizeAbsoluteBase(
      environment.PLURUM_HOME,
      platform.paths,
    );
    if (!isStrictDescendant(root, directory, platform.paths)) {
      return invalidPath();
    }
    return locationsAt(directory, platform.paths);
  }

  if (platform.os === "darwin") {
    const home = normalizeAbsoluteBase(environment.HOME, platform.paths);
    return locationsAt(
      platform.paths.join(home, "Library", "Application Support", "Plurum"),
      platform.paths,
    );
  }
  if (platform.os === "linux") {
    const configBase =
      environment.XDG_CONFIG_HOME === undefined ||
      environment.XDG_CONFIG_HOME === ""
        ? platform.paths.join(
            normalizeAbsoluteBase(environment.HOME, platform.paths),
            ".config",
          )
        : normalizeAbsoluteBase(environment.XDG_CONFIG_HOME, platform.paths);
    return locationsAt(
      platform.paths.join(configBase, "plurum"),
      platform.paths,
    );
  }
  if (platform.os === "win32") {
    const appData = normalizeAbsoluteBase(environment.APPDATA, platform.paths);
    return locationsAt(
      platform.paths.join(appData, "Plurum"),
      platform.paths,
    );
  }
  return invalidPath();
}
