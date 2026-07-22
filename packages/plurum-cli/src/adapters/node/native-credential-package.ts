import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { createRequire } from "node:module";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import {
  NATIVE_CREDENTIAL_STORE_ABI_VERSION,
  NATIVE_CREDENTIAL_STORE_NODE_API_VERSION,
  createNativeCredentialStoreProvider,
  type NativeCredentialStoreProvider,
  type NativeCredentialTarget,
} from "./native-credential-store.js";
import {
  RELEASED_RUNTIME_TARGETS,
  SUPPORTED_NODE_RUNTIME_RANGES,
  type ReleasedRuntimePlatformTarget,
} from "../../system/runtime-support.js";
import { CLI_VERSION } from "../../version.js";

export const NATIVE_CREDENTIAL_PACKAGE_BY_TARGET = Object.freeze({
  "darwin-arm64": "@dunelabs/plurum-native-darwin-arm64",
  "darwin-x64": "@dunelabs/plurum-native-darwin-x64",
  "linux-arm64-gnu": "@dunelabs/plurum-native-linux-arm64-gnu",
  "linux-x64-gnu": "@dunelabs/plurum-native-linux-x64-gnu",
  "win32-x64-msvc": "@dunelabs/plurum-native-win32-x64-msvc",
} as const satisfies Readonly<
  Record<ReleasedRuntimePlatformTarget, string>
>);

export const NATIVE_CREDENTIAL_PACKAGE_MAGIC =
  "plurum-native-credential-package" as const;

/* Test-only seam; the CLI entrypoint never accepts or forwards this loader. */
export interface NativeCredentialPackageVerificationOptions {
  readonly packageRoot: string;
  readonly loadAddon: (artifactPath: string) => unknown;
}

const FIXED_NATIVE_REQUIRE = createRequire(import.meta.url);
const FIXED_NATIVE_CACHE = FIXED_NATIVE_REQUIRE.cache;
const DEFAULT_PACKAGE_ROOT = resolve(
  fileURLToPath(new URL("../../../", import.meta.url)),
);
const ARTIFACT_NAME = "credential-store.node";
const PACKAGE_INVENTORY = Object.freeze([
  "LICENSE",
  "README.md",
  ARTIFACT_NAME,
  "package.json",
] as const);
const PACKAGE_METADATA_KEYS = Object.freeze([
  "cpu",
  "engines",
  "exports",
  "files",
  "license",
  "main",
  "name",
  "os",
  "plurumNative",
  "version",
] as const);
const NATIVE_METADATA_KEYS = Object.freeze([
  "abiVersion",
  "byteLength",
  "magic",
  "nodeApiVersion",
  "schemaVersion",
  "sha256",
  "target",
] as const);
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_PACKAGE_METADATA_BYTES = 32 * 1024;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const RELEASED_TARGET_SET = new Set<string>(RELEASED_RUNTIME_TARGETS);
const TARGET_PACKAGE_METADATA = Object.freeze({
  "darwin-arm64": Object.freeze({ os: "darwin", cpu: "arm64", libc: null }),
  "darwin-x64": Object.freeze({ os: "darwin", cpu: "x64", libc: null }),
  "linux-arm64-gnu": Object.freeze({ os: "linux", cpu: "arm64", libc: "glibc" }),
  "linux-x64-gnu": Object.freeze({ os: "linux", cpu: "x64", libc: "glibc" }),
  "win32-x64-msvc": Object.freeze({ os: "win32", cpu: "x64", libc: null }),
} as const satisfies Readonly<
  Record<
    ReleasedRuntimePlatformTarget,
    Readonly<{ os: string; cpu: string; libc: "glibc" | null }>
  >
>);

type UnknownRecord = Record<string, unknown>;
type AddonLoader = (artifactPath: string) => unknown;

interface FileIdentity {
  readonly device: bigint;
  readonly object: bigint;
  readonly owner: bigint;
  readonly mode: bigint;
  readonly links: bigint;
  readonly size: bigint;
  readonly modified: bigint;
  readonly changed: bigint;
}

interface VerifiedDirectory {
  readonly path: string;
  readonly identity: FileIdentity;
}

interface ResolverConfiguration {
  readonly packageRoot: string;
  readonly loadAddon: AddonLoader;
  readonly enforceCommonJsCache: boolean;
}

