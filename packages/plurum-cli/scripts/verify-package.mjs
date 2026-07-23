import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  snapshotProtectedTrees,
  verifyPackagedCommandCore,
} from "./verify-packaged-command-core.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const npmCli = process.env.npm_execpath;

assert.ok(npmCli, "package verification must run through npm");

function readBoundedRegularFile(path, maxBytes, label) {
  const metadata = lstatSync(path);
  assert.equal(metadata.isSymbolicLink(), false, `${label} must not be a symlink`);
  assert.equal(metadata.isFile(), true, `${label} must be a regular file`);
  assert.equal(metadata.nlink, 1, `${label} must have one link`);
  assert.equal(
    metadata.size <= maxBytes,
    true,
    `${label} exceeded its byte limit`,
  );
  return readFileSync(path);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertBoundedContent(path, expected, maxBytes, label) {
  const actual = readBoundedRegularFile(path, maxBytes, label);
  const expectedBytes = Buffer.from(expected, "utf8");
  assert.equal(
    actual.byteLength === expectedBytes.byteLength &&
      digest(actual) === digest(expectedBytes),
    true,
    `${label} content changed`,
  );
}

function captureIdentity(path, kind, label) {
  const metadata = lstatSync(path);
  assert.equal(metadata.isSymbolicLink(), false, `${label} must not be a symlink`);
  assert.equal(
    kind === "directory" ? metadata.isDirectory() : metadata.isFile(),
    true,
    `${label} has the wrong kind`,
  );
  if (kind === "file") {
    assert.equal(metadata.nlink, 1, `${label} must have one link`);
  }
  return Object.freeze({ device: metadata.dev, inode: metadata.ino });
}

function assertIdentity(path, kind, expected, label) {
  const actual = captureIdentity(path, kind, label);
  assert.deepEqual(actual, expected, `${label} identity changed`);
}

function assertExactWindowsShim(path) {
  const actual = readBoundedRegularFile(
    path,
    16 * 1024,
    "installed Windows command shim",
  );
  const expected = Buffer.from(
    [
      "@ECHO off",
      "GOTO start",
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      ":start",
      "SETLOCAL",
      "CALL :find_dp0",
      "",
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ") ELSE (",
      '  SET "_prog=node"',
      "  SET PATHEXT=%PATHEXT:;.JS;=;%",
      ")",
      "",
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\..\\plurum\\dist\\index.js" %*',
      "",
    ].join("\r\n"),
    "utf8",
  );
  assert.equal(
    actual.byteLength === expected.byteLength && digest(actual) === digest(expected),
    true,
    "installed Windows command shim has an unexpected shape",
  );
}

function assertExactNodeShebang(path) {
  const actual = readBoundedRegularFile(
    path,
    1024 * 1024,
    "installed Node entrypoint",
  );
  const expected = Buffer.from("#!/usr/bin/env node\n", "utf8");
  assert.equal(
    actual.byteLength > expected.byteLength &&
      digest(actual.subarray(0, expected.byteLength)) === digest(expected),
    true,
    "installed entrypoint must use the exact Node shebang",
  );
}

const expectedFiles = [
  "LICENSE",
  "README.md",
  "dist/adapters/node/clock.js",
  "dist/adapters/node/credential-environment.js",
  "dist/adapters/node/hash.js",
  "dist/adapters/node/native-codex-dotenv.js",
  "dist/adapters/node/native-credential-package.js",
  "dist/adapters/node/native-credential-store.js",
  "dist/adapters/node/network.js",
  "dist/adapters/node/platform.js",
  "dist/adapters/node/process-runtime.js",
  "dist/adapters/node/production.js",
  "dist/adapters/node/random.js",
  "dist/adapters/node/setup-credential-input.js",
  "dist/adapters/node/setup-interaction.js",
  "dist/api/agent-registration.js",
  "dist/api/agent-username.js",
  "dist/api/agent-validation.js",
  "dist/api/reachability.js",
  "dist/cli.js",
  "dist/commands/doctor-contracts.js",
  "dist/commands/doctor-observation.js",
  "dist/commands/doctor-output.js",
  "dist/commands/doctor.js",
  "dist/commands/setup-apply-plan.js",
  "dist/commands/setup-approval.js",
  "dist/commands/setup-codex-projection-plan.js",
  "dist/commands/setup-confirmation.js",
  "dist/commands/setup-credential-input.js",
  "dist/commands/setup-credential-plan.js",
  "dist/commands/setup-credential-session.js",
  "dist/commands/setup-display.js",
  "dist/commands/setup-execution-authority.js",
  "dist/commands/setup-host-execution.js",
  "dist/commands/setup-output.js",
  "dist/commands/setup-preflight.js",
  "dist/commands/setup-registration-execution.js",
  "dist/commands/setup-secret-lease.js",
  "dist/commands/setup.js",
  "dist/commands/status-contracts.js",
  "dist/commands/status-observation.js",
  "dist/commands/status-output.js",
  "dist/commands/status.js",
  "dist/commands/types.js",
  "dist/commands/unavailable.js",
  "dist/credentials/codex-containment.js",
  "dist/credentials/discovery-paths.js",
  "dist/credentials/discovery.js",
  "dist/credentials/errors.js",
  "dist/credentials/fingerprint.js",
  "dist/credentials/codex-dotenv-contracts.js",
  "dist/credentials/codex-dotenv-projection.js",
  "dist/credentials/codex-dotenv-setup-observation.js",
  "dist/credentials/codex-dotenv-status.js",
  "dist/credentials/codex-dotenv.js",
  "dist/credentials/legacy-reader-contracts.js",
  "dist/credentials/legacy-reader.js",
  "dist/credentials/origin.js",
  "dist/credentials/paths.js",
  "dist/credentials/schema.js",
  "dist/credentials/store-codec.js",
  "dist/credentials/store-contracts.js",
  "dist/credentials/store-mutation-contracts.js",
  "dist/credentials/store-observation-contracts.js",
  "dist/credentials/store-observer.js",
  "dist/credentials/store-transaction.js",
  "dist/credentials/store-writer.js",
  "dist/credentials/store.js",
  "dist/data/strict-json-object.js",
  "dist/data/uint8-array.js",
  "dist/exit-codes.js",
  "dist/hosts/contracts.js",
  "dist/hosts/claude-code/adapter.js",
  "dist/hosts/claude-code/commands.js",
  "dist/hosts/claude-code/configuration.js",
  "dist/hosts/claude-code/contracts.js",
  "dist/hosts/claude-code/headers-helper.js",
  "dist/hosts/claude-code/output.js",
  "dist/hosts/codex/adapter.js",
  "dist/hosts/codex/commands.js",
  "dist/hosts/codex/configuration.js",
  "dist/hosts/codex/contracts.js",
  "dist/hosts/codex/output.js",
  "dist/hosts/discovery.js",
  "dist/hosts/errors.js",
  "dist/hosts/inspection.js",
  "dist/hosts/journal-codec.js",
  "dist/hosts/journal-contracts.js",
  "dist/hosts/mcp-verification.js",
  "dist/hosts/planner.js",
  "dist/hosts/privacy.js",
  "dist/hosts/process-policy.js",
  "dist/hosts/reconciler.js",
  "dist/hosts/status.js",
  "dist/hosts/version.js",
  "dist/index.js",
  "dist/json-output.js",
  "dist/registration/key-material.js",
  "dist/registration/state-machine.js",
  "dist/runtime.js",
  "dist/system/contracts.js",
  "dist/system/credential-environment.js",
  "dist/system/denied.js",
  "dist/system/errors.js",
  "dist/system/host-mutation-boundary.js",
  "dist/system/platform-snapshot.js",
  "dist/system/runtime-support.js",
  "dist/system/scopes.js",
  "dist/version.js",
  "package.json",
];

const trustedTemporaryBase = realpathSync(tmpdir());
let temporaryRoot;
let sentinelPath;
let runId;
let sentinelWritten = false;
let outsideRoot;
let outsideCanaryPath;
let outsideCanaryContent;
let outsideCanaryWritten = false;
let temporaryRootIdentity;
let sentinelIdentity;
let outsideRootIdentity;
let outsideCanaryIdentity;
let protectedTreeBefore;
let outsideTreeBefore;
let temporaryCleanupBaseline;
let outsideCleanupBaseline;
let primaryError;
const cleanupErrors = [];
try {
  temporaryRoot = mkdtempSync(
    join(trustedTemporaryBase, "plurum-cli-package-"),
  );
  temporaryRoot = realpathSync(temporaryRoot);
  temporaryRootIdentity = captureIdentity(
    temporaryRoot,
    "directory",
    "package test root",
  );
  outsideRoot = mkdtempSync(
    join(trustedTemporaryBase, "plurum-cli-package-canary-"),
  );
  outsideRoot = realpathSync(outsideRoot);
  outsideRootIdentity = captureIdentity(
    outsideRoot,
    "directory",
    "outside canary root",
  );
  runId = randomUUID();
  sentinelPath = join(temporaryRoot, ".plurum-test-root");
  outsideCanaryPath = join(outsideRoot, "outside-canary.txt");
  outsideCanaryContent = `outside-${randomUUID()}`;
  if (process.platform !== "win32") {
    chmodSync(temporaryRoot, 0o700);
    chmodSync(outsideRoot, 0o700);
  }
  writeFileSync(sentinelPath, runId, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  sentinelWritten = true;
  writeFileSync(outsideCanaryPath, outsideCanaryContent, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  outsideCanaryWritten = true;
  if (process.platform !== "win32") {
    chmodSync(sentinelPath, 0o600);
    chmodSync(outsideCanaryPath, 0o600);
  }
  sentinelIdentity = captureIdentity(
    sentinelPath,
    "file",
    "package test sentinel",
  );
  outsideCanaryIdentity = captureIdentity(
    outsideCanaryPath,
    "file",
    "outside package canary",
  );
  outsideTreeBefore = snapshotProtectedTrees([outsideRoot]);
  outsideCleanupBaseline = outsideTreeBefore;

  const artifactDirectory = join(temporaryRoot, "artifact");
  const cacheDirectory = join(temporaryRoot, "npm-cache");
  const configDirectory = join(temporaryRoot, "config");
  const homeDirectory = join(temporaryRoot, "home");
  const installDirectory = join(temporaryRoot, "install");
  const neutralDirectory = join(temporaryRoot, "neutral");
  const codexDirectory = join(configDirectory, "codex");
  const claudeDirectory = join(configDirectory, "claude");
  const plurumDirectory = join(configDirectory, "plurum");
  const executablePath = [
    dirname(process.execPath),
    ...(process.platform === "win32"
      ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32")]
      : []),
  ].join(delimiter);

  mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(homeDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(neutralDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(codexDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(claudeDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(plurumDirectory, { recursive: true, mode: 0o700 });

  const childEnvironment = {
    PATH: executablePath,
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    PATHEXT: process.env.PATHEXT,
    WINDIR: process.env.WINDIR,
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
    XDG_CONFIG_HOME: configDirectory,
    XDG_STATE_HOME: configDirectory,
    APPDATA: configDirectory,
    LOCALAPPDATA: configDirectory,
    CODEX_HOME: codexDirectory,
    CLAUDE_CONFIG_DIR: claudeDirectory,
    PLURUM_HOME: plurumDirectory,
    PLURUM_TEST_ROOT: temporaryRoot,
    PLURUM_TEST_RUN_ID: runId,
    TMPDIR: temporaryRoot,
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    CI: "true",
    NO_COLOR: "1",
    npm_config_cache: cacheDirectory,
    npm_config_globalconfig: join(configDirectory, "global-npmrc"),
    npm_config_userconfig: join(configDirectory, "npmrc"),
    npm_config_update_notifier: "false",
  };
  function runNpm(
    arguments_,
    expectedStatus = 0,
    cwd = packageRoot,
    environmentOverrides = {},
  ) {
    const result = spawnSync(process.execPath, [npmCli, ...arguments_], {
      cwd,
      env: { ...childEnvironment, ...environmentOverrides },
      encoding: "utf8",
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      shell: false,
      timeout: 120_000,
    });

    assert.equal(result.error, undefined, "npm process must start successfully");
    assert.equal(
      result.status,
      expectedStatus,
      `npm command failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    return result;
  }

  const packed = runNpm([
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    artifactDirectory,
    "--cache",
    cacheDirectory,
  ]);
  const packResults = JSON.parse(packed.stdout);

  assert.equal(packResults.length, 1);
  assert.deepEqual(
    packResults[0].files.map(({ path }) => path).sort(),
    [...expectedFiles].sort(),
  );
  assert.equal(
    packResults[0].files.some(({ path }) => path.endsWith(".node")),
    false,
    "the boundary slice must not ship a native binary",
  );

  const archivePath = join(artifactDirectory, packResults[0].filename);
  assert.ok(existsSync(archivePath), "npm pack must create the expected archive");

  runNpm([
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--offline",
    "--prefix",
    installDirectory,
    "--cache",
    cacheDirectory,
    archivePath,
  ], 0, neutralDirectory);

  const installedShim = join(
    installDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "plurum.cmd" : "plurum",
  );
  assert.ok(existsSync(installedShim), "npm install must create the Plurum shim");
  const installedEntrypoint = join(
    installDirectory,
    "node_modules",
    "plurum",
    "dist",
    "index.js",
  );
  assert.ok(
    existsSync(installedEntrypoint),
    "npm install must include the Plurum entrypoint",
  );
  const installedPackage = realpathSync(
    join(installDirectory, "node_modules", "plurum"),
  );
  let installedPackageMetadata;
  try {
    installedPackageMetadata = JSON.parse(
      readBoundedRegularFile(
        join(installedPackage, "package.json"),
        64 * 1024,
        "installed package metadata",
      ).toString("utf8"),
    );
  } catch {
    throw new Error("installed package metadata is invalid");
  }
  assert.equal(installedPackageMetadata.name, "plurum");
  assert.equal(installedPackageMetadata.version, "0.0.0-development");
  assert.equal(installedPackageMetadata.private, true);
  assert.equal(installedPackageMetadata.type, "module");
  assert.deepEqual(installedPackageMetadata.exports, {});
  assert.deepEqual(installedPackageMetadata.engines, {
    node: "^22.12.0 || ^24.0.0",
  });
  assert.deepEqual(installedPackageMetadata.bin, {
    plurum: "./dist/index.js",
  });
  assertExactNodeShebang(installedEntrypoint);
  if (process.platform === "win32") {
    assertExactWindowsShim(installedShim);
  } else {
    assert.equal(realpathSync(installedShim), realpathSync(installedEntrypoint));
  }

  const fakeBin = join(temporaryRoot, "fake-host-bin");
  mkdirSync(fakeBin, { mode: 0o700 });
  if (process.platform !== "win32") {
    chmodSync(fakeBin, 0o700);
  }
  for (const executable of [join(fakeBin, "claude"), join(fakeBin, "codex")]) {
    writeFileSync(executable, "inert packaged-command-core host\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o700,
    });
    if (process.platform !== "win32") {
      chmodSync(executable, 0o700);
    }
  }
  protectedTreeBefore = snapshotProtectedTrees([temporaryRoot]);
  temporaryCleanupBaseline = protectedTreeBefore;

  await verifyPackagedCommandCore({
    testRoot: temporaryRoot,
    installedPackage,
    neutralDirectory,
    homeDirectory,
    configDirectory,
    sentinelPath,
    runId,
    outsideCanaryPath,
  });
  assert.deepEqual(
    snapshotProtectedTrees([temporaryRoot]),
    protectedTreeBefore,
    "installed command execution changed the protected test root",
  );
  assert.deepEqual(
    snapshotProtectedTrees([outsideRoot]),
    outsideTreeBefore,
    "installed command execution changed the outside canary tree",
  );

  for (const path of [
    homeDirectory,
    neutralDirectory,
    codexDirectory,
    claudeDirectory,
    plurumDirectory,
  ]) {
    assert.deepEqual(readdirSync(path), [], `${path} must remain empty`);
  }
  assert.deepEqual(readdirSync(configDirectory).sort(), [
    "claude",
    "codex",
    "plurum",
  ]);

} catch (error) {
  primaryError = error;
  if (temporaryRoot !== undefined && existsSync(temporaryRoot)) {
    try {
      temporaryCleanupBaseline = snapshotProtectedTrees([temporaryRoot]);
    } catch {
      cleanupErrors.push(
        new Error("package test root has no safe cleanup snapshot"),
      );
    }
  }
  if (outsideRoot !== undefined && existsSync(outsideRoot)) {
    try {
      outsideCleanupBaseline = snapshotProtectedTrees([outsideRoot]);
    } catch {
      cleanupErrors.push(
        new Error("outside canary root has no safe cleanup snapshot"),
      );
    }
  }
} finally {
  if (temporaryRoot !== undefined) {
    try {
      assert.equal(realpathSync(temporaryRoot), temporaryRoot);
      const rootMetadata = lstatSync(temporaryRoot);
      assert.equal(rootMetadata.isDirectory(), true);
      assert.equal(rootMetadata.isSymbolicLink(), false);
      if (process.platform !== "win32") {
        assert.equal(rootMetadata.uid, process.getuid?.());
        assert.equal(rootMetadata.mode & 0o077, 0);
      }
      assert.ok(
        temporaryRootIdentity !== undefined,
        "package test root has no original identity",
      );
      assertIdentity(
        temporaryRoot,
        "directory",
        temporaryRootIdentity,
        "package test root",
      );
      if (sentinelWritten) {
        assert.ok(sentinelPath !== undefined && runId !== undefined);
        const sentinelMetadata = lstatSync(sentinelPath);
        assert.equal(sentinelMetadata.isFile(), true);
        assert.equal(sentinelMetadata.isSymbolicLink(), false);
        assert.equal(sentinelMetadata.nlink, 1);
        assertBoundedContent(
          sentinelPath,
          runId,
          256,
          "package test sentinel",
        );
        assert.ok(sentinelIdentity !== undefined);
        assertIdentity(
          sentinelPath,
          "file",
          sentinelIdentity,
          "package test sentinel",
        );
        if (process.platform !== "win32") {
          assert.equal(sentinelMetadata.uid, process.getuid?.());
          assert.equal(sentinelMetadata.mode & 0o077, 0);
        }
      }
      assert.ok(
        temporaryCleanupBaseline !== undefined,
        "package test root has no validated cleanup baseline",
      );
      assert.deepEqual(
        snapshotProtectedTrees([temporaryRoot]),
        temporaryCleanupBaseline,
        "protected package tree changed during execution",
      );
      rmSync(temporaryRoot, { recursive: true, force: false });
      assert.equal(existsSync(temporaryRoot), false);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (outsideRoot !== undefined) {
    try {
      assert.equal(realpathSync(outsideRoot), outsideRoot);
      const outsideRootMetadata = lstatSync(outsideRoot);
      assert.equal(outsideRootMetadata.isDirectory(), true);
      assert.equal(outsideRootMetadata.isSymbolicLink(), false);
      if (process.platform !== "win32") {
        assert.equal(outsideRootMetadata.uid, process.getuid?.());
        assert.equal(outsideRootMetadata.mode & 0o077, 0);
      }
      assert.ok(
        outsideRootIdentity !== undefined,
        "outside canary root has no original identity",
      );
      assertIdentity(
        outsideRoot,
        "directory",
        outsideRootIdentity,
        "outside canary root",
      );
      if (outsideCanaryWritten) {
        assert.ok(
          outsideCanaryPath !== undefined &&
            outsideCanaryContent !== undefined,
        );
        const outsideCanaryMetadata = lstatSync(outsideCanaryPath);
        assert.equal(outsideCanaryMetadata.isFile(), true);
        assert.equal(outsideCanaryMetadata.isSymbolicLink(), false);
        assert.equal(outsideCanaryMetadata.nlink, 1);
        assertBoundedContent(
          outsideCanaryPath,
          outsideCanaryContent,
          256,
          "outside package canary",
        );
        assert.ok(outsideCanaryIdentity !== undefined);
        assertIdentity(
          outsideCanaryPath,
          "file",
          outsideCanaryIdentity,
          "outside package canary",
        );
        if (process.platform !== "win32") {
          assert.equal(outsideCanaryMetadata.uid, process.getuid?.());
          assert.equal(outsideCanaryMetadata.mode & 0o077, 0);
        }
      }
      assert.ok(
        outsideCleanupBaseline !== undefined,
        "outside canary root has no validated cleanup baseline",
      );
      assert.deepEqual(
        snapshotProtectedTrees([outsideRoot]),
        outsideCleanupBaseline,
        "outside canary tree changed during execution",
      );
      rmSync(outsideRoot, { recursive: true, force: false });
      assert.equal(existsSync(outsideRoot), false);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
}

if (primaryError !== undefined) {
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      "package verification and cleanup failed",
    );
  }
  throw primaryError;
}
if (cleanupErrors.length > 0) {
  throw new AggregateError(cleanupErrors, "package verifier cleanup failed");
}
process.stdout.write("package artifact verified\n");
