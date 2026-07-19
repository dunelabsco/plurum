import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
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

const scriptPath = fileURLToPath(import.meta.url);
const crateRoot = dirname(dirname(scriptPath));
const packageRoot = resolve(crateRoot, "../..");
const isolationMarker = "plurum-native-isolation-v1\n";
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

function regularFileFromEnvironment(name) {
  const path = requiredEnvironment(name);
  assert.equal(isAbsolute(path), true, `${name} must be absolute`);
  const metadata = lstatSync(path);
  assert.equal(metadata.isSymbolicLink(), false, `${name} must not be a symlink`);
  assert.equal(metadata.isFile(), true, `${name} must be a regular file`);
  return realpathSync(path);
}

function optionalSystemEnvironment() {
  return Object.fromEntries(
    ["SystemRoot", "WINDIR", "CI"].flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]],
    ),
  );
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
  const config = join(root, "config");
  const home = join(root, "home");
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
    PLURUM_NATIVE_ISOLATION_ROOT: root,
    PLURUM_NATIVE_RUSTC: rustcPath,
    TMPDIR: join(root, "tmp"),
    TEMP: join(root, "tmp"),
    TMP: join(root, "tmp"),
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

function readRustHost(isolationRoot) {
  const rustcPath = regularFileFromEnvironment("PLURUM_NATIVE_RUSTC");
  const result = spawnSync(rustcPath, ["-vV"], {
    env: commandEnvironment(isolationRoot),
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

async function runChild() {
  const isolationRoot = verifiedIsolationRoot();
  const expectedTarget = requiredEnvironment("PLURUM_NATIVE_EXPECTED_TARGET");
  const expectedNode = requiredEnvironment("PLURUM_NATIVE_EXPECTED_NODE");
  const stagedPath = requiredEnvironment("PLURUM_NATIVE_STAGED_PATH");
  const runId = requiredEnvironment("PLURUM_NATIVE_TEST_RUN_ID");
  const runRoot = realpathSync(process.cwd());
  assert.equal(realpathSync(dirname(runRoot)), realpathSync(join(isolationRoot, "tmp")));
  assert.equal(realpathSync(stagedPath), realpathSync(join(runRoot, "credential-store.node")));
  assert.equal(
    readFileSync(join(runRoot, ".plurum-native-abi-root"), "utf8"),
    runId,
  );

  assert.equal(process.versions.node, expectedNode);
  assert.ok(Number.parseInt(process.versions.napi, 10) >= 8);
  assertRuntimeMatchesTarget(expectedTarget);

  const rustHost = readRustHost(isolationRoot);
  assert.equal(
    rustHostTargets[rustHost],
    expectedTarget,
    `Rust host ${rustHost} must map to ${expectedTarget}`,
  );

  const stagedMetadata = lstatSync(stagedPath);
  assert.equal(stagedMetadata.isSymbolicLink(), false);
  assert.equal(stagedMetadata.isFile(), true);

  const nativeModule = { exports: {} };
  process.dlopen(nativeModule, stagedPath);
  const addon = nativeModule.exports;
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

  const [{ createNativeCredentialStoreProvider }, { CLI_VERSION }] =
    await Promise.all([
      import(
        pathToFileURL(
          join(packageRoot, "dist", "adapters", "node", "native-credential-store.js"),
        ).href
      ),
      import(pathToFileURL(join(packageRoot, "dist", "version.js")).href),
    ]);

  assert.equal(addon.magic, "plurum-native-credential-store");
  assert.equal(addon.abiVersion, 1);
  assert.equal(addon.nodeApiVersion, 8);
  assert.equal(addon.packageVersion, CLI_VERSION);
  assert.equal(addon.target, expectedTarget);
  assert.equal(typeof addon.createAdapters, "function");
  assert.equal(Reflect.apply(addon.createAdapters, addon, []), undefined);

  let resolverCalls = 0;
  const provider = createNativeCredentialStoreProvider(
    expectedTarget,
    (target) => {
      resolverCalls += 1;
      assert.equal(target, expectedTarget);
      return addon;
    },
  );

  assert.equal(resolverCalls, 0, "native resolution must remain lazy");
  const first = provider.load();
  assert.deepEqual(first, {
    status: "unavailable",
    code: "native_credential_store_unavailable",
  });
  assert.equal(Object.isFrozen(first), true);
  assert.equal(resolverCalls, 1);
  assert.strictEqual(provider.load(), first);
  assert.equal(resolverCalls, 1, "native resolution must be memoized");
  assert.equal(Object.isFrozen(provider), true);
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

function isOutside(parent, candidate) {
  const difference = relative(parent, candidate);
  return (
    difference === ".." ||
    difference.startsWith(`..${sep}`) ||
    isAbsolute(difference)
  );
}

function runParent() {
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

  const binaryPath = realpathSync(join(realCargoTarget, "release", binaryName()));
  const binaryMetadata = lstatSync(binaryPath);
  assert.equal(binaryMetadata.isSymbolicLink(), false);
  assert.equal(binaryMetadata.isFile(), true);

  const trustedTemporaryBase = realpathSync(join(isolationRoot, "tmp"));
  const temporaryRoot = realpathSync(
    mkdtempSync(join(trustedTemporaryBase, "plurum-native-abi-")),
  );
  const runId = randomUUID();
  const sentinelPath = join(temporaryRoot, ".plurum-native-abi-root");
  const stagedPath = join(temporaryRoot, "credential-store.node");

  if (process.platform !== "win32") {
    chmodSync(temporaryRoot, 0o700);
  }
  writeFileSync(sentinelPath, runId, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  copyFileSync(binaryPath, stagedPath, fsConstants.COPYFILE_EXCL);
  if (process.platform !== "win32") {
    chmodSync(sentinelPath, 0o600);
    chmodSync(stagedPath, 0o600);
  }

  try {
    const result = spawnSync(process.execPath, [scriptPath, "--child"], {
      cwd: temporaryRoot,
      env: commandEnvironment(isolationRoot, {
        PLURUM_NATIVE_EXPECTED_TARGET: expectedTarget,
        PLURUM_NATIVE_EXPECTED_NODE: expectedNode,
        PLURUM_NATIVE_STAGED_PATH: stagedPath,
        PLURUM_NATIVE_TEST_RUN_ID: runId,
        TMPDIR: temporaryRoot,
        TEMP: temporaryRoot,
        TMP: temporaryRoot,
      }),
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
      timeout: 60_000,
    });
    assert.equal(result.error, undefined, "ABI child must start successfully");
    assert.equal(
      result.status,
      0,
      `native ABI child failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  } finally {
    assert.equal(realpathSync(dirname(sentinelPath)), temporaryRoot);
    assert.equal(readFileSync(sentinelPath, "utf8"), runId);
    rmSync(temporaryRoot, { recursive: true, force: false });
  }

  console.log(
    `native credential ABI conforms for ${expectedTarget} on Node ${expectedNode}`,
  );
}

if (process.argv[2] === "--child") {
  await runChild();
} else {
  runParent();
}
