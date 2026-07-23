import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assembleNativeTargetPackage,
  isolatedNpmEnvironment,
  nativeTargetDescriptor,
  requiredNpmCli,
  runNpm,
  verifiedNativeIsolation,
} from "./assemble-native-package.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const testsDirectory = dirname(scriptPath);
const crateRoot = dirname(testsDirectory);
const packageRoot = resolve(crateRoot, "../..");
const childPath = join(testsDirectory, "verify-packaged-native-child.mjs");
const loaderPath = join(testsDirectory, "verify-packaged-native-loader.mjs");
const MAX_PACKAGE_JSON_BYTES = 64 * 1024;
const MAX_ARCHIVE_BYTES = 96 * 1024 * 1024;
const MAX_SNAPSHOT_ENTRIES = 50_000;
const MAX_SNAPSHOT_FILE_BYTES = 128 * 1024 * 1024;
const MAX_SNAPSHOT_TOTAL_BYTES = 512 * 1024 * 1024;
const ROOT_PREFIX = "plurum-native-package-verify-";
const OUTSIDE_PREFIX = "plurum-native-package-outside-";

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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function digest(bytes, algorithm, encoding) {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function directDirectory(path, label) {
  const metadata = lstatSync(path);
  assert.equal(metadata.isSymbolicLink(), false, `${label} must not be a symlink`);
  assert.equal(metadata.isDirectory(), true, `${label} must be a directory`);
  assert.equal(realpathSync(path), resolve(path), `${label} must be direct`);
  if (process.platform !== "win32") {
    assert.equal(metadata.uid, process.getuid?.(), `${label} must be user-owned`);
  }
  return metadata;
}

function directRegularFile(path, label, maxBytes) {
  const metadata = lstatSync(path);
  assert.equal(metadata.isSymbolicLink(), false, `${label} must not be a symlink`);
  assert.equal(metadata.isFile(), true, `${label} must be a regular file`);
  assert.equal(metadata.nlink, 1, `${label} must have one link`);
  assert.equal(metadata.size > 0 && metadata.size <= maxBytes, true);
  assert.equal(realpathSync(path), resolve(path), `${label} must be direct`);
  if (process.platform !== "win32") {
    assert.equal(metadata.uid, process.getuid?.(), `${label} must be user-owned`);
  }
  return metadata;
}

function identity(metadata) {
  return Object.freeze({ device: metadata.dev, inode: metadata.ino });
}

function readJson(path, label) {
  const metadata = directRegularFile(path, label, MAX_PACKAGE_JSON_BYTES);
  const bytes = readFileSync(path);
  assert.equal(bytes.byteLength, metadata.size);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value;
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

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = directDirectory(path, "private verification directory");
  if (process.platform !== "win32") {
    if ((metadata.mode & 0o777) !== 0o700) {
      chmodSync(path, 0o700);
    }
    assert.equal(metadata.uid, process.getuid?.());
  }
  return realpathSync(path);
}

function createOwnedRoot(temporary, prefix, sentinelName) {
  const root = realpathSync(mkdtempSync(join(temporary, prefix)));
  assert.equal(isStrictDescendant(temporary, root), true);
  if (process.platform !== "win32") {
    chmodSync(root, 0o700);
  }
  const rootMetadata = directDirectory(root, "owned package verification root");
  if (process.platform !== "win32") {
    assert.equal(rootMetadata.mode & 0o077, 0);
  }
  const sentinel = `${prefix}${randomUUID()}\n`;
  const sentinelPath = join(root, sentinelName);
  writeFileSync(sentinelPath, sentinel, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const sentinelMetadata = directRegularFile(
    sentinelPath,
    "owned package verification sentinel",
    256,
  );
  if (process.platform !== "win32") {
    assert.equal(sentinelMetadata.mode & 0o077, 0);
  }
  return Object.freeze({
    root,
    prefix,
    rootIdentity: identity(rootMetadata),
    sentinel,
    sentinelPath,
    sentinelIdentity: identity(sentinelMetadata),
  });
}

function snapshotOwnedTree(root) {
  const canonicalRoot = realpathSync(root);
  assert.equal(canonicalRoot, resolve(root));
  const entries = [];
  let totalBytes = 0;
  const visit = (path, displayPath) => {
    assert.equal(entries.length < MAX_SNAPSHOT_ENTRIES, true);
    const metadata = lstatSync(path);
    if (process.platform !== "win32") {
      assert.equal(metadata.uid, process.getuid?.(), "snapshot entry must be user-owned");
    }
    if (metadata.isSymbolicLink()) {
      const target = readlinkSync(path);
      const resolvedTarget = realpathSync(path);
      assert.equal(
        isWithin(canonicalRoot, resolvedTarget),
        true,
        "snapshot symlink must stay within its owned root",
      );
      entries.push(Object.freeze({
        path: displayPath,
        kind: "symbolic-link",
        target,
        resolvedTarget: relative(canonicalRoot, resolvedTarget),
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
      assert.equal(realpathSync(path), resolve(path));
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
    assert.equal(metadata.isFile(), true, "snapshot entry must be a file or directory");
    assert.equal(metadata.nlink, 1, "snapshot file must have one link");
    assert.equal(metadata.size <= MAX_SNAPSHOT_FILE_BYTES, true);
    totalBytes += metadata.size;
    assert.equal(totalBytes <= MAX_SNAPSHOT_TOTAL_BYTES, true);
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
  visit(canonicalRoot, ".");
  return Object.freeze(entries);
}

function safelyRemoveOwnedRoot(owned, temporary, baseline) {
  assert.equal(realpathSync(owned.root), owned.root);
  assert.equal(isStrictDescendant(temporary, owned.root), true);
  assert.equal(owned.root.startsWith(`${temporary}${sep}${owned.prefix}`), true);
  assert.deepEqual(
    identity(directDirectory(owned.root, "owned package verification root")),
    owned.rootIdentity,
  );
  const sentinelMetadata = directRegularFile(
    owned.sentinelPath,
    "owned package verification sentinel",
    256,
  );
  assert.deepEqual(identity(sentinelMetadata), owned.sentinelIdentity);
  assert.equal(readFileSync(owned.sentinelPath, "utf8"), owned.sentinel);
  if (process.platform !== "win32") {
    assert.equal(sentinelMetadata.mode & 0o077, 0);
  }
  assert.deepEqual(snapshotOwnedTree(owned.root), baseline);
  rmSync(owned.root, { recursive: true, force: false });
  assert.equal(existsSync(owned.root), false);
}

function parsePackResult(result, label) {
  let values;
  try {
    values = JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  assert.equal(Array.isArray(values), true);
  assert.equal(values.length, 1);
  const value = values[0];
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  assert.equal(Array.isArray(value.files), true);
  assert.equal(value.files.length > 0 && value.files.length < 2_000, true);
  return value;
}

function assertRootPackInventory(packResult) {
  const paths = packResult.files.map((entry) => entry.path);
  assert.equal(new Set(paths).size, paths.length);
  for (const path of paths) {
    assert.equal(typeof path, "string");
    assert.equal(
      path.length > 0 &&
        path.length <= 512 &&
        !path.startsWith("/") &&
        !path.includes("\\") &&
        !path.split("/").includes(".."),
      true,
    );
    assert.equal(path.endsWith(".node"), false, "root tarball must not embed an addon");
    assert.equal(path.startsWith("node_modules/"), false);
  }
  for (const required of [
    "LICENSE",
    "README.md",
    "package.json",
    "dist/adapters/node/native-codex-dotenv.js",
    "dist/adapters/node/native-credential-package.js",
    "dist/adapters/node/native-credential-store.js",
    "dist/credentials/codex-dotenv-contracts.js",
    "dist/credentials/codex-dotenv.js",
    "dist/credentials/errors.js",
    "dist/credentials/origin.js",
    "dist/credentials/schema.js",
    "dist/data/uint8-array.js",
    "dist/system/runtime-support.js",
    "dist/version.js",
  ]) {
    assert.equal(paths.includes(required), true, `root tarball is missing ${required}`);
  }
}

function targetCandidates(installedRoot, target) {
  const leaf = `plurum-native-${target}`;
  return Object.freeze([
    join(installedRoot, "node_modules", "@dunelabs", leaf),
    join(dirname(installedRoot), "@dunelabs", leaf),
  ]);
}

function assertNoNativeArtifact(root) {
  const pending = [root];
  let entries = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    assert.ok(directory !== undefined);
    for (const name of readdirSync(directory)) {
      entries += 1;
      assert.equal(entries <= MAX_SNAPSHOT_ENTRIES, true);
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) {
        continue;
      }
      if (metadata.isDirectory()) {
        pending.push(path);
      } else {
        assert.equal(metadata.isFile(), true);
        assert.equal(name.endsWith(".node"), false, "unexpected native addon was installed");
      }
    }
  }
}

function installScenario({
  verificationRoot,
  neutralDirectory,
  npmCli,
  rootArchive,
  nativeArchive,
  target,
  mode,
}) {
  const prefix = ensurePrivateDirectory(join(verificationRoot, "installs", mode));
  const operationRoot = join(verificationRoot, "npm", `install-${mode}`);
  const cache = join(operationRoot, "cache");
  const environment = isolatedNpmEnvironment(operationRoot, cache);
  const archives =
    mode === "available" ? [rootArchive, nativeArchive] : [rootArchive];
  const result = runNpm({
    npmCli,
    cwd: neutralDirectory,
    environment,
    args: [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-save",
      "--package-lock=false",
      "--install-strategy=hoisted",
      "--offline",
      ...(mode === "omit" ? ["--omit=optional"] : []),
      "--prefix",
      prefix,
      "--cache",
      cache,
      ...archives,
    ],
  });
  assert.equal(result.signal, null);
  const installedRoot = realpathSync(join(prefix, "node_modules", "plurum"));
  directDirectory(installedRoot, `installed Plurum package (${mode})`);
  assert.deepEqual(readdirSync(installedRoot).sort(), [
    "LICENSE",
    "README.md",
    "dist",
    "package.json",
  ]);
  const candidates = targetCandidates(installedRoot, target);
  const present = candidates.filter(pathExists);
  if (mode === "available") {
    assert.equal(present.length, 1);
    return Object.freeze({
      mode,
      prefix,
      installedRoot,
      installedTarget: realpathSync(present[0]),
    });
  }
  assert.deepEqual(present, []);
  assertNoNativeArtifact(join(prefix, "node_modules"));
  return Object.freeze({ mode, prefix, installedRoot });
}

function permissionModelFlag() {
  if (process.allowedNodeEnvironmentFlags.has("--permission")) {
    return "--permission";
  }
  if (process.allowedNodeEnvironmentFlags.has("--experimental-permission")) {
    return "--experimental-permission";
  }
  throw new Error("runtime does not expose a supported permission model flag");
}

function childEnvironment(
  verificationRoot,
  scenario,
  target,
  expectedNode,
  nativePackage,
  cachePolicy = "normal",
) {
  assert.equal(["normal", "preloaded"].includes(cachePolicy), true);
  if (cachePolicy === "preloaded") {
    assert.equal(scenario.mode, "available");
  }
  const runtimeRoot = ensurePrivateDirectory(
    join(verificationRoot, "runtime", `${scenario.mode}-${cachePolicy}`),
  );
  const home = ensurePrivateDirectory(join(runtimeRoot, "home"));
  const config = ensurePrivateDirectory(join(runtimeRoot, "config"));
  const state = ensurePrivateDirectory(join(runtimeRoot, "state"));
  const cache = ensurePrivateDirectory(join(runtimeRoot, "cache"));
  const temporary = ensurePrivateDirectory(join(runtimeRoot, "tmp"));
  const appdata = ensurePrivateDirectory(join(config, "appdata"));
  const localappdata = ensurePrivateDirectory(join(config, "localappdata"));
  const plurumHome = ensurePrivateDirectory(join(config, "plurum"));
  const codexHome = ensurePrivateDirectory(join(config, "codex"));
  const claudeConfig = ensurePrivateDirectory(join(config, "claude"));
  const encodedManifest = Buffer.from(
    JSON.stringify(nativePackage.manifest),
    "utf8",
  ).toString("base64url");
  assert.equal(encodedManifest.length > 0 && encodedManifest.length <= 32 * 1024, true);
  const environment = {
    PATH: [
      dirname(process.execPath),
      ...(process.platform === "win32"
        ? [join(requiredEnvironment("SystemRoot"), "System32")]
        : []),
    ].join(delimiter),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: state,
    XDG_CACHE_HOME: cache,
    APPDATA: appdata,
    LOCALAPPDATA: localappdata,
    PLURUM_HOME: plurumHome,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeConfig,
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    CI: "true",
    NO_COLOR: "1",
    NODE_NO_WARNINGS: "1",
    PLURUM_NATIVE_VERIFY_ROOT: verificationRoot,
    PLURUM_NATIVE_VERIFY_INSTALLED_ROOT: scenario.installedRoot,
    PLURUM_VERIFY_INSTALLED_ROOT: scenario.installedRoot,
    PLURUM_NATIVE_VERIFY_MODE: scenario.mode,
    PLURUM_NATIVE_VERIFY_CACHE_POLICY: cachePolicy,
    PLURUM_NATIVE_EXPECTED_TARGET: target,
    PLURUM_NATIVE_EXPECTED_NODE: expectedNode,
    PLURUM_NATIVE_EXPECTED_SHA256: nativePackage.artifactSha256,
    PLURUM_NATIVE_VERIFY_MANIFEST: encodedManifest,
    ...(scenario.installedTarget === undefined
      ? {}
      : { PLURUM_NATIVE_VERIFY_INSTALLED_TARGET: scenario.installedTarget }),
  };
  for (const name of ["ComSpec", "PATHEXT", "SystemRoot", "WINDIR"]) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return Object.freeze(environment);
}

function runChildVerifier(
  verificationRoot,
  neutralDirectory,
  scenario,
  target,
  expectedNode,
  nativePackage,
  cachePolicy = "normal",
) {
  const loaderUrl = pathToFileURL(loaderPath);
  assert.equal(fileURLToPath(loaderUrl), loaderPath);
  const result = spawnSync(
    process.execPath,
    [
      "--frozen-intrinsics",
      "--disallow-code-generation-from-strings",
      permissionModelFlag(),
      ...(scenario.mode === "available" && cachePolicy === "normal"
        ? ["--allow-addons"]
        : []),
      "--allow-worker",
      `--allow-fs-read=${testsDirectory}`,
      `--allow-fs-read=${verificationRoot}`,
      "--experimental-loader",
      loaderUrl.href,
      childPath,
    ],
    {
      cwd: neutralDirectory,
      env: childEnvironment(
        verificationRoot,
        scenario,
        target,
        expectedNode,
        nativePackage,
        cachePolicy,
      ),
      encoding: "utf8",
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      shell: false,
      timeout: 120_000,
    },
  );
  assert.equal(result.error, undefined, `native ${scenario.mode} verifier must start`);
  assert.equal(result.signal, null, `native ${scenario.mode} verifier was interrupted`);
  assert.equal(
    result.status,
    0,
    `native ${scenario.mode} verifier failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.equal(
    result.stdout,
    `packaged native provider verified (${scenario.mode}/${cachePolicy})\n`,
  );
  assert.equal(result.stderr, "");
}

const isolation = verifiedNativeIsolation();
const target = requiredEnvironment("PLURUM_NATIVE_EXPECTED_TARGET");
nativeTargetDescriptor(target);
const expectedNode = requiredEnvironment("PLURUM_NATIVE_EXPECTED_NODE");
assert.equal(process.versions.node, expectedNode);
const npmCli = requiredNpmCli();
directRegularFile(childPath, "packaged native child verifier", 2 * 1024 * 1024);
directRegularFile(loaderPath, "packaged native verifier loader", 2 * 1024 * 1024);

let verificationOwned;
let outsideOwned;
let primaryError;
const cleanupErrors = [];
try {
  verificationOwned = createOwnedRoot(
    isolation.temporary,
    ROOT_PREFIX,
    ".plurum-native-package-verification",
  );
  outsideOwned = createOwnedRoot(
    isolation.temporary,
    OUTSIDE_PREFIX,
    ".plurum-native-package-outside",
  );
  const verificationRoot = verificationOwned.root;
  const neutralDirectory = ensurePrivateDirectory(join(verificationRoot, "neutral"));
  const nativeArtifacts = ensurePrivateDirectory(
    join(verificationRoot, "artifacts", "native"),
  );
  const rootArtifacts = ensurePrivateDirectory(
    join(verificationRoot, "artifacts", "root"),
  );

  const nativePackage = assembleNativeTargetPackage({
    target,
    npmCli,
    outputDirectory: nativeArtifacts,
  });
  assert.equal(isStrictDescendant(verificationRoot, nativePackage.archivePath), true);

  const rootMetadata = readJson(join(packageRoot, "package.json"), "root package metadata");
  assert.equal(rootMetadata.name, "plurum");
  assert.equal(rootMetadata.version, nativePackage.version);
  const rootFilename = `plurum-${rootMetadata.version}.tgz`;
  const rootArchive = join(rootArtifacts, rootFilename);
  assert.equal(pathExists(rootArchive), false);
  const rootPackOperation = join(verificationRoot, "npm", "root-pack");
  const rootPackCache = join(rootPackOperation, "cache");
  const rootPack = runNpm({
    npmCli,
    cwd: packageRoot,
    environment: isolatedNpmEnvironment(rootPackOperation, rootPackCache),
    args: [
      "pack",
      "--ignore-scripts",
      "--offline",
      "--json",
      "--pack-destination",
      rootArtifacts,
      "--cache",
      rootPackCache,
    ],
  });
  const rootPackResult = parsePackResult(rootPack, "root npm pack");
  assert.equal(rootPackResult.name, "plurum");
  assert.equal(rootPackResult.version, rootMetadata.version);
  assert.equal(rootPackResult.filename, rootFilename);
  assertRootPackInventory(rootPackResult);
  directRegularFile(rootArchive, "root package archive", MAX_ARCHIVE_BYTES);
  const rootArchiveBytes = readFileSync(rootArchive);
  assert.equal(rootPackResult.size, rootArchiveBytes.byteLength);
  assert.equal(
    rootPackResult.integrity,
    `sha512-${digest(rootArchiveBytes, "sha512", "base64")}`,
  );
  assert.equal(rootPackResult.shasum, digest(rootArchiveBytes, "sha1", "hex"));

  const scenarios = ["available", "missing", "omit"].map((mode) =>
    installScenario({
      verificationRoot,
      neutralDirectory,
      npmCli,
      rootArchive: realpathSync(rootArchive),
      nativeArchive: nativePackage.archivePath,
      target,
      mode,
    }),
  );
  const available = scenarios[0];
  assert.ok(available?.installedTarget !== undefined);
  assert.deepEqual(
    readdirSync(available.installedTarget).sort(),
    ["LICENSE", "README.md", "credential-store.node", "package.json"],
  );
  const installedNativeMetadata = readJson(
    join(available.installedTarget, "package.json"),
    "co-installed native package metadata",
  );
  assert.deepEqual(installedNativeMetadata, nativePackage.manifest);
  const installedArtifact = join(available.installedTarget, "credential-store.node");
  const installedArtifactMetadata = directRegularFile(
    installedArtifact,
    "co-installed native addon",
    MAX_ARCHIVE_BYTES,
  );
  assert.equal(installedArtifactMetadata.size, nativePackage.artifactBytes);
  assert.equal(sha256(readFileSync(installedArtifact)), nativePackage.artifactSha256);

  for (const scenario of scenarios) {
    childEnvironment(
      verificationRoot,
      scenario,
      target,
      expectedNode,
      nativePackage,
      "normal",
    );
  }
  childEnvironment(
    verificationRoot,
    available,
    target,
    expectedNode,
    nativePackage,
    "preloaded",
  );
  const protectedBefore = snapshotOwnedTree(verificationRoot);
  const outsideBefore = snapshotOwnedTree(outsideOwned.root);
  for (const scenario of scenarios) {
    runChildVerifier(
      verificationRoot,
      neutralDirectory,
      scenario,
      target,
      expectedNode,
      nativePackage,
      "normal",
    );
  }
  runChildVerifier(
    verificationRoot,
    neutralDirectory,
    available,
    target,
    expectedNode,
    nativePackage,
    "preloaded",
  );
  assert.deepEqual(
    snapshotOwnedTree(verificationRoot),
    protectedBefore,
    "packaged native resolver changed its protected verification tree",
  );
  assert.deepEqual(
    snapshotOwnedTree(outsideOwned.root),
    outsideBefore,
    "packaged native resolver changed the outside canary tree",
  );
} catch (error) {
  primaryError = error;
} finally {
  for (const owned of [verificationOwned, outsideOwned]) {
    if (owned === undefined || !existsSync(owned.root)) {
      continue;
    }
    try {
      const baseline = snapshotOwnedTree(owned.root);
      safelyRemoveOwnedRoot(owned, isolation.temporary, baseline);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
}

if (primaryError !== undefined) {
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      "packaged native verification and cleanup failed",
    );
  }
  throw primaryError;
}
if (cleanupErrors.length > 0) {
  throw new AggregateError(cleanupErrors, "packaged native cleanup failed");
}
process.stdout.write(`packaged native artifact verified (${target}, Node ${expectedNode})\n`);
