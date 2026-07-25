import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
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

const crateRoot = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));
const sourceWorkspaceRoot = realpathSync(resolve(crateRoot, "../../../.."));
const manifestPath = join(crateRoot, "Cargo.toml");
const isolationMarker = "plurum-native-isolation-v1\n";
const encodedRustflagSeparator = "\x1f";
const remappedSourceRoot = "/plurum/source";
const remappedIsolationRoot = "/plurum/native-isolation";
const processEvidenceManifestMarker =
  "plurum-native-process-evidence-manifest-v1";
const processEvidenceRunSentinel = "plurum-native-process-evidence-run-v1";
const processEvidenceExecutionMarker =
  "plurum-native-process-evidence-execution-v1\n";
const processEvidenceManifestName =
  ".plurum-native-process-evidence-manifest-v1.json";
const processEvidenceExecutionSentinelName =
  ".plurum-native-process-evidence-execution-v1";
const processEvidenceExecutionDirectoryPrefix =
  ".plurum-native-process-evidence-run-v1-";
const processEvidenceHarnessStagedName =
  "plurum-native-process-evidence-harness";
const processEvidenceProbeName = "plurum-native-process-test-probe";
const processEvidenceUniversalProbeName =
  "plurum-native-process-test-probe-universal";
const processEvidenceLibraryName = "plurum_native_credential_store";
const processEvidenceTestName =
  "runtime::supervisor::tests::native_process_evidence";
const processEvidencePackageName = "plurum-native-credential-store";
const processEvidencePackageVersion = "0.0.0-development";
const processEvidenceFeature = "test-support";
const processEvidenceMaximumArtifactBytes = 256 * 1024 * 1024;
const processEvidenceMaximumCargoOutputBytes = 32 * 1024 * 1024;
const processEvidenceMaximumLipoOutputBytes = 1024 * 1024;
const processEvidenceMaximumManifestBytes = 16 * 1024;
const macProcessEvidenceRustTargets = Object.freeze([
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
]);
const macProcessEvidenceArchitectureByRustTarget = Object.freeze({
  "aarch64-apple-darwin": "arm64",
  "x86_64-apple-darwin": "x86_64",
});

function isWithin(parent, candidate) {
  const difference = relative(parent, candidate);
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference))
  );
}

function isStrictDescendant(parent, candidate) {
  return parent !== candidate && isWithin(parent, candidate);
}

assert.equal(
  isWithin(sourceWorkspaceRoot, crateRoot),
  true,
  "native Cargo workspace must stay beneath the canonical source workspace",
);

function remapSourceSpellings(source) {
  const namespaced = toNamespacedPath(source);
  const spellings = new Set([source, namespaced]);
  for (const spelling of [...spellings]) {
    spellings.add(spelling.replaceAll("\\", "/"));
  }
  for (const spelling of [...spellings]) {
    const drive = /^(?:\\\\\?\\|\/\/\?\/)?[A-Za-z]:[\\/]/u.exec(spelling);
    if (drive !== null) {
      const driveIndex = drive[0].length - 3;
      const driveLetter = spelling[driveIndex];
      assert.ok(driveLetter !== undefined);
      spellings.add(
        `${spelling.slice(0, driveIndex)}${driveLetter.toLowerCase()}${spelling.slice(driveIndex + 1)}`,
      );
      spellings.add(
        `${spelling.slice(0, driveIndex)}${driveLetter.toUpperCase()}${spelling.slice(driveIndex + 1)}`,
      );
    }
  }
  return Object.freeze([...spellings]);
}

function compareRemapSources([left], [right]) {
  return (
    left.length - right.length || (left < right ? -1 : left > right ? 1 : 0)
  );
}

function encodedReleaseBuildRustFlags(mode, isolationRoot) {
  if (mode !== "build") {
    return undefined;
  }
  const remaps = Object.freeze(
    [
      ...remapSourceSpellings(sourceWorkspaceRoot).map((source) =>
        Object.freeze([source, remappedSourceRoot]),
      ),
      ...remapSourceSpellings(isolationRoot).map((source) =>
        Object.freeze([source, remappedIsolationRoot]),
      ),
    ].sort(compareRemapSources),
  );
  assert.equal(new Set(remaps.map(([source]) => source)).size, remaps.length);
  assert.deepEqual(
    new Set(remaps.map(([, target]) => target)),
    new Set([remappedSourceRoot, remappedIsolationRoot]),
  );
  const flags = remaps.map(([source, target]) => {
    assert.equal(isAbsolute(source), true, "remap source must be absolute");
    assert.equal(
      /[\r\n\0\x1f]/u.test(source),
      false,
      "remap source contains a forbidden delimiter",
    );
    assert.match(target, /^\/plurum\/[a-z-]+$/u);
    return `--remap-path-prefix=${source}=${target}`;
  });
  return flags.join(encodedRustflagSeparator);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.ok(value, `${name} must be set`);
  return value;
}

function verifiedIsolationRoot() {
  const configured = requiredEnvironment("PLURUM_NATIVE_ISOLATION_ROOT");
  const metadata = lstatSync(configured);
  assert.equal(metadata.isSymbolicLink(), false);
  assert.equal(metadata.isDirectory(), true);
  const root = realpathSync(configured);
  assert.equal(
    readFileSync(join(root, ".plurum-native-isolation"), "utf8"),
    isolationMarker,
  );
  return root;
}

function isolatedDirectory(root, environmentName, childName) {
  const configured = requiredEnvironment(environmentName);
  const metadata = lstatSync(configured);
  assert.equal(metadata.isSymbolicLink(), false);
  assert.equal(metadata.isDirectory(), true);
  assert.equal(realpathSync(configured), realpathSync(join(root, childName)));
  return realpathSync(configured);
}

function regularFile(path, label) {
  assert.equal(isAbsolute(path), true, `${label} must be absolute`);
  const metadata = lstatSync(path);
  assert.equal(metadata.isSymbolicLink(), false, `${label} must not be a symlink`);
  assert.equal(metadata.isFile(), true, `${label} must be a regular file`);
  return realpathSync(path);
}

function regularDirectory(path, label, allowLiteralSymlink = false) {
  assert.equal(isAbsolute(path), true, `${label} must be absolute`);
  const metadata = lstatSync(path);
  if (!allowLiteralSymlink) {
    assert.equal(
      metadata.isSymbolicLink(),
      false,
      `${label} must not be a symlink`,
    );
  }
  const resolved = realpathSync(path);
  const resolvedMetadata = lstatSync(resolved);
  assert.equal(
    resolvedMetadata.isSymbolicLink(),
    false,
    `${label} must resolve to a directory`,
  );
  assert.equal(
    resolvedMetadata.isDirectory(),
    true,
    `${label} must be a directory`,
  );
  return resolved;
}

function stableFileIdentity(metadata) {
  return Object.freeze({
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    mode: metadata.mode.toString(),
    nlink: metadata.nlink.toString(),
    size: metadata.size.toString(),
    mtimeNs: metadata.mtimeNs.toString(),
    ctimeNs: metadata.ctimeNs.toString(),
  });
}

function stableObjectIdentity(metadata) {
  return Object.freeze({
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    mode: metadata.mode.toString(),
    nlink: metadata.nlink.toString(),
  });
}

function stableDirectoryIdentity(metadata) {
  return Object.freeze({
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    mode: metadata.mode.toString(),
  });
}

function assertSameObjectIdentity(left, right, label) {
  assert.deepEqual(
    stableObjectIdentity(left),
    stableObjectIdentity(right),
    `${label} identity changed`,
  );
}