interface VerifiedArtifact {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly digest: string;
}

interface ParsedPackageMetadata {
  readonly value: UnknownRecord;
  readonly text: string;
  readonly file: VerifiedArtifact;
}

interface VerifiedNativePackage {
  readonly trustedOwner: bigint;
  readonly enforcePosixTrust: boolean;
  readonly trustedDirectories: readonly VerifiedDirectory[];
  readonly packageDirectory: string;
  readonly packageIdentity: FileIdentity;
  readonly metadata: VerifiedArtifact;
  readonly artifact: VerifiedArtifact;
}

interface TrustedNativeLoad {
  readonly target: ReleasedRuntimePlatformTarget;
  readonly verified: VerifiedNativePackage;
  readonly cache: typeof FIXED_NATIVE_CACHE;
  readonly cacheEntry: object;
  readonly addon: unknown;
}

type DefaultNativeLoadState =
  | Readonly<{ status: "pristine" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "trusted"; record: TrustedNativeLoad }>
  | Readonly<{ status: "failed" }>;

const DEFAULT_NATIVE_LOAD_PRISTINE = Object.freeze({
  status: "pristine" as const,
});
const DEFAULT_NATIVE_LOAD_LOADING = Object.freeze({
  status: "loading" as const,
});
const DEFAULT_NATIVE_LOAD_FAILED = Object.freeze({ status: "failed" as const });
let defaultNativeLoadState: DefaultNativeLoadState =
  DEFAULT_NATIVE_LOAD_PRISTINE;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, expected: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.every((key) => typeof key === "string") &&
    actual.length === expected.length &&
    actual.every((key) => expected.includes(key as string)) &&
    expected.every((key) => actual.includes(key))
  );
}

function exactStringArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function bigintIdentity(
  metadata: ReturnType<typeof fstatSync> & {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly uid: bigint;
    readonly mode: bigint;
    readonly nlink: bigint;
    readonly size: bigint;
    readonly mtimeNs: bigint;
    readonly ctimeNs: bigint;
  },
): FileIdentity {
  return Object.freeze({
    device: metadata.dev,
    object: metadata.ino,
    owner: metadata.uid,
    mode: metadata.mode,
    links: metadata.nlink,
    size: metadata.size,
    modified: metadata.mtimeNs,
    changed: metadata.ctimeNs,
  });
}

function sameNonDeviceIdentity(
  left: FileIdentity,
  right: FileIdentity,
): boolean {
  return (
    left.object === right.object &&
    left.owner === right.owner &&
    left.mode === right.mode &&
    left.links === right.links &&
    left.size === right.size &&
    left.modified === right.modified &&
    left.changed === right.changed
  );
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.device === right.device && sameNonDeviceIdentity(left, right)
  );
}

function samePathAndDescriptorIdentity(
  pathIdentity: FileIdentity,
  descriptorIdentity: FileIdentity,
): boolean {
  /*
   * Node 22.12 and Node 24.0 bundle libuv releases that decode the tail of
   * Windows' fast path-stat structure in the wrong order, so path and
   * descriptor device values are not a portable cross-version comparison.
   * Keep exact device checks within each source and bridge the two using the
   * stable file ID plus every other identity field.
   */
  return (
    (sep === "\\" || pathIdentity.device === descriptorIdentity.device) &&
    sameNonDeviceIdentity(pathIdentity, descriptorIdentity)
  );
}

function sameDirectoryIdentity(
  left: FileIdentity,
  right: FileIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.object === right.object &&
    left.owner === right.owner &&
    left.mode === right.mode
  );
}

function assertTrustedPosixObject(
  identity: FileIdentity,
  trustedOwner: bigint,
  directory: boolean,
  enforcePosixTrust: boolean,
): void {
  if (!enforcePosixTrust) {
    return;
  }
  if (identity.owner !== 0n && identity.owner !== trustedOwner) {
    throw new Error("native package path has an untrusted owner");
  }
  if ((identity.mode & 0o022n) !== 0n) {
    const protectedSharedDirectory =
      directory && (identity.mode & 0o1000n) !== 0n;
    if (!protectedSharedDirectory) {
      throw new Error("native package path is writable by another principal");
    }
  }
}

