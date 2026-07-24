import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const crateRoot = dirname(dirname(scriptPath));
const packageRoot = resolve(crateRoot, "../..");
const isolationMarker = "plurum-native-isolation-v1\n";
const MAX_CLEANUP_DEPTH = 16;
const MAX_CLEANUP_ENTRIES = 512;
const MAX_CLEANUP_FILE_BYTES = 96 * 1024 * 1024;
const MAX_CLEANUP_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_SENTINEL_BYTES = 256;
const parentFaultPoints = new Set([
  "after-lifecycle-authority",
  "after-outside-authority",
  "after-outside-snapshot",
]);
const expectedExportKeys = Object.freeze([
  "abiVersion",
  "createAdapters",
  "magic",
  "nodeApiVersion",
  "packageVersion",
  "target",
]);
const rustHostTargets = Object.freeze({
  "aarch64-apple-darwin": "darwin-arm64",
  "x86_64-apple-darwin": "darwin-x64",
  "aarch64-unknown-linux-gnu": "linux-arm64-gnu",
  "aarch64-unknown-linux-musl": "linux-arm64-musl",
  "x86_64-unknown-linux-gnu": "linux-x64-gnu",
  "x86_64-unknown-linux-musl": "linux-x64-musl",
  "aarch64-pc-windows-msvc": "win32-arm64-msvc",
  "x86_64-pc-windows-msvc": "win32-x64-msvc",
});
const runtimeTargets = new Set([
  `${process.platform}-${process.arch}`,
  process.platform === "darwin" ? `darwin-${process.arch}` : "",
  process.platform === "win32" ? `win32-${process.arch}` : "",
]);

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.ok(value, `${name} must be set`);
  assert.equal(/[\r\n\0]/u.test(value), false, `${name} must be one safe line`);
  return value;
}

class InjectedParentFault extends Error {
  constructor(point) {
    super(`native ABI injected fault: ${point}`);
    this.name = "InjectedParentFault";
    this.point = point;
  }
}

function injectParentFault(point, requested) {
  if (requested === undefined) {
    return;
  }
  assert.equal(
    parentFaultPoints.has(requested),
    true,
    "native ABI fault point is invalid",
  );
  if (requested === point) {
    throw new InjectedParentFault(point);
  }
}

function verifiedIsolationRoot() {
  const configured = requiredEnvironment("PLURUM_NATIVE_ISOLATION_ROOT");
  assert.equal(isAbsolute(configured), true, "isolation root must be absolute");
  exactObjectIdentity(configured, "directory", "native isolation root");
  const root = realpathSync(configured);
  const markerPath = join(root, ".plurum-native-isolation");
  const marker = readBoundedDigest(
    markerPath,
    MAX_SENTINEL_BYTES,
    "native isolation marker",
  );
  const expectedMarker = Buffer.from(isolationMarker, "utf8");
  assert.equal(
    marker.size === expectedMarker.byteLength &&
      marker.digest === sha256(expectedMarker),
    true,
    "native isolation marker content changed",
  );
  exactObjectIdentity(
    join(root, "tmp"),
    "directory",
    "native isolation temporary directory",
  );
  return root;
}

function isolatedDirectory(root, environmentName, childName) {
  const configured = requiredEnvironment(environmentName);
  exactObjectIdentity(
    configured,
    "directory",
    `${environmentName} isolated directory`,
  );
  assert.equal(realpathSync(configured), resolve(join(root, childName)));
  return realpathSync(configured);
}

function regularFileFromEnvironment(name) {
  const path = requiredEnvironment(name);
  return regularFileFromPath(path, name);
}

function regularFileFromPath(path, label) {
  assert.equal(isAbsolute(path), true, `${label} must be absolute`);
  const metadata = lstatSync(path, { bigint: true });
  assert.equal(
    metadata.isSymbolicLink(),
    false,
    `${label} must not be a symlink`,
  );
  assert.equal(metadata.isFile(), true, `${label} must be a regular file`);
  return realpathSync(path);
}

