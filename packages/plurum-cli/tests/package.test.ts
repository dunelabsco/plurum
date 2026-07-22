import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CLI_VERSION } from "../src/version.js";
import {
  SUPPORTED_NODE_RUNTIME_RANGES,
} from "../src/system/runtime-support.js";

interface PackageJson {
  readonly name: string;
  readonly version: string;
  readonly private: boolean;
  readonly type: string;
  readonly bin: Record<string, string>;
  readonly files: readonly string[];
  readonly scripts: Record<string, string>;
  readonly engines: Record<string, string>;
  readonly license: string;
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly bundleDependencies?: readonly string[] | boolean;
  readonly bundledDependencies?: readonly string[] | boolean;
  readonly peerDependencies?: Record<string, string>;
  readonly peerDependenciesMeta?: Record<string, unknown>;
}

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageJson;

describe("package safety invariants", () => {
  it("is an unpublished ESM package with the intended binary", () => {
    expect(packageJson.name).toBe("plurum");
    expect(packageJson.version).toBe(CLI_VERSION);
    expect(packageJson.private).toBe(true);
    expect(packageJson.type).toBe("module");
    expect(packageJson.bin).toEqual({ plurum: "./dist/index.js" });
    expect(packageJson.license).toBe("Apache-2.0");
    expect(packageJson.engines.node).toBe(
      SUPPORTED_NODE_RUNTIME_RANGES.join(" || "),
    );
  });

  it("ships only the runtime build and required package documents", () => {
    expect(packageJson.files).toEqual(["dist", "LICENSE", "README.md"]);
    expect(packageJson.dependencies).toBeUndefined();
    expect(packageJson.optionalDependencies).toBeUndefined();
    expect(packageJson.bundleDependencies).toBeUndefined();
    expect(packageJson.bundledDependencies).toBeUndefined();
    expect(packageJson.peerDependencies).toBeUndefined();
    expect(packageJson.peerDependenciesMeta).toBeUndefined();
    expect(packageJson.scripts).toEqual({
      clean:
        "node -e \"require('node:fs').rmSync('dist',{recursive:true,force:true})\"",
      "verify-capabilities": "node scripts/verify-capability-boundary.mjs",
      prebuild: "npm run clean && npm run verify-capabilities",
      build: "tsc -p tsconfig.build.json",
      typecheck: "tsc -p tsconfig.json --noEmit",
      pretest: "npm run build",
      test: "vitest run",
      "verify-package": "node scripts/verify-package.mjs",
      check:
        "npm run verify-capabilities && npm run typecheck && npm test && npm run verify-package",
      prepack: "npm run check",
    });
    for (const forbiddenLifecycle of [
      "preinstall",
      "install",
      "postinstall",
      "prepublish",
      "preprepare",
      "prepare",
      "postprepare",
    ]) {
      expect(packageJson.scripts[forbiddenLifecycle]).toBeUndefined();
    }
  });

  it("keeps obsolete product surfaces out of package copy", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    for (const obsolete of [
      "collective consciousness",
      "knowledge graph",
      "plurum_register",
      "sessions",
      "pulse",
      "acquire",
    ]) {
      expect(readme.toLowerCase()).not.toContain(obsolete);
    }
  });

  it("keeps the executable shebang in source", () => {
    const entrypoint = readFileSync(
      new URL("../src/index.ts", import.meta.url),
      "utf8",
    );
    expect(entrypoint.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("runs the AST capability gate before builds, tests, and packaging", () => {
    expect(packageJson.scripts["verify-capabilities"]).toBe(
      "node scripts/verify-capability-boundary.mjs",
    );
    expect(packageJson.scripts.prebuild).toBe(
      "npm run clean && npm run verify-capabilities",
    );
    expect(packageJson.scripts.check).toBe(
      "npm run verify-capabilities && npm run typecheck && npm test && npm run verify-package",
    );
    expect(packageJson.scripts.prepack).toBe("npm run check");
  });
});