function strictDescendant(parent: string, candidate: string): boolean {
  const difference = relative(parent, candidate);
  return (
    difference !== "" &&
    difference !== ".." &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference)
  );
}

function directDirectory(path: string): FileIdentity {
  const metadata = lstatSync(path, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("native package directory is unavailable");
  }
  if (realpathSync(path) !== resolve(path)) {
    throw new Error("native package directory is not direct");
  }
  return bigintIdentity(metadata);
}

function directRegularFile(
  path: string,
  maximumBytes: number,
  trustedOwner?: bigint,
  enforcePosixTrust = false,
): FileIdentity {
  const metadata = lstatSync(path, { bigint: true });
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.nlink !== 1n ||
    metadata.size <= 0n ||
    metadata.size > BigInt(maximumBytes) ||
    realpathSync(path) !== resolve(path)
  ) {
    throw new Error("native package file is unavailable");
  }
  const identity = bigintIdentity(metadata);
  if (trustedOwner !== undefined) {
    assertTrustedPosixObject(
      identity,
      trustedOwner,
      false,
      enforcePosixTrust,
    );
  }
  return identity;
}

function readDirectFile(
  path: string,
  maximumBytes: number,
  trustedOwner: bigint,
  enforcePosixTrust: boolean,
): Uint8Array {
  const before = directRegularFile(
    path,
    maximumBytes,
    trustedOwner,
    enforcePosixTrust,
  );
  const descriptor = openSync(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const openedBefore = bigintIdentity(fstatSync(descriptor, { bigint: true }));
    if (!samePathAndDescriptorIdentity(before, openedBefore)) {
      throw new Error("native package file changed before opening");
    }
    const bytes = new Uint8Array(Number(openedBefore.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (count <= 0) {
        throw new Error("native package file changed while reading");
      }
      offset += count;
    }
    const overflow = new Uint8Array(1);
    if (readSync(descriptor, overflow, 0, 1, null) !== 0) {
      throw new Error("native package file exceeded its verified size");
    }
    const openedAfter = bigintIdentity(fstatSync(descriptor, { bigint: true }));
    if (
      !sameIdentity(openedBefore, openedAfter) ||
      bytes.byteLength !== Number(openedBefore.size)
    ) {
      throw new Error("native package file changed while reading");
    }
    const pathAfter = directRegularFile(
      path,
      maximumBytes,
      trustedOwner,
      enforcePosixTrust,
    );
    if (!samePathAndDescriptorIdentity(pathAfter, openedAfter)) {
      throw new Error("native package file was replaced");
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function trustedDirectoryAncestry(
  path: string,
  trustRoot: string,
  trustedOwner: bigint,
  enforcePosixTrust: boolean,
): readonly VerifiedDirectory[] {
  const directories: VerifiedDirectory[] = [];
  let current = resolve(path);
  if (current !== trustRoot && !strictDescendant(trustRoot, current)) {
    throw new Error("native package path escaped its install trust root");
  }
  for (;;) {
    const identity = directDirectory(current);
    assertTrustedPosixObject(
      identity,
      trustedOwner,
      true,
      enforcePosixTrust,
    );
    directories.push(Object.freeze({ path: current, identity }));
    if (current === trustRoot) {
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("native package ancestry did not reach its trust root");
    }
    current = parent;
  }
  return Object.freeze(directories);
}

function readMetadata(
  packageDirectory: string,
  trustedOwner: bigint,
  enforcePosixTrust: boolean,
): ParsedPackageMetadata {
  const path = join(packageDirectory, "package.json");
  const bytes = readDirectFile(
    path,
    MAX_PACKAGE_METADATA_BYTES,
    trustedOwner,
    enforcePosixTrust,
  );
  const identity = directRegularFile(
    path,
    MAX_PACKAGE_METADATA_BYTES,
    trustedOwner,
    enforcePosixTrust,
  );
  const digest = createHash("sha256").update(bytes).digest("hex");
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    throw new Error("native package metadata is invalid");
  }
  if (!isRecord(value)) {
    throw new Error("native package metadata has an invalid shape");
  }
  return Object.freeze({
    value,
    text,
    file: Object.freeze({ path, identity, digest }),
  });
}

function validateMetadata(
  parsed: ParsedPackageMetadata,
  target: ReleasedRuntimePlatformTarget,
  packageName: string,
): Readonly<{ byteLength: number; sha256: string }> {
  const value = parsed.value;
  const platform = TARGET_PACKAGE_METADATA[target];
  const expectedMetadataKeys =
    platform.libc === null
      ? PACKAGE_METADATA_KEYS
      : Object.freeze([...PACKAGE_METADATA_KEYS, "libc"]);
  const engines = value.engines;
  const native = value.plurumNative;
  if (
    !hasExactKeys(value, expectedMetadataKeys) ||
    value.name !== packageName ||
    value.version !== CLI_VERSION ||
    value.license !== "Apache-2.0" ||
    value.main !== `./${ARTIFACT_NAME}` ||
    value.exports !== `./${ARTIFACT_NAME}` ||
    !exactStringArray(value.files, [ARTIFACT_NAME]) ||
    !exactStringArray(value.os, [platform.os]) ||
    !exactStringArray(value.cpu, [platform.cpu]) ||
    !isRecord(engines) ||
    !hasExactKeys(engines, ["node"]) ||
    engines.node !== SUPPORTED_NODE_RUNTIME_RANGES.join(" || ") ||
    !isRecord(native) ||
    !hasExactKeys(native, NATIVE_METADATA_KEYS) ||
    native.schemaVersion !== 1 ||
    native.magic !== NATIVE_CREDENTIAL_PACKAGE_MAGIC ||
    native.abiVersion !== NATIVE_CREDENTIAL_STORE_ABI_VERSION ||
    native.nodeApiVersion !== NATIVE_CREDENTIAL_STORE_NODE_API_VERSION ||
    native.target !== target ||
    !Number.isSafeInteger(native.byteLength) ||
    (native.byteLength as number) <= 0 ||
    (native.byteLength as number) > MAX_ARTIFACT_BYTES ||
    typeof native.sha256 !== "string" ||
    !SHA256.test(native.sha256)
  ) {
    throw new Error("native package metadata does not match the runtime");
  }
  if (
    platform.libc === null
      ? Object.hasOwn(value, "libc")
      : !exactStringArray(value.libc, [platform.libc])
  ) {
    throw new Error("native package libc metadata does not match the runtime");
  }
  const canonical = {
    name: packageName,
    version: CLI_VERSION,
    license: "Apache-2.0",
    main: `./${ARTIFACT_NAME}`,
    exports: `./${ARTIFACT_NAME}`,
    files: [ARTIFACT_NAME],
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
      byteLength: native.byteLength,
      sha256: native.sha256,
    },
  };
  if (`${JSON.stringify(canonical, null, 2)}\n` !== parsed.text) {
    throw new Error("native package metadata is not canonical");
  }
  return Object.freeze({
    byteLength: native.byteLength as number,
    sha256: native.sha256,
  });
}

function existingPath(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function locatePackageDirectory(packageRoot: string, packageName: string): string {
  const [scope, name, extra] = packageName.split("/");
  if (scope !== "@dunelabs" || name === undefined || extra !== undefined) {
    throw new Error("native package name is invalid");
  }
  const candidates = [
    join(packageRoot, "node_modules", scope, name),
    join(dirname(packageRoot), scope, name),
  ];
  const present = candidates.filter(existingPath);
  if (present.length !== 1 || present[0] === undefined) {
    throw new Error("native package is missing or duplicated");
  }
  const selected = present[0];
  const allowedParent = selected === candidates[0] ? packageRoot : dirname(packageRoot);
  if (!strictDescendant(allowedParent, selected)) {
    throw new Error("native package escaped its install root");
  }
  return selected;
}

function inspectPackage(
  packageRoot: string,
  target: ReleasedRuntimePlatformTarget,
): Readonly<VerifiedNativePackage> {
  if (
    !isAbsolute(packageRoot) ||
    basename(packageRoot) !== "plurum" ||
    realpathSync(packageRoot) !== resolve(packageRoot)
  ) {
    throw new Error("Plurum package root is unavailable");
  }
  const rootIdentity = directDirectory(packageRoot);
  const trustedOwner = rootIdentity.owner;
  const enforcePosixTrust = sep === "/";
  const nodeModulesRoot = dirname(packageRoot);
  if (basename(nodeModulesRoot) !== "node_modules") {
    throw new Error("Plurum package is outside an npm install tree");
  }
  const installTrustRoot = dirname(nodeModulesRoot);
  const packageName = NATIVE_CREDENTIAL_PACKAGE_BY_TARGET[target];
  const packageDirectory = locatePackageDirectory(packageRoot, packageName);
  const trustedDirectoryMap = new Map<string, VerifiedDirectory>();
  for (const directory of [
    ...trustedDirectoryAncestry(
      packageRoot,
      installTrustRoot,
      trustedOwner,
      enforcePosixTrust,
    ),
    ...trustedDirectoryAncestry(
      packageDirectory,
      installTrustRoot,
      trustedOwner,
      enforcePosixTrust,
    ),
  ]) {
    trustedDirectoryMap.set(directory.path, directory);
  }
  const trustedDirectories = Object.freeze([...trustedDirectoryMap.values()]);
  const packageIdentity = directDirectory(packageDirectory);
  const inventory = readdirSync(packageDirectory).sort();
  if (!exactStringArray(inventory, [...PACKAGE_INVENTORY].sort())) {
    throw new Error("native package inventory is invalid");
  }
  for (const document of ["LICENSE", "README.md"] as const) {
    directRegularFile(
      join(packageDirectory, document),
      MAX_DOCUMENT_BYTES,
      trustedOwner,
      enforcePosixTrust,
    );
  }
  const metadata = readMetadata(
    packageDirectory,
    trustedOwner,
    enforcePosixTrust,
  );
  const expected = validateMetadata(metadata, target, packageName);
  const artifactPath = join(packageDirectory, ARTIFACT_NAME);
  if (
    !isAbsolute(artifactPath) ||
    relative(packageDirectory, artifactPath) !== ARTIFACT_NAME ||
    realpathSync(artifactPath) !== resolve(artifactPath)
  ) {
    throw new Error("native artifact path is invalid");
  }
  const bytes = readDirectFile(
    artifactPath,
    MAX_ARTIFACT_BYTES,
    trustedOwner,
    enforcePosixTrust,
  );
  const artifactIdentity = directRegularFile(
    artifactPath,
    MAX_ARTIFACT_BYTES,
    trustedOwner,
    enforcePosixTrust,
  );
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (
    bytes.byteLength !== expected.byteLength ||
    digest !== expected.sha256
  ) {
    throw new Error("native artifact does not match its package metadata");
  }
  return Object.freeze({
    trustedOwner,
    enforcePosixTrust,
    trustedDirectories,
    packageDirectory,
    packageIdentity,
    metadata: metadata.file,
    artifact: Object.freeze({
      path: artifactPath,
      identity: artifactIdentity,
      digest,
    }),
  });
}

function revalidatePackage(
  verified: ReturnType<typeof inspectPackage>,
): void {
  for (const directory of verified.trustedDirectories) {
    const identity = directDirectory(directory.path);
    assertTrustedPosixObject(
      identity,
      verified.trustedOwner,
      true,
      verified.enforcePosixTrust,
    );
    if (!sameDirectoryIdentity(directory.identity, identity)) {
      throw new Error("native package ancestry was replaced");
    }
  }
  if (
    !sameIdentity(
      verified.packageIdentity,
      directDirectory(verified.packageDirectory),
    ) ||
    !exactStringArray(
      readdirSync(verified.packageDirectory).sort(),
      [...PACKAGE_INVENTORY].sort(),
    )
  ) {
    throw new Error("native package was replaced");
  }
  const metadataBytes = readDirectFile(
    verified.metadata.path,
    MAX_PACKAGE_METADATA_BYTES,
    verified.trustedOwner,
    verified.enforcePosixTrust,
  );
  const metadataAfter = directRegularFile(
    verified.metadata.path,
    MAX_PACKAGE_METADATA_BYTES,
    verified.trustedOwner,
    verified.enforcePosixTrust,
  );
  const metadataDigest = createHash("sha256")
    .update(metadataBytes)
    .digest("hex");
  if (
    !sameIdentity(verified.metadata.identity, metadataAfter) ||
    metadataDigest !== verified.metadata.digest
  ) {
    throw new Error("native package metadata was replaced");
  }
  const bytes = readDirectFile(
    verified.artifact.path,
    MAX_ARTIFACT_BYTES,
    verified.trustedOwner,
    verified.enforcePosixTrust,
  );
  const after = directRegularFile(
    verified.artifact.path,
    MAX_ARTIFACT_BYTES,
    verified.trustedOwner,
    verified.enforcePosixTrust,
  );
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (
    !sameIdentity(verified.artifact.identity, after) ||
    digest !== verified.artifact.digest
  ) {
    throw new Error("native artifact was replaced");
  }
}

function sameVerifiedArtifact(
  left: VerifiedArtifact,
  right: VerifiedArtifact,
): boolean {
  return (
    left.path === right.path &&
    left.digest === right.digest &&
    sameIdentity(left.identity, right.identity)
  );
}

function sameVerifiedPackage(
  left: VerifiedNativePackage,
  right: VerifiedNativePackage,
): boolean {
  return (
    left.trustedOwner === right.trustedOwner &&
    left.enforcePosixTrust === right.enforcePosixTrust &&
    left.trustedDirectories.length === right.trustedDirectories.length &&
    left.trustedDirectories.every((directory, index) => {
      const other = right.trustedDirectories[index];
      return (
        other !== undefined &&
        directory.path === other.path &&
        sameDirectoryIdentity(directory.identity, other.identity)
      );
    }) &&
    left.packageDirectory === right.packageDirectory &&
    sameIdentity(left.packageIdentity, right.packageIdentity) &&
    sameVerifiedArtifact(left.metadata, right.metadata) &&
    sameVerifiedArtifact(left.artifact, right.artifact)
  );
}

function ownDataDescriptor(
  value: object,
  property: string,
): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, property);
  return descriptor !== undefined && Object.hasOwn(descriptor, "value")
    ? descriptor
    : undefined;
}

function rejectPreexistingCacheEntry(artifactPath: string): void {
  if (
    Object.getOwnPropertyDescriptor(FIXED_NATIVE_CACHE, artifactPath) !==
    undefined
  ) {
    throw new Error("native artifact cache entry already exists");
  }
}

function verifiedCacheEntry(
  artifactPath: string,
  addon: unknown,
  expectedEntry?: object,
): object {
  const cacheDescriptor = ownDataDescriptor(FIXED_NATIVE_CACHE, artifactPath);
  const entry = cacheDescriptor?.value;
  if (
    entry === null ||
    typeof entry !== "object" ||
    (expectedEntry !== undefined && entry !== expectedEntry)
  ) {
    throw new Error("native artifact cache entry is invalid");
  }
  const filename = ownDataDescriptor(entry, "filename");
  const modulePath = Object.getOwnPropertyDescriptor(entry, "path");
  const exports = ownDataDescriptor(entry, "exports");
  if (
    filename?.value !== artifactPath ||
    exports?.value !== addon ||
    (modulePath !== undefined &&
      (!Object.hasOwn(modulePath, "value") ||
        modulePath.value !== dirname(artifactPath)))
  ) {
    throw new Error("native artifact cache binding is invalid");
  }
  return entry;
}

/*
 * Across supported platforms Node loads a native CommonJS addon by pathname,
 * not from the descriptor used for verification. The installed npm package and
 * this captured cache object are therefore rechecked immediately around that
 * one load. The installed npm tree is executable code, not user data: any
 * principal allowed to modify it can already replace this running JavaScript.
 * POSIX loads additionally require a non-broadly-writable, owner-consistent
 * path ancestry. Node does not expose equivalent Windows DACL evidence, so this
 * verifier does not claim it and production composition remains disabled until
 * the later native lifecycle gate records that bootstrap trust decision.
 */

function defaultLoadAddon(artifactPath: string): unknown {
  return FIXED_NATIVE_REQUIRE(artifactPath);
}

function normalizeOptions(
  options: NativeCredentialPackageVerificationOptions | undefined,
): ResolverConfiguration | undefined {
  if (options === undefined) {
    return Object.freeze({
      packageRoot: DEFAULT_PACKAGE_ROOT,
      loadAddon: defaultLoadAddon,
      enforceCommonJsCache: true,
    });
  }
  try {
    if (
      !Object.isFrozen(options) ||
      !hasExactKeys(options as unknown as UnknownRecord, [
        "loadAddon",
        "packageRoot",
      ]) ||
      typeof options.packageRoot !== "string" ||
      typeof options.loadAddon !== "function"
    ) {
      return undefined;
    }
    return Object.freeze({
      packageRoot: options.packageRoot,
      loadAddon: options.loadAddon,
      enforceCommonJsCache: false,
    });
  } catch {
    return undefined;
  }
}

function loadTrustedNativePackage(
  target: ReleasedRuntimePlatformTarget,
  verified: VerifiedNativePackage,
  record: TrustedNativeLoad,
): unknown {
  revalidatePackage(verified);
  if (
    record.cache !== FIXED_NATIVE_CACHE ||
    record.target !== target ||
    !sameVerifiedPackage(record.verified, verified) ||
    verifiedCacheEntry(
      verified.artifact.path,
      record.addon,
      record.cacheEntry,
    ) !== record.cacheEntry
  ) {
    throw new Error("trusted native artifact binding changed");
  }
  return record.addon;
}

function loadDefaultNativePackage(
  target: ReleasedRuntimePlatformTarget,
  verified: VerifiedNativePackage,
  configuration: ResolverConfiguration,
): unknown {
  if (defaultNativeLoadState.status === "trusted") {
    try {
      return loadTrustedNativePackage(
        target,
        verified,
        defaultNativeLoadState.record,
      );
    } catch {
      defaultNativeLoadState = DEFAULT_NATIVE_LOAD_FAILED;
      throw new Error("trusted native artifact is unavailable");
    }
  }
  if (defaultNativeLoadState !== DEFAULT_NATIVE_LOAD_PRISTINE) {
    defaultNativeLoadState = DEFAULT_NATIVE_LOAD_FAILED;
    throw new Error("native artifact loading is unavailable");
  }

  defaultNativeLoadState = DEFAULT_NATIVE_LOAD_LOADING;
  try {
    revalidatePackage(verified);
    rejectPreexistingCacheEntry(verified.artifact.path);
    const addon = configuration.loadAddon(verified.artifact.path);
    revalidatePackage(verified);
    const cacheEntry = verifiedCacheEntry(verified.artifact.path, addon);
    if (defaultNativeLoadState !== DEFAULT_NATIVE_LOAD_LOADING) {
      throw new Error("native artifact loading was reentered");
    }
    const record = Object.freeze({
      target,
      verified,
      cache: FIXED_NATIVE_CACHE,
      cacheEntry,
      addon,
    });
    defaultNativeLoadState = Object.freeze({
      status: "trusted" as const,
      record,
    });
    return addon;
  } catch {
    defaultNativeLoadState = DEFAULT_NATIVE_LOAD_FAILED;
    throw new Error("native artifact loading failed verification");
  }
}

function loadNativePackage(
  target: NativeCredentialTarget,
  configuration: ResolverConfiguration | undefined,
): unknown {
  if (
    configuration === undefined ||
    !RELEASED_TARGET_SET.has(target) ||
    !Object.hasOwn(NATIVE_CREDENTIAL_PACKAGE_BY_TARGET, target)
  ) {
    throw new Error("native package target is unsupported");
  }
  const releasedTarget = target as ReleasedRuntimePlatformTarget;
  const verified = inspectPackage(configuration.packageRoot, releasedTarget);
  if (configuration.enforceCommonJsCache) {
    return loadDefaultNativePackage(releasedTarget, verified, configuration);
  }
  const addon = configuration.loadAddon(verified.artifact.path);
  revalidatePackage(verified);
  return addon;
}

/*
 * Verifier-only composition boundary. The public CLI entrypoint must remain
 * deny-by-default until the later native lifecycle gates activate it.
 * The caller supplies an already positively identified target; this module
 * never guesses Linux libc from process.platform/process.arch.
 */
export function createNativeCredentialPackageProvider(
  target: NativeCredentialTarget,
  options?: NativeCredentialPackageVerificationOptions,
): NativeCredentialStoreProvider {
  const configuration = normalizeOptions(options);
  return createNativeCredentialStoreProvider(target, (requestedTarget) =>
    loadNativePackage(requestedTarget, configuration),
  );
}
