import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

const markerName = ".plurum-native-isolation";
const markerValue = "plurum-native-isolation-v1\n";
const directoryNames = Object.freeze([
  "cargo-home",
  "cargo-target",
  "config",
  "home",
  "npm-cache",
  "rustup-home",
  "tmp",
]);
const rustHosts = new Set([
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-gnu",
  "x86_64-pc-windows-msvc",
]);

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.ok(value, `${name} must be set`);
  assert.equal(/[\r\n]/u.test(value), false, `${name} must be one line`);
  return value;
}

function ensurePrivateDirectory(path) {
  if (!existsSync(path)) {
    mkdirSync(path, { mode: 0o700 });
  }
  const metadata = lstatSync(path);
  assert.equal(metadata.isSymbolicLink(), false, `${path} must not be a symlink`);
  assert.equal(metadata.isDirectory(), true, `${path} must be a directory`);
  if (process.platform !== "win32") {
    chmodSync(path, 0o700);
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

const requestedRoot = requiredEnvironment("PLURUM_NATIVE_ISOLATION_ROOT");
assert.equal(isAbsolute(requestedRoot), true);
assert.equal(basename(requestedRoot), "plurum-native-isolation");

const trustedBase = realpathSync(
  process.env.CI === "true"
    ? requiredEnvironment("RUNNER_TEMP")
    : tmpdir(),
);
assert.equal(realpathSync(dirname(requestedRoot)), trustedBase);

const isolationRoot = resolve(requestedRoot);
if (existsSync(isolationRoot)) {
  const rootMetadata = lstatSync(isolationRoot);
  assert.equal(rootMetadata.isSymbolicLink(), false);
  assert.equal(rootMetadata.isDirectory(), true);
  const existingEntries = readdirSync(isolationRoot);
  if (!existingEntries.includes(markerName)) {
    assert.deepEqual(
      existingEntries,
      [],
      "an existing isolation root must be empty or carry the exact sentinel",
    );
  }
  for (const entry of existingEntries) {
    assert.ok(
      entry === markerName || directoryNames.includes(entry),
      `unexpected isolation-root entry: ${entry}`,
    );
  }
} else {
  mkdirSync(isolationRoot, { mode: 0o700 });
}
assert.equal(realpathSync(dirname(isolationRoot)), trustedBase);
if (process.platform !== "win32") {
  chmodSync(isolationRoot, 0o700);
}

const markerPath = join(isolationRoot, markerName);
if (existsSync(markerPath)) {
  const markerMetadata = lstatSync(markerPath);
  assert.equal(markerMetadata.isSymbolicLink(), false);
  assert.equal(markerMetadata.isFile(), true);
  assert.equal(readFileSync(markerPath, "utf8"), markerValue);
} else {
  writeFileSync(markerPath, markerValue, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}
if (process.platform !== "win32") {
  chmodSync(markerPath, 0o600);
}

const paths = Object.fromEntries(
  directoryNames.map((name) => {
    const path = join(isolationRoot, name);
    ensurePrivateDirectory(path);
    return [name, realpathSync(path)];
  }),
);
for (const name of ["appdata", "claude", "codex", "localappdata", "plurum"]) {
  ensurePrivateDirectory(join(paths.config, name));
}

const rustHost = requiredEnvironment("PLURUM_NATIVE_RUST_HOST");
assert.ok(rustHosts.has(rustHost), `unexpected native Rust host: ${rustHost}`);
const expectedRustHost = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
}[`${process.platform}-${process.arch}`];
assert.equal(rustHost, expectedRustHost);

const toolchain = requiredEnvironment("RUSTUP_TOOLCHAIN");
assert.equal(toolchain, "1.97.1");
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const toolchainBin = join(
  paths["rustup-home"],
  "toolchains",
  `${toolchain}-${rustHost}`,
  "bin",
);
const environment = {
  PLURUM_NATIVE_ISOLATION_ROOT: isolationRoot,
  PLURUM_NATIVE_RUST_HOST: rustHost,
  PLURUM_NATIVE_CARGO: join(toolchainBin, `cargo${executableSuffix}`),
  PLURUM_NATIVE_RUSTC: join(toolchainBin, `rustc${executableSuffix}`),
  HOME: paths.home,
  USERPROFILE: paths.home,
  XDG_CONFIG_HOME: paths.config,
  APPDATA: join(paths.config, "appdata"),
  LOCALAPPDATA: join(paths.config, "localappdata"),
  PLURUM_HOME: join(paths.config, "plurum"),
  CODEX_HOME: join(paths.config, "codex"),
  CLAUDE_CONFIG_DIR: join(paths.config, "claude"),
  CARGO_HOME: paths["cargo-home"],
  CARGO_TARGET_DIR: paths["cargo-target"],
  RUSTUP_HOME: paths["rustup-home"],
  TMPDIR: paths.tmp,
  TEMP: paths.tmp,
  TMP: paths.tmp,
  npm_config_cache: paths["npm-cache"],
  npm_config_globalconfig: join(paths.config, "global-npmrc"),
  npm_config_userconfig: join(paths.config, "npmrc"),
  npm_config_update_notifier: "false",
};

const githubEnvironmentPath = process.env.GITHUB_ENV;
if (githubEnvironmentPath !== undefined) {
  assert.equal(process.env.CI, "true");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(isAbsolute(githubEnvironmentPath), true);
  const githubEnvironmentMetadata = lstatSync(githubEnvironmentPath);
  assert.equal(githubEnvironmentMetadata.isSymbolicLink(), false);
  assert.equal(githubEnvironmentMetadata.isFile(), true);
  assert.equal(githubEnvironmentMetadata.nlink, 1);
  if (typeof process.getuid === "function") {
    assert.equal(githubEnvironmentMetadata.uid, process.getuid());
  }
  const realGithubEnvironmentPath = realpathSync(githubEnvironmentPath);
  assert.equal(
    isStrictDescendant(trustedBase, realGithubEnvironmentPath),
    true,
    "GITHUB_ENV must be contained by the current GitHub runner temp directory",
  );
  appendFileSync(
    realGithubEnvironmentPath,
    `${Object.entries(environment)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n")}\n`,
    "utf8",
  );
}

console.log("native credential test isolation prepared");
