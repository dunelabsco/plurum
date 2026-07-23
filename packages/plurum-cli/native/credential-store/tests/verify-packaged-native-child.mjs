import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";

const MAX_PACKAGE_JSON_BYTES = 64 * 1024;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_NATIVE_ARTIFACT_BYTES = 64 * 1024 * 1024;
const PACKAGE_MAGIC = "plurum-native-credential-package";
const PACKAGE_INVENTORY = Object.freeze([
  "LICENSE",
  "README.md",
  "credential-store.node",
  "package.json",
]);
const TARGETS = Object.freeze({
  "darwin-arm64": Object.freeze({ os: "darwin", cpu: "arm64" }),
  "darwin-x64": Object.freeze({ os: "darwin", cpu: "x64" }),
  "linux-arm64-gnu": Object.freeze({ os: "linux", cpu: "arm64", libc: "glibc" }),
  "linux-x64-gnu": Object.freeze({ os: "linux", cpu: "x64", libc: "glibc" }),
  "win32-x64-msvc": Object.freeze({ os: "win32", cpu: "x64" }),
});
const PACKAGE_BY_TARGET = Object.freeze(Object.fromEntries(
  Object.keys(TARGETS).map((target) => [
    target,
    `@dunelabs/plurum-native-${target}`,
  ]),
));
let verificationStage = "bootstrap";
process.on("uncaughtExceptionMonitor", () => {
  try {
    process.stderr.write(
      `packaged native verifier failed at ${verificationStage}\n`,
    );
  } catch {
    // The original failure remains authoritative.
  }
});

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.ok(value, `${name} must be set`);
  assert.equal(/[\r\n\0]/u.test(value), false, `${name} must be one safe line`);
  return value;
}

function isWithin(parent, candidate) {
  const difference = relative(parent, candidate);
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference))
  );
}

function directRegularFile(path, label, maxBytes) {
  const metadata = lstatSync(path);
  assert.equal(metadata.isSymbolicLink(), false, `${label} must not be a symlink`);
  assert.equal(metadata.isFile(), true, `${label} must be a regular file`);
  assert.equal(metadata.nlink, 1, `${label} must have one link`);
  assert.equal(metadata.size > 0 && metadata.size <= maxBytes, true);
  assert.equal(realpathSync(path), resolve(path), `${label} must be direct`);
  if (process.platform !== "win32") {
    assert.equal(metadata.uid, process.getuid?.(), `${label} must be user-owned`);
  }
  return metadata;
}

function directDirectory(path, label) {
  const metadata = lstatSync(path);
  assert.equal(metadata.isSymbolicLink(), false, `${label} must not be a symlink`);
  assert.equal(metadata.isDirectory(), true, `${label} must be a directory`);
  assert.equal(realpathSync(path), resolve(path), `${label} must be direct`);
  if (process.platform !== "win32") {
    assert.equal(metadata.uid, process.getuid?.(), `${label} must be user-owned`);
  }
  return metadata;
}

function boundedBytes(path, maxBytes, label) {
  directRegularFile(path, label, maxBytes);
  return readFileSync(path);
}

function jsonBytes(bytes, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value;
}

function jsonFile(path, label) {
  return jsonBytes(boundedBytes(path, MAX_PACKAGE_JSON_BYTES, label), label);
}

function expectedManifest() {
  const payload = requiredEnvironment("PLURUM_NATIVE_VERIFY_MANIFEST");
  assert.equal(payload.length <= 32 * 1024, true);
  const bytes = Buffer.from(payload, "base64url");
  assert.equal(bytes.byteLength > 0 && bytes.byteLength <= MAX_PACKAGE_JSON_BYTES, true);
  return jsonBytes(bytes, "packaged native manifest evidence");
}

