import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
  toNamespacedPath,
} from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const crateRoot = realpathSync(dirname(dirname(scriptPath)));
const packageRoot = realpathSync(resolve(crateRoot, "../.."));
const sourceWorkspaceLexicalRoot = resolve(packageRoot, "../..");
const sourceWorkspaceRoot = realpathSync(sourceWorkspaceLexicalRoot);
const isolationMarker = "plurum-native-isolation-v1\n";
const MAX_PACKAGE_JSON_BYTES = 64 * 1024;
const MAX_NATIVE_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_CLEANUP_ENTRIES = 20_000;
const MAX_CLEANUP_FILE_BYTES = 96 * 1024 * 1024;
const MAX_CLEANUP_TOTAL_BYTES = 256 * 1024 * 1024;
const NATIVE_PACKAGE_MAGIC = "plurum-native-credential-package";
const PORTABLE_PACKAGE_FILE_MODE = 0o644;
const NATIVE_PACKAGE_INVENTORY = Object.freeze([
  "LICENSE",
  "README.md",
  "credential-store.node",
  "package.json",
]);
const SENSITIVE_BUILD_PATH_ENVIRONMENT = Object.freeze([
  "HOME",
  "USERPROFILE",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "GITHUB_WORKSPACE",
]);
const ISOLATED_BUILD_PATH_BY_ENVIRONMENT = Object.freeze({
  HOME: "home",
  USERPROFILE: "home",
  CARGO_HOME: "cargo-home",
  RUSTUP_HOME: "rustup-home",
});

export const NATIVE_TARGET_PACKAGES = Object.freeze({
  "darwin-arm64": Object.freeze({
    name: "@dunelabs/plurum-native-darwin-arm64",
    os: "darwin",
    cpu: "arm64",
    rustHost: "aarch64-apple-darwin",
    binary: "libplurum_native_credential_store.dylib",
  }),
  "darwin-x64": Object.freeze({
    name: "@dunelabs/plurum-native-darwin-x64",
    os: "darwin",
    cpu: "x64",
    rustHost: "x86_64-apple-darwin",
    binary: "libplurum_native_credential_store.dylib",
  }),
  "linux-arm64-gnu": Object.freeze({
    name: "@dunelabs/plurum-native-linux-arm64-gnu",
    os: "linux",
    cpu: "arm64",
    libc: "glibc",
    rustHost: "aarch64-unknown-linux-gnu",
    binary: "libplurum_native_credential_store.so",
  }),
  "linux-x64-gnu": Object.freeze({
    name: "@dunelabs/plurum-native-linux-x64-gnu",
    os: "linux",
    cpu: "x64",
    libc: "glibc",
    rustHost: "x86_64-unknown-linux-gnu",
    binary: "libplurum_native_credential_store.so",
  }),
  "win32-x64-msvc": Object.freeze({
    name: "@dunelabs/plurum-native-win32-x64-msvc",
    os: "win32",
    cpu: "x64",
    rustHost: "x86_64-pc-windows-msvc",
    binary: "plurum_native_credential_store.dll",
  }),
});

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.ok(value, `${name} must be set`);
  assert.equal(/[\r\n\0]/u.test(value), false, `${name} must be one safe line`);
  return value;
}

function isStrictDescendant(parent, candidate) {
  const difference = relative(parent, candidate);
  return (
    difference !== "" &&
    difference !== ".." &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference)
  );
}

function isWithin(parent, candidate) {
  return candidate === parent || isStrictDescendant(parent, candidate);
}

