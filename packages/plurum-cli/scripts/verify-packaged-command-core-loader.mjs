import { realpathSync } from "node:fs";
import { relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const installedRoot = realpathSync(
  process.env.PLURUM_VERIFY_INSTALLED_ROOT ?? "",
);
const installedRootUrl = pathToFileURL(`${installedRoot}${sep}`).href;
const allowedModulesPayload = process.env.PLURUM_VERIFY_ALLOWED_MODULES ?? "";
if (
  allowedModulesPayload.length === 0 ||
  allowedModulesPayload.length > 32 * 1024
) {
  throw new Error("installed command module allowlist is invalid");
}
const allowedModulePaths = JSON.parse(
  Buffer.from(allowedModulesPayload, "base64url").toString("utf8"),
);
if (
  !Array.isArray(allowedModulePaths) ||
  allowedModulePaths.length === 0 ||
  allowedModulePaths.length > 256
) {
  throw new Error("installed command module allowlist is invalid");
}
const allowedModuleUrls = new Set();
for (const modulePath of allowedModulePaths) {
  if (
    typeof modulePath !== "string" ||
    !/^dist\/[a-z0-9][a-z0-9./-]*\.js$/u.test(modulePath)
  ) {
    throw new Error("installed command module allowlist is invalid");
  }
  const canonicalModule = realpathSync(`${installedRoot}/${modulePath}`);
  if (installedRelativePath(pathToFileURL(canonicalModule).href) !== modulePath) {
    throw new Error("installed command module allowlist is invalid");
  }
  const moduleUrl = pathToFileURL(canonicalModule).href;
  if (
    !moduleUrl.startsWith(installedRootUrl) ||
    allowedModuleUrls.has(moduleUrl)
  ) {
    throw new Error("installed command module allowlist is invalid");
  }
  allowedModuleUrls.add(moduleUrl);
}
if (allowedModuleUrls.size !== allowedModulePaths.length) {
  throw new Error("installed command module allowlist is invalid");
}

function installedRelativePath(parentUrl) {
  return relative(installedRoot, fileURLToPath(parentUrl)).split(sep).join("/");
}

export async function resolve(specifier, context, nextResolve) {
  const installedParent = context.parentURL?.startsWith(installedRootUrl) === true;
  if (installedParent) {
    if (
      specifier === "node:util" &&
      installedRelativePath(context.parentURL) === "dist/cli.js"
    ) {
      return await nextResolve(specifier, context);
    }
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      throw new Error("installed command module requested a forbidden import");
    }
  }
  const resolution = await nextResolve(specifier, context);
  if (installedParent && !resolution.url.startsWith(installedRootUrl)) {
    throw new Error("installed command module escaped its package boundary");
  }
  if (resolution.url.startsWith(installedRootUrl)) {
    if (
      !allowedModuleUrls.has(resolution.url) ||
      resolution.url.includes("?") ||
      resolution.url.includes("#")
    ) {
      throw new Error("installed command module escaped its audited graph");
    }
  }
  return resolution;
}
