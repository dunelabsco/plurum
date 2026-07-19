import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

const crateRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(crateRoot, "Cargo.toml");
const lockPath = join(crateRoot, "Cargo.lock");
const sourcePath = join(crateRoot, "src", "lib.rs");
const targetMapPath = join(crateRoot, "src", "target_map.rs");
const isolationMarker = "plurum-native-isolation-v1\n";

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.ok(value, `${name} must be set`);
  return value;
}

function regularFileFromEnvironment(name) {
  const path = requiredEnvironment(name);
  assert.equal(isAbsolute(path), true, `${name} must be absolute`);
  const metadata = lstatSync(path);
  assert.equal(metadata.isSymbolicLink(), false, `${name} must not be a symlink`);
  assert.equal(metadata.isFile(), true, `${name} must be a regular file`);
  return realpathSync(path);
}

function isolatedDirectory(root, environmentName, childName) {
  const configured = requiredEnvironment(environmentName);
  const metadata = lstatSync(configured);
  assert.equal(metadata.isSymbolicLink(), false);
  assert.equal(metadata.isDirectory(), true);
  assert.equal(realpathSync(configured), realpathSync(join(root, childName)));
  return realpathSync(configured);
}

function optionalSystemEnvironment() {
  return Object.fromEntries(
    ["SystemRoot", "WINDIR", "CI"].flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]],
    ),
  );
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

function commandEnvironment(root, cargoPath, rustcPath) {
  const cargoHome = isolatedDirectory(root, "CARGO_HOME", "cargo-home");
  const cargoTarget = isolatedDirectory(
    root,
    "CARGO_TARGET_DIR",
    "cargo-target",
  );
  const rustupHome = isolatedDirectory(root, "RUSTUP_HOME", "rustup-home");
  const config = join(root, "config");
  const home = join(root, "home");
  const temporary = join(root, "tmp");
  const systemPath =
    process.platform === "win32"
      ? [
          dirname(cargoPath),
          dirname(rustcPath),
          join(requiredEnvironment("SystemRoot"), "System32"),
        ]
      : [dirname(cargoPath), dirname(rustcPath)];

  return {
    ...optionalSystemEnvironment(),
    PATH: systemPath.join(delimiter),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: config,
    APPDATA: join(config, "appdata"),
    LOCALAPPDATA: join(config, "localappdata"),
    PLURUM_HOME: join(config, "plurum"),
    CODEX_HOME: join(config, "codex"),
    CLAUDE_CONFIG_DIR: join(config, "claude"),
    CARGO_HOME: cargoHome,
    CARGO_TARGET_DIR: cargoTarget,
    RUSTUP_HOME: rustupHome,
    RUSTUP_TOOLCHAIN: requiredEnvironment("RUSTUP_TOOLCHAIN"),
    RUSTC: rustcPath,
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    NO_COLOR: "1",
  };
}

for (const path of [manifestPath, lockPath, sourcePath, targetMapPath]) {
  const metadata = lstatSync(path);
  assert.equal(metadata.isSymbolicLink(), false, `${path} must not be a symlink`);
  assert.equal(metadata.isFile(), true, `${path} must be a regular file`);
}

const configuredIsolationRoot = requiredEnvironment(
  "PLURUM_NATIVE_ISOLATION_ROOT",
);
const isolationRootMetadata = lstatSync(configuredIsolationRoot);
assert.equal(isolationRootMetadata.isSymbolicLink(), false);
assert.equal(isolationRootMetadata.isDirectory(), true);
const isolationRoot = realpathSync(configuredIsolationRoot);
assert.equal(
  readFileSync(join(isolationRoot, ".plurum-native-isolation"), "utf8"),
  isolationMarker,
);
const cargoPath = regularFileFromEnvironment("PLURUM_NATIVE_CARGO");
const rustcPath = regularFileFromEnvironment("PLURUM_NATIVE_RUSTC");
const metadataWorkingDirectory = realpathSync(join(isolationRoot, "tmp"));
assertNoCargoConfigInAncestors(metadataWorkingDirectory);
for (const name of ["config", "config.toml"]) {
  assert.equal(
    existsSync(join(requiredEnvironment("CARGO_HOME"), name)),
    false,
    `isolated Cargo config is forbidden: ${name}`,
  );
}
const result = spawnSync(
  cargoPath,
  [
    "metadata",
    "--frozen",
    "--format-version",
    "1",
    "--manifest-path",
    manifestPath,
  ],
  {
    cwd: metadataWorkingDirectory,
    env: commandEnvironment(isolationRoot, cargoPath, rustcPath),
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
    timeout: 60_000,
  },
);