function pathExists(path) {
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

function assertDirectOwnedRegularFile(path, label, maxBytes) {
  const metadata = lstatSync(path);
  assert.equal(metadata.isSymbolicLink(), false, `${label} must not be a symlink`);
  assert.equal(metadata.isFile(), true, `${label} must be a regular file`);
  assert.equal(metadata.size > 0, true, `${label} must not be empty`);
  assert.equal(metadata.size <= maxBytes, true, `${label} exceeded its byte limit`);
  if (process.platform !== "win32") {
    assert.equal(metadata.uid, process.getuid?.(), `${label} must be user-owned`);
  }
  return metadata;
}

function assertDirectRegularFile(path, label, maxBytes) {
  const metadata = assertDirectOwnedRegularFile(path, label, maxBytes);
  assert.equal(metadata.nlink, 1, `${label} must have one link`);
  return metadata;
}

function assertControlledCargoArtifact(path, cargoTarget, descriptor) {
  const label = "Cargo native artifact";
  const releaseDirectory = join(cargoTarget, "release");
  assert.equal(
    path,
    join(releaseDirectory, descriptor.binary),
    `${label} must use the fixed release path`,
  );
  assertDirectDirectory(releaseDirectory, "isolated Cargo release directory");
  assert.equal(
    realpathSync(releaseDirectory),
    resolve(releaseDirectory),
    "isolated Cargo release directory must be direct",
  );
  assert.equal(realpathSync(path), resolve(path), `${label} must be direct`);
  const metadata = assertDirectOwnedRegularFile(
    path,
    label,
    MAX_NATIVE_ARTIFACT_BYTES,
  );
  if (metadata.nlink === 1) {
    return metadata;
  }

  assert.equal(
    process.platform === "linux" || process.platform === "win32",
    true,
    `${label} may only use Cargo's second release link on Linux or Windows`,
  );
  assert.equal(metadata.nlink, 2, `${label} must have one or two links`);
  const dependenciesDirectory = join(releaseDirectory, "deps");
  assertDirectDirectory(
    dependenciesDirectory,
    "isolated Cargo release dependencies directory",
  );
  assert.equal(
    realpathSync(dependenciesDirectory),
    resolve(dependenciesDirectory),
    "isolated Cargo release dependencies directory must be direct",
  );
  const dependencyArtifact = join(dependenciesDirectory, descriptor.binary);
  assert.equal(
    realpathSync(dependencyArtifact),
    resolve(dependencyArtifact),
    "Cargo dependency artifact must be direct",
  );
  const dependencyMetadata = assertDirectOwnedRegularFile(
    dependencyArtifact,
    "Cargo dependency artifact",
    MAX_NATIVE_ARTIFACT_BYTES,
  );
  assert.equal(
    dependencyMetadata.nlink,
    2,
    "Cargo dependency artifact must account for the second release link",
  );
  assert.deepEqual(
    fileIdentity(dependencyMetadata),
    fileIdentity(metadata),
    "Cargo release links must identify the same artifact",
  );
  return metadata;
}

function assertPortablePackageFileMode(metadata, label) {
  if (process.platform !== "win32") {
    assert.equal(
      metadata.mode & 0o777,
      PORTABLE_PACKAGE_FILE_MODE,
      `${label} must use the portable package file mode`,
    );
  }
}

function assertInstalledPackageFileMode(metadata, label) {
  if (process.platform !== "win32") {
    const expectedMode = PORTABLE_PACKAGE_FILE_MODE & ~process.umask();
    assert.equal(
      metadata.mode & 0o777,
      expectedMode,
      `${label} must retain the portable mode subject to the installer umask`,
    );
    assert.notEqual(
      metadata.mode & 0o400,
      0,
      `${label} must remain owner-readable`,
    );
  }
}

function assertDirectDirectory(path, label) {
  const metadata = lstatSync(path);
  assert.equal(metadata.isSymbolicLink(), false, `${label} must not be a symlink`);
  assert.equal(metadata.isDirectory(), true, `${label} must be a directory`);
  if (process.platform !== "win32") {
    assert.equal(metadata.uid, process.getuid?.(), `${label} must be user-owned`);
  }
  return metadata;
}

function readBounded(path, maxBytes, label) {
  assertDirectRegularFile(path, label, maxBytes);
  return readFileSync(path);
}

function readStableBounded(path, maxBytes, label) {
  const before = fileIdentity(assertDirectRegularFile(path, label, maxBytes));
  const descriptor = openSync(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const openedBeforeMetadata = fstatSync(descriptor);
    assert.equal(openedBeforeMetadata.isFile(), true, `${label} must stay a file`);
    assert.equal(openedBeforeMetadata.nlink, 1, `${label} must have one link`);
    assert.equal(
      openedBeforeMetadata.size > 0 && openedBeforeMetadata.size <= maxBytes,
      true,
      `${label} exceeded its byte limit`,
    );
    const openedBefore = fileIdentity(openedBeforeMetadata);
    assertPathAndDescriptorIdentity(
      before,
      openedBefore,
      `${label} changed before opening`,
    );
    const bytes = Buffer.alloc(openedBefore.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      assert.equal(count > 0, true, `${label} changed while reading`);
      offset += count;
    }
    assert.equal(
      readSync(descriptor, Buffer.alloc(1), 0, 1, null),
      0,
      `${label} exceeded its verified size`,
    );
    const openedAfter = fileIdentity(fstatSync(descriptor));
    assert.deepEqual(openedAfter, openedBefore, `${label} changed while reading`);
    const pathAfter = fileIdentity(
      assertDirectRegularFile(path, label, maxBytes),
    );
    assertPathAndDescriptorIdentity(
      pathAfter,
      openedAfter,
      `${label} was replaced`,
    );
    return Object.freeze({
      bytes,
      identity: openedAfter,
      digest: sha256(bytes),
    });
  } finally {
    closeSync(descriptor);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function buildPathSeparatorVariants(path) {
  const variants = new Set([path, toNamespacedPath(path)]);
  for (const variant of [...variants]) {
    variants.add(variant.replaceAll("\\", "/"));
    variants.add(variant.replaceAll("/", "\\"));
  }
  for (const variant of [...variants]) {
    const drive = /^(?:\\\\\?\\|\/\/\?\/)?[A-Za-z]:[\\/]/u.exec(variant);
    if (drive !== null) {
      const driveIndex = drive[0].length - 3;
      const driveLetter = variant[driveIndex];
      assert.ok(driveLetter !== undefined);
      variants.add(
        `${variant.slice(0, driveIndex)}${driveLetter.toLowerCase()}${variant.slice(driveIndex + 1)}`,
      );
      variants.add(
        `${variant.slice(0, driveIndex)}${driveLetter.toUpperCase()}${variant.slice(driveIndex + 1)}`,
      );
    }
  }
  return variants;
}

function sensitiveBuildPaths(isolationRoot) {
  const paths = [
    Object.freeze({ label: "source workspace", path: sourceWorkspaceRoot }),
    Object.freeze({ label: "native isolation", path: isolationRoot }),
  ];
  for (const name of SENSITIVE_BUILD_PATH_ENVIRONMENT) {
    const value = process.env[name];
    if (value === undefined) {
      assert.equal(
        name === "GITHUB_WORKSPACE" && process.env.GITHUB_ACTIONS !== "true",
        true,
        `${name} must be set for native artifact path inspection`,
      );
      continue;
    }
    assert.equal(
      /[\r\n\0\x1f]/u.test(value),
      false,
      `${name} must be one safe path`,
    );
    assert.equal(isAbsolute(value), true, `${name} must be absolute`);
    const lexicalPath = resolve(value);
    if (name === "GITHUB_WORKSPACE") {
      assert.equal(
        lexicalPath === sourceWorkspaceLexicalRoot ||
          lexicalPath === sourceWorkspaceRoot,
        true,
        "GITHUB_WORKSPACE must name the canonical source workspace",
      );
    } else {
      const child = ISOLATED_BUILD_PATH_BY_ENVIRONMENT[name];
      assert.ok(child !== undefined, `${name} must have an isolated path rule`);
      assert.equal(
        lexicalPath,
        resolve(join(isolationRoot, child)),
        `${name} must stay in the native isolation root`,
      );
    }
    assertDirectDirectory(lexicalPath, `${name} lexical directory`);
    const canonicalPath = realpathSync(value);
    assertDirectDirectory(canonicalPath, `${name} directory`);
    if (name === "GITHUB_WORKSPACE") {
      assert.equal(canonicalPath, sourceWorkspaceRoot);
    } else {
      assert.equal(isWithin(isolationRoot, canonicalPath), true);
    }
    paths.push(Object.freeze({ label: name, path: lexicalPath }));
    if (canonicalPath !== lexicalPath) {
      paths.push(
        Object.freeze({ label: `${name} canonical`, path: canonicalPath }),
      );
    }
  }
  return Object.freeze(paths);
}

function assertNoSensitiveBuildPaths(artifactBytes, isolationRoot) {
  assert.equal(Buffer.isBuffer(artifactBytes), true);
  assert.equal(artifactBytes.byteLength > 0, true);
  const inspected = new Set();
  for (const candidate of sensitiveBuildPaths(isolationRoot)) {
    assert.equal(isAbsolute(candidate.path), true);
    assert.equal(
      resolve(candidate.path) === parse(candidate.path).root,
      false,
      `${candidate.label} path must not be a filesystem root`,
    );
    for (const variant of buildPathSeparatorVariants(candidate.path)) {
      assert.equal(variant.length >= 4, true);
      for (const encoding of ["utf8", "utf16le"]) {
        const needle = Buffer.from(variant, encoding);
        const identity = `${encoding}\0${needle.toString("hex")}`;
        if (inspected.has(identity)) {
          continue;
        }
        inspected.add(identity);
        assert.equal(
          artifactBytes.indexOf(needle),
          -1,
          `Cargo native artifact embeds a forbidden ${candidate.label} path (${encoding})`,
        );
      }
    }
  }
}

function fileIdentity(metadata) {
  return Object.freeze({
    device: metadata.dev,
    inode: metadata.ino,
    links: metadata.nlink,
    size: metadata.size,
    modified: metadata.mtimeMs,
    changed: metadata.ctimeMs,
  });
}

function assertPathAndDescriptorIdentity(
  pathIdentity,
  descriptorIdentity,
  message,
) {
  /*
   * Node 22.12 and Node 24.0 bundle libuv releases that decode the tail of
   * Windows' fast path-stat structure in the wrong order, so path and
   * descriptor device values are not a portable cross-version comparison.
   * Keep exact device checks within each source and bridge the two using the
   * stable file ID plus every other identity field.
   */
  if (process.platform === "win32") {
    assert.deepEqual(
      {
        inode: pathIdentity.inode,
        links: pathIdentity.links,
        size: pathIdentity.size,
        modified: pathIdentity.modified,
        changed: pathIdentity.changed,
      },
      {
        inode: descriptorIdentity.inode,
        links: descriptorIdentity.links,
        size: descriptorIdentity.size,
        modified: descriptorIdentity.modified,
        changed: descriptorIdentity.changed,
      },
      message,
    );
    return;
  }
  assert.deepEqual(pathIdentity, descriptorIdentity, message);
}

function digest(bytes, algorithm, encoding) {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function exactJson(path, maxBytes, label) {
  const bytes = readBounded(path, maxBytes, label);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value;
}

export function verifiedNativeIsolation() {
  const configured = requiredEnvironment("PLURUM_NATIVE_ISOLATION_ROOT");
  assert.equal(isAbsolute(configured), true, "native isolation root must be absolute");
  assertDirectDirectory(configured, "native isolation root");
  const root = realpathSync(configured);
  assert.equal(
    readBounded(
      join(root, ".plurum-native-isolation"),
      256,
      "native isolation marker",
    ).toString("utf8"),
    isolationMarker,
  );

  const temporary = realpathSync(join(root, "tmp"));
  assertDirectDirectory(temporary, "native isolation temporary directory");
  for (const name of ["TMPDIR", "TEMP", "TMP"]) {
    const configuredTemporary = requiredEnvironment(name);
    assert.equal(
      realpathSync(configuredTemporary),
      temporary,
      `${name} must name the native isolation temporary directory`,
    );
  }

  const cargoTarget = realpathSync(requiredEnvironment("CARGO_TARGET_DIR"));
  assert.equal(cargoTarget, realpathSync(join(root, "cargo-target")));
  assertDirectDirectory(cargoTarget, "isolated Cargo target directory");
  return Object.freeze({ root, temporary, cargoTarget });
}

export function nativeTargetDescriptor(target) {
  assert.equal(typeof target, "string", "native target must be a string");
  const descriptor = NATIVE_TARGET_PACKAGES[target];
  assert.ok(descriptor !== undefined, `unsupported native package target: ${target}`);
  return descriptor;
}

function assertCurrentRuntime(target, descriptor) {
  assert.equal(process.platform, descriptor.os, "native package OS must match the runtime");
  assert.equal(process.arch, descriptor.cpu, "native package CPU must match the runtime");
  if (descriptor.libc === "glibc") {
    const report = process.report?.getReport();
    assert.equal(
      typeof report?.header?.glibcVersionRuntime,
      "string",
      "GNU native packaging requires positive glibc runtime evidence",
    );
  }
  const configuredRustHost = requiredEnvironment("PLURUM_NATIVE_RUST_HOST");
  assert.equal(configuredRustHost, descriptor.rustHost);
  assert.equal(requiredEnvironment("PLURUM_NATIVE_EXPECTED_TARGET"), target);
}

function rootPackageMetadata() {
  const metadata = exactJson(
    join(packageRoot, "package.json"),
    MAX_PACKAGE_JSON_BYTES,
    "root package metadata",
  );
  assert.equal(metadata.name, "plurum");
  assert.equal(typeof metadata.version, "string");
  assert.match(metadata.version, /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u);
  assert.deepEqual(metadata.engines, { node: "^22.12.0 || ^24.0.0" });
  assert.equal(metadata.license, "Apache-2.0");
  return metadata;
}

function targetPackageManifest(
  target,
  descriptor,
  rootMetadata,
  artifactBytes,
  artifactSha256,
) {
  return Object.freeze({
    name: descriptor.name,
    version: rootMetadata.version,
    license: "Apache-2.0",
    main: "./credential-store.node",
    exports: "./credential-store.node",
    files: Object.freeze(["credential-store.node"]),
    os: Object.freeze([descriptor.os]),
    cpu: Object.freeze([descriptor.cpu]),
    ...(descriptor.libc === undefined
      ? {}
      : { libc: Object.freeze([descriptor.libc]) }),
    engines: Object.freeze({ node: rootMetadata.engines.node }),
    plurumNative: Object.freeze({
      schemaVersion: 1,
      magic: NATIVE_PACKAGE_MAGIC,
      abiVersion: 4,
      nodeApiVersion: 8,
      target,
      byteLength: artifactBytes,
      sha256: artifactSha256,
    }),
  });
}

function canonicalJsonBytes(value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  assert.equal(bytes.byteLength <= MAX_PACKAGE_JSON_BYTES, true);
  assert.deepEqual(JSON.parse(bytes.toString("utf8")), value);
  return bytes;
}

function generatedReadmeBytes(target, descriptor) {
  const bytes = Buffer.from(
    [
      `# ${descriptor.name}`,
      "",
      `Native Plurum credential-store addon for \`${target}\`.`,
      "",
      "This target package is installed automatically by `plurum` and is not a standalone API.",
      "",
    ].join("\n"),
    "utf8",
  );
  assert.equal(bytes.byteLength > 0 && bytes.byteLength <= MAX_DOCUMENT_BYTES, true);
  return bytes;
}

function verifiedNpmCli(configured) {
  assert.equal(isAbsolute(configured), true, "npm_execpath must be absolute");
  const metadata = lstatSync(configured);
  assert.equal(metadata.isSymbolicLink(), false, "npm CLI must not be a symlink");
  assert.equal(metadata.isFile(), true, "npm CLI must be a regular file");
  assert.equal(metadata.nlink, 1, "npm CLI must have one link");
  assert.equal(metadata.size > 0 && metadata.size <= 4 * 1024 * 1024, true);
  if (process.platform !== "win32") {
    assert.equal(
      metadata.uid === 0 || metadata.uid === process.getuid?.(),
      true,
      "npm CLI must be owned by the user or system administrator",
    );
    assert.equal(metadata.mode & 0o022, 0, "npm CLI must not be group/world writable");
  }
  const canonical = realpathSync(configured);
  assert.equal(canonical, resolve(configured), "npm CLI must be direct");
  return canonical;
}

export function requiredNpmCli() {
  return verifiedNpmCli(requiredEnvironment("npm_execpath"));
}

export function isolatedNpmEnvironment(operationRoot, cacheDirectory) {
  const home = join(operationRoot, "home");
  const config = join(operationRoot, "config");
  const state = join(operationRoot, "state");
  const temporary = join(operationRoot, "tmp");
  const plurumHome = join(config, "plurum");
  const codexHome = join(config, "codex");
  const claudeConfig = join(config, "claude");
  for (const directory of [
    home,
    config,
    state,
    temporary,
    cacheDirectory,
    plurumHome,
    codexHome,
    claudeConfig,
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      chmodSync(directory, 0o700);
    }
  }
  const path = [
    dirname(process.execPath),
    ...(process.platform === "win32"
      ? [join(requiredEnvironment("SystemRoot"), "System32")]
      : []),
  ].join(delimiter);
  return Object.freeze({
    PATH: path,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: state,
    XDG_CACHE_HOME: cacheDirectory,
    APPDATA: config,
    LOCALAPPDATA: config,
    PLURUM_HOME: plurumHome,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeConfig,
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    NO_COLOR: "1",
    CI: "true",
    npm_config_cache: cacheDirectory,
    npm_config_globalconfig: join(config, "global-npmrc"),
    npm_config_userconfig: join(config, "npmrc"),
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
    npm_config_offline: "true",
    ...(process.platform === "win32"
      ? {
          SystemRoot: requiredEnvironment("SystemRoot"),
          ComSpec: requiredEnvironment("ComSpec"),
          PATHEXT: requiredEnvironment("PATHEXT"),
          WINDIR: requiredEnvironment("WINDIR"),
        }
      : {}),
  });
}

export function runNpm({ npmCli, args, cwd, environment, timeoutMs = 120_000 }) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    env: environment,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    killSignal: "SIGKILL",
    shell: false,
    timeout: timeoutMs,
  });
  assert.equal(result.error, undefined, "npm process must start successfully");
  assert.equal(
    result.status,
    0,
    `npm command failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function exactInstalledPackage(directory, manifest, expectedArtifactDigest) {
  assertDirectDirectory(directory, "installed native target package");
  assert.deepEqual(readdirSync(directory).sort(), [...NATIVE_PACKAGE_INVENTORY]);
  for (const name of NATIVE_PACKAGE_INVENTORY) {
    const maximumBytes =
      name === "credential-store.node"
        ? MAX_NATIVE_ARTIFACT_BYTES
        : name === "package.json"
          ? MAX_PACKAGE_JSON_BYTES
          : MAX_DOCUMENT_BYTES;
    const metadata = assertDirectRegularFile(
      join(directory, name),
      `installed native package ${name}`,
      maximumBytes,
    );
    assertInstalledPackageFileMode(metadata, `installed native package ${name}`);
  }
  const installedManifestBytes = readBounded(
    join(directory, "package.json"),
    MAX_PACKAGE_JSON_BYTES,
    "installed native package metadata",
  );
  assert.equal(
    installedManifestBytes.equals(canonicalJsonBytes(manifest)),
    true,
    "installed native package metadata must retain its canonical bytes",
  );
  assert.deepEqual(
    JSON.parse(installedManifestBytes.toString("utf8")),
    manifest,
  );
  const installedArtifact = join(directory, "credential-store.node");
  const installedBytes = readBounded(
    installedArtifact,
    MAX_NATIVE_ARTIFACT_BYTES,
    "installed native artifact",
  );
  assert.equal(sha256(installedBytes), expectedArtifactDigest);
  return installedArtifact;
}

function boundedOwnedTreeSnapshot(root) {
  const entries = [];
  let totalBytes = 0;
  const visit = (path, displayPath) => {
    assert.equal(entries.length < MAX_CLEANUP_ENTRIES, true);
    const metadata = lstatSync(path);
    if (process.platform !== "win32") {
      assert.equal(metadata.uid, process.getuid?.(), "cleanup entry must be user-owned");
    }
    if (metadata.isSymbolicLink()) {
      const target = readlinkSync(path);
      const resolvedTarget = realpathSync(path);
      assert.equal(
        isWithin(root, resolvedTarget),
        true,
        "cleanup symlink must remain within its owned root",
      );
      entries.push(Object.freeze({
        path: displayPath,
        kind: "symbolic-link",
        target,
        resolvedTarget: relative(root, resolvedTarget),
        device: metadata.dev,
        inode: metadata.ino,
        mode: metadata.mode,
        links: metadata.nlink,
        modified: metadata.mtimeMs,
        changed: metadata.ctimeMs,
      }));
      return;
    }
    if (metadata.isDirectory()) {
      assert.equal(realpathSync(path), resolve(path), "cleanup directory must be direct");
      entries.push(Object.freeze({
        path: displayPath,
        kind: "directory",
        device: metadata.dev,
        inode: metadata.ino,
        mode: metadata.mode,
        links: metadata.nlink,
        modified: metadata.mtimeMs,
        changed: metadata.ctimeMs,
      }));
      for (const name of readdirSync(path).sort()) {
        visit(join(path, name), `${displayPath}/${name}`);
      }
      return;
    }
    assert.equal(metadata.isFile(), true, "cleanup entry must be a file or directory");
    assert.equal(metadata.nlink, 1, "cleanup file must have one link");
    assert.equal(metadata.size <= MAX_CLEANUP_FILE_BYTES, true);
    totalBytes += metadata.size;
    assert.equal(totalBytes <= MAX_CLEANUP_TOTAL_BYTES, true);
    entries.push(Object.freeze({
      path: displayPath,
      kind: "file",
      device: metadata.dev,
      inode: metadata.ino,
      mode: metadata.mode,
      links: metadata.nlink,
      size: metadata.size,
      modified: metadata.mtimeMs,
      changed: metadata.ctimeMs,
      digest: sha256(readFileSync(path)),
    }));
  };
  visit(root, ".");
  return Object.freeze(entries);
}

function safeRemoveOwnedRoot(
  root,
  identity,
  sentinelPath,
  sentinelIdentity,
  sentinel,
  temporary,
) {
  assert.equal(realpathSync(root), root);
  assert.equal(isStrictDescendant(temporary, root), true);
  assert.equal(root.startsWith(`${temporary}${sep}plurum-native-assemble-`), true);
  const metadata = assertDirectDirectory(root, "native package assembly root");
  assert.deepEqual({ device: metadata.dev, inode: metadata.ino }, identity);
  const sentinelMetadata = assertDirectRegularFile(
    sentinelPath,
    "native package assembly sentinel",
    256,
  );
  assert.deepEqual(
    { device: sentinelMetadata.dev, inode: sentinelMetadata.ino },
    sentinelIdentity,
  );
  assert.equal(
    readBounded(sentinelPath, 256, "native package assembly sentinel").toString(
      "utf8",
    ),
    sentinel,
  );
  boundedOwnedTreeSnapshot(root);
  rmSync(root, { recursive: true, force: false });
  assert.equal(existsSync(root), false);
}

export function assembleNativeTargetPackage(options = {}) {
  const isolation = verifiedNativeIsolation();
  const target = options.target ?? requiredEnvironment("PLURUM_NATIVE_EXPECTED_TARGET");
  const descriptor = nativeTargetDescriptor(target);
  assertCurrentRuntime(target, descriptor);
  const outputDirectory = realpathSync(
    options.outputDirectory ?? requiredEnvironment("PLURUM_NATIVE_PACKAGE_OUTPUT"),
  );
  assertDirectDirectory(outputDirectory, "native package output directory");
  assert.equal(
    isStrictDescendant(isolation.temporary, outputDirectory),
    true,
    "native package output must stay beneath the isolated temporary directory",
  );

  const cargoBinary = join(isolation.cargoTarget, "release", descriptor.binary);
  const cargoMetadata = assertControlledCargoArtifact(
    cargoBinary,
    isolation.cargoTarget,
    descriptor,
  );
  const cargoIdentity = fileIdentity(cargoMetadata);
  const cargoBytes = readFileSync(cargoBinary);
  assert.equal(cargoBytes.byteLength, cargoMetadata.size);
  assert.deepEqual(
    fileIdentity(
      assertControlledCargoArtifact(
        cargoBinary,
        isolation.cargoTarget,
        descriptor,
      ),
    ),
    cargoIdentity,
    "Cargo native artifact changed while being inspected",
  );
  assertNoSensitiveBuildPaths(cargoBytes, isolation.root);
  const cargoDigest = sha256(cargoBytes);
  const rootMetadata = rootPackageMetadata();
  assert.equal(rootMetadata.optionalDependencies?.[descriptor.name], rootMetadata.version);
  const manifest = targetPackageManifest(
    target,
    descriptor,
    rootMetadata,
    cargoMetadata.size,
    cargoDigest,
  );
  const npmCli =
    options.npmCli === undefined
      ? requiredNpmCli()
      : verifiedNpmCli(options.npmCli);
  const expectedFilename = `dunelabs-plurum-native-${target}-${rootMetadata.version}.tgz`;
  const expectedArchivePath = join(outputDirectory, expectedFilename);
  assert.equal(
    pathExists(expectedArchivePath),
    false,
    "native package assembly refuses to replace an existing archive",
  );

  let workRoot;
  let workIdentity;
  let sentinelPath;
  let sentinelIdentity;
  let sentinel;
  let primaryError;
  let result;
  try {
    workRoot = realpathSync(
      mkdtempSync(join(isolation.temporary, "plurum-native-assemble-")),
    );
    const workMetadata = assertDirectDirectory(workRoot, "native package assembly root");
    workIdentity = Object.freeze({
      device: workMetadata.dev,
      inode: workMetadata.ino,
    });
    if (process.platform !== "win32") {
      chmodSync(workRoot, 0o700);
    }
    sentinel = `plurum-native-package-${randomUUID()}\n`;
    sentinelPath = join(workRoot, ".plurum-native-package-root");
    writeFileSync(sentinelPath, sentinel, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const sentinelMetadata = assertDirectRegularFile(
      sentinelPath,
      "native package assembly sentinel",
      256,
    );
    sentinelIdentity = Object.freeze({
      device: sentinelMetadata.dev,
      inode: sentinelMetadata.ino,
    });

    const stage = join(workRoot, "stage");
    const packedDirectory = join(workRoot, "packed");
    const repeatedPackedDirectory = join(workRoot, "packed-repeat");
    const cache = join(workRoot, "npm-cache");
    const inspection = join(workRoot, "inspection");
    mkdirSync(stage, { mode: 0o700 });
    mkdirSync(packedDirectory, { mode: 0o700 });
    mkdirSync(repeatedPackedDirectory, { mode: 0o700 });
    mkdirSync(inspection, { mode: 0o700 });
    if (process.platform !== "win32") {
      chmodSync(stage, 0o700);
      chmodSync(packedDirectory, 0o700);
      chmodSync(repeatedPackedDirectory, 0o700);
      chmodSync(inspection, 0o700);
    }

    const stagedArtifact = join(stage, "credential-store.node");
    copyFileSync(cargoBinary, stagedArtifact, fsConstants.COPYFILE_EXCL);
    if (process.platform !== "win32") {
      chmodSync(stagedArtifact, PORTABLE_PACKAGE_FILE_MODE);
    }
    const stagedMetadata = assertDirectRegularFile(
      stagedArtifact,
      "staged native artifact",
      MAX_NATIVE_ARTIFACT_BYTES,
    );
    assert.equal(stagedMetadata.size, cargoMetadata.size);
    assert.equal(sha256(readFileSync(stagedArtifact)), cargoDigest);
    assert.deepEqual(
      fileIdentity(
        assertControlledCargoArtifact(
          cargoBinary,
          isolation.cargoTarget,
          descriptor,
        ),
      ),
      cargoIdentity,
      "Cargo native artifact changed while being staged",
    );
    assert.equal(sha256(readFileSync(cargoBinary)), cargoDigest);
    const sourceLicensePath = join(packageRoot, "LICENSE");
    const sourceLicense = readStableBounded(
      sourceLicensePath,
      MAX_DOCUMENT_BYTES,
      "source package license",
    );
    writeFileSync(join(stage, "LICENSE"), sourceLicense.bytes, {
      flag: "wx",
      mode: 0o600,
    });
    const sourceLicenseAfter = readStableBounded(
      sourceLicensePath,
      MAX_DOCUMENT_BYTES,
      "source package license",
    );
    assert.deepEqual(sourceLicenseAfter.identity, sourceLicense.identity);
    assert.equal(sourceLicenseAfter.digest, sourceLicense.digest);
    assertDirectRegularFile(
      join(stage, "LICENSE"),
      "staged native package license",
      MAX_DOCUMENT_BYTES,
    );
    writeFileSync(join(stage, "README.md"), generatedReadmeBytes(target, descriptor), {
      flag: "wx",
      mode: 0o600,
    });
    writeFileSync(join(stage, "package.json"), canonicalJsonBytes(manifest), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    if (process.platform !== "win32") {
      for (const name of NATIVE_PACKAGE_INVENTORY) {
        chmodSync(join(stage, name), PORTABLE_PACKAGE_FILE_MODE);
      }
    }
    assert.deepEqual(readdirSync(stage).sort(), [...NATIVE_PACKAGE_INVENTORY]);
    for (const name of NATIVE_PACKAGE_INVENTORY) {
      const maximumBytes =
        name === "credential-store.node"
          ? MAX_NATIVE_ARTIFACT_BYTES
          : name === "package.json"
            ? MAX_PACKAGE_JSON_BYTES
            : MAX_DOCUMENT_BYTES;
      const metadata = assertDirectRegularFile(
        join(stage, name),
        `staged native package ${name}`,
        maximumBytes,
      );
      assertPortablePackageFileMode(metadata, `staged native package ${name}`);
    }

    const environment = isolatedNpmEnvironment(workRoot, cache);
    const packed = runNpm({
      npmCli,
      cwd: stage,
      environment,
      args: [
        "pack",
        "--ignore-scripts",
        "--offline",
        "--json",
        "--pack-destination",
        packedDirectory,
        "--cache",
        cache,
      ],
    });
    let packResults;
    try {
      packResults = JSON.parse(packed.stdout);
    } catch {
      throw new Error("npm pack returned invalid JSON");
    }
    assert.equal(Array.isArray(packResults), true);
    assert.equal(packResults.length, 1);
    const packedPackage = packResults[0];
    assert.equal(packedPackage.name, descriptor.name);
    assert.equal(packedPackage.version, rootMetadata.version);
    assert.deepEqual(
      packedPackage.files.map(({ path }) => path).sort(),
      [...NATIVE_PACKAGE_INVENTORY],
    );
    assert.equal(typeof packedPackage.integrity, "string");
    assert.match(packedPackage.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/u);
    assert.match(packedPackage.shasum, /^[0-9a-f]{40}$/u);
    assert.equal(packedPackage.filename, expectedFilename);
    const packedArchivePath = join(packedDirectory, expectedFilename);
    assert.equal(realpathSync(packedArchivePath), resolve(packedArchivePath));
    assertDirectRegularFile(
      packedArchivePath,
      "staged native target package archive",
      96 * 1024 * 1024,
    );
    const packedArchiveBytes = readFileSync(packedArchivePath);
    assert.equal(packedPackage.size, packedArchiveBytes.byteLength);
    assert.equal(
      packedPackage.integrity,
      `sha512-${digest(packedArchiveBytes, "sha512", "base64")}`,
    );
    assert.equal(
      packedPackage.shasum,
      digest(packedArchiveBytes, "sha1", "hex"),
    );
    const repeatedPack = runNpm({
      npmCli,
      cwd: stage,
      environment,
      args: [
        "pack",
        "--ignore-scripts",
        "--offline",
        "--json",
        "--pack-destination",
        repeatedPackedDirectory,
        "--cache",
        cache,
      ],
    });
    let repeatedPackResults;
    try {
      repeatedPackResults = JSON.parse(repeatedPack.stdout);
    } catch {
      throw new Error("repeated npm pack returned invalid JSON");
    }
    assert.deepEqual(
      repeatedPackResults,
      packResults,
      "repeated native package metadata must be deterministic",
    );
    const repeatedArchivePath = join(repeatedPackedDirectory, expectedFilename);
    assertDirectRegularFile(
      repeatedArchivePath,
      "repeated native target package archive",
      96 * 1024 * 1024,
    );
    assert.equal(
      readFileSync(repeatedArchivePath).equals(packedArchiveBytes),
      true,
      "repeated native package bytes must be deterministic",
    );

    runNpm({
      npmCli,
      cwd: workRoot,
      environment,
      args: [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--offline",
        "--prefix",
        inspection,
        "--cache",
        cache,
        packedArchivePath,
      ],
    });
    const installedPackage = realpathSync(
      join(inspection, "node_modules", "@dunelabs", `plurum-native-${target}`),
    );
    exactInstalledPackage(installedPackage, manifest, cargoDigest);
    copyFileSync(
      packedArchivePath,
      expectedArchivePath,
      fsConstants.COPYFILE_EXCL,
    );
    assert.equal(realpathSync(expectedArchivePath), resolve(expectedArchivePath));
    assertDirectRegularFile(
      expectedArchivePath,
      "native target package archive",
      96 * 1024 * 1024,
    );
    assert.equal(
      sha256(readFileSync(expectedArchivePath)),
      sha256(packedArchiveBytes),
    );
    result = Object.freeze({
      target,
      packageName: descriptor.name,
      version: rootMetadata.version,
      archivePath: realpathSync(expectedArchivePath),
      filename: expectedFilename,
      integrity: packedPackage.integrity,
      shasum: packedPackage.shasum,
      artifactSha256: cargoDigest,
      artifactBytes: cargoMetadata.size,
      manifest,
    });
  } catch (error) {
    primaryError = error;
  } finally {
    let cleanupError;
    if (workRoot !== undefined) {
      try {
        assert.ok(
          workIdentity !== undefined &&
            sentinelPath !== undefined &&
            sentinelIdentity !== undefined &&
            sentinel !== undefined,
        );
        safeRemoveOwnedRoot(
          workRoot,
          workIdentity,
          sentinelPath,
          sentinelIdentity,
          sentinel,
          isolation.temporary,
        );
      } catch (error) {
        cleanupError = error;
      }
    }
    if (primaryError !== undefined && cleanupError !== undefined) {
      throw new AggregateError(
        [primaryError, cleanupError],
        "native target package assembly and cleanup failed",
      );
    }
    if (cleanupError !== undefined) {
      throw cleanupError;
    }
  }
  if (primaryError !== undefined) {
    throw primaryError;
  }
  assert.ok(result !== undefined);
  return result;
}

async function main() {
  const assembled = assembleNativeTargetPackage();
  process.stdout.write(`${JSON.stringify(assembled)}\n`);
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(scriptPath)) {
  await main();
}