function pathExists(path) {
  try {
    lstatSync(path, { bigint: true });
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

function isStrictDescendant(parent, candidate) {
  const difference = relative(parent, candidate);
  return (
    difference !== "" &&
    difference !== ".." &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference)
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function objectIdentity(metadata) {
  return Object.freeze({
    device: metadata.dev,
    inode: metadata.ino,
  });
}

function privateMode(kind) {
  return kind === "directory" ? 0o700n : 0o600n;
}

function securityEvidence(metadata) {
  return Object.freeze({
    mode: metadata.mode,
    owner: metadata.uid,
    group: metadata.gid,
    deviceType: metadata.rdev,
  });
}

function stableObjectEvidence(metadata) {
  return Object.freeze({
    ...objectIdentity(metadata),
    ...securityEvidence(metadata),
    links: metadata.nlink,
    size: metadata.size,
    blockSize: metadata.blksize,
    blocks: metadata.blocks,
    modified: metadata.mtimeNs,
    changed: metadata.ctimeNs,
    created: metadata.birthtimeNs,
  });
}

function exactObjectIdentity(path, kind, label) {
  const metadata = lstatSync(path, { bigint: true });
  assert.equal(metadata.isSymbolicLink(), false, `${label} must not be a link`);
  assert.equal(
    kind === "directory" ? metadata.isDirectory() : metadata.isFile(),
    true,
    `${label} must be a ${kind}`,
  );
  if (kind === "file") {
    assert.equal(metadata.nlink, 1n, `${label} must have one link`);
  }
  if (process.platform !== "win32") {
    assert.equal(
      metadata.uid,
      BigInt(process.getuid?.()),
      `${label} must be user-owned`,
    );
    assert.equal(
      metadata.mode & 0o7777n,
      privateMode(kind),
      `${label} must have its exact private mode without special bits`,
    );
  }
  assert.equal(
    realpathSync(path),
    resolve(path),
    `${label} must not traverse a link or reparse-like object`,
  );
  return Object.freeze({ identity: objectIdentity(metadata), metadata });
}

function assertOriginalIdentity(path, kind, expected, label) {
  const { identity, metadata } = exactObjectIdentity(path, kind, label);
  assert.deepEqual(identity, expected, `${label} identity changed`);
  return metadata;
}

function assertOriginalSecurity(metadata, expected, label) {
  assert.deepEqual(
    securityEvidence(metadata),
    expected,
    `${label} security metadata changed`,
  );
}

function pathDescriptorEvidence(evidence) {
  return Object.freeze({
    device: evidence.device,
    inode: evidence.inode,
    owner: evidence.owner,
    mode: evidence.mode,
    links: evidence.links,
    size: evidence.size,
    modified: evidence.modified,
    changed: evidence.changed,
  });
}

function assertPathAndDescriptorIdentity(pathIdentity, descriptorIdentity, label) {
  const comparablePath = pathDescriptorEvidence(pathIdentity);
  const comparableDescriptor = pathDescriptorEvidence(descriptorIdentity);
  if (process.platform === "win32") {
    const { device: _pathDevice, ...pathWithoutDevice } = comparablePath;
    const {
      device: _descriptorDevice,
      ...descriptorWithoutDevice
    } = comparableDescriptor;
    assert.deepEqual(
      pathWithoutDevice,
      descriptorWithoutDevice,
      `${label} path and descriptor identities differ`,
    );
    return;
  }
  assert.deepEqual(
    comparablePath,
    comparableDescriptor,
    `${label} path and descriptor identities differ`,
  );
}

function readBoundedDigest(path, maximumBytes, label) {
  const before = exactObjectIdentity(path, "file", label).metadata;
  assert.equal(
    before.size <= BigInt(maximumBytes),
    true,
    `${label} exceeded its byte limit`,
  );
  const beforeIdentity = stableObjectEvidence(before);
  const descriptor = openSync(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const openedBefore = fstatSync(descriptor, { bigint: true });
    assert.equal(openedBefore.isFile(), true, `${label} must stay a file`);
    assert.equal(openedBefore.nlink, 1n, `${label} must retain one link`);
    if (process.platform !== "win32") {
      assert.equal(
        openedBefore.uid,
        BigInt(process.getuid?.()),
        `${label} must stay user-owned`,
      );
      assert.equal(
        openedBefore.mode & 0o7777n,
        0o600n,
        `${label} must retain exact 0600 mode without special bits`,
      );
    }
    assert.equal(
      openedBefore.size <= BigInt(maximumBytes),
      true,
      `${label} exceeded its byte limit after opening`,
    );
    const openedBeforeIdentity = stableObjectEvidence(openedBefore);
    assertPathAndDescriptorIdentity(beforeIdentity, openedBeforeIdentity, label);

    const bytes = Buffer.alloc(Number(openedBefore.size));
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
      `${label} grew while reading`,
    );
    assert.deepEqual(
      stableObjectEvidence(fstatSync(descriptor, { bigint: true })),
      openedBeforeIdentity,
      `${label} descriptor changed while reading`,
    );
    const after = exactObjectIdentity(path, "file", label).metadata;
    assertPathAndDescriptorIdentity(
      stableObjectEvidence(after),
      openedBeforeIdentity,
      label,
    );
    return Object.freeze({
      identity: objectIdentity(after),
      evidence: stableObjectEvidence(after),
      size: bytes.byteLength,
      digest: sha256(bytes),
    });
  } finally {
    closeSync(descriptor);
  }
}

function boundedDigestTree(root) {
  const entries = [];
  let totalBytes = 0;

  const visit = (path, displayPath, depth) => {
    assert.equal(
      depth <= MAX_CLEANUP_DEPTH,
      true,
      "cleanup tree exceeded its depth limit",
    );
    assert.equal(
      entries.length < MAX_CLEANUP_ENTRIES,
      true,
      "cleanup tree exceeded its entry limit",
    );
    const before = lstatSync(path, { bigint: true });
    assert.equal(
      before.isSymbolicLink(),
      false,
      "cleanup refuses symbolic links and junctions",
    );
    if (process.platform !== "win32") {
      assert.equal(
        before.uid,
        BigInt(process.getuid?.()),
        "cleanup entry must be user-owned",
      );
      assert.equal(
        before.mode & 0o7777n,
        before.isDirectory() ? 0o700n : 0o600n,
        "cleanup entry must have its exact private mode without special bits",
      );
    }
    assert.equal(
      realpathSync(path),
      resolve(path),
      "cleanup refuses link or reparse-like traversal",
    );

    if (before.isDirectory()) {
      const names = readdirSync(path).sort();
      entries.push(
        Object.freeze({
          path: displayPath,
          kind: "directory",
          identity: objectIdentity(before),
          evidence: stableObjectEvidence(before),
        }),
      );
      for (const name of names) {
        visit(join(path, name), `${displayPath}/${name}`, depth + 1);
      }
      const after = lstatSync(path, { bigint: true });
      assert.equal(after.isDirectory(), true, "cleanup directory changed kind");
      assert.equal(after.isSymbolicLink(), false, "cleanup directory became a link");
      assert.deepEqual(
        stableObjectEvidence(after),
        stableObjectEvidence(before),
        "cleanup directory evidence changed during inspection",
      );
      assert.deepEqual(
        readdirSync(path).sort(),
        names,
        "cleanup directory entries changed during inspection",
      );
      return;
    }

    assert.equal(
      before.isFile(),
      true,
      "cleanup refuses sockets, devices, and other special objects",
    );
    assert.equal(before.nlink, 1n, "cleanup refuses multiply-linked files");
    const digested = readBoundedDigest(
      path,
      MAX_CLEANUP_FILE_BYTES,
      "cleanup file",
    );
    totalBytes += digested.size;
    assert.equal(
      totalBytes <= MAX_CLEANUP_TOTAL_BYTES,
      true,
      "cleanup tree exceeded its total byte limit",
    );
    entries.push(
      Object.freeze({
        path: displayPath,
        kind: "file",
        identity: digested.identity,
        evidence: digested.evidence,
        size: digested.size,
        digest: digested.digest,
      }),
    );
  };

  visit(root, ".", 0);
  return Object.freeze(entries);
}

function assertExactBoundedFile(
  path,
  authority,
  expectedContent,
  label,
) {
  const metadata = assertOriginalIdentity(
    path,
    "file",
    authority.identity,
    label,
  );
  assert.equal(
    metadata.size <= BigInt(MAX_SENTINEL_BYTES),
    true,
    `${label} exceeded its byte limit`,
  );
  const expectedBytes = Buffer.from(expectedContent, "utf8");
  const actual = readBoundedDigest(path, MAX_SENTINEL_BYTES, label);
  assert.deepEqual(
    actual.evidence,
    authority.evidence,
    `${label} stable evidence changed`,
  );
  assert.equal(
    actual.size === expectedBytes.byteLength &&
      actual.digest === sha256(expectedBytes),
    true,
    `${label} content changed`,
  );
}

function assertExactStagedAddon(path, authority, label) {
  const metadata = assertOriginalIdentity(
    path,
    "file",
    authority.identity,
    label,
  );
  assertOriginalSecurity(metadata, authority.security, label);
  const actual = readBoundedDigest(path, MAX_CLEANUP_FILE_BYTES, label);
  assert.deepEqual(
    actual.evidence,
    authority.evidence,
    `${label} stable evidence changed`,
  );
  assert.equal(actual.size, authority.size, `${label} size changed`);
  assert.equal(actual.digest, authority.digest, `${label} content changed`);
}

function assertTreeReboundAfterSameParentRename(before, after, label) {
  const normalizedBefore = before.map((entry) => {
    if (entry.path !== "." || entry.kind !== "directory") {
      return entry;
    }
    const {
      evidence: { changed: _changed, ...stableEvidence },
      ...stableEntry
    } = entry;
    return Object.freeze({
      ...stableEntry,
      evidence: Object.freeze(stableEvidence),
    });
  });
  const normalizedAfter = after.map((entry) => {
    if (entry.path !== "." || entry.kind !== "directory") {
      return entry;
    }
    const {
      evidence: { changed: _changed, ...stableEvidence },
      ...stableEntry
    } = entry;
    return Object.freeze({
      ...stableEntry,
      evidence: Object.freeze(stableEvidence),
    });
  });
  assert.deepEqual(
    normalizedAfter,
    normalizedBefore,
    `${label} tree failed to rebind after quarantine`,
  );
}

function safeRemoveOwnedRoot({
  root,
  rootAuthority,
  sentinelPath,
  sentinelAuthority,
  sentinelContent,
  trustedTemporaryBase,
  prefix,
  label,
  expectedTree,
}) {
  assert.equal(
    isStrictDescendant(trustedTemporaryBase, root),
    true,
    `${label} must stay beneath the isolated temporary directory`,
  );
  assert.equal(
    dirname(root),
    trustedTemporaryBase,
    `${label} must be a direct child of the isolated temporary directory`,
  );
  assert.equal(
    root.startsWith(join(trustedTemporaryBase, prefix)),
    true,
    `${label} must retain its fixed prefix`,
  );
  const currentRoot = assertOriginalIdentity(
    root,
    "directory",
    rootAuthority.identity,
    label,
  );
  assertOriginalSecurity(currentRoot, rootAuthority.security, label);
  assert.equal(dirname(sentinelPath), root, `${label} sentinel must stay direct`);
  assertExactBoundedFile(
    sentinelPath,
    sentinelAuthority,
    sentinelContent,
    `${label} sentinel`,
  );
  const inspected = boundedDigestTree(root);
  if (expectedTree !== undefined) {
    assert.deepEqual(inspected, expectedTree, `${label} tree changed`);
  }
  const checkedRoot = assertOriginalIdentity(
    root,
    "directory",
    rootAuthority.identity,
    label,
  );
  assertOriginalSecurity(checkedRoot, rootAuthority.security, label);
  assertExactBoundedFile(
    sentinelPath,
    sentinelAuthority,
    sentinelContent,
    `${label} sentinel`,
  );
  assert.deepEqual(
    boundedDigestTree(root),
    inspected,
    `${label} changed between cleanup checks`,
  );

  /*
   * Node cannot bind recursive deletion to a directory descriptor. First move
   * the fully attested tree to a fresh, unpredictable same-parent quarantine,
   * then rebind every identity/security/content fact there. The parent is
   * private and this test treats another process running as the same OS user
   * as already trusted. On Windows this is deliberately only same-runner,
   * Node-visible hygiene: owner/DACL/integrity proof and authority-bound
   * deletion remain a separate native gate.
   */
  if (process.platform === "win32") {
    assert.equal(
      process.env.CI,
      "true",
      "Windows Node-visible cleanup is restricted to the isolated CI runner",
    );
    assert.equal(
      process.env.GITHUB_ACTIONS,
      "true",
      "Windows native cleanup authority remains pending outside CI",
    );
  }
  const quarantine = join(
    trustedTemporaryBase,
    `.plurum-native-abi-quarantine-${randomUUID()}`,
  );
  assert.equal(pathExists(quarantine), false, `${label} quarantine must be fresh`);
  renameSync(root, quarantine);
  assert.equal(pathExists(root), false, `${label} quarantine did not detach`);

  const quarantinedSentinel = join(quarantine, basename(sentinelPath));
  const reboundRoot = assertOriginalIdentity(
    quarantine,
    "directory",
    rootAuthority.identity,
    `${label} quarantine`,
  );
  assertOriginalSecurity(
    reboundRoot,
    rootAuthority.security,
    `${label} quarantine`,
  );
  assertExactBoundedFile(
    quarantinedSentinel,
    sentinelAuthority,
    sentinelContent,
    `${label} quarantined sentinel`,
  );
  const reboundTree = boundedDigestTree(quarantine);
  assertTreeReboundAfterSameParentRename(inspected, reboundTree, label);
  assertTreeReboundAfterSameParentRename(
    reboundTree,
    boundedDigestTree(quarantine),
    label,
  );

  if (process.platform === "win32") {
    /*
     * Holding a Node directory descriptor can deny recursive removal on
     * Windows. The unpredictable quarantine under the isolated runner's
     * private parent is the strongest non-native binding claimed here.
     */
    rmSync(quarantine, { recursive: true, force: false });
    assert.equal(
      pathExists(quarantine),
      false,
      `${label} quarantine cleanup did not complete`,
    );
    assert.equal(pathExists(root), false, `${label} cleanup did not complete`);
    return;
  }

  /*
   * The descriptor below detects identity changes while removal is in
   * progress, but Node's recursive rm remains path-based. The safety boundary
   * is the unpredictable quarantine under the private parent and the
   * same-OS-user runner assumption, not descriptor-bound deletion.
   */
  const descriptor = openSync(
    quarantine,
    fsConstants.O_RDONLY |
      (fsConstants.O_DIRECTORY ?? 0) |
      (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    assert.equal(opened.isDirectory(), true, `${label} quarantine must stay open`);
    assertPathAndDescriptorIdentity(
      stableObjectEvidence(
        exactObjectIdentity(
          quarantine,
          "directory",
          `${label} final quarantine`,
        ).metadata,
      ),
      stableObjectEvidence(opened),
      `${label} final quarantine`,
    );
    assertTreeReboundAfterSameParentRename(
      reboundTree,
      boundedDigestTree(quarantine),
      label,
    );
    rmSync(quarantine, { recursive: true, force: false });
    assert.equal(
      pathExists(quarantine),
      false,
      `${label} quarantine cleanup did not complete`,
    );
    assert.deepEqual(
      objectIdentity(fstatSync(descriptor, { bigint: true })),
      rootAuthority.identity,
      `${label} retained descriptor changed during cleanup`,
    );
  } finally {
    closeSync(descriptor);
  }
  assert.equal(pathExists(root), false, `${label} cleanup did not complete`);
}

function randomSecret(prefix) {
  return `${prefix}${randomUUID().replaceAll("-", "")}`;
}

function secretFragments(secret) {
  assert.equal(secret.length >= 8, true);
  const fragments = new Set([secret]);
  for (let index = 0; index <= secret.length - 8; index += 1) {
    fragments.add(secret.slice(index, index + 8));
  }
  return Object.freeze([...fragments]);
}

function assertChildOutputExcludesSecrets(result, secrets) {
  const output = [
    typeof result.stdout === "string" ? result.stdout : "",
    typeof result.stderr === "string" ? result.stderr : "",
    result.error instanceof Error ? result.error.message : "",
  ].join("\n");
  for (const secret of secrets) {
    for (const fragment of secretFragments(secret)) {
      assert.equal(
        output.includes(fragment),
        false,
        "ABI child output exposed a secret fragment",
      );
    }
  }
}

function optionalSystemEnvironment() {
  return Object.fromEntries(
    ["SystemRoot", "WINDIR", "CI", "GITHUB_ACTIONS"].flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]],
    ),
  );
}

function lifecyclePathEnvironment(root) {
  const home = join(root, "home");
  const config = join(root, "config");
  return Object.freeze({
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    APPDATA: join(config, "appdata"),
    LOCALAPPDATA: join(config, "localappdata"),
    PLURUM_HOME: join(config, "plurum"),
    CODEX_HOME: join(config, "codex"),
    CLAUDE_CONFIG_DIR: join(config, "claude"),
    TMPDIR: join(root, "tmp"),
    TEMP: join(root, "tmp"),
    TMP: join(root, "tmp"),
  });
}

function createPrivateLifecyclePaths(environment) {
  for (const path of new Set(Object.values(environment))) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      chmodSync(path, 0o700);
    }
    exactObjectIdentity(path, "directory", "native ABI lifecycle directory");
  }
}