function pathExists(path) {
  try {
    lstatSync(path);
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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function identity(metadata) {
  return Object.freeze({
    device: metadata.dev,
    inode: metadata.ino,
    links: metadata.nlink,
    size: metadata.size,
    modified: metadata.mtimeMs,
    changed: metadata.ctimeMs,
  });
}

const testRoot = realpathSync(requiredEnvironment("PLURUM_NATIVE_VERIFY_ROOT"));
directDirectory(testRoot, "packaged native verification root");
const rootPackage = realpathSync(
  requiredEnvironment("PLURUM_NATIVE_VERIFY_INSTALLED_ROOT"),
);
assert.equal(isWithin(testRoot, rootPackage), true);
assert.equal(basename(rootPackage), "plurum");
directDirectory(rootPackage, "installed Plurum package");

const target = requiredEnvironment("PLURUM_NATIVE_EXPECTED_TARGET");
const descriptor = TARGETS[target];
assert.ok(descriptor !== undefined, "packaged target must be released");
assert.equal(process.platform, descriptor.os);
assert.equal(process.arch, descriptor.cpu);
if (descriptor.libc === "glibc") {
  assert.equal(
    typeof process.report?.getReport()?.header?.glibcVersionRuntime,
    "string",
    "packaged GNU addon requires positive glibc evidence",
  );
}
assert.equal(
  process.versions.node,
  requiredEnvironment("PLURUM_NATIVE_EXPECTED_NODE"),
);

const mode = requiredEnvironment("PLURUM_NATIVE_VERIFY_MODE");
assert.equal(["available", "missing", "omit"].includes(mode), true);
const cachePolicy = requiredEnvironment("PLURUM_NATIVE_VERIFY_CACHE_POLICY");
assert.equal(["normal", "preloaded"].includes(cachePolicy), true);
assert.equal(cachePolicy === "preloaded" ? mode : "available", "available");
verificationStage = "manifest";
const manifest = expectedManifest();
const expectedPackageName = PACKAGE_BY_TARGET[target];
assert.equal(manifest.name, expectedPackageName);
assert.equal(manifest.plurumNative?.magic, PACKAGE_MAGIC);
assert.equal(manifest.plurumNative?.target, target);

const rootMetadata = jsonFile(
  join(rootPackage, "package.json"),
  "installed Plurum package metadata",
);
assert.equal(rootMetadata.name, "plurum");
assert.equal(rootMetadata.version, manifest.version);
assert.equal(rootMetadata.optionalDependencies?.[expectedPackageName], manifest.version);

const packageLeaf = expectedPackageName.slice("@dunelabs/".length);
const candidates = [
  join(rootPackage, "node_modules", "@dunelabs", packageLeaf),
  join(dirname(rootPackage), "@dunelabs", packageLeaf),
];
const presentCandidates = candidates.filter(pathExists);
let artifactPath;
let artifactIdentity;
if (mode === "available") {
  assert.equal(presentCandidates.length, 1);
  const targetPackage = realpathSync(
    requiredEnvironment("PLURUM_NATIVE_VERIFY_INSTALLED_TARGET"),
  );
  assert.equal(presentCandidates[0], targetPackage);
  assert.equal(isWithin(testRoot, targetPackage), true);
  directDirectory(targetPackage, "installed native target package");
  assert.deepEqual(readdirSync(targetPackage).sort(), [...PACKAGE_INVENTORY]);
  for (const document of ["LICENSE", "README.md"]) {
    directRegularFile(
      join(targetPackage, document),
      `installed native package ${document}`,
      MAX_DOCUMENT_BYTES,
    );
  }
  const installedManifestBytes = boundedBytes(
    join(targetPackage, "package.json"),
    MAX_PACKAGE_JSON_BYTES,
    "installed native package metadata",
  );
  const canonicalManifestBytes = Buffer.from(
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  assert.equal(
    installedManifestBytes.equals(canonicalManifestBytes),
    true,
    "installed native package metadata must be canonical",
  );
  assert.deepEqual(
    jsonBytes(installedManifestBytes, "installed native package metadata"),
    manifest,
  );
  artifactPath = join(targetPackage, "credential-store.node");
  const artifactMetadata = directRegularFile(
    artifactPath,
    "installed native addon",
    MAX_NATIVE_ARTIFACT_BYTES,
  );
  artifactIdentity = identity(artifactMetadata);
  const artifactBytes = readFileSync(artifactPath);
  assert.equal(artifactBytes.byteLength, manifest.plurumNative.byteLength);
  assert.equal(sha256(artifactBytes), requiredEnvironment("PLURUM_NATIVE_EXPECTED_SHA256"));
  assert.equal(sha256(artifactBytes), manifest.plurumNative.sha256);
} else {
  assert.deepEqual(presentCandidates, []);
  assert.equal(process.env.PLURUM_NATIVE_VERIFY_INSTALLED_TARGET, undefined);
}

const resolverPath = join(
  rootPackage,
  "dist",
  "adapters",
  "node",
  "native-credential-package.js",
);
directRegularFile(resolverPath, "installed native package resolver", 1024 * 1024);
verificationStage = "resolver-import";
const resolverModule = await import(pathToFileURL(resolverPath).href);
assert.deepEqual(Object.keys(resolverModule).sort(), [
  "NATIVE_CREDENTIAL_PACKAGE_BY_TARGET",
  "NATIVE_CREDENTIAL_PACKAGE_MAGIC",
  "createNativeCredentialPackageProvider",
]);
assert.equal(resolverModule.NATIVE_CREDENTIAL_PACKAGE_MAGIC, PACKAGE_MAGIC);
assert.equal(Object.isFrozen(resolverModule.NATIVE_CREDENTIAL_PACKAGE_BY_TARGET), true);
assert.deepEqual(resolverModule.NATIVE_CREDENTIAL_PACKAGE_BY_TARGET, PACKAGE_BY_TARGET);

const nativeRequire = createRequire(import.meta.url);
let preloadedEntry;
if (cachePolicy === "preloaded") {
  assert.ok(artifactPath !== undefined && artifactIdentity !== undefined);
  assert.equal(Object.hasOwn(nativeRequire.cache, artifactPath), false);
  preloadedEntry = Object.freeze({
    exports: Object.freeze(Object.create(null)),
    filename: artifactPath,
  });
  nativeRequire.cache[artifactPath] = preloadedEntry;
  assert.strictEqual(nativeRequire.cache[artifactPath], preloadedEntry);
}

const nativeConfiguration = Object.freeze({
  codexHomeDirectory: join(testRoot, "codex-home"),
  legacyPaths: Object.freeze({
    hermes: join(testRoot, "legacy-hermes", "plurum.json"),
    openclaw: join(testRoot, "legacy-openclaw", "plurum.json"),
    removedCli: join(testRoot, "legacy-removed", "config.json"),
  }),
  stateDirectory: join(testRoot, "plurum-state"),
});
verificationStage = "provider-construction";
const provider = resolverModule.createNativeCredentialPackageProvider(
  target,
  nativeConfiguration,
);
assert.equal(Object.isFrozen(provider), true);
assert.deepEqual(Object.keys(provider), ["load"]);
if (cachePolicy === "preloaded") {
  assert.ok(artifactPath !== undefined && artifactIdentity !== undefined);
  const unavailable = provider.load();
  assert.equal(Object.isFrozen(unavailable), true);
  assert.deepEqual(unavailable, {
    status: "unavailable",
    code: "native_credential_store_unavailable",
  });
  assert.strictEqual(provider.load(), unavailable);
  assert.strictEqual(nativeRequire.cache[artifactPath], preloadedEntry);
  assert.deepEqual(identity(lstatSync(artifactPath)), artifactIdentity);
  assert.equal(
    sha256(readFileSync(artifactPath)),
    manifest.plurumNative.sha256,
  );
} else if (mode === "available") {
  verificationStage = "provider-load";
  assert.ok(artifactPath !== undefined && artifactIdentity !== undefined);
  assert.deepEqual(
    identity(lstatSync(artifactPath)),
    artifactIdentity,
    "provider construction must not inspect or load the addon",
  );
  const loaded = provider.load();
  assert.equal(loaded.status, "available");
  if (loaded.status !== "available") {
    assert.fail("installed native package resolver must load the packaged addon");
  }
  assert.equal(Object.isFrozen(loaded), true);
  assert.deepEqual(Object.keys(loaded).sort(), [
    "codexDotenv",
    "journal",
    "legacy",
    "mutation",
    "observation",
    "read",
    "status",
  ]);
  assert.equal(Object.isFrozen(loaded.codexDotenv), true);
  assert.equal(Object.isFrozen(loaded.journal), true);
  assert.equal(Object.isFrozen(loaded.legacy), true);
  assert.equal(Object.isFrozen(loaded.read), true);
  assert.equal(Object.isFrozen(loaded.observation), true);
  assert.equal(Object.isFrozen(loaded.mutation), true);
  assert.deepEqual(Object.keys(loaded.journal), ["acquire"]);
  assert.deepEqual(Object.keys(loaded.codexDotenv).sort(), [
    "observe",
    "synchronize",
  ]);
  assert.deepEqual(Object.keys(loaded.legacy), ["read"]);
  assert.deepEqual(Object.keys(loaded.read), ["openPrivateDirectory"]);
  assert.deepEqual(Object.keys(loaded.observation), ["openPrivateDirectory"]);
  assert.deepEqual(Object.keys(loaded.mutation).sort(), [
    "acquireObservedSetupLease",
    "acquireSetupLease",
  ]);
  verificationStage = "provider-reuse";
  assert.strictEqual(provider.load(), loaded);
  assert.deepEqual(identity(lstatSync(artifactPath)), artifactIdentity);
  const laterProvider = resolverModule.createNativeCredentialPackageProvider(
    target,
    nativeConfiguration,
  );
  assert.equal(Object.isFrozen(laterProvider), true);
  assert.notStrictEqual(laterProvider, provider);
  assert.deepEqual(identity(lstatSync(artifactPath)), artifactIdentity);
  const laterLoaded = laterProvider.load();
  assert.equal(laterLoaded.status, "available");
  if (laterLoaded.status !== "available") {
    assert.fail("later providers must reuse the one verified native addon");
  }
  assert.equal(Object.isFrozen(laterLoaded), true);
  assert.deepEqual(Object.keys(laterLoaded).sort(), [
    "codexDotenv",
    "journal",
    "legacy",
    "mutation",
    "observation",
    "read",
    "status",
  ]);
  assert.equal(Object.isFrozen(laterLoaded.codexDotenv), true);
  assert.equal(Object.isFrozen(laterLoaded.journal), true);
  assert.equal(Object.isFrozen(laterLoaded.legacy), true);
  assert.equal(Object.isFrozen(laterLoaded.read), true);
  assert.equal(Object.isFrozen(laterLoaded.observation), true);
  assert.equal(Object.isFrozen(laterLoaded.mutation), true);
  assert.deepEqual(Object.keys(laterLoaded.journal), ["acquire"]);
  assert.deepEqual(Object.keys(laterLoaded.codexDotenv).sort(), [
    "observe",
    "synchronize",
  ]);
  assert.deepEqual(Object.keys(laterLoaded.legacy), ["read"]);
  assert.deepEqual(Object.keys(laterLoaded.read), ["openPrivateDirectory"]);
  assert.deepEqual(Object.keys(laterLoaded.observation), ["openPrivateDirectory"]);
  assert.deepEqual(Object.keys(laterLoaded.mutation).sort(), [
    "acquireObservedSetupLease",
    "acquireSetupLease",
  ]);
  verificationStage = "cache-fail-closed";
  assert.strictEqual(laterProvider.load(), laterLoaded);
  assert.deepEqual(
    identity(lstatSync(artifactPath)),
    artifactIdentity,
    "later provider reuse must not replace the installed addon",
  );
  const loadedCacheEntry = nativeRequire.cache[artifactPath];
  assert.ok(loadedCacheEntry !== undefined);
  assert.equal(loadedCacheEntry.filename, artifactPath);
  assert.equal(delete nativeRequire.cache[artifactPath], true);
  assert.equal(Object.hasOwn(nativeRequire.cache, artifactPath), false);
  const thirdProvider = resolverModule.createNativeCredentialPackageProvider(
    target,
    nativeConfiguration,
  );
  assert.equal(Object.isFrozen(thirdProvider), true);
  const poisoned = thirdProvider.load();
  assert.equal(Object.isFrozen(poisoned), true);
  assert.deepEqual(poisoned, {
    status: "unavailable",
    code: "native_credential_store_unavailable",
  });
  assert.strictEqual(thirdProvider.load(), poisoned);
  assert.equal(
    Object.hasOwn(nativeRequire.cache, artifactPath),
    false,
    "cache removal must fail closed without reloading the addon",
  );
  assert.deepEqual(identity(lstatSync(artifactPath)), artifactIdentity);
  const artifactAfter = boundedBytes(
    artifactPath,
    MAX_NATIVE_ARTIFACT_BYTES,
    "installed native addon",
  );
  assert.equal(sha256(artifactAfter), manifest.plurumNative.sha256);
  assert.equal(dirname(realpathSync(artifactPath)), presentCandidates[0]);
} else {
  verificationStage = "unavailable-provider";
  const unavailable = provider.load();
  assert.equal(Object.isFrozen(unavailable), true);
  assert.deepEqual(unavailable, {
    status: "unavailable",
    code: "native_credential_store_unavailable",
  });
  assert.strictEqual(provider.load(), unavailable);
  assert.deepEqual(candidates.filter(pathExists), []);
}

verificationStage = "complete";
process.stdout.write(
  `packaged native provider verified (${mode}/${cachePolicy})\n`,
);