assert.equal(result.error, undefined, "cargo metadata must start successfully");
assert.equal(
  result.status,
  0,
  `cargo metadata failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
);

const cargo = JSON.parse(result.stdout);
const rootPackage = cargo.packages.find(
  ({ manifest_path: path }) => realpathSync(path) === realpathSync(manifestPath),
);
assert.ok(rootPackage, "Cargo metadata must contain the foundation crate");

assert.equal(rootPackage.name, "plurum-native-credential-store");
assert.equal(rootPackage.version, "0.0.0-development");
assert.equal(rootPackage.edition, "2021");
assert.equal(rootPackage.rust_version, "1.88");
assert.equal(rootPackage.license, "Apache-2.0");
assert.deepEqual(rootPackage.publish, []);
assert.deepEqual(rootPackage.features, {});

const dependencies = rootPackage.dependencies
  .map((dependency) => ({
    name: dependency.name,
    requirement: dependency.req,
    kind: dependency.kind,
    optional: dependency.optional,
    defaultFeatures: dependency.uses_default_features,
    features: [...dependency.features].sort(),
    target: dependency.target,
  }))
  .sort((left, right) => left.name.localeCompare(right.name));

assert.deepEqual(dependencies, [
  {
    name: "napi",
    requirement: "=3.10.5",
    kind: null,
    optional: false,
    defaultFeatures: false,
    features: ["dyn-symbols", "napi8"],
    target: null,
  },
  {
    name: "napi-build",
    requirement: "=2.3.2",
    kind: "build",
    optional: false,
    defaultFeatures: true,
    features: [],
    target: null,
  },
  {
    name: "napi-derive",
    requirement: "=3.5.9",
    kind: null,
    optional: false,
    defaultFeatures: true,
    features: [],
    target: null,
  },
]);

assert.equal(rootPackage.targets.length, 2);
const libraryTarget = rootPackage.targets.find(({ kind }) =>
  kind.includes("cdylib"),
);
assert.ok(libraryTarget, "the crate must expose one cdylib target");
assert.equal(libraryTarget.name, "plurum_native_credential_store");
assert.deepEqual(libraryTarget.kind, ["cdylib"]);
assert.deepEqual(libraryTarget.crate_types, ["cdylib"]);
assert.equal(realpathSync(libraryTarget.src_path), realpathSync(sourcePath));

const buildTarget = rootPackage.targets.find(({ kind }) =>
  kind.includes("custom-build"),
);
assert.ok(buildTarget, "the crate must retain its napi build script");
assert.deepEqual(buildTarget.kind, ["custom-build"]);

const rootNode = cargo.resolve.nodes.find(({ id }) => id === rootPackage.id);
assert.ok(rootNode, "Cargo resolution must contain the foundation crate");
const napiDependency = rootNode.deps.find(({ name }) => name === "napi");
assert.ok(napiDependency, "Cargo resolution must contain napi");
const napiPackage = cargo.packages.find(({ id }) => id === napiDependency.pkg);
assert.ok(napiPackage, "Cargo metadata must describe the resolved napi package");
assert.equal(napiPackage.version, "3.10.5");
const napiNode = cargo.resolve.nodes.find(({ id }) => id === napiPackage.id);
assert.ok(napiNode, "Cargo resolution must describe napi features");
assert.deepEqual([...napiNode.features].sort(), [
  "dyn-symbols",
  "napi1",
  "napi2",
  "napi3",
  "napi4",
  "napi5",
  "napi6",
  "napi7",
  "napi8",
]);

const napiSysPackage = cargo.packages.find(({ name }) => name === "napi-sys");
assert.ok(napiSysPackage, "Cargo metadata must describe napi-sys");
assert.equal(napiSysPackage.version, "3.2.3");
assert.ok(
  napiNode.deps.some(({ pkg }) => pkg === napiSysPackage.id),
  "napi must resolve through the audited napi-sys package",
);
const napiSysNode = cargo.resolve.nodes.find(
  ({ id }) => id === napiSysPackage.id,
);
assert.ok(napiSysNode, "Cargo resolution must describe napi-sys features");
assert.deepEqual([...napiSysNode.features].sort(), [
  "dyn-symbols",
  "napi1",
  "napi2",
  "napi3",
  "napi4",
  "napi5",
  "napi6",
  "napi7",
  "napi8",
]);

console.log("native credential Cargo metadata conforms");