function commandEnvironment(root, overrides = {}) {
  const rustcPath = regularFileFromEnvironment("PLURUM_NATIVE_RUSTC");
  const cargoHome = isolatedDirectory(root, "CARGO_HOME", "cargo-home");
  const cargoTarget = isolatedDirectory(
    root,
    "CARGO_TARGET_DIR",
    "cargo-target",
  );
  const rustupHome = isolatedDirectory(root, "RUSTUP_HOME", "rustup-home");
  assert.equal(
    isStrictDescendant(rustupHome, rustcPath),
    true,
    "isolated rustc must stay beneath the isolated Rustup home",
  );
  const systemPath =
    process.platform === "win32"
      ? [
          dirname(process.execPath),
          dirname(rustcPath),
          join(requiredEnvironment("SystemRoot"), "System32"),
        ]
      : [dirname(process.execPath), dirname(rustcPath)];

  return {
    ...optionalSystemEnvironment(),
    PATH: systemPath.join(delimiter),
    CARGO_HOME: cargoHome,
    CARGO_TARGET_DIR: cargoTarget,
    RUSTUP_HOME: rustupHome,
    RUSTUP_TOOLCHAIN: requiredEnvironment("RUSTUP_TOOLCHAIN"),
    PLURUM_NATIVE_ISOLATION_ROOT: root,
    PLURUM_NATIVE_RUSTC: rustcPath,
    NO_COLOR: "1",
    ...overrides,
  };
}

function assertRuntimeMatchesTarget(target) {
  const [platform, architecture] = target.split("-");
  const normalizedRuntime =
    process.platform === "linux"
      ? `linux-${process.arch}`
      : `${process.platform}-${process.arch}`;
  assert.ok(runtimeTargets.has(normalizedRuntime));
  assert.equal(platform, process.platform);
  assert.equal(architecture, process.arch);
}