function captureProcessEvidenceArtifact(
  path,
  allowedRoot,
  label,
  requireSingleLink = true,
) {
  assert.equal(isAbsolute(path), true, `${label} path must be absolute`);
  const literalMetadata = lstatSync(path, { bigint: true });
  assert.equal(
    literalMetadata.isSymbolicLink(),
    false,
    `${label} must not be a symlink`,
  );
  assert.equal(
    literalMetadata.isFile(),
    true,
    `${label} must be a regular file`,
  );
  if (requireSingleLink) {
    assert.equal(literalMetadata.nlink, 1n, `${label} must have one link`);
  } else {
    assert.ok(literalMetadata.nlink > 0n, `${label} must have a live link`);
  }
  const canonicalPath = realpathSync(path);
  assert.equal(
    isStrictDescendant(allowedRoot, canonicalPath),
    true,
    `${label} must stay beneath its approved artifact root`,
  );

  const descriptor = openSync(canonicalPath, constants.O_RDONLY);
  let descriptorMetadata;
  let finalDescriptorMetadata;
  let digest;
  try {
    descriptorMetadata = fstatSync(descriptor, { bigint: true });
    assert.equal(
      descriptorMetadata.isFile(),
      true,
      `${label} descriptor must identify a regular file`,
    );
    assertSameObjectIdentity(
      literalMetadata,
      descriptorMetadata,
      `${label} literal and descriptor`,
    );
    assert.ok(descriptorMetadata.size > 0n, `${label} must not be empty`);
    assert.ok(
      descriptorMetadata.size <= BigInt(processEvidenceMaximumArtifactBytes),
      `${label} exceeds the fixed artifact byte bound`,
    );
    if (process.platform !== "win32") {
      assert.notEqual(
        descriptorMetadata.mode & 0o111n,
        0n,
        `${label} must be executable`,
      );
    }

    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let remaining = Number(descriptorMetadata.size);
    while (remaining > 0) {
      const requested = Math.min(remaining, chunk.byteLength);
      const bytesRead = readSync(descriptor, chunk, 0, requested, null);
      assert.ok(bytesRead > 0, `${label} ended before its attested size`);
      hash.update(chunk.subarray(0, bytesRead));
      remaining -= bytesRead;
    }
    assert.equal(
      readSync(descriptor, chunk, 0, 1, null),
      0,
      `${label} grew while it was hashed`,
    );
    finalDescriptorMetadata = fstatSync(descriptor, { bigint: true });
    assert.deepEqual(
      stableFileIdentity(finalDescriptorMetadata),
      stableFileIdentity(descriptorMetadata),
      `${label} changed while it was hashed`,
    );
    digest = hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }

  const finalLiteralMetadata = lstatSync(canonicalPath, { bigint: true });
  assert.deepEqual(
    stableFileIdentity(finalLiteralMetadata),
    stableFileIdentity(finalDescriptorMetadata),
    `${label} path changed after it was hashed`,
  );
  assert.match(digest, /^[0-9a-f]{64}$/u);
  return Object.freeze({
    path: canonicalPath,
    size: descriptorMetadata.size.toString(),
    sha256: digest,
    identity: stableFileIdentity(descriptorMetadata),
  });
}

function captureStableProcessEvidenceArtifact(
  path,
  allowedRoot,
  label,
  requireSingleLink = true,
) {
  const first = captureProcessEvidenceArtifact(
    path,
    allowedRoot,
    label,
    requireSingleLink,
  );
  const second = captureProcessEvidenceArtifact(
    path,
    allowedRoot,
    label,
    requireSingleLink,
  );
  assert.deepEqual(second, first, `${label} was not stable across captures`);
  return first;
}

function expectedProcessEvidenceProbeLayout(rustHost) {
  if (process.platform === "darwin" && process.env.CI === "true") {
    return Object.freeze({
      kind: "mach-o-universal",
      rustTargets: macProcessEvidenceRustTargets,
    });
  }
  return Object.freeze({
    kind: "thin",
    rustTargets: Object.freeze([rustHost]),
  });
}

function captureTrustedSystemLipo() {
  assert.equal(
    process.platform,
    "darwin",
    "the trusted system lipo is macOS-only",
  );
  const systemBin = realpathSync("/usr/bin");
  assert.equal(systemBin, "/usr/bin", "the trusted system bin path drifted");
  const lipo = captureStableProcessEvidenceArtifact(
    "/usr/bin/lipo",
    systemBin,
    "trusted system lipo",
    false,
  );
  assert.equal(lipo.path, "/usr/bin/lipo", "the trusted lipo path drifted");
  const metadata = lstatSync(lipo.path, { bigint: true });
  assert.deepEqual(
    stableFileIdentity(metadata),
    lipo.identity,
    "trusted system lipo identity drifted",
  );
  assert.equal(metadata.uid, 0n, "trusted system lipo must be root-owned");
  assert.equal(
    metadata.mode & 0o022n,
    0n,
    "trusted system lipo must not be group- or world-writable",
  );
  return lipo;
}

