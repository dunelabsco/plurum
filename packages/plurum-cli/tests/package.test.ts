import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CLI_VERSION } from "../src/version.js";

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
    expect(packageJson.engines.node).toBe("^22.12.0 || ^24.0.0");
  });

  it("ships only the runtime build and required package documents", () => {
    expect(packageJson.files).toEqual(["dist", "LICENSE", "README.md"]);
    expect(packageJson.dependencies).toBeUndefined();
    for (const forbiddenLifecycle of [
      "preinstall",
      "install",
      "postinstall",
      "prepare",
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
