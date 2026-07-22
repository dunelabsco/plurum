import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
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

function isWithin(parent, candidate) {
  const difference = relative(parent, candidate);
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference))
  );
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

const mode = process.argv[2];
assert.ok(
  ["build", "clippy", "fetch", "fmt", "launcher", "msrv", "test"].includes(
    mode,
  ),
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
const neutralDirectory = realpathSync(join(isolationRoot, "tmp"));
assertNoCargoConfigInAncestors(neutralDirectory);
assertNoCargoHomeConfig(cargoHome);

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
    "--bin",
    "plurum-medium-integrity-test-launcher",
  ],
  msrv: [
    "check",
    "--frozen",
    "--manifest-path",
    manifestPath,
    "--workspace",
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

const config = join(isolationRoot, "config");
const home = join(isolationRoot, "home");
const temporary = join(isolationRoot, "tmp");
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
  APPDATA: join(config, "appdata"),
  LOCALAPPDATA: join(config, "localappdata"),
  PLURUM_NATIVE_ISOLATION_ROOT: isolationRoot,
  PLURUM_HOME: join(config, "plurum"),
  CODEX_HOME: join(config, "codex"),
  CLAUDE_CONFIG_DIR: join(config, "claude"),
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
