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
const posixSourcePath = join(crateRoot, "src", "posix.rs");
const posixMutationSourcePath = join(
  crateRoot,
  "src",
  "posix",
  "mutation.rs",
);
const posixPlatformSourcePath = join(
  crateRoot,
  "src",
  "posix",
  "platform.rs",
);
const macosAclManifestPath = join(crateRoot, "macos-acl", "Cargo.toml");
const macosAclSourcePath = join(crateRoot, "macos-acl", "src", "lib.rs");
const windowsSourcePath = join(crateRoot, "src", "windows.rs");
const windowsMutationSourcePath = join(
  crateRoot,
  "src",
  "windows",
  "mutation.rs",
);
const windowsSyscallManifestPath = join(
  crateRoot,
  "windows-syscall",
  "Cargo.toml",
);
const windowsSyscallSourcePath = join(
  crateRoot,
  "windows-syscall",
  "src",
  "lib.rs",
);
const windowsMediumLauncherSourcePath = join(
  crateRoot,
  "windows-syscall",
  "src",
  "bin",
  "medium-integrity-test-launcher.rs",
);
const bridgeSourcePath = join(crateRoot, "src", "bridge.rs");
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

for (const path of [
  manifestPath,
  lockPath,
  sourcePath,
  posixSourcePath,
  posixMutationSourcePath,
  posixPlatformSourcePath,
  macosAclManifestPath,
  macosAclSourcePath,
  windowsSourcePath,
  windowsMutationSourcePath,
  windowsSyscallManifestPath,
  windowsSyscallSourcePath,
  windowsMediumLauncherSourcePath,
  bridgeSourcePath,
  targetMapPath,
]) {
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
const workspacePackages = cargo.packages.filter(({ id }) =>
  cargo.workspace_members.includes(id),
);
assert.deepEqual(
  workspacePackages.map(({ name }) => name).sort(),
  [
    "plurum-native-credential-store",
    "plurum-native-macos-acl",
    "plurum-windows-syscall",
  ],
);
assert.deepEqual(cargo.workspace_default_members, [rootPackage.id]);

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
  {
    name: "plurum-native-macos-acl",
    requirement: "*",
    kind: null,
    optional: false,
    defaultFeatures: true,
    features: [],
    target: 'cfg(target_os = "macos")',
  },
  {
    name: "plurum-native-macos-acl",
    requirement: "*",
    kind: "dev",
    optional: false,
    defaultFeatures: true,
    features: ["test-support"],
    target: 'cfg(target_os = "macos")',
  },
  {
    name: "plurum-windows-syscall",
    requirement: "*",
    kind: null,
    optional: false,
    defaultFeatures: true,
    features: [],
    target: 'cfg(target_os = "windows")',
  },
  {
    name: "plurum-windows-syscall",
    requirement: "*",
    kind: "dev",
    optional: false,
    defaultFeatures: true,
    features: ["test-support"],
    target: 'cfg(target_os = "windows")',
  },
  {
    name: "rustix",
    requirement: "=1.1.4",
    kind: null,
    optional: false,
    defaultFeatures: false,
    features: ["fs", "process", "std"],
    target: 'cfg(any(target_os = "macos", target_os = "linux"))',
  },
  {
    name: "sha2",
    requirement: "=0.11.0",
    kind: null,
    optional: false,
    defaultFeatures: false,
    features: [],
    target: 'cfg(any(target_os = "macos", target_os = "linux"))',
  },
  {
    name: "sha2",
    requirement: "=0.11.0",
    kind: null,
    optional: false,
    defaultFeatures: false,
    features: [],
    target: 'cfg(target_os = "windows")',
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
const macosAclDependency = rootNode.deps.find(
  ({ name }) => name === "plurum_native_macos_acl",
);
assert.ok(
  macosAclDependency,
  "Cargo resolution must contain the descriptor-only macOS ACL boundary",
);
const macosAclPackage = cargo.packages.find(
  ({ id }) => id === macosAclDependency.pkg,
);
assert.ok(
  macosAclPackage,
  "Cargo metadata must describe the local macOS ACL boundary",
);
assert.equal(
  realpathSync(macosAclPackage.manifest_path),
  realpathSync(macosAclManifestPath),
);
assert.equal(macosAclPackage.name, "plurum-native-macos-acl");
assert.equal(macosAclPackage.version, "0.0.0-development");
assert.equal(macosAclPackage.edition, "2021");
assert.equal(macosAclPackage.rust_version, "1.88");
assert.equal(macosAclPackage.license, "Apache-2.0");
assert.deepEqual(macosAclPackage.publish, []);
assert.deepEqual(macosAclPackage.dependencies, []);
assert.deepEqual(macosAclPackage.features, {
  default: [],
  "test-support": [],
});
const macosAclLibrary = macosAclPackage.targets.find(({ kind }) =>
  kind.includes("lib"),
);
assert.ok(macosAclLibrary, "macOS ACL boundary must expose one Rust library");
assert.deepEqual(macosAclLibrary.kind, ["lib"]);
assert.equal(
  realpathSync(macosAclLibrary.src_path),
  realpathSync(macosAclSourcePath),
);
const macosAclNode = cargo.resolve.nodes.find(
  ({ id }) => id === macosAclPackage.id,
);
assert.ok(
  macosAclNode,
  "Cargo resolution must describe macOS ACL boundary features",
);
assert.deepEqual([...macosAclNode.features].sort(), [
  "default",
  "test-support",
]);

const windowsSyscallDependency = rootNode.deps.find(
  ({ name }) => name === "plurum_windows_syscall",
);
assert.ok(
  windowsSyscallDependency,
  "Cargo resolution must contain the Windows syscall boundary",
);
const windowsSyscallPackage = cargo.packages.find(
  ({ id }) => id === windowsSyscallDependency.pkg,
);
assert.ok(
  windowsSyscallPackage,
  "Cargo metadata must describe the local Windows syscall boundary",
);
assert.equal(
  realpathSync(windowsSyscallPackage.manifest_path),
  realpathSync(windowsSyscallManifestPath),
);
assert.equal(windowsSyscallPackage.name, "plurum-windows-syscall");
assert.equal(windowsSyscallPackage.version, "0.0.0-development");
assert.equal(windowsSyscallPackage.edition, "2021");
assert.equal(windowsSyscallPackage.rust_version, "1.88");
assert.equal(windowsSyscallPackage.license, "Apache-2.0");
assert.deepEqual(windowsSyscallPackage.publish, []);
assert.deepEqual(windowsSyscallPackage.features, {
  default: [],
  "test-support": [],
});
assert.deepEqual(
  windowsSyscallPackage.dependencies.map((dependency) => ({
    name: dependency.name,
    requirement: dependency.req,
    kind: dependency.kind,
    optional: dependency.optional,
    defaultFeatures: dependency.uses_default_features,
    features: [...dependency.features].sort(),
    target: dependency.target,
  })),
  [
    {
      name: "windows-sys",
      requirement: "=0.61.2",
      kind: null,
      optional: false,
      defaultFeatures: true,
      features: [
        "Wdk_Storage_FileSystem",
        "Win32_Foundation",
        "Win32_Security",
        "Win32_Security_Authorization",
        "Win32_Storage_FileSystem",
        "Win32_System_IO",
        "Win32_System_Ioctl",
        "Win32_System_SystemServices",
        "Win32_System_Threading",
      ],
      target: 'cfg(target_os = "windows")',
    },
  ],
);
const windowsSyscallLibrary = windowsSyscallPackage.targets.find(({ kind }) =>
  kind.includes("lib"),
);
assert.ok(
  windowsSyscallLibrary,
  "Windows syscall boundary must expose one Rust library",
);
assert.deepEqual(windowsSyscallLibrary.kind, ["lib"]);
assert.equal(
  realpathSync(windowsSyscallLibrary.src_path),
  realpathSync(windowsSyscallSourcePath),
);
assert.equal(windowsSyscallPackage.targets.length, 2);
const windowsMediumLauncher = windowsSyscallPackage.targets.find(({ kind }) =>
  kind.includes("bin"),
);
assert.ok(
  windowsMediumLauncher,
  "Windows syscall boundary must expose one test-only launcher",
);
assert.equal(
  windowsMediumLauncher.name,
  "plurum-medium-integrity-test-launcher",
);
assert.deepEqual(windowsMediumLauncher.kind, ["bin"]);
assert.deepEqual(windowsMediumLauncher.crate_types, ["bin"]);
assert.deepEqual(windowsMediumLauncher["required-features"], ["test-support"]);
assert.equal(
  realpathSync(windowsMediumLauncher.src_path),
  realpathSync(windowsMediumLauncherSourcePath),
);
const windowsSyscallNode = cargo.resolve.nodes.find(
  ({ id }) => id === windowsSyscallPackage.id,
);
assert.ok(
  windowsSyscallNode,
  "Cargo resolution must describe Windows syscall boundary features",
);
assert.deepEqual([...windowsSyscallNode.features].sort(), [
  "default",
  "test-support",
]);
const windowsSysDependency = windowsSyscallNode.deps.find(
  ({ name }) => name === "windows_sys",
);
assert.ok(
  windowsSysDependency,
  "Windows syscall boundary must resolve through windows-sys",
);
const windowsSysPackage = cargo.packages.find(
  ({ id }) => id === windowsSysDependency.pkg,
);
assert.ok(windowsSysPackage, "Cargo metadata must describe windows-sys");
assert.equal(windowsSysPackage.version, "0.61.2");
assert.equal(windowsSysPackage.rust_version, "1.71");
const windowsSysNode = cargo.resolve.nodes.find(
  ({ id }) => id === windowsSysPackage.id,
);
assert.ok(windowsSysNode, "Cargo resolution must describe windows-sys features");
for (const feature of windowsSyscallPackage.dependencies[0].features) {
  assert.ok(
    windowsSysNode.features.includes(feature),
    `windows-sys must include ${feature}`,
  );
}

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

const rustixDependency = rootNode.deps.find(({ name }) => name === "rustix");
assert.ok(rustixDependency, "Cargo resolution must contain rustix");
const rustixPackage = cargo.packages.find(
  ({ id }) => id === rustixDependency.pkg,
);
assert.ok(rustixPackage, "Cargo metadata must describe the resolved rustix");
assert.equal(rustixPackage.version, "1.1.4");
assert.equal(rustixPackage.rust_version, "1.63");
const rustixNode = cargo.resolve.nodes.find(
  ({ id }) => id === rustixPackage.id,
);
assert.ok(rustixNode, "Cargo resolution must describe rustix features");
assert.deepEqual([...rustixNode.features].sort(), [
  "alloc",
  "fs",
  "process",
  "std",
]);

const sha2Dependency = rootNode.deps.find(({ name }) => name === "sha2");
assert.ok(sha2Dependency, "Cargo resolution must contain sha2");
const sha2Package = cargo.packages.find(({ id }) => id === sha2Dependency.pkg);
assert.ok(sha2Package, "Cargo metadata must describe the resolved sha2");
assert.equal(sha2Package.version, "0.11.0");
assert.equal(sha2Package.rust_version, "1.85");
const sha2Node = cargo.resolve.nodes.find(({ id }) => id === sha2Package.id);
assert.ok(sha2Node, "Cargo resolution must describe sha2 features");
assert.deepEqual([...sha2Node.features].sort(), []);

console.log("native credential Cargo metadata conforms");
