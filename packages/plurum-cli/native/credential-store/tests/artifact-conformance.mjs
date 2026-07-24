import assert from "node:assert/strict";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const crateRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(crateRoot, "..", "..");
const nativeExtensions = new Set([
  ".a",
  ".dll",
  ".dylib",
  ".exp",
  ".lib",
  ".node",
  ".o",
  ".obj",
  ".pdb",
  ".rlib",
  ".rmeta",
  ".so",
]);

assert.equal(
  existsSync(join(crateRoot, "target")),
  false,
  "Cargo output must remain outside the package tree",
);

function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") {
      continue;
    }
    const path = join(directory, entry.name);
    const metadata = lstatSync(path);
    const displayPath = relative(packageRoot, path).split(sep).join("/");
    assert.equal(
      metadata.isSymbolicLink(),
      false,
      `package source must not contain a symlink: ${displayPath}`,
    );
    if (entry.isDirectory()) {
      inspect(path);
    } else {
      assert.equal(
        nativeExtensions.has(extname(entry.name).toLowerCase()),
        false,
        `native artifact must not enter the package tree: ${displayPath}`,
      );
    }
  }
}

inspect(packageRoot);
console.log("native credential artifact boundary conforms");
