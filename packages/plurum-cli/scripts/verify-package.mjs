import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
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
  "dist/cli.js",
  "dist/commands/doctor.js",
  "dist/commands/setup.js",
  "dist/commands/status.js",
  "dist/commands/types.js",
  "dist/commands/unavailable.js",
  "dist/exit-codes.js",
  "dist/index.js",
  "dist/json-output.js",
  "dist/runtime.js",
  "dist/version.js",
  "package.json",
];

const temporaryRoot = mkdtempSync(join(tmpdir(), "plurum-cli-package-"));

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
      : ["/usr/bin", "/bin"]),
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
    TMPDIR: temporaryRoot,
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    CI: "true",
    NO_COLOR: "1",
    npm_config_cache: cacheDirectory,
    npm_config_userconfig: join(configDirectory, "npmrc"),
    npm_config_update_notifier: "false",
  };

  function runNpm(arguments_, expectedStatus = 0, cwd = packageRoot) {
    const result = spawnSync(process.execPath, [npmCli, ...arguments_], {
      cwd,
      env: childEnvironment,
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

  function runInstalled(arguments_, expectedStatus = 0) {
    return runNpm(
      [
        "exec",
        "--offline",
        "--prefix",
        installDirectory,
        "--cache",
        cacheDirectory,
        "--",
        "plurum",
        ...arguments_,
      ],
      expectedStatus,
      neutralDirectory,
    );
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

  for (const arguments_ of [["setup"], ["setup", "--dry-run"]]) {
    const setup = runInstalled(arguments_, 3);
    assert.equal(setup.stdout, "");
    assert.match(setup.stderr, /private development build/);
  }

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
  rmSync(temporaryRoot, { recursive: true, force: true });
}