function runTrustedSystemLipo(arguments_, stateDirectory, label) {
  assert.ok(
    Array.isArray(arguments_) &&
      arguments_.length > 0 &&
      arguments_.every(
        (argument) =>
          typeof argument === "string" &&
          argument.length > 0 &&
          !/[\r\n\0]/u.test(argument),
      ),
    `${label} arguments are invalid`,
  );
  const canonicalStateDirectory = regularDirectory(
    stateDirectory,
    `${label} state directory`,
  );
  const lipoBefore = captureTrustedSystemLipo();
  const result = spawnSync(lipoBefore.path, arguments_, {
    cwd: canonicalStateDirectory,
    env: {
      HOME: canonicalStateDirectory,
      USERPROFILE: canonicalStateDirectory,
      XDG_CONFIG_HOME: canonicalStateDirectory,
      CFFIXED_USER_HOME: canonicalStateDirectory,
      TMPDIR: canonicalStateDirectory,
      TEMP: canonicalStateDirectory,
      TMP: canonicalStateDirectory,
      NO_COLOR: "1",
    },
    encoding: "utf8",
    maxBuffer: processEvidenceMaximumLipoOutputBytes,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    timeout: 60_000,
  });
  const lipoAfter = captureTrustedSystemLipo();
  assert.deepEqual(
    lipoAfter,
    lipoBefore,
    "trusted system lipo changed during execution",
  );
  assert.equal(result.error, undefined, `${label} must start`);
  assert.equal(result.signal, null, `${label} must not receive a signal`);
  assert.equal(result.status, 0, `${label} failed`);
  assert.equal(typeof result.stdout, "string", `${label} stdout must be text`);
  assert.equal(typeof result.stderr, "string", `${label} stderr must be text`);
  assert.ok(
    Buffer.byteLength(result.stdout, "utf8") <=
      processEvidenceMaximumLipoOutputBytes,
    `${label} stdout exceeded its fixed bound`,
  );
  assert.ok(
    Buffer.byteLength(result.stderr, "utf8") <=
      processEvidenceMaximumLipoOutputBytes,
    `${label} stderr exceeded its fixed bound`,
  );
  return Object.freeze({
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

function assertMacProcessEvidenceProbeLayout(
  path,
  allowedRoot,
  probeLayout,
  lipoStateDirectory,
  label,
) {
  assert.equal(
    process.platform,
    "darwin",
    `${label} Mach-O validation is macOS-only`,
  );
  assert.ok(
    probeLayout.kind === "thin" ||
      probeLayout.kind === "mach-o-universal",
    `${label} has an invalid Mach-O layout kind`,
  );
  const expectedArchitectures = probeLayout.rustTargets.map((rustTarget) => {
    assert.equal(
      Object.hasOwn(
        macProcessEvidenceArchitectureByRustTarget,
        rustTarget,
      ),
      true,
      `${label} has a non-macOS Rust target`,
    );
    return macProcessEvidenceArchitectureByRustTarget[rustTarget];
  });
  assert.equal(
    new Set(expectedArchitectures).size,
    expectedArchitectures.length,
    `${label} contains a duplicate architecture`,
  );
  assert.equal(
    probeLayout.kind === "thin",
    expectedArchitectures.length === 1,
    `${label} kind and architecture count disagree`,
  );

  const before = captureStableProcessEvidenceArtifact(
    path,
    allowedRoot,
    `${label} before Mach-O validation`,
  );
  const architectureResult = runTrustedSystemLipo(
    [before.path, "-archs"],
    lipoStateDirectory,
    `${label} architecture inspection`,
  );
  const architectures = architectureResult.stdout.trim().split(/\s+/u);
  assert.deepEqual(
    [...architectures].sort(),
    [...expectedArchitectures].sort(),
    `${label} architecture set drifted`,
  );
  assert.equal(
    new Set(architectures).size,
    architectures.length,
    `${label} contains a duplicate Mach-O slice`,
  );
  const verificationResult = runTrustedSystemLipo(
    [before.path, "-verify_arch", ...expectedArchitectures],
    lipoStateDirectory,
    `${label} architecture verification`,
  );
  assert.equal(
    verificationResult.stdout,
    "",
    `${label} architecture verification wrote to stdout`,
  );
  assert.deepEqual(
    captureStableProcessEvidenceArtifact(
      before.path,
      allowedRoot,
      `${label} after Mach-O validation`,
    ),
    before,
    `${label} changed during Mach-O validation`,
  );
  return before;
}

function assertPosixOwnerAndMode(metadata, mode, label) {
  assert.notEqual(
    process.platform,
    "win32",
    `${label} is valid only for POSIX process evidence`,
  );
  assert.equal(
    metadata.mode & 0o777n,
    BigInt(mode),
    `${label} permissions drifted`,
  );
  if (typeof process.getuid === "function") {
    assert.equal(metadata.uid, BigInt(process.getuid()), `${label} owner drifted`);
  }
}

function createPrivateProcessEvidenceExecutionDirectory(temporary) {
  assert.notEqual(
    process.platform,
    "win32",
    "private execution staging is POSIX-only",
  );
  const prefix = join(temporary, processEvidenceExecutionDirectoryPrefix);
  const created = mkdtempSync(prefix);
  let directoryDescriptor;
  let sentinelDescriptor;
  let sentinelCreated = false;
  try {
    assert.equal(
      dirname(created),
      temporary,
      "execution staging must be a direct child of isolated temporary storage",
    );
    chmodSync(created, 0o700);
    const literalMetadata = lstatSync(created, { bigint: true });
    assert.equal(literalMetadata.isSymbolicLink(), false);
    assert.equal(literalMetadata.isDirectory(), true);
    assertPosixOwnerAndMode(literalMetadata, 0o700, "execution directory");
    const canonical = realpathSync(created);
    assert.equal(canonical, created);
    assert.equal(dirname(canonical), temporary);
    assert.equal(
      canonical
        .slice(temporary.length + 1)
        .startsWith(processEvidenceExecutionDirectoryPrefix),
      true,
      "execution directory prefix drifted",
    );

    directoryDescriptor = openSync(
      canonical,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const descriptorMetadata = fstatSync(directoryDescriptor, { bigint: true });
    assertSameObjectIdentity(
      literalMetadata,
      descriptorMetadata,
      "execution directory",
    );
    assertPosixOwnerAndMode(
      descriptorMetadata,
      0o700,
      "execution directory descriptor",
    );

    const sentinelPath = join(
      canonical,
      processEvidenceExecutionSentinelName,
    );
    sentinelDescriptor = openSync(
      sentinelPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    sentinelCreated = true;
    writeFileSync(
      sentinelDescriptor,
      processEvidenceExecutionMarker,
      "utf8",
    );
    fchmodSync(sentinelDescriptor, 0o600);
    fsyncSync(sentinelDescriptor);
    const sentinelMetadata = fstatSync(sentinelDescriptor, { bigint: true });
    assert.equal(sentinelMetadata.isFile(), true);
    assert.equal(sentinelMetadata.nlink, 1n);
    assertPosixOwnerAndMode(
      sentinelMetadata,
      0o600,
      "execution sentinel",
    );
    closeSync(sentinelDescriptor);
    sentinelDescriptor = undefined;
    assert.deepEqual(
      stableFileIdentity(lstatSync(sentinelPath, { bigint: true })),
      stableFileIdentity(sentinelMetadata),
      "execution sentinel path changed",
    );
    fsyncSync(directoryDescriptor);

    return {
      path: canonical,
      descriptor: directoryDescriptor,
      identity: stableDirectoryIdentity(descriptorMetadata),
      sentinel: Object.freeze({
        path: sentinelPath,
        identity: stableFileIdentity(sentinelMetadata),
      }),
      artifacts: [],
    };
  } catch (error) {
    if (sentinelDescriptor !== undefined) {
      closeSync(sentinelDescriptor);
    }
    if (directoryDescriptor !== undefined) {
      closeSync(directoryDescriptor);
    }
    if (
      sentinelCreated &&
      existsSync(join(created, processEvidenceExecutionSentinelName))
    ) {
      unlinkSync(join(created, processEvidenceExecutionSentinelName));
    }
    if (existsSync(created) && readdirSync(created).length === 0) {
      rmdirSync(created);
    }
    throw error;
  }
}

function stageProcessEvidenceArtifact(
  sourceArtifact,
  cargoTarget,
  execution,
  destinationName,
  label,
) {
  assert.match(destinationName, /^[a-z][a-z0-9-]{0,95}$/u);
  const destination = join(execution.path, destinationName);
  assert.equal(dirname(destination), execution.path);
  const sourceBefore = captureStableProcessEvidenceArtifact(
    sourceArtifact.path,
    cargoTarget,
    `${label} source`,
  );
  assert.deepEqual(
    sourceBefore,
    sourceArtifact,
    `${label} source no longer matches its manifest`,
  );

  let sourceDescriptor;
  let destinationDescriptor;
  let destinationCreated = false;
  let destinationMetadata;
  let stagingError;
  try {
    sourceDescriptor = openSync(
      sourceArtifact.path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const sourceMetadata = fstatSync(sourceDescriptor, { bigint: true });
    assert.deepEqual(
      stableFileIdentity(sourceMetadata),
      sourceArtifact.identity,
      `${label} source descriptor identity drifted`,
    );
    destinationDescriptor = openSync(
      destination,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o700,
    );
    destinationCreated = true;

    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let remaining = Number(sourceMetadata.size);
    while (remaining > 0) {
      const requested = Math.min(remaining, chunk.byteLength);
      const bytesRead = readSync(
        sourceDescriptor,
        chunk,
        0,
        requested,
        null,
      );
      assert.ok(bytesRead > 0, `${label} source ended during staging`);
      hash.update(chunk.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const amount = writeSync(
          destinationDescriptor,
          chunk,
          written,
          bytesRead - written,
          null,
        );
        assert.ok(amount > 0, `${label} staging write made no progress`);
        written += amount;
      }
      remaining -= bytesRead;
    }
    assert.equal(
      readSync(sourceDescriptor, chunk, 0, 1, null),
      0,
      `${label} source grew during staging`,
    );
    assert.equal(
      hash.digest("hex"),
      sourceArtifact.sha256,
      `${label} staged bytes did not match the source digest`,
    );
    assert.deepEqual(
      stableFileIdentity(fstatSync(sourceDescriptor, { bigint: true })),
      sourceArtifact.identity,
      `${label} source changed during staging`,
    );

    fchmodSync(destinationDescriptor, 0o700);
    fsyncSync(destinationDescriptor);
    destinationMetadata = fstatSync(destinationDescriptor, { bigint: true });
    assert.equal(destinationMetadata.isFile(), true);
    assert.equal(destinationMetadata.nlink, 1n);
    assert.equal(destinationMetadata.size, sourceMetadata.size);
    assertPosixOwnerAndMode(
      destinationMetadata,
      0o700,
      `${label} staged descriptor`,
    );
  } catch (error) {
    stagingError = error;
  } finally {
    if (sourceDescriptor !== undefined) {
      closeSync(sourceDescriptor);
    }
    if (destinationDescriptor !== undefined) {
      closeSync(destinationDescriptor);
    }
  }
  if (stagingError !== undefined) {
    if (destinationCreated && existsSync(destination)) {
      const metadata = lstatSync(destination, { bigint: true });
      if (
        !metadata.isSymbolicLink() &&
        metadata.isFile() &&
        metadata.nlink === 1n
      ) {
        unlinkSync(destination);
        fsyncSync(execution.descriptor);
      }
    }
    throw stagingError;
  }

  try {
    assert.deepEqual(
      stableFileIdentity(lstatSync(destination, { bigint: true })),
      stableFileIdentity(destinationMetadata),
      `${label} staged path changed after copy`,
    );
    const staged = captureStableProcessEvidenceArtifact(
      destination,
      execution.path,
      `${label} staged artifact`,
    );
    assert.equal(staged.sha256, sourceArtifact.sha256);
    assert.equal(staged.size, sourceArtifact.size);
    assertPosixOwnerAndMode(
      lstatSync(staged.path, { bigint: true }),
      0o700,
      `${label} staged artifact`,
    );
    assert.deepEqual(
      captureStableProcessEvidenceArtifact(
        sourceArtifact.path,
        cargoTarget,
        `${label} source after staging`,
      ),
      sourceArtifact,
      `${label} source changed around staging`,
    );
    execution.artifacts.push(staged);
    fsyncSync(execution.descriptor);
    return staged;
  } catch (error) {
    if (destinationCreated && existsSync(destination)) {
      const metadata = lstatSync(destination, { bigint: true });
      if (
        !metadata.isSymbolicLink() &&
        metadata.isFile() &&
        metadata.nlink === 1n
      ) {
        unlinkSync(destination);
        fsyncSync(execution.descriptor);
      }
    }
    throw error;
  }
}

function cleanupPrivateProcessEvidenceExecutionDirectory(
  temporary,
  execution,
) {
  try {
    assert.equal(dirname(execution.path), temporary);
    assert.equal(realpathSync(execution.path), execution.path);
    const directoryMetadata = lstatSync(execution.path, { bigint: true });
    assert.equal(directoryMetadata.isSymbolicLink(), false);
    assert.equal(directoryMetadata.isDirectory(), true);
    assert.deepEqual(
      stableDirectoryIdentity(directoryMetadata),
      execution.identity,
      "execution directory identity changed before cleanup",
    );
    assert.deepEqual(
      stableDirectoryIdentity(
        fstatSync(execution.descriptor, { bigint: true }),
      ),
      execution.identity,
      "execution directory descriptor identity changed before cleanup",
    );
    assertPosixOwnerAndMode(
      directoryMetadata,
      0o700,
      "execution directory cleanup",
    );

    const expectedEntries = [
      processEvidenceExecutionSentinelName,
      ...execution.artifacts.map((artifact) =>
        artifact.path.slice(execution.path.length + 1),
      ),
    ].sort();
    assert.deepEqual(
      readdirSync(execution.path).sort(),
      expectedEntries,
      "execution directory contains an unexpected entry",
    );

    const sentinelDescriptor = openSync(
      execution.sentinel.path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const sentinelMetadata = fstatSync(sentinelDescriptor, { bigint: true });
      assert.deepEqual(
        stableFileIdentity(sentinelMetadata),
        execution.sentinel.identity,
        "execution sentinel identity changed",
      );
      assertPosixOwnerAndMode(
        sentinelMetadata,
        0o600,
        "execution sentinel cleanup",
      );
      assert.equal(
        readFileSync(sentinelDescriptor, "utf8"),
        processEvidenceExecutionMarker,
        "execution sentinel marker changed",
      );
    } finally {
      closeSync(sentinelDescriptor);
    }

    for (const artifact of execution.artifacts) {
      assert.equal(dirname(artifact.path), execution.path);
      assert.deepEqual(
        captureStableProcessEvidenceArtifact(
          artifact.path,
          execution.path,
          "staged process evidence cleanup artifact",
        ),
        artifact,
        "staged process evidence artifact changed during execution",
      );
      unlinkSync(artifact.path);
    }
    fsyncSync(execution.descriptor);
    assert.deepEqual(readdirSync(execution.path), [
      processEvidenceExecutionSentinelName,
    ]);
    unlinkSync(execution.sentinel.path);
    fsyncSync(execution.descriptor);
    assert.deepEqual(readdirSync(execution.path), []);
  } finally {
    closeSync(execution.descriptor);
  }
  rmdirSync(execution.path);
  assert.equal(
    existsSync(execution.path),
    false,
    "execution directory survived sentinel-bound cleanup",
  );
}

function retainPrivateProcessEvidenceExecutionDirectory(execution) {
  // An outer timeout proves only that the harness was killed. It cannot prove
  // that every descendant is gone, so close our authority handle and leave the
  // private, sentinel-bound directory untouched for disposable-host teardown.
  closeSync(execution.descriptor);
}

function assertNoCargoConfigInAncestors(directory) {
  let current = realpathSync(directory);
  for (;;) {
    const cargoDirectory = join(current, ".cargo");
    if (existsSync(cargoDirectory)) {
      const metadata = lstatSync(cargoDirectory);
      assert.equal(
        metadata.isSymbolicLink(),
        false,
        `Cargo config directory must not be a symlink: ${cargoDirectory}`,
      );
      for (const name of ["config", "config.toml"]) {
        assert.equal(
          existsSync(join(cargoDirectory, name)),
          false,
          `ambient Cargo config is forbidden: ${join(cargoDirectory, name)}`,
        );
      }
    }
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) {
      break;
    }
    current = parent;
  }
}

function assertNoCargoHomeConfig(cargoHome) {
  for (const name of ["config", "config.toml"]) {
    assert.equal(
      existsSync(join(cargoHome, name)),
      false,
      `isolated Cargo config is forbidden: ${join(cargoHome, name)}`,
    );
  }
}

function assertSingleLineEnvironmentValue(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.notEqual(value.length, 0, `${label} must not be empty`);
  assert.equal(
    /[\r\n\0]/u.test(value),
    false,
    `${label} contains an environment-file delimiter`,
  );
}

function assertProcessEvidenceOptIn(mode) {
  const optIn = requiredEnvironment("PLURUM_NATIVE_PROCESS_EVIDENCE");
  const row = `${process.platform}-${process.arch}-${requiredEnvironment(
    "PLURUM_NATIVE_RUST_HOST",
  )}`;
  const allowedRows = new Set([
    "darwin-arm64-aarch64-apple-darwin",
    "darwin-x64-x86_64-apple-darwin",
    "linux-arm64-aarch64-unknown-linux-gnu",
    "linux-x64-x86_64-unknown-linux-gnu",
    "win32-x64-x86_64-pc-windows-msvc",
  ]);
  assert.equal(
    allowedRows.has(row),
    true,
    `native process evidence is forbidden on unexpected row ${row}`,
  );

  if (process.env.CI === undefined) {
    // Local mode isolates paths and ambient configuration, not the caller's
    // operating-system identity. It is restricted to these audited test-only
    // artifacts and always requires an explicit trusted-source opt-in.
    assert.equal(process.env.GITHUB_ACTIONS, undefined);
    assert.equal(process.env.GITHUB_ENV, undefined);
    assert.equal(
      optIn,
      "local-disposable-v1",
      "local trusted-source process evidence requires its exact disposable opt-in",
    );
    if (mode === "process-evidence-run") {
      assert.notEqual(
        process.platform,
        "win32",
        "the isolated runner executes process evidence only on POSIX",
      );
    }
    return;
  }

  assert.equal(process.env.CI, "true");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(process.env.GITHUB_REPOSITORY, "dunelabsco/plurum");
  const expectedRunnerOs = {
    darwin: "macOS",
    linux: "Linux",
    win32: "Windows",
  }[process.platform];
  const expectedRunnerArchitecture = {
    arm64: "ARM64",
    x64: "X64",
  }[process.arch];
  assert.ok(expectedRunnerOs, "unexpected GitHub runner operating system");
  assert.ok(
    expectedRunnerArchitecture,
    "unexpected GitHub runner architecture",
  );
  assert.equal(process.env.RUNNER_OS, expectedRunnerOs);
  assert.equal(
    requiredEnvironment("RUNNER_ARCH"),
    expectedRunnerArchitecture,
    "GitHub runner architecture must match the executing Node/Rust row",
  );

  if (mode === "process-evidence-build") {
    assert.equal(
      optIn,
      "github-five-row-universal-macos-build-v1",
      "CI evidence build requires its exact universal-macOS five-row opt-in",
    );
    requiredEnvironment("GITHUB_ENV");
    return;
  }

  assert.notEqual(
    process.platform,
    "win32",
    "the isolated runner executes process evidence only on POSIX",
  );
  assert.equal(
    optIn,
    "github-posix-universal-macos-run-v1",
    "CI evidence execution requires its exact universal-macOS POSIX opt-in",
  );
}

function processEvidenceManifestPath(isolationRoot) {
  return join(
    isolationRoot,
    "tmp",
    processEvidenceManifestName,
  );
}

function readPrivateProcessEvidenceManifest(path, isolationRoot) {
  assert.equal(
    path,
    processEvidenceManifestPath(isolationRoot),
    "process evidence manifest must use its fixed isolation path",
  );
  const literalMetadata = lstatSync(path, { bigint: true });
  assert.equal(literalMetadata.isSymbolicLink(), false);
  assert.equal(literalMetadata.isFile(), true);
  assert.equal(literalMetadata.nlink, 1n);
  assert.ok(literalMetadata.size > 0n);
  assert.ok(
    literalMetadata.size <= BigInt(processEvidenceMaximumManifestBytes),
    "process evidence manifest is oversized",
  );
  if (process.platform !== "win32") {
    assert.equal(
      literalMetadata.mode & 0o777n,
      0o600n,
      "process evidence manifest permissions must be 0600",
    );
    if (typeof process.getuid === "function") {
      assert.equal(literalMetadata.uid, BigInt(process.getuid()));
    }
  }
  const canonicalPath = realpathSync(path);
  assert.equal(
    isStrictDescendant(isolationRoot, canonicalPath),
    true,
    "process evidence manifest escaped isolation",
  );

  const descriptor = openSync(canonicalPath, constants.O_RDONLY);
  let bytes;
  let descriptorMetadata;
  try {
    descriptorMetadata = fstatSync(descriptor, { bigint: true });
    assertSameObjectIdentity(
      literalMetadata,
      descriptorMetadata,
      "process evidence manifest",
    );
    assert.equal(descriptorMetadata.size, literalMetadata.size);
    bytes = Buffer.alloc(Number(descriptorMetadata.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const bytesRead = readSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      assert.ok(bytesRead > 0, "process evidence manifest ended early");
      offset += bytesRead;
    }
    assert.equal(
      readSync(descriptor, Buffer.alloc(1), 0, 1, null),
      0,
      "process evidence manifest grew while it was read",
    );
    assert.deepEqual(
      stableFileIdentity(fstatSync(descriptor, { bigint: true })),
      stableFileIdentity(descriptorMetadata),
      "process evidence manifest changed while it was read",
    );
  } finally {
    closeSync(descriptor);
  }
  assert.deepEqual(
    stableFileIdentity(lstatSync(canonicalPath, { bigint: true })),
    stableFileIdentity(descriptorMetadata),
    "process evidence manifest path changed while it was read",
  );
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed = JSON.parse(text);
  assert.equal(
    Object.getPrototypeOf(parsed),
    Object.prototype,
    "process evidence manifest must be an object",
  );
  return parsed;
}

function writePrivateProcessEvidenceManifest(
  path,
  isolationRoot,
  manifest,
) {
  assert.equal(path, processEvidenceManifestPath(isolationRoot));
  const serialized = `${JSON.stringify(manifest)}\n`;
  assert.ok(
    Buffer.byteLength(serialized, "utf8") <=
      processEvidenceMaximumManifestBytes,
    "process evidence manifest serialization is oversized",
  );
  const manifestDirectory = realpathSync(dirname(path));
  assert.equal(
    manifestDirectory,
    realpathSync(join(isolationRoot, "tmp")),
    "process evidence manifest directory drifted",
  );
  const temporaryPath = join(
    manifestDirectory,
    `${processEvidenceManifestName}.tmp-${process.pid}`,
  );
  let descriptor;
  let temporaryExists = false;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    temporaryExists = true;
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (process.platform !== "win32") {
      chmodSync(temporaryPath, 0o600);
    }
    renameSync(temporaryPath, path);
    temporaryExists = false;
    if (process.platform !== "win32") {
      const rootDescriptor = openSync(
        manifestDirectory,
        constants.O_RDONLY,
      );
      try {
        fsyncSync(rootDescriptor);
      } finally {
        closeSync(rootDescriptor);
      }
    }
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (temporaryExists) {
      unlinkSync(temporaryPath);
    }
  }
  assert.deepEqual(
    readPrivateProcessEvidenceManifest(path, isolationRoot),
    manifest,
    "atomic process evidence manifest did not round-trip",
  );
}

function appendRevalidatedGithubEnvironment(entries) {
  assert.equal(process.env.CI, "true");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  const runnerTemporary = regularDirectory(
    requiredEnvironment("RUNNER_TEMP"),
    "RUNNER_TEMP",
  );
  const configuredPath = requiredEnvironment("GITHUB_ENV");
  assert.equal(isAbsolute(configuredPath), true);
  const literalMetadata = lstatSync(configuredPath, { bigint: true });
  assert.equal(literalMetadata.isSymbolicLink(), false);
  assert.equal(literalMetadata.isFile(), true);
  assert.equal(literalMetadata.nlink, 1n);
  if (typeof process.getuid === "function") {
    assert.equal(literalMetadata.uid, BigInt(process.getuid()));
  }
  const canonicalPath = realpathSync(configuredPath);
  assert.equal(
    isStrictDescendant(runnerTemporary, canonicalPath),
    true,
    "GITHUB_ENV must remain beneath RUNNER_TEMP",
  );
  const lines = Object.entries(entries).map(([name, value]) => {
    assert.match(name, /^[A-Z][A-Z0-9_]*$/u);
    assertSingleLineEnvironmentValue(value, name);
    return `${name}=${value}`;
  });
  const descriptor = openSync(
    canonicalPath,
    constants.O_WRONLY | constants.O_APPEND,
  );
  try {
    assertSameObjectIdentity(
      literalMetadata,
      fstatSync(descriptor, { bigint: true }),
      "GITHUB_ENV",
    );
    writeFileSync(descriptor, `${lines.join("\n")}\n`, "utf8");
    fsyncSync(descriptor);
    assertSameObjectIdentity(
      literalMetadata,
      fstatSync(descriptor, { bigint: true }),
      "GITHUB_ENV",
    );
  } finally {
    closeSync(descriptor);
  }
  assertSameObjectIdentity(
    literalMetadata,
    lstatSync(canonicalPath, { bigint: true }),
    "GITHUB_ENV",
  );
}

function platformBuildEnvironment() {
  const environment =
    process.env.CI === undefined ? {} : { CI: process.env.CI };
  // The locked graph needs no ambient build tools. Pinned rustc discovers
  // MSVC through Windows APIs; Unix linkers live in the fixed system paths.
  if (process.platform === "win32") {
    const systemRoot = regularDirectory(
      requiredEnvironment("SystemRoot"),
      "SystemRoot",
    );
    const windowsDirectory = regularDirectory(
      requiredEnvironment("WINDIR"),
      "WINDIR",
    );
    assert.equal(windowsDirectory, systemRoot);
    const system32 = regularDirectory(
      join(systemRoot, "System32"),
      "System32",
    );
    return {
      environment: {
        ...environment,
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      },
      pathDirectories: [system32],
    };
  }
  return {
    environment,
    pathDirectories: [
      regularDirectory("/usr/bin", "/usr/bin"),
      regularDirectory("/bin", "/bin", true),
    ],
  };
}

function runCargoJson(cargoPath, arguments_, environment, cwd, label) {
  const result = spawnSync(cargoPath, arguments_, {
    cwd,
    env: environment,
    encoding: "utf8",
    maxBuffer: processEvidenceMaximumCargoOutputBytes,
    stdio: ["ignore", "pipe", "inherit"],
    shell: false,
    timeout: 15 * 60_000,
  });
  assert.equal(result.error, undefined, `${label} must start`);
  assert.equal(result.signal, null, `${label} must not receive a signal`);
  assert.equal(result.status, 0, `${label} failed`);
  assert.equal(typeof result.stdout, "string", `${label} must emit text JSON`);
  return result.stdout;
}

function assertExactCanonicalPath(actual, expected, label) {
  assert.equal(typeof actual, "string", `${label} must be a path`);
  assert.equal(isAbsolute(actual), true, `${label} must be absolute`);
  assert.equal(
    realpathSync(actual),
    realpathSync(expected),
    `${label} must identify its exact expected path`,
  );
}

function readProcessEvidenceMetadata(
  cargoPath,
  environment,
  neutralDirectory,
  cargoTarget,
) {
  const output = runCargoJson(
    cargoPath,
    [
      "metadata",
      "--frozen",
      "--offline",
      "--no-deps",
      "--format-version",
      "1",
      "--manifest-path",
      manifestPath,
    ],
    environment,
    neutralDirectory,
    "isolated process evidence metadata",
  );
  const metadata = JSON.parse(output);
  assertExactCanonicalPath(
    metadata.workspace_root,
    crateRoot,
    "Cargo metadata workspace root",
  );
  assertExactCanonicalPath(
    metadata.target_directory,
    cargoTarget,
    "Cargo metadata target directory",
  );
  assert.ok(Array.isArray(metadata.packages));
  const packages = metadata.packages.filter(
    (candidate) =>
      candidate.name === processEvidencePackageName &&
      candidate.version === processEvidencePackageVersion,
  );
  assert.equal(packages.length, 1, "expected one exact root Cargo package");
  const package_ = packages[0];
  assert.equal(package_.source, null);
  assertExactCanonicalPath(
    package_.manifest_path,
    manifestPath,
    "root Cargo manifest",
  );
  assert.deepEqual(
    package_.features[processEvidenceFeature],
    ["plurum-native-posix-syscall/test-support"],
    "test-support must expose only the fake probe's POSIX signal helper",
  );
  assert.deepEqual(package_.features.default, []);

  const probeTargets = package_.targets.filter(
    (target) => target.name === processEvidenceProbeName,
  );
  assert.equal(probeTargets.length, 1, "expected one exact probe target");
  const probeTarget = probeTargets[0];
  assert.deepEqual(probeTarget.kind, ["bin"]);
  assert.deepEqual(probeTarget.crate_types, ["bin"]);
  assert.deepEqual(probeTarget["required-features"], [
    processEvidenceFeature,
  ]);
  assert.equal(
    probeTarget.test,
    false,
    "the fake probe must not become a Cargo test target",
  );
  assertExactCanonicalPath(
    probeTarget.src_path,
    join(crateRoot, "src", "bin", "native-process-test-probe.rs"),
    "probe source",
  );

  const libraryTargets = package_.targets.filter(
    (target) => target.name === processEvidenceLibraryName,
  );
  assert.equal(libraryTargets.length, 1, "expected one exact library target");
  const libraryTarget = libraryTargets[0];
  assert.deepEqual(libraryTarget.kind, ["cdylib"]);
  assert.deepEqual(libraryTarget.crate_types, ["cdylib"]);
  assertExactCanonicalPath(
    libraryTarget.src_path,
    join(crateRoot, "src", "lib.rs"),
    "library source",
  );

  return Object.freeze({
    packageId: package_.id,
    probeTarget,
    libraryTarget,
  });
}

function parseCargoCompilerArtifacts(output, label) {
  return output
    .split(/\r?\n/u)
    .filter((line) => line.length !== 0)
    .map((line, index) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        assert.fail(
          `${label} emitted invalid JSON on line ${index + 1}: ${String(error)}`,
        );
      }
      assert.equal(
        Object.getPrototypeOf(message),
        Object.prototype,
        `${label} message ${index + 1} must be an object`,
      );
      assert.equal(typeof message.reason, "string");
      return message;
    })
    .filter((message) => message.reason === "compiler-artifact");
}

function exactDevelopmentProfile(test) {
  return Object.freeze({
    opt_level: "0",
    debuginfo: 2,
    debug_assertions: true,
    overflow_checks: true,
    test,
  });
}

function selectExactExecutableArtifact({
  artifacts,
  expectedPackageId,
  expectedTarget,
  expectedProfile,
  label,
}) {
  const matching = artifacts.filter(
    (artifact) =>
      artifact.package_id === expectedPackageId &&
      artifact.target?.name === expectedTarget.name &&
      typeof artifact.executable === "string",
  );
  assert.equal(
    matching.length,
    1,
    `${label} must produce one non-null executable`,
  );
  const artifact = matching[0];
  assert.deepEqual(
    artifact.target,
    expectedTarget,
    `${label} target metadata drifted`,
  );
  assert.deepEqual(
    artifact.profile,
    expectedProfile,
    `${label} profile drifted`,
  );
  assert.deepEqual(
    [...artifact.features].sort(),
    ["default", processEvidenceFeature],
    `${label} feature set drifted`,
  );
  assert.equal(typeof artifact.fresh, "boolean");
  assert.equal(typeof artifact.executable, "string");
  assertExactCanonicalPath(
    artifact.target.src_path,
    expectedTarget.src_path,
    `${label} source`,
  );
  return artifact.executable;
}

function buildProcessEvidenceProbe({
  cargoPath,
  environment,
  neutralDirectory,
  cargoTarget,
  metadata,
  rustTarget,
}) {
  if (rustTarget !== undefined) {
    assert.equal(
      process.platform,
      "darwin",
      "an explicit process-evidence probe target is macOS-only",
    );
    assert.equal(
      macProcessEvidenceRustTargets.includes(rustTarget),
      true,
      "the explicit process-evidence probe target is invalid",
    );
  }
  const label =
    rustTarget === undefined
      ? "isolated process evidence probe build"
      : `isolated ${rustTarget} process evidence probe build`;
  const arguments_ = [
    "build",
    "--frozen",
    "--offline",
    "--manifest-path",
    manifestPath,
    "--package",
    processEvidencePackageName,
    "--features",
    processEvidenceFeature,
    "--bin",
    processEvidenceProbeName,
    ...(rustTarget === undefined ? [] : ["--target", rustTarget]),
    "--message-format",
    "json-render-diagnostics",
  ];
  const artifacts = parseCargoCompilerArtifacts(
    runCargoJson(
      cargoPath,
      arguments_,
      environment,
      neutralDirectory,
      label,
    ),
    label,
  );
  const executable = selectExactExecutableArtifact({
    artifacts,
    expectedPackageId: metadata.packageId,
    expectedTarget: metadata.probeTarget,
    expectedProfile: exactDevelopmentProfile(false),
    label,
  });
  const executableSuffix = process.platform === "win32" ? ".exe" : "";
  const expectedPath =
    rustTarget === undefined
      ? join(
          cargoTarget,
          "debug",
          `${processEvidenceProbeName}${executableSuffix}`,
        )
      : join(
          cargoTarget,
          rustTarget,
          "debug",
          processEvidenceProbeName,
        );
  assertExactCanonicalPath(
    executable,
    expectedPath,
    `${label} executable`,
  );
  return captureStableProcessEvidenceArtifact(
    executable,
    cargoTarget,
    label,
  );
}

function createUniversalMacProcessEvidenceProbe(
  slices,
  probeLayout,
  cargoTarget,
) {
  assert.equal(process.platform, "darwin");
  assert.equal(process.env.CI, "true");
  assert.deepEqual(
    probeLayout,
    {
      kind: "mach-o-universal",
      rustTargets: macProcessEvidenceRustTargets,
    },
    "CI macOS must build the exact universal probe layout",
  );
  assert.deepEqual(
    [...slices.keys()],
    macProcessEvidenceRustTargets,
    "universal probe slices must use the exact target order",
  );

  const slicesBefore = macProcessEvidenceRustTargets.map((rustTarget) => {
    const slice = slices.get(rustTarget);
    assert.ok(slice, `the ${rustTarget} process-evidence slice is missing`);
    assert.deepEqual(
      assertMacProcessEvidenceProbeLayout(
        slice.path,
        cargoTarget,
        {
          kind: "thin",
          rustTargets: [rustTarget],
        },
        cargoTarget,
        `${rustTarget} process evidence probe slice`,
      ),
      slice,
      `${rustTarget} process evidence probe slice changed before lipo`,
    );
    return slice;
  });
  assert.equal(
    new Set(slicesBefore.map(({ path }) => path)).size,
    slicesBefore.length,
    "universal process-evidence slices must be distinct files",
  );

  const universalPath = join(
    cargoTarget,
    processEvidenceUniversalProbeName,
  );
  assert.equal(dirname(universalPath), cargoTarget);
  assert.equal(
    existsSync(universalPath),
    false,
    "the fixed universal process-evidence output must not preexist",
  );
  const lipoBefore = captureTrustedSystemLipo();
  const createResult = runTrustedSystemLipo(
    [
      ...slicesBefore.map(({ path }) => path),
      "-create",
      "-output",
      universalPath,
    ],
    cargoTarget,
    "universal process evidence probe creation",
  );
  assert.equal(
    createResult.stdout,
    "",
    "universal process evidence probe creation wrote to stdout",
  );
  chmodSync(universalPath, 0o700);
  const universal = captureStableProcessEvidenceArtifact(
    universalPath,
    cargoTarget,
    "universal process evidence probe",
  );
  assertPosixOwnerAndMode(
    lstatSync(universal.path, { bigint: true }),
    0o700,
    "universal process evidence probe",
  );
  assert.deepEqual(
    assertMacProcessEvidenceProbeLayout(
      universal.path,
      cargoTarget,
      probeLayout,
      cargoTarget,
      "universal process evidence probe",
    ),
    universal,
    "universal process evidence probe changed during validation",
  );
  for (const [index, rustTarget] of macProcessEvidenceRustTargets.entries()) {
    const after = captureStableProcessEvidenceArtifact(
      slicesBefore[index].path,
      cargoTarget,
      `${rustTarget} process evidence probe slice after lipo`,
    );
    assert.deepEqual(
      after,
      slicesBefore[index],
      `${rustTarget} process evidence probe slice changed during lipo`,
    );
  }
  assert.deepEqual(
    captureTrustedSystemLipo(),
    lipoBefore,
    "trusted system lipo changed around universal probe creation",
  );
  return universal;
}

function validateProcessEvidenceManifest(
  manifest,
  isolationRoot,
  cargoTarget,
  rustHost,
  toolchain,
) {
  assert.deepEqual(Object.keys(manifest).sort(), [
    "arch",
    "cargoTarget",
    "harness",
    "marker",
    "platform",
    "probe",
    "probeLayout",
    "rustHost",
    "toolchain",
    "version",
  ]);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.marker, processEvidenceManifestMarker);
  assert.equal(manifest.platform, process.platform);
  assert.equal(manifest.arch, process.arch);
  assert.equal(manifest.rustHost, rustHost);
  assert.equal(manifest.toolchain, toolchain);
  assert.equal(manifest.cargoTarget, cargoTarget);
  assert.equal(
    Object.getPrototypeOf(manifest.probeLayout),
    Object.prototype,
    "probeLayout must be an object",
  );
  assert.deepEqual(Object.keys(manifest.probeLayout).sort(), [
    "kind",
    "rustTargets",
  ]);
  assert.ok(
    manifest.probeLayout.kind === "thin" ||
      manifest.probeLayout.kind === "mach-o-universal",
    "probeLayout kind is invalid",
  );
  assert.ok(
    Array.isArray(manifest.probeLayout.rustTargets),
    "probeLayout Rust targets must be an array",
  );
  assert.deepEqual(
    manifest.probeLayout,
    expectedProcessEvidenceProbeLayout(rustHost),
    "process evidence probe layout does not match this exact row",
  );
  assert.equal(
    isStrictDescendant(isolationRoot, manifest.cargoTarget),
    true,
    "manifest Cargo target must remain inside isolation",
  );

  for (const [name, artifact] of [
    ["probe", manifest.probe],
    ["harness", manifest.harness],
  ]) {
    assert.deepEqual(Object.keys(artifact).sort(), [
      "identity",
      "path",
      "sha256",
      "size",
    ]);
    assert.deepEqual(Object.keys(artifact.identity).sort(), [
      "ctimeNs",
      "dev",
      "ino",
      "mode",
      "mtimeNs",
      "nlink",
      "size",
    ]);
    for (const value of Object.values(artifact.identity)) {
      assert.match(value, /^[0-9]+$/u);
    }
    assert.match(artifact.size, /^[1-9][0-9]*$/u);
    assert.equal(artifact.identity.size, artifact.size);
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/u);
    assertSingleLineEnvironmentValue(artifact.path, `${name} path`);
  }

  const probe = captureStableProcessEvidenceArtifact(
    manifest.probe.path,
    cargoTarget,
    "process evidence probe",
  );
  const harness = captureStableProcessEvidenceArtifact(
    manifest.harness.path,
    cargoTarget,
    "process evidence harness",
  );
  assert.deepEqual(probe, manifest.probe, "probe evidence did not revalidate");
  assert.deepEqual(
    harness,
    manifest.harness,
    "harness evidence did not revalidate",
  );
  if (process.platform === "darwin") {
    assert.deepEqual(
      assertMacProcessEvidenceProbeLayout(
        probe.path,
        cargoTarget,
        manifest.probeLayout,
        cargoTarget,
        "manifest process evidence probe",
      ),
      probe,
      "manifest process evidence probe changed during Mach-O validation",
    );
  }
  return Object.freeze({ probe, harness });
}

function processEvidenceGithubEntries(manifestPath_, manifest) {
  return Object.freeze({
    PLURUM_NATIVE_PROCESS_PROBE_PATH: manifest.probe.path,
    PLURUM_NATIVE_PROCESS_PROBE_SHA256: manifest.probe.sha256,
    PLURUM_NATIVE_PROCESS_HARNESS_PATH: manifest.harness.path,
    PLURUM_NATIVE_PROCESS_HARNESS_SHA256: manifest.harness.sha256,
    PLURUM_NATIVE_PROCESS_EVIDENCE_MANIFEST: manifestPath_,
    PLURUM_NATIVE_PROCESS_EVIDENCE_SENTINEL: processEvidenceRunSentinel,
  });
}

const mode = process.argv[2];
assert.ok(
  [
    "build",
    "clippy",
    "fetch",
    "fmt",
    "launcher",
    "msrv",
    "process-evidence-build",
    "process-evidence-run",
    "test",
  ].includes(mode),
  "expected one fixed isolated Cargo operation",
);
if (mode === "launcher") {
  assert.equal(
    process.platform,
    "win32",
    "the medium-integrity ABI launcher is Windows-only",
  );
}

const isolationRoot = verifiedIsolationRoot();
const cargoHome = isolatedDirectory(isolationRoot, "CARGO_HOME", "cargo-home");
const cargoTarget = isolatedDirectory(
  isolationRoot,
  "CARGO_TARGET_DIR",
  "cargo-target",
);
const rustupHome = isolatedDirectory(
  isolationRoot,
  "RUSTUP_HOME",
  "rustup-home",
);
const temporary = isolatedDirectory(
  isolationRoot,
  "TMPDIR",
  "tmp",
);
for (const temporaryEnvironment of ["TEMP", "TMP"]) {
  assert.equal(
    isolatedDirectory(isolationRoot, temporaryEnvironment, "tmp"),
    temporary,
    `${temporaryEnvironment} must name the exact isolated temporary directory`,
  );
}
const neutralDirectory = temporary;
const home = isolatedDirectory(isolationRoot, "HOME", "home");
assert.equal(
  isolatedDirectory(isolationRoot, "USERPROFILE", "home"),
  home,
  "USERPROFILE must name the exact isolated home directory",
);
const config = isolatedDirectory(
  isolationRoot,
  "XDG_CONFIG_HOME",
  "config",
);
const appData = isolatedDirectory(
  isolationRoot,
  "APPDATA",
  "config/appdata",
);
const localAppData = isolatedDirectory(
  isolationRoot,
  "LOCALAPPDATA",
  "config/localappdata",
);
const plurumHome = isolatedDirectory(
  isolationRoot,
  "PLURUM_HOME",
  "config/plurum",
);
const codexHome = isolatedDirectory(
  isolationRoot,
  "CODEX_HOME",
  "config/codex",
);
const claudeConfig = isolatedDirectory(
  isolationRoot,
  "CLAUDE_CONFIG_DIR",
  "config/claude",
);
assertNoCargoConfigInAncestors(neutralDirectory);
assertNoCargoHomeConfig(cargoHome);
if (
  mode === "process-evidence-build" ||
  mode === "process-evidence-run"
) {
  assertProcessEvidenceOptIn(mode);
}

let cargoPath;
let rustcPath;
let toolchain;
if (mode === "msrv") {
  const rustHost = requiredEnvironment("PLURUM_NATIVE_RUST_HOST");
  const executableSuffix = process.platform === "win32" ? ".exe" : "";
  const toolchainBin = join(
    rustupHome,
    "toolchains",
    `1.88.0-${rustHost}`,
    "bin",
  );
  cargoPath = regularFile(
    join(toolchainBin, `cargo${executableSuffix}`),
    "minimum-version Cargo",
  );
  rustcPath = regularFile(
    join(toolchainBin, `rustc${executableSuffix}`),
    "minimum-version rustc",
  );
  toolchain = "1.88.0";
} else {
  cargoPath = regularFile(
    requiredEnvironment("PLURUM_NATIVE_CARGO"),
    "pinned Cargo",
  );
  rustcPath = regularFile(
    requiredEnvironment("PLURUM_NATIVE_RUSTC"),
    "pinned rustc",
  );
  toolchain = requiredEnvironment("RUSTUP_TOOLCHAIN");
}

const operationArguments = {
  build: ["build", "--frozen", "--manifest-path", manifestPath, "--release"],
  clippy: [
    "clippy",
    "--frozen",
    "--manifest-path",
    manifestPath,
    "--workspace",
    "--all-targets",
    "--features",
    "plurum-native-credential-store/test-support",
    "--",
    "-D",
    "warnings",
  ],
  fetch: ["fetch", "--locked", "--manifest-path", manifestPath],
  fmt: [
    "fmt",
    "--all",
    "--manifest-path",
    manifestPath,
    "--",
    "--check",
  ],
  launcher: [
    "build",
    "--frozen",
    "--manifest-path",
    manifestPath,
    "--release",
    "--package",
    "plurum-windows-syscall",
    "--features",
    "test-support",
    "--bins",
  ],
  msrv: [
    "check",
    "--frozen",
    "--manifest-path",
    manifestPath,
    "--workspace",
    "--all-targets",
    "--features",
    "plurum-native-credential-store/test-support",
  ],
  test: [
    "test",
    "--frozen",
    "--manifest-path",
    manifestPath,
    "--workspace",
    "--all-targets",
  ],
}[mode];

const platformBuild = platformBuildEnvironment();
const releaseBuildRustFlags = encodedReleaseBuildRustFlags(mode, isolationRoot);
const environment = {
  ...platformBuild.environment,
  PATH: [
    ...new Set([
      dirname(cargoPath),
      dirname(rustcPath),
      ...platformBuild.pathDirectories,
    ]),
  ].join(delimiter),
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: config,
  APPDATA: appData,
  LOCALAPPDATA: localAppData,
  PLURUM_NATIVE_ISOLATION_ROOT: isolationRoot,
  PLURUM_HOME: plurumHome,
  CODEX_HOME: codexHome,
  CLAUDE_CONFIG_DIR: claudeConfig,
  CARGO_HOME: cargoHome,
  CARGO_TARGET_DIR: cargoTarget,
  RUSTUP_HOME: rustupHome,
  RUSTUP_TOOLCHAIN: toolchain,
  RUSTC: rustcPath,
  TMPDIR: temporary,
  TEMP: temporary,
  TMP: temporary,
  NO_COLOR: "1",
  ...(releaseBuildRustFlags === undefined
    ? {}
    : { CARGO_ENCODED_RUSTFLAGS: releaseBuildRustFlags }),
};
if (mode !== "fetch") {
  environment.CARGO_NET_OFFLINE = "true";
}

if (mode === "process-evidence-build") {
  const metadata = readProcessEvidenceMetadata(
    cargoPath,
    environment,
    neutralDirectory,
    cargoTarget,
  );
  const rustHost = requiredEnvironment("PLURUM_NATIVE_RUST_HOST");
  const probeLayout = expectedProcessEvidenceProbeLayout(rustHost);
  const probe =
    probeLayout.kind === "mach-o-universal"
      ? createUniversalMacProcessEvidenceProbe(
          new Map(
            probeLayout.rustTargets.map((rustTarget) => [
              rustTarget,
              buildProcessEvidenceProbe({
                cargoPath,
                environment,
                neutralDirectory,
                cargoTarget,
                metadata,
                rustTarget,
              }),
            ]),
          ),
          probeLayout,
          cargoTarget,
        )
      : buildProcessEvidenceProbe({
          cargoPath,
          environment,
          neutralDirectory,
          cargoTarget,
          metadata,
          rustTarget: undefined,
        });
  const harnessArtifacts = parseCargoCompilerArtifacts(
    runCargoJson(
      cargoPath,
      [
        "test",
        "--frozen",
        "--offline",
        "--manifest-path",
        manifestPath,
        "--package",
        processEvidencePackageName,
        "--features",
        processEvidenceFeature,
        "--lib",
        "--no-run",
        "--message-format",
        "json-render-diagnostics",
      ],
      environment,
      neutralDirectory,
      "isolated process evidence harness build",
    ),
    "isolated process evidence harness build",
  );
  const harnessPath = selectExactExecutableArtifact({
    artifacts: harnessArtifacts,
    expectedPackageId: metadata.packageId,
    expectedTarget: metadata.libraryTarget,
    expectedProfile: exactDevelopmentProfile(true),
    label: "process evidence harness",
  });
  const manifest = Object.freeze({
    version: 1,
    marker: processEvidenceManifestMarker,
    platform: process.platform,
    arch: process.arch,
    rustHost,
    toolchain,
    cargoTarget,
    probeLayout,
    probe,
    harness: captureStableProcessEvidenceArtifact(
      harnessPath,
      cargoTarget,
      "process evidence harness",
    ),
  });
  const evidenceManifestPath = processEvidenceManifestPath(isolationRoot);
  writePrivateProcessEvidenceManifest(
    evidenceManifestPath,
    isolationRoot,
    manifest,
  );
  validateProcessEvidenceManifest(
    readPrivateProcessEvidenceManifest(evidenceManifestPath, isolationRoot),
    isolationRoot,
    cargoTarget,
    rustHost,
    toolchain,
  );
  if (process.env.CI === "true") {
    appendRevalidatedGithubEnvironment(
      processEvidenceGithubEntries(evidenceManifestPath, manifest),
    );
  }
  console.log("isolated native process evidence artifacts passed");
} else if (mode === "process-evidence-run") {
  assert.notEqual(
    process.platform,
    "win32",
    "native process evidence execution is POSIX-only",
  );
  const evidenceManifestPath = processEvidenceManifestPath(isolationRoot);
  const manifest = readPrivateProcessEvidenceManifest(
    evidenceManifestPath,
    isolationRoot,
  );
  const artifacts = validateProcessEvidenceManifest(
    manifest,
    isolationRoot,
    cargoTarget,
    requiredEnvironment("PLURUM_NATIVE_RUST_HOST"),
    toolchain,
  );
  if (process.env.CI === "true") {
    for (const [name, expected] of Object.entries(
      processEvidenceGithubEntries(evidenceManifestPath, manifest),
    )) {
      assert.equal(
        requiredEnvironment(name),
        expected,
        `${name} did not survive GITHUB_ENV exactly`,
      );
    }
  }

  const execution =
    createPrivateProcessEvidenceExecutionDirectory(temporary);
  let processAttempted = false;
  let processCompletedSafely = false;
  try {
    const stagedProbe = stageProcessEvidenceArtifact(
      artifacts.probe,
      cargoTarget,
      execution,
      processEvidenceProbeName,
      "process evidence probe",
    );
    const stagedHarness = stageProcessEvidenceArtifact(
      artifacts.harness,
      cargoTarget,
      execution,
      processEvidenceHarnessStagedName,
      "process evidence harness",
    );
    if (process.platform === "darwin") {
      assert.deepEqual(
        assertMacProcessEvidenceProbeLayout(
          stagedProbe.path,
          execution.path,
          manifest.probeLayout,
          cargoTarget,
          "staged process evidence probe",
        ),
        stagedProbe,
        "staged process evidence probe changed during Mach-O validation",
      );
    }
    fsyncSync(execution.descriptor);

    processAttempted = true;
    const result = spawnSync(
      stagedHarness.path,
      [
        processEvidenceTestName,
        "--exact",
        "--ignored",
        "--test-threads=1",
      ],
      {
        cwd: neutralDirectory,
        env: {
          PLURUM_NATIVE_ISOLATION_ROOT: isolationRoot,
          PLURUM_NATIVE_PROCESS_TEST_PROBE: stagedProbe.path,
          PLURUM_NATIVE_PROCESS_EVIDENCE_SENTINEL:
            processEvidenceRunSentinel,
          TMPDIR: temporary,
          TEMP: temporary,
          TMP: temporary,
          NO_COLOR: "1",
        },
        stdio: ["ignore", "inherit", "inherit"],
        shell: false,
        timeout: 5 * 60_000,
        killSignal: "SIGKILL",
      },
    );
    const finalManifest = readPrivateProcessEvidenceManifest(
      evidenceManifestPath,
      isolationRoot,
    );
    assert.deepEqual(
      finalManifest,
      manifest,
      "process evidence manifest changed during execution",
    );
    validateProcessEvidenceManifest(
      finalManifest,
      isolationRoot,
      cargoTarget,
      requiredEnvironment("PLURUM_NATIVE_RUST_HOST"),
      toolchain,
    );
    assert.equal(
      result.error,
      undefined,
      "isolated native process evidence must start and finish on time",
    );
    assert.equal(
      result.signal,
      null,
      "isolated native process evidence must not receive a signal",
    );
    assert.equal(result.status, 0, "isolated native process evidence failed");
    processCompletedSafely = true;
    console.log("isolated native process evidence passed");
  } finally {
    if (!processAttempted || processCompletedSafely) {
      cleanupPrivateProcessEvidenceExecutionDirectory(temporary, execution);
    } else {
      retainPrivateProcessEvidenceExecutionDirectory(execution);
    }
  }
} else {
  const result = spawnSync(cargoPath, operationArguments, {
    cwd: neutralDirectory,
    env: environment,
    stdio: "inherit",
    shell: false,
    timeout: 15 * 60_000,
  });
  assert.equal(result.error, undefined, `isolated Cargo ${mode} must start`);
  assert.equal(result.status, 0, `isolated Cargo ${mode} failed`);
  console.log(`isolated Cargo ${mode} passed`);
}
