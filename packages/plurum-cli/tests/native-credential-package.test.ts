import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NATIVE_CREDENTIAL_PACKAGE_BY_TARGET,
  NATIVE_CREDENTIAL_PACKAGE_MAGIC,
  createNativeCredentialPackageProvider,
  type NativeCredentialPackageVerificationOptions,
} from "../src/adapters/node/native-credential-package.js";
import {
  NATIVE_CREDENTIAL_STORE_ABI_VERSION,
  NATIVE_CREDENTIAL_STORE_MAGIC,
  NATIVE_CREDENTIAL_STORE_NODE_API_VERSION,
  type NativeCredentialTarget,
} from "../src/adapters/node/native-credential-store.js";
import { SUPPORTED_NODE_RUNTIME_RANGES } from "../src/system/runtime-support.js";
import { CLI_VERSION } from "../src/version.js";

const TARGET = "darwin-arm64" as const;
const ARTIFACT_BYTES = new TextEncoder().encode(
  "isolated native credential package fixture\n",
);
const SECRET = "plrm_live_NATIVE_PACKAGE_SECRET_SENTINEL";
const ROOT_PREFIX = "plurum-native-package-test-";
const TEST_REQUIRE_CACHE = createRequire(import.meta.url).cache;

interface TemporaryRoot {
  readonly path: string;
  readonly device: bigint;
  readonly object: bigint;
  readonly sentinelPath: string;
  readonly sentinelDevice: bigint;
  readonly sentinelObject: bigint;
  readonly token: string;
}

const temporaryRoots: TemporaryRoot[] = [];

interface Fixture {
  readonly root: string;
  readonly packageRoot: string;
  readonly packageDirectory: string;
  readonly artifactPath: string;
  readonly target: keyof typeof NATIVE_CREDENTIAL_PACKAGE_BY_TARGET;
  readonly bytes: Uint8Array;
}

interface FixtureOptions {
  readonly target?: keyof typeof NATIVE_CREDENTIAL_PACKAGE_BY_TARGET;
  readonly placement?: "nested" | "hoisted";
  readonly bytes?: Uint8Array;
  readonly metadata?: (metadata: Record<string, unknown>) => Record<string, unknown>;
  readonly rawMetadata?: (canonical: string) => string;
}

