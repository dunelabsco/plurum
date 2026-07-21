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
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const npmCli = process.env.npm_execpath;

assert.ok(npmCli, "package verification must run through npm");

const expectedFiles = [
  "LICENSE",
  "README.md",
  "dist/adapters/node/clock.js",
  "dist/adapters/node/credential-environment.js",
  "dist/adapters/node/hash.js",
  "dist/adapters/node/native-credential-store.js",
  "dist/adapters/node/network.js",
  "dist/adapters/node/platform.js",
  "dist/adapters/node/production.js",
  "dist/adapters/node/random.js",
  "dist/api/agent-registration.js",
  "dist/api/agent-validation.js",
  "dist/cli.js",
  "dist/commands/doctor.js",
  "dist/commands/setup-approval.js",
  "dist/commands/setup-credential-plan.js",
  "dist/commands/setup-output.js",
  "dist/commands/setup-preflight.js",
  "dist/commands/setup.js",
  "dist/commands/status.js",
  "dist/commands/types.js",
  "dist/commands/unavailable.js",
  "dist/credentials/discovery-paths.js",
  "dist/credentials/discovery.js",
  "dist/credentials/errors.js",
  "dist/credentials/fingerprint.js",
  "dist/credentials/codex-dotenv-contracts.js",
  "dist/credentials/codex-dotenv-projection.js",
  "dist/credentials/codex-dotenv.js",
  "dist/credentials/legacy-reader-contracts.js",
  "dist/credentials/legacy-reader.js",
  "dist/credentials/origin.js",
  "dist/credentials/paths.js",
  "dist/credentials/schema.js",
  "dist/credentials/store-codec.js",
  "dist/credentials/store-contracts.js",
  "dist/credentials/store-mutation-contracts.js",
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
  "dist/hosts/planner.js",
  "dist/hosts/privacy.js",
  "dist/hosts/process-policy.js",
  "dist/hosts/reconciler.js",
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
  "dist/system/scopes.js",
  "dist/version.js",
  "package.json",
];

const trustedTemporaryBase = realpathSync(tmpdir());
const temporaryRoot = realpathSync(
  mkdtempSync(join(trustedTemporaryBase, "plurum-cli-package-")),
);
const runId = randomUUID();
const sentinelPath = join(temporaryRoot, ".plurum-test-root");
if (process.platform !== "win32") {
  chmodSync(temporaryRoot, 0o700);
}
writeFileSync(sentinelPath, runId, { encoding: "utf8", flag: "wx", mode: 0o600 });
if (process.platform !== "win32") {
  chmodSync(sentinelPath, 0o600);
}