function readRustHost(isolationRoot, lifecycleRoot) {
  const rustcPath = regularFileFromEnvironment("PLURUM_NATIVE_RUSTC");
  const rustEnvironment = commandEnvironment(
    isolationRoot,
    lifecyclePathEnvironment(lifecycleRoot),
  );
  assert.equal(
    Object.hasOwn(rustEnvironment, "PLURUM_NATIVE_ABI_CREDENTIAL_SECRET"),
    false,
    "rustc must not inherit the ABI credential secret",
  );
  const result = spawnSync(rustcPath, ["-vV"], {
    env: rustEnvironment,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    shell: false,
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, "rustc must start successfully");
  assert.equal(
    result.status,
    0,
    `rustc -vV failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  const host = /^host: (.+)$/mu.exec(result.stdout)?.[1];
  assert.ok(host, "rustc must report its host triple");
  return host;
}

function digestOpenDescriptor(descriptor, size, label) {
  assert.equal(
    size > 0n && size <= BigInt(MAX_CLEANUP_FILE_BYTES),
    true,
    `${label} has an invalid size`,
  );
  const bytes = Buffer.alloc(Number(size));
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = readSync(
      descriptor,
      bytes,
      offset,
      bytes.byteLength - offset,
      offset,
    );
    assert.equal(count > 0, true, `${label} changed while reading`);
    offset += count;
  }
  assert.equal(
    readSync(descriptor, Buffer.alloc(1), 0, 1, bytes.byteLength),
    0,
    `${label} grew while reading`,
  );
  return sha256(bytes);
}

function assertDirectOwnedBuildDirectory(path, label) {
  const metadata = lstatSync(path, { bigint: true });
  assert.equal(metadata.isSymbolicLink(), false, `${label} must not be a link`);
  assert.equal(metadata.isDirectory(), true, `${label} must be a directory`);
  assert.equal(
    realpathSync(path),
    resolve(path),
    `${label} must stay direct`,
  );
  if (process.platform !== "win32") {
    assert.equal(
      metadata.uid,
      BigInt(process.getuid?.()),
      `${label} must be user-owned`,
    );
  }
  return metadata;
}

function assertDirectOwnedBuildFile(path, label) {
  const metadata = lstatSync(path, { bigint: true });
  assert.equal(metadata.isSymbolicLink(), false, `${label} must not be a link`);
  assert.equal(metadata.isFile(), true, `${label} must be a regular file`);
  assert.equal(
    metadata.size > 0n &&
      metadata.size <= BigInt(MAX_CLEANUP_FILE_BYTES),
    true,
    `${label} has an invalid size`,
  );
  assert.equal(
    realpathSync(path),
    resolve(path),
    `${label} must stay direct`,
  );
  if (process.platform !== "win32") {
    assert.equal(
      metadata.uid,
      BigInt(process.getuid?.()),
      `${label} must be user-owned`,
    );
    assert.equal(
      metadata.mode & 0o022n,
      0n,
      `${label} must not be writable by another principal`,
    );
  }
  return metadata;
}

function assertControlledCargoArtifact(source, cargoTarget, binary, label) {
  const releaseDirectory = join(cargoTarget, "release");
  assert.equal(
    source,
    join(releaseDirectory, binary),
    `${label} must use the fixed Cargo release path`,
  );
  assertDirectOwnedBuildDirectory(
    releaseDirectory,
    "isolated Cargo release directory",
  );
  const metadata = assertDirectOwnedBuildFile(source, label);
  if (metadata.nlink === 1n) {
    return Object.freeze({
      identity: objectIdentity(metadata),
      evidence: stableObjectEvidence(metadata),
    });
  }

  assert.equal(
    process.platform === "linux" || process.platform === "win32",
    true,
    `${label} may only use Cargo's second release link on Linux or Windows`,
  );
  assert.equal(metadata.nlink, 2n, `${label} must have one or two links`);
  const dependenciesDirectory = join(releaseDirectory, "deps");
  assertDirectOwnedBuildDirectory(
    dependenciesDirectory,
    "isolated Cargo release dependencies directory",
  );
  const dependencyArtifact = join(dependenciesDirectory, binary);
  const dependencyMetadata = assertDirectOwnedBuildFile(
    dependencyArtifact,
    "Cargo dependency artifact",
  );
  assert.equal(
    dependencyMetadata.nlink,
    2n,
    "Cargo dependency artifact must account for the second release link",
  );
  assert.deepEqual(
    stableObjectEvidence(dependencyMetadata),
    stableObjectEvidence(metadata),
    "Cargo release links must identify the same full stable artifact",
  );
  return Object.freeze({
    identity: objectIdentity(metadata),
    evidence: stableObjectEvidence(metadata),
  });
}

function copyPrivateRegularFile(
  source,
  destination,
  sourceAuthority,
  label,
) {
  const sourceBefore = lstatSync(source, { bigint: true });
  assert.equal(sourceBefore.isSymbolicLink(), false, `${label} source is linked`);
  assert.equal(sourceBefore.isFile(), true, `${label} source must be a file`);
  assert.deepEqual(
    objectIdentity(sourceBefore),
    sourceAuthority.identity,
    `${label} source identity changed`,
  );
  assert.deepEqual(
    stableObjectEvidence(sourceBefore),
    sourceAuthority.evidence,
    `${label} source evidence changed`,
  );
  assert.equal(
    sourceBefore.size > 0n &&
      sourceBefore.size <= BigInt(MAX_CLEANUP_FILE_BYTES),
    true,
    `${label} source has an invalid size`,
  );
  assert.equal(
    realpathSync(source),
    resolve(source),
    `${label} source must stay direct`,
  );
  if (process.platform !== "win32") {
    assert.equal(
      sourceBefore.uid,
      BigInt(process.getuid?.()),
      `${label} source must be user-owned`,
    );
    assert.equal(
      sourceBefore.mode & 0o022n,
      0n,
      `${label} source must not be writable by another principal`,
    );
  }

  const sourceDescriptor = openSync(
    source,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  let destinationDescriptor;
  try {
    const openedSource = fstatSync(sourceDescriptor, { bigint: true });
    assertPathAndDescriptorIdentity(
      stableObjectEvidence(sourceBefore),
      stableObjectEvidence(openedSource),
      `${label} source`,
    );
    destinationDescriptor = openSync(
      destination,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    if (process.platform !== "win32") {
      fchmodSync(destinationDescriptor, 0o600);
    }

    const sourceDigest = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let sourceOffset = 0;
    while (sourceOffset < Number(openedSource.size)) {
      const count = readSync(
        sourceDescriptor,
        buffer,
        0,
        Math.min(buffer.byteLength, Number(openedSource.size) - sourceOffset),
        sourceOffset,
      );
      assert.equal(count > 0, true, `${label} source changed while copying`);
      sourceDigest.update(buffer.subarray(0, count));
      let written = 0;
      while (written < count) {
        const writeCount = writeSync(
          destinationDescriptor,
          buffer,
          written,
          count - written,
          null,
        );
        assert.equal(writeCount > 0, true, `${label} destination write stalled`);
        written += writeCount;
      }
      sourceOffset += count;
    }
    assert.equal(
      readSync(
        sourceDescriptor,
        buffer,
        0,
        1,
        Number(openedSource.size),
      ),
      0,
      `${label} source grew while copying`,
    );
    fsyncSync(destinationDescriptor);
    assert.deepEqual(
      stableObjectEvidence(fstatSync(sourceDescriptor, { bigint: true })),
      stableObjectEvidence(openedSource),
      `${label} source changed while copying`,
    );
    assertPathAndDescriptorIdentity(
      stableObjectEvidence(lstatSync(source, { bigint: true })),
      stableObjectEvidence(openedSource),
      `${label} source`,
    );
    closeSync(destinationDescriptor);
    destinationDescriptor = undefined;

    const destinationDigest = readBoundedDigest(
      destination,
      MAX_CLEANUP_FILE_BYTES,
      `${label} destination`,
    );
    assert.equal(
      destinationDigest.size,
      Number(openedSource.size),
      `${label} destination size changed`,
    );
    assert.equal(
      destinationDigest.digest,
      sourceDigest.digest("hex"),
      `${label} destination content changed`,
    );
    const destinationMetadata = exactObjectIdentity(
      destination,
      "file",
      `${label} destination`,
    ).metadata;
    assert.deepEqual(
      stableObjectEvidence(destinationMetadata),
      destinationDigest.evidence,
      `${label} destination evidence changed after verification`,
    );
    return Object.freeze({
      identity: destinationDigest.identity,
      security: securityEvidence(destinationMetadata),
      evidence: destinationDigest.evidence,
      size: destinationDigest.size,
      digest: destinationDigest.digest,
    });
  } finally {
    if (destinationDescriptor !== undefined) {
      closeSync(destinationDescriptor);
    }
    closeSync(sourceDescriptor);
  }
}

function loadStableNativeAddon(path, label) {
  const pathBefore = exactObjectIdentity(path, "file", label).metadata;
  assert.equal(
    pathBefore.size > 0n &&
      pathBefore.size <= BigInt(MAX_CLEANUP_FILE_BYTES),
    true,
    `${label} has an invalid size`,
  );
  const descriptor = openSync(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const openedBefore = fstatSync(descriptor, { bigint: true });
    assert.equal(openedBefore.isFile(), true, `${label} must stay a file`);
    assertPathAndDescriptorIdentity(
      stableObjectEvidence(pathBefore),
      stableObjectEvidence(openedBefore),
      label,
    );
    const digestBefore = digestOpenDescriptor(
      descriptor,
      openedBefore.size,
      label,
    );
    assert.deepEqual(
      stableObjectEvidence(fstatSync(descriptor, { bigint: true })),
      stableObjectEvidence(openedBefore),
      `${label} changed before loading`,
    );
    assertPathAndDescriptorIdentity(
      stableObjectEvidence(
        exactObjectIdentity(path, "file", label).metadata,
      ),
      stableObjectEvidence(openedBefore),
      label,
    );

    const nativeModule = { exports: {} };
    process.dlopen(nativeModule, path);

    const openedAfter = fstatSync(descriptor, { bigint: true });
    assert.deepEqual(
      stableObjectEvidence(openedAfter),
      stableObjectEvidence(openedBefore),
      `${label} descriptor changed while loading`,
    );
    const pathAfter = exactObjectIdentity(path, "file", label).metadata;
    assertPathAndDescriptorIdentity(
      stableObjectEvidence(pathAfter),
      stableObjectEvidence(openedAfter),
      label,
    );
    assert.equal(
      digestOpenDescriptor(descriptor, openedAfter.size, label),
      digestBefore,
      `${label} content changed while loading`,
    );
    assert.deepEqual(
      stableObjectEvidence(fstatSync(descriptor, { bigint: true })),
      stableObjectEvidence(openedAfter),
      `${label} changed during post-load verification`,
    );
    assertPathAndDescriptorIdentity(
      stableObjectEvidence(
        exactObjectIdentity(path, "file", label).metadata,
      ),
      stableObjectEvidence(openedAfter),
      label,
    );
    return nativeModule.exports;
  } finally {
    closeSync(descriptor);
  }
}

async function runChild() {
  assertSupportedWindowsRunner();
  const isolationRoot = verifiedIsolationRoot();
  const expectedTarget = requiredEnvironment("PLURUM_NATIVE_EXPECTED_TARGET");
  const expectedNode = requiredEnvironment("PLURUM_NATIVE_EXPECTED_NODE");
  const stagedPath = requiredEnvironment("PLURUM_NATIVE_STAGED_PATH");
  const runId = requiredEnvironment("PLURUM_NATIVE_TEST_RUN_ID");
  const runRoot = realpathSync(process.cwd());
  assert.equal(realpathSync(dirname(runRoot)), realpathSync(join(isolationRoot, "tmp")));
  assert.equal(realpathSync(stagedPath), realpathSync(join(runRoot, "credential-store.node")));
  const childSentinel = readBoundedDigest(
    join(runRoot, ".plurum-native-abi-root"),
    MAX_SENTINEL_BYTES,
    "native ABI child sentinel",
  );
  const expectedSentinel = Buffer.from(runId, "utf8");
  assert.equal(
    childSentinel.size === expectedSentinel.byteLength &&
      childSentinel.digest === sha256(expectedSentinel),
    true,
    "native ABI child sentinel changed",
  );

  assert.equal(process.versions.node, expectedNode);
  assert.ok(Number.parseInt(process.versions.napi, 10) >= 8);
  assertRuntimeMatchesTarget(expectedTarget);

  const rustHost = readRustHost(isolationRoot, runRoot);
  assert.equal(
    rustHostTargets[rustHost],
    expectedTarget,
    `Rust host ${rustHost} must map to ${expectedTarget}`,
  );

  const addon = loadStableNativeAddon(
    stagedPath,
    "staged native credential addon",
  );
  assert.ok(addon !== null && typeof addon === "object");

  const ownKeys = Reflect.ownKeys(addon);
  assert.ok(ownKeys.every((key) => typeof key === "string"));
  assert.deepEqual([...ownKeys].sort(), expectedExportKeys);
  assert.deepEqual(Object.keys(addon).sort(), expectedExportKeys);
  for (const key of expectedExportKeys) {
    assert.equal(
      Object.getOwnPropertyDescriptor(addon, key)?.enumerable,
      true,
      `${key} must be enumerable`,
    );
  }

  const [
    { createNativeCredentialStoreProvider },
    { CLI_VERSION },
    { readCredentialStore },
    { recoverCredentialStore, writeCredentialStore },
    {
      claimCredentialStoreObservationEvidence,
      createCredentialStoreObservationAuthority,
    },
  ] =
    await Promise.all([
      import(
        pathToFileURL(
          join(packageRoot, "dist", "adapters", "node", "native-credential-store.js"),
        ).href
      ),
      import(pathToFileURL(join(packageRoot, "dist", "version.js")).href),
      import(pathToFileURL(join(packageRoot, "dist", "credentials", "store.js")).href),
      import(
        pathToFileURL(
          join(packageRoot, "dist", "credentials", "store-writer.js"),
        ).href
      ),
      import(
        pathToFileURL(
          join(packageRoot, "dist", "credentials", "store-observer.js"),
        ).href
      ),
    ]);

  assert.equal(addon.magic, "plurum-native-credential-store");
  assert.equal(addon.abiVersion, 4);
  assert.equal(addon.nodeApiVersion, 8);
  assert.equal(addon.packageVersion, CLI_VERSION);
  assert.equal(addon.target, expectedTarget);
  assert.equal(typeof addon.createAdapters, "function");
  const nativeConfiguration = Object.freeze({
    codexHomeDirectory: join(runRoot, "codex-home"),
    legacyPaths: Object.freeze({
      hermes: join(runRoot, "legacy-hermes", "plurum.json"),
      openclaw: join(runRoot, "legacy-openclaw", "plurum.json"),
      removedCli: join(runRoot, "legacy-removed", "config.json"),
    }),
    stateDirectory: join(runRoot, "credential-store"),
  });
  const rawAdapters = Reflect.apply(addon.createAdapters, addon, [
    nativeConfiguration,
  ]);
  assert.ok(rawAdapters !== null && typeof rawAdapters === "object");
  assert.deepEqual(Object.keys(rawAdapters).sort(), [
    "codexDotenv",
    "journal",
    "legacy",
    "mutation",
    "observation",
    "read",
  ]);
  assert.deepEqual(Object.keys(rawAdapters.codexDotenv).sort(), [
    "observe",
    "synchronize",
  ]);
  assert.deepEqual(Object.keys(rawAdapters.journal), ["acquire"]);
  assert.deepEqual(Object.keys(rawAdapters.legacy), ["read"]);
  assert.deepEqual(Object.keys(rawAdapters.read), ["openPrivateDirectory"]);
  assert.deepEqual(Object.keys(rawAdapters.observation), [
    "openPrivateDirectory",
  ]);
  assert.deepEqual(Object.keys(rawAdapters.mutation).sort(), [
    "acquireObservedSetupLease",
    "acquireSetupLease",
  ]);
  assert.throws(
    () => Reflect.apply(addon.createAdapters, addon, []),
    /argument|invalid|object/iu,
    "raw factory must require its exact configuration",
  );
  assert.throws(
    () =>
      Reflect.apply(addon.createAdapters, addon, [
        {
          ...nativeConfiguration,
          unexpected: true,
        },
      ]),
    /invalid/iu,
    "raw factory must reject configuration extensions",
  );
  for (const extension of ["hidden", "symbol"]) {
    const invalidOptions = { noFollow: true };
    Object.defineProperty(
      invalidOptions,
      extension === "hidden" ? "unexpected" : Symbol("unexpected"),
      { value: true },
    );
    assert.throws(
      () =>
        rawAdapters.read.openPrivateDirectory(
          join(runRoot, "shape-rejection"),
          invalidOptions,
        ),
      /invalid/iu,
      `raw bridge must reject ${extension} option extensions`,
    );
  }

  const rawObservedDirectory = join(runRoot, "raw-observed-store");
  const rawMissing = rawAdapters.observation.openPrivateDirectory(
    rawObservedDirectory,
    Object.freeze({ noFollow: true }),
  );
  assert.equal(rawMissing.status, "missing");
  assert.deepEqual(Reflect.ownKeys(rawMissing.evidence), []);
  const rawObservedAcquired =
    rawAdapters.mutation.acquireObservedSetupLease(
      rawObservedDirectory,
      Object.freeze({
        createDirectory: true,
        evidence: rawMissing.evidence,
        noFollow: true,
        nonce: randomUUID(),
      }),
    );
  assert.equal(rawObservedAcquired.status, "acquired");
  assert.equal(rawObservedAcquired.directory, "created");
  rawObservedAcquired.lease.release();
  assert.deepEqual(readdirSync(rawObservedDirectory), ["setup.lock"]);
  assert.throws(
    () =>
      rawAdapters.mutation.acquireObservedSetupLease(
        rawObservedDirectory,
        Object.freeze({
          createDirectory: true,
          evidence: rawMissing.evidence,
          noFollow: true,
          nonce: randomUUID(),
        }),
      ),
    /invalid/iu,
    "raw observation evidence must be one-shot",
  );

  const rawMismatchDirectory = join(runRoot, "raw-mismatch-store");
  const rawMismatchEvidence = rawAdapters.observation.openPrivateDirectory(
    rawMismatchDirectory,
    Object.freeze({ noFollow: true }),
  );
  assert.equal(rawMismatchEvidence.status, "missing");
  const rawMismatchResult =
    rawAdapters.mutation.acquireObservedSetupLease(
      join(runRoot, "raw-mismatch-other"),
      Object.freeze({
        createDirectory: true,
        evidence: rawMismatchEvidence.evidence,
        noFollow: true,
        nonce: randomUUID(),
      }),
    );
  assert.deepEqual(rawMismatchResult, { status: "precondition-failed" });
  assert.equal(pathExists(rawMismatchDirectory), false);
  assert.equal(pathExists(join(runRoot, "raw-mismatch-other")), false);

  const otherRawAdapters = Reflect.apply(addon.createAdapters, addon, [
    nativeConfiguration,
  ]);
  const rawCrossPairDirectory = join(runRoot, "raw-cross-pair-store");
  const rawCrossPairEvidence =
    rawAdapters.observation.openPrivateDirectory(
      rawCrossPairDirectory,
      Object.freeze({ noFollow: true }),
    );
  assert.equal(rawCrossPairEvidence.status, "missing");
  assert.throws(
    () =>
      otherRawAdapters.mutation.acquireObservedSetupLease(
        rawCrossPairDirectory,
        Object.freeze({
          createDirectory: true,
          evidence: rawCrossPairEvidence.evidence,
          noFollow: true,
          nonce: randomUUID(),
        }),
      ),
    /invalid/iu,
    "raw observation evidence must remain bound to one adapter pair",
  );
  assert.equal(pathExists(rawCrossPairDirectory), false);

  let resolverCalls = 0;
  const provider = createNativeCredentialStoreProvider(
    expectedTarget,
    (target) => {
      resolverCalls += 1;
      assert.equal(target, expectedTarget);
      return addon;
    },
    nativeConfiguration,
  );

  assert.equal(resolverCalls, 0, "native resolution must remain lazy");
  const first = provider.load();
  assert.equal(first.status, "available");
  if (first.status !== "available") {
    assert.fail("native credential adapters must be available");
  }
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.codexDotenv), true);
  assert.equal(Object.isFrozen(first.journal), true);
  assert.equal(Object.isFrozen(first.legacy), true);
  assert.equal(Object.isFrozen(first.read), true);
  assert.equal(Object.isFrozen(first.observation), true);
  assert.equal(Object.isFrozen(first.mutation), true);
  assert.equal(resolverCalls, 1);
  assert.strictEqual(provider.load(), first);
  assert.equal(resolverCalls, 1, "native resolution must be memoized");
  assert.equal(Object.isFrozen(provider), true);

  const credentialDirectory = join(runRoot, "credential-store");
  const credentialKey = requiredEnvironment(
    "PLURUM_NATIVE_ABI_CREDENTIAL_SECRET",
  );
  assert.equal(
    /^plrm_live_native_abi_[0-9a-f]{32}$/u.test(credentialKey),
    true,
    "ABI credential secret must have the fixed test-only shape",
  );
  const timestamp = "2026-07-19T12:00:00.000Z";
  const clock = Object.freeze({
    now() {
      return Date.parse(timestamp);
    },
  });
  const random = Object.freeze({
    uuid() {
      return randomUUID();
    },
  });
  const credential = Object.freeze({
    schema_version: 1,
    state: "active",
    api_origin: "https://api.plurum.ai",
    api_key: credentialKey,
    agent_id: "018f5d10-ee3a-476f-9bfb-c1e93dd50074",
    agent_name: "Native ABI Test Agent",
    username: "native-abi-test",
    registration_request_id: null,
    created_at: timestamp,
    updated_at: timestamp,
    activated_at: timestamp,
  });
  const locations = Object.freeze({ directory: credentialDirectory });
  const writerDependencies = Object.freeze({
    storage: first.mutation,
    clock,
    random,
  });

  const observationAuthority =
    createCredentialStoreObservationAuthority(first.observation);
  const missingObservation = await observationAuthority.inspect(
    Object.freeze({ directory: credentialDirectory }),
  );
  assert.equal(missingObservation.status, "available");
  assert.equal(missingObservation.canonical, "missing");
  assert.equal(missingObservation.transaction, "clean");
  const missingRedeemed = observationAuthority.redeem(
    Object.freeze({
      directory: credentialDirectory,
      identity: missingObservation.identity,
    }),
  );
  assert.equal(missingRedeemed.status, "redeemed");
  assert.equal(missingRedeemed.credential, null);
  assert.equal(missingRedeemed.transaction, null);
  const missingEvidence = claimCredentialStoreObservationEvidence(
    observationAuthority,
    missingRedeemed.evidence,
  );
  assert.ok(missingEvidence);
  assert.deepEqual(Reflect.ownKeys(missingEvidence), []);
  const observedCreation =
    await first.mutation.acquireObservedSetupLease(
      credentialDirectory,
      Object.freeze({
        createDirectory: true,
        evidence: missingEvidence,
        noFollow: true,
      }),
    );
  assert.equal(observedCreation.status, "acquired");
  assert.equal(observedCreation.directory, "created");
  await observedCreation.lease.release();
  assert.deepEqual(readdirSync(credentialDirectory), ["setup.lock"]);

  const crossPairDirectory = join(runRoot, "public-cross-pair-store");
  const crossPairObservation = await observationAuthority.inspect(
    Object.freeze({ directory: crossPairDirectory }),
  );
  assert.equal(crossPairObservation.status, "available");
  const crossPairRedeemed = observationAuthority.redeem(
    Object.freeze({
      directory: crossPairDirectory,
      identity: crossPairObservation.identity,
    }),
  );
  assert.equal(crossPairRedeemed.status, "redeemed");
  const crossPairEvidence = claimCredentialStoreObservationEvidence(
    observationAuthority,
    crossPairRedeemed.evidence,
  );
  assert.ok(crossPairEvidence);
  const secondProvider = createNativeCredentialStoreProvider(
    expectedTarget,
    () => addon,
    nativeConfiguration,
  );
  const second = secondProvider.load();
  assert.equal(second.status, "available");
  await assert.rejects(
    () =>
      second.mutation.acquireObservedSetupLease(
        crossPairDirectory,
        Object.freeze({
          createDirectory: true,
          evidence: crossPairEvidence,
          noFollow: true,
        }),
      ),
    /invalid/iu,
    "public observation evidence must remain bound to one adapter pair",
  );
  assert.equal(pathExists(crossPairDirectory), false);
  const crossPairCreation =
    await first.mutation.acquireObservedSetupLease(
      crossPairDirectory,
      Object.freeze({
        createDirectory: true,
        evidence: crossPairEvidence,
        noFollow: true,
      }),
    );
  assert.equal(crossPairCreation.status, "acquired");
  await crossPairCreation.lease.release();

  const written = await writeCredentialStore(
    writerDependencies,
    locations,
    credential,
  );
  assert.deepEqual(written, { status: "written" });
  assert.equal(Object.isFrozen(written), true);

  const unchanged = await writeCredentialStore(
    writerDependencies,
    locations,
    credential,
  );
  assert.deepEqual(unchanged, { status: "unchanged" });
  assert.equal(Object.isFrozen(unchanged), true);

  const codexHomeDirectory = nativeConfiguration.codexHomeDirectory;
  const codexDotenvPath = join(codexHomeDirectory, ".env");
  const excludedProjectDirectory = join(runRoot, "excluded-project");
  mkdirSync(excludedProjectDirectory, { mode: 0o700 });
  if (process.platform !== "win32") {
    chmodSync(excludedProjectDirectory, 0o700);
  }
  exactObjectIdentity(
    excludedProjectDirectory,
    "directory",
    "native ABI excluded project directory",
  );
  assert.equal(pathExists(codexHomeDirectory), false);

  const codexObserveRequest = Object.freeze({
    kind: "codex-dotenv-observe",
    scope: "user",
    apiOrigin: "https://api.plurum.ai",
    expectation: Object.freeze({
      kind: "known",
      apiKey: credentialKey,
    }),
    excludedProjectDirectory,
  });
  const codexMissing = await first.codexDotenv.observe(
    codexObserveRequest,
  );
  assert.equal(codexMissing.status, "absent");
  assert.match(codexMissing.revision, /^[0-9a-f]{64}$/u);
  const codexCreated = await first.codexDotenv.synchronize(
    Object.freeze({
      kind: "codex-dotenv-synchronize",
      scope: "user",
      apiOrigin: "https://api.plurum.ai",
      expectedRevision: codexMissing.revision,
      expectedStatus: "absent",
      expectation: codexObserveRequest.expectation,
      excludedProjectDirectory,
    }),
  );
  assert.equal(codexCreated.status, "completed");
  if (codexCreated.status !== "completed") {
    assert.fail("Codex dotenv creation must complete");
  }
  assert.equal(codexCreated.disposition, "changed");
  assert.notEqual(codexCreated.stateRevision, codexMissing.revision);
  exactObjectIdentity(
    codexHomeDirectory,
    "directory",
    "native ABI Codex home",
  );
  exactObjectIdentity(
    codexDotenvPath,
    "file",
    "native ABI Codex dotenv",
  );
  const canonicalCodexBytes = Buffer.from(
    `PLURUM_API_KEY=${credentialKey}${expectedTarget.startsWith("win32-") ? "\r\n" : "\n"}`,
    "utf8",
  );
  const canonicalCodexDigest = readBoundedDigest(
    codexDotenvPath,
    128 * 1024,
    "native ABI Codex dotenv",
  );
  assert.equal(canonicalCodexDigest.size, canonicalCodexBytes.byteLength);
  assert.equal(canonicalCodexDigest.digest, sha256(canonicalCodexBytes));

  const codexExact = await first.codexDotenv.observe(codexObserveRequest);
  assert.deepEqual(codexExact, {
    revision: codexCreated.stateRevision,
    status: "exact",
  });
  assert.deepEqual(
    await first.codexDotenv.synchronize(
      Object.freeze({
        kind: "codex-dotenv-synchronize",
        scope: "user",
        apiOrigin: "https://api.plurum.ai",
        expectedRevision: codexExact.revision,
        expectedStatus: "exact",
        expectation: codexObserveRequest.expectation,
        excludedProjectDirectory,
      }),
    ),
    {
      status: "completed",
      disposition: "unchanged",
      stateRevision: codexExact.revision,
    },
  );

  const otherCodexKey = `plrm_live_${"Z".repeat(43)}`;
  const complexCodexBytes = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(
      `# keep\r\nOTHER="unrelated"\r\nexport PLURUM_API_KEY = '${otherCodexKey}' # keep\r\nLAST=value\r\n`,
      "utf8",
    ),
  ]);
  writeFileSync(codexDotenvPath, complexCodexBytes, { flag: "w" });
  if (process.platform !== "win32") {
    chmodSync(codexDotenvPath, 0o600);
  }
  const codexMismatched = await first.codexDotenv.observe(
    codexObserveRequest,
  );
  assert.equal(codexMismatched.status, "mismatched");
  assert.notEqual(codexMismatched.revision, codexExact.revision);
  const codexReplaced = await first.codexDotenv.synchronize(
    Object.freeze({
      kind: "codex-dotenv-synchronize",
      scope: "user",
      apiOrigin: "https://api.plurum.ai",
      expectedRevision: codexMismatched.revision,
      expectedStatus: "mismatched",
      expectation: codexObserveRequest.expectation,
      excludedProjectDirectory,
    }),
  );
  assert.equal(codexReplaced.status, "completed");
  if (codexReplaced.status !== "completed") {
    assert.fail("Codex dotenv replacement must complete");
  }
  assert.equal(codexReplaced.disposition, "changed");
  const expectedComplexCodexBytes = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(
      `# keep\r\nOTHER="unrelated"\r\nexport PLURUM_API_KEY = '${credentialKey}' # keep\r\nLAST=value\r\n`,
      "utf8",
    ),
  ]);
  const complexCodexDigest = readBoundedDigest(
    codexDotenvPath,
    128 * 1024,
    "native ABI replaced Codex dotenv",
  );
  assert.equal(complexCodexDigest.size, expectedComplexCodexBytes.byteLength);
  assert.equal(complexCodexDigest.digest, sha256(expectedComplexCodexBytes));

  writeFileSync(codexDotenvPath, complexCodexBytes, { flag: "w" });
  const racedEvidence = await first.codexDotenv.observe(codexObserveRequest);
  assert.equal(racedEvidence.status, "mismatched");
  const racedCodexBytes = Buffer.concat([
    complexCodexBytes,
    Buffer.from("# raced\r\n", "utf8"),
  ]);
  writeFileSync(codexDotenvPath, racedCodexBytes, { flag: "w" });
  assert.deepEqual(
    await first.codexDotenv.synchronize(
      Object.freeze({
        kind: "codex-dotenv-synchronize",
        scope: "user",
        apiOrigin: "https://api.plurum.ai",
        expectedRevision: racedEvidence.revision,
        expectedStatus: "mismatched",
        expectation: codexObserveRequest.expectation,
        excludedProjectDirectory,
      }),
    ),
    { status: "precondition-failed" },
  );
  const racedDigest = readBoundedDigest(
    codexDotenvPath,
    128 * 1024,
    "native ABI raced Codex dotenv",
  );
  assert.equal(racedDigest.size, racedCodexBytes.byteLength);
  assert.equal(racedDigest.digest, sha256(racedCodexBytes));

  const currentRacedEvidence = await first.codexDotenv.observe(
    codexObserveRequest,
  );
  assert.equal(currentRacedEvidence.status, "mismatched");
  const convergedAfterRace = await first.codexDotenv.synchronize(
    Object.freeze({
      kind: "codex-dotenv-synchronize",
      scope: "user",
      apiOrigin: "https://api.plurum.ai",
      expectedRevision: currentRacedEvidence.revision,
      expectedStatus: "mismatched",
      expectation: codexObserveRequest.expectation,
      excludedProjectDirectory,
    }),
  );
  assert.equal(convergedAfterRace.status, "completed");

  const rawCodexObservation = rawAdapters.codexDotenv.observe(
    Object.freeze({
      excludedProjectDirectory,
      maxBytes: 128 * 1024,
      noFollow: true,
      revisionNonce: "a".repeat(64),
    }),
  );
  assert.equal(rawCodexObservation.status, "present");
  assert.match(rawCodexObservation.revision, /^[0-9a-f]{64}$/u);
  assert.equal(rawCodexObservation.read.endOfFile, true);
  assert.equal(rawCodexObservation.read.bytes instanceof Uint8Array, true);
  assert.deepEqual(
    rawAdapters.codexDotenv.synchronize(
      Object.freeze({
        disposition: "unchanged",
        excludedProjectDirectory,
        expectedRevision: rawCodexObservation.revision,
        maxBytes: 128 * 1024,
        nextRevisionNonce: "b".repeat(64),
        noFollow: true,
        nonce: randomUUID(),
      }),
    ),
    {
      status: "completed",
      disposition: "unchanged",
      stateRevision: rawCodexObservation.revision,
    },
  );
  rawCodexObservation.read.bytes.fill(0);
  assert.deepEqual(
    rawAdapters.codexDotenv.synchronize(
      Object.freeze({
        disposition: "unchanged",
        excludedProjectDirectory,
        expectedRevision: "f".repeat(64),
        maxBytes: 128 * 1024,
        nextRevisionNonce: "e".repeat(64),
        noFollow: true,
        nonce: randomUUID(),
      }),
    ),
    { status: "precondition-failed" },
  );

  const duplicateCodexBytes = Buffer.from(
    `PLURUM_API_KEY=${credentialKey}\nPLURUM_API_KEY=${credentialKey}\n`,
    "utf8",
  );
  writeFileSync(codexDotenvPath, duplicateCodexBytes, { flag: "w" });
  const duplicateCodexObservation = await first.codexDotenv.observe(
    codexObserveRequest,
  );
  assert.equal(duplicateCodexObservation.status, "ambiguous");
  writeFileSync(codexDotenvPath, expectedComplexCodexBytes, { flag: "w" });
  assert.equal(
    (await first.codexDotenv.observe(codexObserveRequest)).status,
    "exact",
  );
  canonicalCodexBytes.fill(0);
  complexCodexBytes.fill(0);
  expectedComplexCodexBytes.fill(0);
  racedCodexBytes.fill(0);
  duplicateCodexBytes.fill(0);

  const presentObservation = await observationAuthority.inspect(
    Object.freeze({ directory: credentialDirectory }),
  );
  assert.equal(presentObservation.status, "available");
  assert.equal(presentObservation.canonical, "active");
  assert.equal(presentObservation.transaction, "clean");
  const presentRedeemed = observationAuthority.redeem(
    Object.freeze({
      directory: credentialDirectory,
      identity: presentObservation.identity,
    }),
  );
  assert.equal(presentRedeemed.status, "redeemed");
  assert.equal(presentRedeemed.credential.api_key, credentialKey);
  const staleEvidence = claimCredentialStoreObservationEvidence(
    observationAuthority,
    presentRedeemed.evidence,
  );
  assert.ok(staleEvidence);

  const changedCredential = Object.freeze({
    ...credential,
    agent_name: "Native ABI Changed Agent",
  });
  const changed = await writeCredentialStore(
    writerDependencies,
    locations,
    changedCredential,
  );
  assert.deepEqual(changed, { status: "written" });
  const staleAcquire =
    await first.mutation.acquireObservedSetupLease(
      credentialDirectory,
      Object.freeze({
        createDirectory: true,
        evidence: staleEvidence,
        noFollow: true,
      }),
    );
  assert.deepEqual(staleAcquire, { status: "precondition-failed" });
  await assert.rejects(
    () =>
      first.mutation.acquireObservedSetupLease(
        credentialDirectory,
        Object.freeze({
          createDirectory: true,
          evidence: staleEvidence,
          noFollow: true,
        }),
      ),
    /invalid/iu,
    "stale public evidence must still be burned before native CAS",
  );

  const freshObservation = await observationAuthority.inspect(
    Object.freeze({ directory: credentialDirectory }),
  );
  assert.equal(freshObservation.status, "available");
  const freshRedeemed = observationAuthority.redeem(
    Object.freeze({
      directory: credentialDirectory,
      identity: freshObservation.identity,
    }),
  );
  assert.equal(freshRedeemed.status, "redeemed");
  const freshEvidence = claimCredentialStoreObservationEvidence(
    observationAuthority,
    freshRedeemed.evidence,
  );
  assert.ok(freshEvidence);
  const freshAcquire =
    await first.mutation.acquireObservedSetupLease(
      credentialDirectory,
      Object.freeze({
        createDirectory: true,
        evidence: freshEvidence,
        noFollow: true,
      }),
    );
  assert.equal(freshAcquire.status, "acquired");
  assert.equal(freshAcquire.directory, "existing");
  await freshAcquire.lease.release();

  const nestedCredentialLease = await first.mutation.acquireSetupLease(
    credentialDirectory,
    Object.freeze({
      createDirectory: true,
      noFollow: true,
      nonce: randomUUID(),
    }),
  );
  assert.equal(nestedCredentialLease.status, "acquired");
  if (nestedCredentialLease.status !== "acquired") {
    assert.fail("credential lease must be acquired for nested journal proof");
  }

  const rawJournalAcquired = rawAdapters.journal.acquire(
    Object.freeze({ nonce: randomUUID() }),
  );
  assert.equal(rawJournalAcquired.status, "acquired");
  assert.equal(rawJournalAcquired.priorLease, "absent");
  assert.deepEqual(Object.keys(rawJournalAcquired.lease).sort(), [
    "abandon",
    "observe",
    "release",
    "remove",
    "renew",
    "replace",
  ]);
  const rawJournalMissing = rawJournalAcquired.lease.observe();
  assert.equal(rawJournalMissing.status, "missing");
  assert.deepEqual(Reflect.ownKeys(rawJournalMissing.revision), []);
  const journalBytes = new TextEncoder().encode(
    '{"kind":"host-reconciliation","stage":"apply"}\n',
  );
  const expectedJournalBytes = journalBytes.slice();
  const rawJournalReplaced = rawJournalAcquired.lease.replace(
    Object.freeze({
      bytes: journalBytes,
      expected: rawJournalMissing.revision,
    }),
  );
  assert.equal(rawJournalReplaced.status, "replaced");
  assert.deepEqual(Reflect.ownKeys(rawJournalReplaced.revision), []);
  journalBytes.fill(0);
  assert.throws(
    () =>
      rawJournalAcquired.lease.replace(
        Object.freeze({
          bytes: expectedJournalBytes,
          expected: rawJournalMissing.revision,
        }),
      ),
    /invalid/iu,
    "raw journal revisions must be one-shot",
  );
  const rawJournalPresent = rawJournalAcquired.lease.observe();
  assert.equal(rawJournalPresent.status, "present");
  assert.deepEqual(Object.keys(rawJournalPresent).sort(), [
    "read",
    "revision",
    "status",
  ]);
  assert.equal(rawJournalPresent.read.endOfFile, true);
  assert.deepEqual(
    Uint8Array.from(rawJournalPresent.read.bytes),
    expectedJournalBytes,
  );
  rawJournalPresent.read.bytes.fill(0);
  assert.deepEqual(
    rawAdapters.journal.acquire(Object.freeze({ nonce: randomUUID() })),
    { status: "busy" },
  );
  rawJournalAcquired.lease.release();
  await nestedCredentialLease.lease.release();

  const publicJournalFirst = await first.journal.acquire(
    Object.freeze({ nonce: randomUUID() }),
  );
  assert.equal(publicJournalFirst.status, "acquired");
  if (publicJournalFirst.status !== "acquired") {
    assert.fail("public journal lease must be acquired");
  }
  const firstPublicObservation = await publicJournalFirst.lease.observe();
  assert.equal(firstPublicObservation.status, "present");
  if (firstPublicObservation.status !== "present") {
    assert.fail("public journal must observe the raw write");
  }
  assert.deepEqual(firstPublicObservation.bytes, expectedJournalBytes);
  assert.deepEqual(Reflect.ownKeys(firstPublicObservation.revision), []);
  await publicJournalFirst.lease.release();

  const publicJournalSecond = await first.journal.acquire(
    Object.freeze({ nonce: randomUUID() }),
  );
  assert.equal(publicJournalSecond.status, "acquired");
  if (publicJournalSecond.status !== "acquired") {
    assert.fail("second public journal lease must be acquired");
  }
  await assert.rejects(
    () =>
      publicJournalSecond.lease.remove(
        Object.freeze({ expected: firstPublicObservation.revision }),
      ),
    /invalid/iu,
    "journal revisions must remain bound to one lease",
  );
  const secondPublicObservation = await publicJournalSecond.lease.observe();
  assert.equal(secondPublicObservation.status, "present");
  if (secondPublicObservation.status !== "present") {
    assert.fail("second public journal observation must be present");
  }
  const replacementJournalBytes = new TextEncoder().encode(
    '{"kind":"host-reconciliation","stage":"verify"}\n',
  );
  const publicJournalReplaced = await publicJournalSecond.lease.replace(
    Object.freeze({
      bytes: replacementJournalBytes,
      expected: secondPublicObservation.revision,
    }),
  );
  assert.equal(publicJournalReplaced.status, "replaced");
  replacementJournalBytes.fill(0);
  if (publicJournalReplaced.status !== "replaced") {
    assert.fail("public journal replacement must succeed");
  }
  assert.deepEqual(
    await publicJournalSecond.lease.remove(
      Object.freeze({ expected: publicJournalReplaced.revision }),
    ),
    { status: "removed" },
  );
  await publicJournalSecond.lease.release();

  const rawAbandonedJournal = rawAdapters.journal.acquire(
    Object.freeze({ nonce: randomUUID() }),
  );
  assert.equal(rawAbandonedJournal.status, "acquired");
  rawAbandonedJournal.lease.abandon();

  const recoveredJournal = await first.journal.acquire(
    Object.freeze({ nonce: randomUUID() }),
  );
  assert.equal(recoveredJournal.status, "acquired");
  assert.equal(recoveredJournal.priorLease, "proven-abandoned");
  if (recoveredJournal.status !== "acquired") {
    assert.fail("abandoned journal lease must be recoverable");
  }
  assert.equal((await recoveredJournal.lease.observe()).status, "missing");
  await recoveredJournal.lease.release();
  expectedJournalBytes.fill(0);

  const incompleteRawObservation =
    rawAdapters.observation.openPrivateDirectory(
      credentialDirectory,
      Object.freeze({ noFollow: true }),
    );
  assert.equal(incompleteRawObservation.status, "opened");
  const incompleteDirectory = incompleteRawObservation.directory;
  incompleteDirectory.attest();
  const incompleteCredential = incompleteDirectory.observeEntry(
    Object.freeze({
      entry: Object.freeze({
        kind: "canonical",
        name: "credentials.json",
        role: "credential",
      }),
      noFollow: true,
    }),
  );
  assert.equal(incompleteCredential.status, "opened");
  assert.equal(
    incompleteDirectory.observeEntry(
      Object.freeze({
        entry: Object.freeze({
          kind: "canonical",
          name: "credentials-transaction.json",
          role: "transaction",
        }),
        noFollow: true,
      }),
    ).status,
    "missing",
  );
  assert.deepEqual(incompleteDirectory.listTemporaryEntries(), []);
  incompleteDirectory.attest();
  assert.throws(
    () => incompleteDirectory.finishObservation(),
    /failed|native|operation/iu,
    "raw evidence must require each opened file's semantic read protocol",
  );
  incompleteDirectory.close();

  const legacyOptions = Object.freeze({
    maxBytes: 16_384,
    noFollow: true,
  });
  assert.throws(
    () =>
      rawAdapters.legacy.read(
        "hermes",
        nativeConfiguration.legacyPaths.openclaw,
        legacyOptions,
      ),
    /invalid/iu,
    "raw legacy reads must remain bound to the configured source/path pair",
  );
  if (process.platform === "win32") {
    assert.deepEqual(
      rawAdapters.legacy.read(
        "hermes",
        nativeConfiguration.legacyPaths.hermes,
        legacyOptions,
      ),
      { status: "missing" },
    );
    assert.deepEqual(
      await first.legacy.read(
        "hermes",
        nativeConfiguration.legacyPaths.hermes,
        legacyOptions,
      ),
      { status: "missing" },
    );
  } else {
    const legacyDirectory = dirname(nativeConfiguration.legacyPaths.hermes);
    mkdirSync(legacyDirectory, { mode: 0o700 });
    chmodSync(legacyDirectory, 0o700);
    const legacyDocument = Buffer.from(
      JSON.stringify({
        api_key: credentialKey,
        api_url: "https://api.plurum.ai",
      }),
      "utf8",
    );
    writeFileSync(nativeConfiguration.legacyPaths.hermes, legacyDocument, {
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(nativeConfiguration.legacyPaths.hermes, 0o600);
    const rawLegacy = rawAdapters.legacy.read(
      "hermes",
      nativeConfiguration.legacyPaths.hermes,
      legacyOptions,
    );
    if (rawLegacy.status === "unsafe") {
      assert.equal(
        expectedTarget,
        "darwin-arm64",
        "only Darwin arm64 may inherit an unsafe host-managed temp ancestor",
      );
      assert.deepEqual(
        await first.legacy.read(
          "hermes",
          nativeConfiguration.legacyPaths.hermes,
          legacyOptions,
        ),
        { status: "unsafe" },
      );
      legacyDocument.fill(0);
    } else {
      assert.equal(rawLegacy.status, "loaded");
      assert.equal(sha256(rawLegacy.bytes), sha256(legacyDocument));
      rawLegacy.bytes.fill(0);

      let capturedRawLegacyBytes;
      const capturingLegacyAdapter = Object.freeze({
        read(...args) {
          const result = Reflect.apply(
            rawAdapters.legacy.read,
            rawAdapters.legacy,
            args,
          );
          if (result.status === "loaded") {
            capturedRawLegacyBytes = result.bytes;
          }
          return result;
        },
      });
      const capturingModule = Object.freeze({
        abiVersion: addon.abiVersion,
        createAdapters(configuration) {
          assert.deepEqual(configuration, nativeConfiguration);
          return Object.freeze({
            codexDotenv: rawAdapters.codexDotenv,
            journal: rawAdapters.journal,
            legacy: capturingLegacyAdapter,
            mutation: rawAdapters.mutation,
            observation: rawAdapters.observation,
            read: rawAdapters.read,
          });
        },
        magic: addon.magic,
        nodeApiVersion: addon.nodeApiVersion,
        packageVersion: addon.packageVersion,
        target: addon.target,
      });
      const capturingProvider = createNativeCredentialStoreProvider(
        expectedTarget,
        () => capturingModule,
        nativeConfiguration,
      );
      const capturingLoaded = capturingProvider.load();
      assert.equal(capturingLoaded.status, "available");
      const publicLegacy = await capturingLoaded.legacy.read(
        "hermes",
        nativeConfiguration.legacyPaths.hermes,
        legacyOptions,
      );
      assert.equal(publicLegacy.status, "loaded");
      assert.equal(sha256(publicLegacy.bytes), sha256(legacyDocument));
      assert.ok(capturedRawLegacyBytes instanceof Uint8Array);
      assert.equal(
        capturedRawLegacyBytes.every((byte) => byte === 0),
        true,
        "the native legacy buffer must be wiped by the public membrane",
      );
      publicLegacy.bytes.fill(0);
      legacyDocument.fill(0);

      writeFileSync(nativeConfiguration.legacyPaths.hermes, Buffer.alloc(0));
      assert.deepEqual(
        rawAdapters.legacy.read(
          "hermes",
          nativeConfiguration.legacyPaths.hermes,
          legacyOptions,
        ),
        { status: "malformed" },
      );
      writeFileSync(
        nativeConfiguration.legacyPaths.hermes,
        Buffer.alloc(16_385, 0x78),
      );
      assert.deepEqual(
        rawAdapters.legacy.read(
          "hermes",
          nativeConfiguration.legacyPaths.hermes,
          legacyOptions,
        ),
        { status: "malformed" },
      );
    }
  }

  const recovered = await recoverCredentialStore(
    Object.freeze({ storage: first.mutation, random }),
    locations,
  );
  assert.deepEqual(recovered, { status: "clean" });
  assert.equal(Object.isFrozen(recovered), true);

  const loaded = await readCredentialStore(first.read, locations);
  assert.equal(loaded.status, "loaded");
  if (loaded.status !== "loaded") {
    assert.fail("native credential readback must load the written document");
  }
  assert.ok(
    loaded.credential.api_key === credentialKey,
    "native credential key must round-trip without diagnostic rendering",
  );
  assert.equal(loaded.credential.agent_id, credential.agent_id);
  assert.equal(loaded.credential.api_origin, credential.api_origin);
  assert.equal(loaded.credential.agent_name, changedCredential.agent_name);
  assert.deepEqual(readdirSync(credentialDirectory).sort(), [
    "codex-dotenv.lock",
    "credentials.json",
    "host-reconciliation.lock",
    "setup.lock",
  ]);
}

function binaryName() {
  if (process.platform === "darwin") {
    return "libplurum_native_credential_store.dylib";
  }
  if (process.platform === "linux") {
    return "libplurum_native_credential_store.so";
  }
  if (process.platform === "win32") {
    return "plurum_native_credential_store.dll";
  }
  assert.fail(`unsupported ABI-test platform: ${process.platform}`);
}

function launcherName() {
  assert.equal(process.platform, "win32");
  return "plurum-medium-integrity-test-launcher.exe";
}

function isOutside(parent, candidate) {
  const difference = relative(parent, candidate);
  return (
    difference === ".." ||
    difference.startsWith(`..${sep}`) ||
    isAbsolute(difference)
  );
}

function assertSupportedWindowsRunner() {
  if (process.platform !== "win32") {
    return;
  }
  assert.equal(
    process.env.CI,
    "true",
    "Windows native ABI lifecycle verification requires CI=true",
  );
  assert.equal(
    process.env.GITHUB_ACTIONS,
    "true",
    "Windows native ABI lifecycle verification requires GITHUB_ACTIONS=true",
  );
}

function runParent(requestedFault) {
  assertSupportedWindowsRunner();
  if (requestedFault !== undefined) {
    assert.equal(
      parentFaultPoints.has(requestedFault),
      true,
      "native ABI fault point is invalid",
    );
  }
  const isolationRoot = verifiedIsolationRoot();
  const expectedTarget = requiredEnvironment("PLURUM_NATIVE_EXPECTED_TARGET");
  const expectedNode = requiredEnvironment("PLURUM_NATIVE_EXPECTED_NODE");
  const cargoTarget = isolatedDirectory(
    isolationRoot,
    "CARGO_TARGET_DIR",
    "cargo-target",
  );

  const realPackageRoot = realpathSync(packageRoot);
  const realCargoTarget = realpathSync(cargoTarget);
  assert.equal(
    isOutside(realPackageRoot, realCargoTarget),
    true,
    "native builds must stay outside the npm package",
  );

  const binary = binaryName();
  const binaryPath = join(realCargoTarget, "release", binary);
  const binaryAuthority = assertControlledCargoArtifact(
    binaryPath,
    realCargoTarget,
    binary,
    "Cargo native artifact",
  );

  const trustedTemporaryBase = realpathSync(join(isolationRoot, "tmp"));
  const runId = randomUUID();
  const credentialSecret = randomSecret("plrm_live_native_abi_");
  const outsideCanarySecret = randomSecret("plurum_native_outside_canary_");
  let lifecycleRoot;
  let outsideCanaryRoot;
  let sentinelPath;
  let outsideCanaryPath;
  let stagedPath;
  let stagedAddonAuthority;
  let lifecycleCleanupAuthority;
  let outsideCanaryCleanupAuthority;
  let outsideCanaryTree;
  let primaryError;
  const cleanupErrors = [];

  try {
    /*
     * No cleanup claim exists until the root sentinel and immutable authority
     * below are complete. An unexpected earlier failure deliberately retains
     * the disposable root for fail-closed inspection.
     */
    lifecycleRoot = mkdtempSync(
      join(trustedTemporaryBase, "plurum-native-abi-"),
    );
    assert.equal(
      realpathSync(lifecycleRoot),
      resolve(lifecycleRoot),
      "native ABI lifecycle root must stay direct",
    );
    sentinelPath = join(lifecycleRoot, ".plurum-native-abi-root");
    stagedPath = join(lifecycleRoot, "credential-store.node");
    if (process.platform !== "win32") {
      chmodSync(lifecycleRoot, 0o700);
    }
    const lifecycleRootMetadata = exactObjectIdentity(
      lifecycleRoot,
      "directory",
      "native ABI lifecycle root",
    );
    writeFileSync(sentinelPath, runId, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    if (process.platform !== "win32") {
      chmodSync(sentinelPath, 0o600);
    }
    const lifecycleSentinelAuthority = readBoundedDigest(
      sentinelPath,
      MAX_SENTINEL_BYTES,
      "native ABI lifecycle sentinel",
    );
    lifecycleCleanupAuthority = Object.freeze({
      root: Object.freeze({
        identity: lifecycleRootMetadata.identity,
        security: securityEvidence(lifecycleRootMetadata.metadata),
      }),
      sentinel: lifecycleSentinelAuthority,
    });
    injectParentFault("after-lifecycle-authority", requestedFault);

    outsideCanaryRoot = mkdtempSync(
      join(trustedTemporaryBase, "plurum-native-abi-canary-"),
    );
    assert.equal(
      realpathSync(outsideCanaryRoot),
      resolve(outsideCanaryRoot),
      "native ABI outside canary root must stay direct",
    );
    outsideCanaryPath = join(
      outsideCanaryRoot,
      ".plurum-native-abi-outside-canary",
    );
    if (process.platform !== "win32") {
      chmodSync(outsideCanaryRoot, 0o700);
    }
    const outsideCanaryRootMetadata = exactObjectIdentity(
      outsideCanaryRoot,
      "directory",
      "native ABI outside canary root",
    );
    writeFileSync(outsideCanaryPath, outsideCanarySecret, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    if (process.platform !== "win32") {
      chmodSync(outsideCanaryPath, 0o600);
    }
    const outsideCanarySentinelAuthority = readBoundedDigest(
      outsideCanaryPath,
      MAX_SENTINEL_BYTES,
      "native ABI outside canary",
    );
    outsideCanaryCleanupAuthority = Object.freeze({
      root: Object.freeze({
        identity: outsideCanaryRootMetadata.identity,
        security: securityEvidence(outsideCanaryRootMetadata.metadata),
      }),
      sentinel: outsideCanarySentinelAuthority,
    });
    injectParentFault("after-outside-authority", requestedFault);

    assert.equal(dirname(lifecycleRoot), trustedTemporaryBase);
    assert.equal(dirname(outsideCanaryRoot), trustedTemporaryBase);
    assert.equal(lifecycleRoot === outsideCanaryRoot, false);
    stagedAddonAuthority = copyPrivateRegularFile(
      binaryPath,
      stagedPath,
      binaryAuthority,
      "staged native credential addon",
    );
    const lifecycleEnvironment = lifecyclePathEnvironment(lifecycleRoot);
    createPrivateLifecyclePaths(lifecycleEnvironment);
    outsideCanaryTree = boundedDigestTree(outsideCanaryRoot);
    injectParentFault("after-outside-snapshot", requestedFault);

    const windowsLauncher =
      process.platform === "win32"
        ? regularFileFromPath(
            join(realCargoTarget, "release", launcherName()),
            "Windows medium-integrity ABI launcher",
          )
        : undefined;
    const childEnvironment = commandEnvironment(isolationRoot, {
      ...lifecycleEnvironment,
      PLURUM_NATIVE_EXPECTED_TARGET: expectedTarget,
      PLURUM_NATIVE_EXPECTED_NODE: expectedNode,
      PLURUM_NATIVE_STAGED_PATH: stagedPath,
      PLURUM_NATIVE_TEST_RUN_ID: runId,
      PLURUM_NATIVE_ABI_CREDENTIAL_SECRET: credentialSecret,
      ...(windowsLauncher === undefined
        ? {}
        : {
            PLURUM_NATIVE_ABI_NODE: realpathSync(process.execPath),
            PLURUM_NATIVE_ABI_RUN_ROOT: lifecycleRoot,
            RUNNER_TEMP: requiredEnvironment("RUNNER_TEMP"),
          }),
    });
    const result = spawnSync(
      windowsLauncher ?? process.execPath,
      windowsLauncher === undefined ? [scriptPath, "--child"] : [],
      {
        cwd: lifecycleRoot,
        env: childEnvironment,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        shell: false,
        timeout: 60_000,
      },
    );
    let childOutcomeError;
    try {
      assertChildOutputExcludesSecrets(result, [
        credentialSecret,
        outsideCanarySecret,
      ]);
      assert.equal(result.error, undefined, "ABI child must start successfully");
      assert.equal(
        result.status,
        0,
        `native ABI child failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    } catch (error) {
      childOutcomeError = error;
    }
    let stagedRevalidationError;
    try {
      assertExactStagedAddon(
        stagedPath,
        stagedAddonAuthority,
        "staged native credential addon after child exit",
      );
    } catch (error) {
      stagedRevalidationError = error;
    }
    if (childOutcomeError !== undefined) {
      if (stagedRevalidationError !== undefined) {
        throw new AggregateError(
          [childOutcomeError, stagedRevalidationError],
          "native ABI child and staged-addon revalidation failed",
        );
      }
      throw childOutcomeError;
    }
    if (stagedRevalidationError !== undefined) {
      throw stagedRevalidationError;
    }
    const lifecycleRootAfterChild = assertOriginalIdentity(
      lifecycleRoot,
      "directory",
      lifecycleCleanupAuthority.root.identity,
      "native ABI lifecycle root",
    );
    assertOriginalSecurity(
      lifecycleRootAfterChild,
      lifecycleCleanupAuthority.root.security,
      "native ABI lifecycle root",
    );
    assertExactBoundedFile(
      sentinelPath,
      lifecycleCleanupAuthority.sentinel,
      runId,
      "native ABI lifecycle sentinel",
    );
    const outsideCanaryRootAfterChild = assertOriginalIdentity(
      outsideCanaryRoot,
      "directory",
      outsideCanaryCleanupAuthority.root.identity,
      "native ABI outside canary root",
    );
    assertOriginalSecurity(
      outsideCanaryRootAfterChild,
      outsideCanaryCleanupAuthority.root.security,
      "native ABI outside canary root",
    );
    assertExactBoundedFile(
      outsideCanaryPath,
      outsideCanaryCleanupAuthority.sentinel,
      outsideCanarySecret,
      "native ABI outside canary",
    );
    assert.deepEqual(
      boundedDigestTree(outsideCanaryRoot),
      outsideCanaryTree,
      "native ABI child changed the outside canary tree",
    );
  } catch (error) {
    primaryError = error;
  } finally {
    if (
      lifecycleRoot !== undefined &&
      sentinelPath !== undefined &&
      lifecycleCleanupAuthority !== undefined
    ) {
      try {
        safeRemoveOwnedRoot({
          root: lifecycleRoot,
          rootAuthority: lifecycleCleanupAuthority.root,
          sentinelPath,
          sentinelAuthority: lifecycleCleanupAuthority.sentinel,
          sentinelContent: runId,
          trustedTemporaryBase,
          prefix: "plurum-native-abi-",
          label: "native ABI lifecycle root",
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
    } else if (lifecycleRoot !== undefined) {
      cleanupErrors.push(
        new Error(
          "native ABI lifecycle root retained: cleanup authority was incomplete",
        ),
      );
    }
    if (
      outsideCanaryRoot !== undefined &&
      outsideCanaryPath !== undefined &&
      outsideCanaryCleanupAuthority !== undefined
    ) {
      try {
        safeRemoveOwnedRoot({
          root: outsideCanaryRoot,
          rootAuthority: outsideCanaryCleanupAuthority.root,
          sentinelPath: outsideCanaryPath,
          sentinelAuthority: outsideCanaryCleanupAuthority.sentinel,
          sentinelContent: outsideCanarySecret,
          trustedTemporaryBase,
          prefix: "plurum-native-abi-canary-",
          label: "native ABI outside canary root",
          expectedTree: outsideCanaryTree,
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
    } else if (outsideCanaryRoot !== undefined) {
      cleanupErrors.push(
        new Error(
          "native ABI outside canary root retained: cleanup authority was incomplete",
        ),
      );
    }
    if (cleanupErrors.length === 0) {
      try {
        if (lifecycleRoot !== undefined) {
          assert.equal(
            pathExists(lifecycleRoot),
            false,
            "native ABI lifecycle root left cleanup residue",
          );
        }
        if (outsideCanaryRoot !== undefined) {
          assert.equal(
            pathExists(outsideCanaryRoot),
            false,
            "native ABI outside canary root left cleanup residue",
          );
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }

  if (primaryError !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        "native ABI verification and cleanup failed",
      );
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "native ABI cleanup failed");
  }
  console.log(
    `native credential ABI conforms for ${expectedTarget} on Node ${expectedNode}`,
  );
}

function runParentMatrix() {
  assertSupportedWindowsRunner();
  runParent();
  for (const point of parentFaultPoints) {
    assert.throws(
      () => runParent(point),
      (error) =>
        error instanceof InjectedParentFault && error.point === point,
      `native ABI cleanup fault ${point} must preserve its primary failure`,
    );
  }
  console.log("native credential ABI cleanup fault matrix conforms");
}

if (process.argv[2] === "--child") {
  await runChild();
} else {
  runParentMatrix();
}