function unavailable() {
  return {
    status: "unavailable",
    code: "native_credential_store_unavailable",
  } as const;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function platformMetadata(
  target: keyof typeof NATIVE_CREDENTIAL_PACKAGE_BY_TARGET,
): Readonly<{ os: string; cpu: string; libc: "glibc" | null }> {
  switch (target) {
    case "darwin-arm64":
      return { os: "darwin", cpu: "arm64", libc: null };
    case "darwin-x64":
      return { os: "darwin", cpu: "x64", libc: null };
    case "linux-arm64-gnu":
      return { os: "linux", cpu: "arm64", libc: "glibc" };
    case "linux-x64-gnu":
      return { os: "linux", cpu: "x64", libc: "glibc" };
    case "win32-x64-msvc":
      return { os: "win32", cpu: "x64", libc: null };
  }
}

function packageMetadata(
  target: keyof typeof NATIVE_CREDENTIAL_PACKAGE_BY_TARGET,
  bytes: Uint8Array,
): Record<string, unknown> {
  const platform = platformMetadata(target);
  return {
    name: NATIVE_CREDENTIAL_PACKAGE_BY_TARGET[target],
    version: CLI_VERSION,
    license: "Apache-2.0",
    main: "./credential-store.node",
    exports: "./credential-store.node",
    files: ["credential-store.node"],
    os: [platform.os],
    cpu: [platform.cpu],
    ...(platform.libc === null ? {} : { libc: [platform.libc] }),
    engines: { node: SUPPORTED_NODE_RUNTIME_RANGES.join(" || ") },
    plurumNative: {
      schemaVersion: 1,
      magic: NATIVE_CREDENTIAL_PACKAGE_MAGIC,
      abiVersion: NATIVE_CREDENTIAL_STORE_ABI_VERSION,
      nodeApiVersion: NATIVE_CREDENTIAL_STORE_NODE_API_VERSION,
      target,
      byteLength: bytes.byteLength,
      sha256: digest(bytes),
    },
  };
}

function canonicalMetadata(metadata: Record<string, unknown>): string {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

function createTemporaryRoot(): string {
  const trustedBase = realpathSync(tmpdir());
  const path = realpathSync(mkdtempSync(join(trustedBase, ROOT_PREFIX)));
  const metadata = lstatSync(path, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("native package test root is unsafe");
  }
  const token = randomUUID();
  const sentinelPath = join(path, ".plurum-native-package-test");
  writeFileSync(sentinelPath, token, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const sentinel = lstatSync(sentinelPath, { bigint: true });
  if (
    sentinel.isSymbolicLink() ||
    !sentinel.isFile() ||
    sentinel.nlink !== 1n
  ) {
    throw new Error("native package test sentinel is unsafe");
  }
  temporaryRoots.push({
    path,
    device: metadata.dev,
    object: metadata.ino,
    sentinelPath,
    sentinelDevice: sentinel.dev,
    sentinelObject: sentinel.ino,
    token,
  });
  return path;
}

function verifyTemporaryRoot(root: TemporaryRoot): void {
  const trustedBase = realpathSync(tmpdir());
  const metadata = lstatSync(root.path, { bigint: true });
  const sentinel = lstatSync(root.sentinelPath, { bigint: true });
  if (
    basename(root.path).startsWith(ROOT_PREFIX) !== true ||
    realpathSync(dirname(root.path)) !== trustedBase ||
    realpathSync(root.path) !== root.path ||
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.dev !== root.device ||
    metadata.ino !== root.object ||
    realpathSync(root.sentinelPath) !== root.sentinelPath ||
    sentinel.isSymbolicLink() ||
    !sentinel.isFile() ||
    sentinel.nlink !== 1n ||
    sentinel.dev !== root.sentinelDevice ||
    sentinel.ino !== root.sentinelObject ||
    readFileSync(root.sentinelPath, "utf8") !== root.token
  ) {
    throw new Error("native package test root cleanup was not authorized");
  }
}

function createFixture(options: FixtureOptions = {}): Fixture {
  const target = options.target ?? TARGET;
  const placement = options.placement ?? "nested";
  const bytes = options.bytes ?? ARTIFACT_BYTES;
  const root = createTemporaryRoot();
  const packageRoot = join(root, "node_modules", "plurum");
  mkdirSync(packageRoot, { recursive: true, mode: 0o700 });
  const [, packageLeaf] = NATIVE_CREDENTIAL_PACKAGE_BY_TARGET[target].split("/");
  if (packageLeaf === undefined) {
    throw new Error("invalid native package fixture name");
  }
  const packageDirectory =
    placement === "nested"
      ? join(packageRoot, "node_modules", "@dunelabs", packageLeaf)
      : join(dirname(packageRoot), "@dunelabs", packageLeaf);
  mkdirSync(packageDirectory, { recursive: true, mode: 0o700 });
  const artifactPath = join(packageDirectory, "credential-store.node");
  writeFileSync(join(packageDirectory, "LICENSE"), "Apache-2.0 fixture\n", {
    flag: "wx",
    mode: 0o600,
  });
  writeFileSync(join(packageDirectory, "README.md"), "# native fixture\n", {
    flag: "wx",
    mode: 0o600,
  });
  writeFileSync(artifactPath, bytes, { flag: "wx", mode: 0o600 });
  const initialMetadata = packageMetadata(target, bytes);
  const selectedMetadata = options.metadata?.(initialMetadata) ?? initialMetadata;
  const canonical = canonicalMetadata(selectedMetadata);
  writeFileSync(
    join(packageDirectory, "package.json"),
    options.rawMetadata?.(canonical) ?? canonical,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  return {
    root,
    packageRoot,
    packageDirectory,
    artifactPath,
    target,
    bytes,
  };
}

function createNativeModule(
  target: NativeCredentialTarget = TARGET,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const read = Object.freeze({
    openPrivateDirectory() {
      return { status: "missing" as const };
    },
  });
  const mutation = Object.freeze({
    acquireSetupLease() {
      return { status: "busy" as const };
    },
  });
  return {
    magic: NATIVE_CREDENTIAL_STORE_MAGIC,
    abiVersion: NATIVE_CREDENTIAL_STORE_ABI_VERSION,
    nodeApiVersion: NATIVE_CREDENTIAL_STORE_NODE_API_VERSION,
    packageVersion: CLI_VERSION,
    target,
    createAdapters() {
      return { read, mutation };
    },
    ...overrides,
  };
}

function verificationOptions(
  fixture: Pick<Fixture, "packageRoot">,
  loadAddon: (artifactPath: string) => unknown,
): NativeCredentialPackageVerificationOptions {
  return Object.freeze({
    packageRoot: fixture.packageRoot,
    loadAddon,
  });
}

function loadFixture(
  fixture: Fixture,
  loadAddon: (artifactPath: string) => unknown = () =>
    createNativeModule(fixture.target),
) {
  return createNativeCredentialPackageProvider(
    fixture.target,
    verificationOptions(fixture, loadAddon),
  ).load();
}

afterEach(() => {
  vi.restoreAllMocks();
  const roots = temporaryRoots.splice(0);
  for (const root of roots) {
    verifyTemporaryRoot(root);
  }
  for (const root of roots) {
    rmSync(root.path, { recursive: true, force: false });
  }
});

describe("native credential package resolver", () => {
  it("locks the five released targets to exact controlled package names", () => {
    expect(NATIVE_CREDENTIAL_PACKAGE_BY_TARGET).toEqual({
      "darwin-arm64": "@dunelabs/plurum-native-darwin-arm64",
      "darwin-x64": "@dunelabs/plurum-native-darwin-x64",
      "linux-arm64-gnu": "@dunelabs/plurum-native-linux-arm64-gnu",
      "linux-x64-gnu": "@dunelabs/plurum-native-linux-x64-gnu",
      "win32-x64-msvc": "@dunelabs/plurum-native-win32-x64-msvc",
    });
    expect(Object.isFrozen(NATIVE_CREDENTIAL_PACKAGE_BY_TARGET)).toBe(true);
    expect(NATIVE_CREDENTIAL_PACKAGE_MAGIC).toBe(
      "plurum-native-credential-package",
    );
  });

  it("loads one exact nested artifact lazily and memoizes its adapters", () => {
    const fixture = createFixture();
    const loader = vi.fn((artifactPath: string) => {
      expect(artifactPath).toBe(fixture.artifactPath);
      return createNativeModule();
    });
    const provider = createNativeCredentialPackageProvider(
      TARGET,
      verificationOptions(fixture, loader),
    );

    expect(loader).not.toHaveBeenCalled();
    const first = provider.load();
    expect(first.status).toBe("available");
    expect(provider.load()).toBe(first);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(provider)).toBe(true);
  });

  it("keeps the injected test loader independent of the production cache", () => {
    const fixture = createFixture();
    const fakeEntry = {
      filename: fixture.artifactPath,
      path: dirname(fixture.artifactPath),
      exports: Object.freeze({ poisoned: true }),
    };
    expect(Object.hasOwn(TEST_REQUIRE_CACHE, fixture.artifactPath)).toBe(false);
    Object.defineProperty(TEST_REQUIRE_CACHE, fixture.artifactPath, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: fakeEntry,
    });
    const loader = vi.fn(() => createNativeModule());

    try {
      expect(loadFixture(fixture, loader).status).toBe("available");
      expect(loader).toHaveBeenCalledTimes(1);
    } finally {
      const descriptor = Object.getOwnPropertyDescriptor(
        TEST_REQUIRE_CACHE,
        fixture.artifactPath,
      );
      if (descriptor?.value !== fakeEntry) {
        throw new Error("native package test cache cleanup was not authorized");
      }
      delete TEST_REQUIRE_CACHE[fixture.artifactPath];
    }
    expect(Object.hasOwn(TEST_REQUIRE_CACHE, fixture.artifactPath)).toBe(false);
  });

  it("accepts the exact hoisted npm location and canonical GNU metadata", () => {
    const fixture = createFixture({
      target: "linux-x64-gnu",
      placement: "hoisted",
    });
    const loader = vi.fn(() => createNativeModule("linux-x64-gnu"));

    expect(loadFixture(fixture, loader).status).toBe("available");
    expect(loader).toHaveBeenCalledWith(fixture.artifactPath);
  });

  it("rejects an unreleased target before filesystem or loader access", () => {
    const loader = vi.fn(() => {
      throw new Error(SECRET);
    });
    const provider = createNativeCredentialPackageProvider(
      "linux-x64-musl",
      Object.freeze({
        packageRoot: join(tmpdir(), `missing-plurum-${SECRET}`),
        loadAddon: loader,
      }),
    );

    expect(provider.load()).toEqual(unavailable());
    expect(loader).not.toHaveBeenCalled();
    expect(JSON.stringify(provider.load())).not.toContain(SECRET);
  });

  it("rejects a missing package without invoking the loader", () => {
    const fixture = createFixture();
    rmSync(fixture.packageDirectory, { recursive: true, force: false });
    const loader = vi.fn(() => createNativeModule());

    expect(loadFixture(fixture, loader)).toEqual(unavailable());
    expect(loader).not.toHaveBeenCalled();
  });

  it("rejects duplicate nested and hoisted candidates", () => {
    const nested = createFixture();
    const [, packageLeaf] = NATIVE_CREDENTIAL_PACKAGE_BY_TARGET[TARGET].split("/");
    if (packageLeaf === undefined) {
      throw new Error("invalid native package fixture name");
    }
    const duplicate = join(
      dirname(nested.packageRoot),
      "@dunelabs",
      packageLeaf,
    );
    mkdirSync(duplicate, { recursive: true, mode: 0o700 });
    const loader = vi.fn(() => createNativeModule());

    expect(loadFixture(nested, loader)).toEqual(unavailable());
    expect(loader).not.toHaveBeenCalled();
  });

  it("ignores an ambient ancestor package instead of falling back to it", () => {
    const fixture = createFixture();
    rmSync(fixture.packageDirectory, { recursive: true, force: false });
    const [, packageLeaf] = NATIVE_CREDENTIAL_PACKAGE_BY_TARGET[TARGET].split("/");
    if (packageLeaf === undefined) {
      throw new Error("invalid native package fixture name");
    }
    mkdirSync(join(fixture.root, "@dunelabs", packageLeaf), {
      recursive: true,
      mode: 0o700,
    });
    const loader = vi.fn(() => createNativeModule());

    expect(loadFixture(fixture, loader)).toEqual(unavailable());
    expect(loader).not.toHaveBeenCalled();
  });

  it("rejects an unexpected package inventory before loading", () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.packageDirectory, "unexpected.node"), "extra", {
      flag: "wx",
      mode: 0o600,
    });
    const loader = vi.fn(() => createNativeModule());

    expect(loadFixture(fixture, loader)).toEqual(unavailable());
    expect(loader).not.toHaveBeenCalled();
  });

  it("rejects duplicate nested metadata keys through canonical-byte validation", () => {
    const fixture = createFixture({
      rawMetadata(canonical) {
        const needle = `    \"target\": \"${TARGET}\",`;
        const duplicated = canonical.replace(needle, `${needle}\n${needle}`);
        if (duplicated === canonical) {
          throw new Error("native package duplicate-key fixture was not applied");
        }
        return duplicated;
      },
    });
    const loader = vi.fn(() => createNativeModule());

    expect(loadFixture(fixture, loader)).toEqual(unavailable());
    expect(loader).not.toHaveBeenCalled();
  });

  it.each([
    ["package version", (metadata: Record<string, unknown>) => ({ ...metadata, version: "9.9.9" })],
    [
      "package magic",
      (metadata: Record<string, unknown>) => ({
        ...metadata,
        plurumNative: {
          ...(metadata.plurumNative as Record<string, unknown>),
          magic: "not-plurum",
        },
      }),
    ],
    [
      "ABI",
      (metadata: Record<string, unknown>) => ({
        ...metadata,
        plurumNative: {
          ...(metadata.plurumNative as Record<string, unknown>),
          abiVersion: NATIVE_CREDENTIAL_STORE_ABI_VERSION + 1,
        },
      }),
    ],
    [
      "target",
      (metadata: Record<string, unknown>) => ({
        ...metadata,
        plurumNative: {
          ...(metadata.plurumNative as Record<string, unknown>),
          target: "darwin-x64",
        },
      }),
    ],
  ])("rejects mismatched %s metadata", (_label, mutate) => {
    const fixture = createFixture({ metadata: mutate });
    const loader = vi.fn(() => createNativeModule());

    expect(loadFixture(fixture, loader)).toEqual(unavailable());
    expect(loader).not.toHaveBeenCalled();
  });

  it.each([
    [
      "byte length",
      (metadata: Record<string, unknown>) => ({
        ...metadata,
        plurumNative: {
          ...(metadata.plurumNative as Record<string, unknown>),
          byteLength: ARTIFACT_BYTES.byteLength + 1,
        },
      }),
    ],
    [
      "checksum",
      (metadata: Record<string, unknown>) => ({
        ...metadata,
        plurumNative: {
          ...(metadata.plurumNative as Record<string, unknown>),
          sha256: "0".repeat(64),
        },
      }),
    ],
  ])("rejects an artifact %s mismatch before loading", (_label, mutate) => {
    const fixture = createFixture({ metadata: mutate });
    const loader = vi.fn(() => createNativeModule());

    expect(loadFixture(fixture, loader)).toEqual(unavailable());
    expect(loader).not.toHaveBeenCalled();
  });

  it("rejects a hard-linked artifact", () => {
    const fixture = createFixture();
    linkSync(fixture.artifactPath, join(fixture.root, "artifact-hard-link.node"));
    const loader = vi.fn(() => createNativeModule());

    expect(loadFixture(fixture, loader)).toEqual(unavailable());
    expect(loader).not.toHaveBeenCalled();
  });

  it("rejects POSIX package ancestry writable by another principal", () => {
    if (process.platform === "win32") {
      return;
    }
    const fixture = createFixture();
    chmodSync(dirname(fixture.packageRoot), 0o777);
    const loader = vi.fn(() => createNativeModule());

    expect(loadFixture(fixture, loader)).toEqual(unavailable());
    expect(loader).not.toHaveBeenCalled();
  });

  it("rejects a POSIX artifact writable by another principal", () => {
    if (process.platform === "win32") {
      return;
    }
    const fixture = createFixture();
    chmodSync(fixture.artifactPath, 0o666);
    const loader = vi.fn(() => createNativeModule());

    expect(loadFixture(fixture, loader)).toEqual(unavailable());
    expect(loader).not.toHaveBeenCalled();
  });

  it("rejects linked package paths and artifact paths", () => {
    if (process.platform === "win32") {
      return;
    }

    const linkedPackage = createFixture();
    const actualPackage = join(linkedPackage.root, "actual-native-package");
    renameSync(linkedPackage.packageDirectory, actualPackage);
    symlinkSync(actualPackage, linkedPackage.packageDirectory, "dir");
    const packageLoader = vi.fn(() => createNativeModule());
    expect(loadFixture(linkedPackage, packageLoader)).toEqual(unavailable());
    expect(packageLoader).not.toHaveBeenCalled();

    const linkedArtifact = createFixture();
    const actualArtifact = join(linkedArtifact.root, "actual-addon.node");
    renameSync(linkedArtifact.artifactPath, actualArtifact);
    symlinkSync(actualArtifact, linkedArtifact.artifactPath, "file");
    const artifactLoader = vi.fn(() => createNativeModule());
    expect(loadFixture(linkedArtifact, artifactLoader)).toEqual(unavailable());
    expect(artifactLoader).not.toHaveBeenCalled();
  });

  it("maps loader failures to one memoized safe unavailable result", () => {
    const fixture = createFixture();
    const loader = vi.fn(() => {
      throw new Error(SECRET);
    });
    const provider = createNativeCredentialPackageProvider(
      fixture.target,
      verificationOptions(fixture, loader),
    );

    const first = provider.load();
    expect(first).toEqual(unavailable());
    expect(provider.load()).toBe(first);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).not.toContain(SECRET);
  });

  it("rejects artifact replacement during loading", () => {
    const fixture = createFixture();
    const replacement = join(fixture.root, "replacement.node");
    writeFileSync(replacement, fixture.bytes, { flag: "wx", mode: 0o600 });
    const loader = vi.fn(() => {
      rmSync(fixture.artifactPath, { force: false });
      renameSync(replacement, fixture.artifactPath);
      return createNativeModule();
    });

    expect(loadFixture(fixture, loader)).toEqual(unavailable());
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("ignores unrelated install-root directory timestamp changes", () => {
    const fixture = createFixture();
    const loader = vi.fn(() => {
      writeFileSync(join(fixture.root, "unrelated-package-manager-state"), "ok\n", {
        flag: "wx",
        mode: 0o600,
      });
      return createNativeModule();
    });

    expect(loadFixture(fixture, loader).status).toBe("available");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("rejects metadata replacement during loading even when bytes match", () => {
    const fixture = createFixture();
    const metadataPath = join(fixture.packageDirectory, "package.json");
    const replacement = join(fixture.root, "replacement-package.json");
    writeFileSync(replacement, readFileSync(metadataPath), {
      flag: "wx",
      mode: 0o600,
    });
    const loader = vi.fn(() => {
      rmSync(metadataPath, { force: false });
      renameSync(replacement, metadataPath);
      return createNativeModule();
    });

    expect(loadFixture(fixture, loader)).toEqual(unavailable());
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("lets the existing strict provider reject a mismatched loaded descriptor", () => {
    const fixture = createFixture();
    const loader = vi.fn(() =>
      createNativeModule(TARGET, {
        packageVersion: "9.9.9",
      }),
    );

    expect(loadFixture(fixture, loader)).toEqual(unavailable());
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("fails closed for a malformed verifier configuration", () => {
    const fixture = createFixture();
    const loader = vi.fn(() => createNativeModule());
    const options = {
      packageRoot: fixture.packageRoot,
      loadAddon: loader,
    };

    const provider = createNativeCredentialPackageProvider(TARGET, options);
    expect(provider.load()).toEqual(unavailable());
    const policyInjection = Object.freeze({
      packageRoot: fixture.packageRoot,
      loadAddon: loader,
      enforceCommonJsCache: true,
    });
    expect(
      createNativeCredentialPackageProvider(TARGET, policyInjection).load(),
    ).toEqual(unavailable());
    expect(loader).not.toHaveBeenCalled();
  });
});