try {
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

  function runInstalled(
    arguments_,
    expectedStatus = 0,
    environmentOverrides = {},
  ) {
    const result = spawnSync(installedShim, arguments_, {
      cwd: neutralDirectory,
      env: { ...childEnvironment, ...environmentOverrides },
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      shell: process.platform === "win32",
      timeout: 120_000,
    });
    assert.equal(result.error, undefined, "installed CLI must start successfully");
    assert.equal(
      result.status,
      expectedStatus,
      `installed CLI failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    return result;
  }

  const version = runInstalled(["--version"]);
  assert.equal(version.stdout, "0.0.0-development\n");

  const help = runInstalled(["--help"]);
  assert.match(help.stdout, /^plurum — connect Claude Code and Codex to Plurum/m);
  assert.match(help.stdout, /^  setup /m);
  assert.match(help.stdout, /^  status /m);
  assert.match(help.stdout, /^  doctor /m);

  const invalid = runInstalled(["setup", "--json"], 2);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /Invalid arguments/);

  const missingApproval = runInstalled(
    ["setup", "--api-key-stdin"],
    2,
  );
  assert.equal(missingApproval.stdout, "");
  assert.match(missingApproval.stderr, /Invalid arguments/);

  const dryRunApproval = runInstalled(
    ["setup", "--dry-run", "--yes"],
    2,
  );
  assert.equal(dryRunApproval.stdout, "");
  assert.match(dryRunApproval.stderr, /Invalid arguments/);

  const setupHelp = runInstalled(["setup", "--help"]);
  assert.match(setupHelp.stdout, /--api-key-stdin\s+reserve stdin as the API-key source \(requires --yes\)/);
  assert.match(setupHelp.stdout, /--yes\s+reserve noninteractive approval for the exact apply plan/);
  assert.match(setupHelp.stdout, /apply is unavailable; these flags do not read input/);

  const groups = process.getgroups?.();
  const standardExecution =
    (process.platform === "darwin" || process.platform === "linux") &&
    process.getuid?.() !== undefined &&
    process.geteuid?.() !== undefined &&
    process.getgid?.() !== undefined &&
    process.getegid?.() !== undefined &&
    groups !== undefined &&
    process.getuid?.() !== 0 &&
    process.geteuid?.() !== 0 &&
    process.getgid?.() !== 0 &&
    process.getegid?.() !== 0 &&
    process.getuid?.() === process.geteuid?.() &&
    process.getgid?.() === process.getegid?.() &&
    !groups.includes(0);

  if (standardExecution) {
    const setup = runInstalled(["setup"], 3);
    assert.equal(setup.stdout, "");
    assert.match(setup.stderr, /private development build/);

    for (const approvedArgs of [
      ["setup", "--yes"],
      ["setup", "--api-key-stdin", "--yes"],
    ]) {
      const approvedSetup = runInstalled(approvedArgs, 3);
      assert.equal(approvedSetup.stdout, "");
      assert.match(
        approvedSetup.stderr,
        /private development build/,
      );
    }

    const dryRunCanary =
      "plrm_live_PACKAGE_VERIFY_CANARY_DO_NOT_PRINT";
    const dryRun = runInstalled(
      ["setup", "--dry-run"],
      1,
      { PLURUM_API_KEY: dryRunCanary },
    );
    assert.match(dryRun.stdout, /^Plurum setup preflight/m);
    assert.equal(
      (dryRun.stdout.match(/status: inspection-failed/g) ?? []).length,
      2,
    );
    assert.match(dryRun.stdout, /^readiness: unavailable$/m);
    assert.match(dryRun.stdout, /^No changes were made\.$/m);
    assert.doesNotMatch(dryRun.stdout, new RegExp(dryRunCanary));
    assert.equal(dryRun.stderr, "");

    for (const command of ["status", "doctor"]) {
      const readOnly = runInstalled([command, "--json"], 3);
      assert.deepEqual(JSON.parse(readOnly.stdout), {
        schema_version: 1,
        ok: false,
        command,
        error: {
          code: "command_unavailable",
          message: "This command is not available in the private development build.",
        },
      });
    }
  } else {
    const setup = runInstalled(["setup"], 1);
    assert.equal(setup.stdout, "");
    assert.match(setup.stderr, /refuses|cannot verify/);

    for (const command of ["status", "doctor"]) {
      const readOnly = runInstalled([command, "--json"], 1);
      assert.equal(JSON.parse(readOnly.stdout).error.code, "unsafe_execution_context");
    }
  }

  const elevatedSetup = runInstalled(["setup"], 1, { SUDO_UID: "0" });
  assert.equal(elevatedSetup.stdout, "");
  assert.match(elevatedSetup.stderr, /refuses to run with elevated privileges/);
  for (const command of ["status", "doctor"]) {
    const elevatedReadOnly = runInstalled(
      [command, "--json"],
      1,
      { SUDO_UID: "0" },
    );
    assert.equal(
      JSON.parse(elevatedReadOnly.stdout).error.code,
      "unsafe_execution_context",
    );
  }
  assert.equal(runInstalled(["--help"], 0, { SUDO_UID: "0" }).stderr, "");
  assert.equal(runInstalled(["--version"], 0, { SUDO_UID: "0" }).stderr, "");

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

  process.stdout.write("package artifact verified\n");
} finally {
  assert.equal(realpathSync(temporaryRoot), temporaryRoot);
  const rootMetadata = lstatSync(temporaryRoot);
  const sentinelMetadata = lstatSync(sentinelPath);
  assert.equal(rootMetadata.isDirectory(), true);
  assert.equal(rootMetadata.isSymbolicLink(), false);
  assert.equal(sentinelMetadata.isFile(), true);
  assert.equal(sentinelMetadata.isSymbolicLink(), false);
  assert.equal(sentinelMetadata.nlink, 1);
  assert.equal(readFileSync(sentinelPath, "utf8"), runId);
  if (process.platform !== "win32") {
    assert.equal(rootMetadata.uid, process.getuid?.());
    assert.equal(sentinelMetadata.uid, process.getuid?.());
    assert.equal(rootMetadata.mode & 0o077, 0);
    assert.equal(sentinelMetadata.mode & 0o077, 0);
  }
  rmSync(temporaryRoot, { recursive: true, force: false });
  assert.equal(existsSync(temporaryRoot), false);
}
