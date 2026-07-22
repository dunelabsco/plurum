import { lstatSync, realpathSync } from "node:fs";
import {
  basename,
  isAbsolute,
  relative,
  resolve as resolvePath,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const configuredRoot = process.env.PLURUM_VERIFY_INSTALLED_ROOT;
if (configuredRoot === undefined || !isAbsolute(configuredRoot)) {
  throw new Error("installed native verification root is invalid");
}
const installedRoot = realpathSync(configuredRoot);
if (
  installedRoot !== resolvePath(configuredRoot) ||
  basename(installedRoot) !== "plurum"
) {
  throw new Error("installed native verification root is invalid");
}
const installedRootMetadata = lstatSync(installedRoot);
if (
  installedRootMetadata.isSymbolicLink() ||
  !installedRootMetadata.isDirectory()
) {
  throw new Error("installed native verification root is invalid");
}
const installedRootUrl = pathToFileURL(`${installedRoot}${sep}`).href;
const graph = new Map([
  [
    "dist/adapters/node/native-credential-package.js",
    new Set([
      "node:crypto",
      "node:fs",
      "node:module",
      "node:path",
      "node:url",
      "./native-credential-store.js",
      "../../system/runtime-support.js",
      "../../version.js",
    ]),
  ],
  [
    "dist/adapters/node/native-credential-store.js",
    new Set(["../../version.js"]),
  ],
  ["dist/system/runtime-support.js", new Set()],
  ["dist/version.js", new Set()],
]);

function installedRelativePath(url) {
  const path = fileURLToPath(url);
  const difference = relative(installedRoot, path);
  if (
    difference === "" ||
    difference === ".." ||
    difference.startsWith(`..${sep}`) ||
    isAbsolute(difference)
  ) {
    throw new Error("installed native module escaped its package boundary");
  }
  return difference.split(sep).join("/");
}

const moduleUrls = new Map();
for (const modulePath of graph.keys()) {
  const path = `${installedRoot}/${modulePath}`;
  const canonical = realpathSync(path);
  const metadata = lstatSync(path);
  if (
    canonical !== resolvePath(path) ||
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    metadata.size <= 0 ||
    metadata.size > 2 * 1024 * 1024
  ) {
    throw new Error("installed native module graph is invalid");
  }
  moduleUrls.set(modulePath, pathToFileURL(canonical).href);
}
const entryUrl = moduleUrls.get(
  "dist/adapters/node/native-credential-package.js",
);

export async function resolve(specifier, context, nextResolve) {
  const parentUrl = context.parentURL;
  const installedParent = parentUrl?.startsWith(installedRootUrl) === true;
  let parentPath;
  if (installedParent) {
    parentPath = installedRelativePath(parentUrl);
    const allowedSpecifiers = graph.get(parentPath);
    if (allowedSpecifiers === undefined || !allowedSpecifiers.has(specifier)) {
      throw new Error("installed native module requested a forbidden import");
    }
  }

  const resolution = await nextResolve(specifier, context);
  if (installedParent && specifier.startsWith("node:")) {
    if (resolution.url !== specifier) {
      throw new Error("installed native builtin import resolved unexpectedly");
    }
    return resolution;
  }
  if (installedParent) {
    if (
      !resolution.url.startsWith(installedRootUrl) ||
      resolution.url.includes("?") ||
      resolution.url.includes("#")
    ) {
      throw new Error("installed native module escaped its package boundary");
    }
    const resolvedPath = installedRelativePath(resolution.url);
    if (graph.has(resolvedPath) === false || moduleUrls.get(resolvedPath) !== resolution.url) {
      throw new Error("installed native module escaped its audited graph");
    }
    return resolution;
  }
  if (
    resolution.url.startsWith(installedRootUrl) &&
    resolution.url !== entryUrl
  ) {
    throw new Error("native verifier entered an unaudited installed module");
  }
  return resolution;
}
