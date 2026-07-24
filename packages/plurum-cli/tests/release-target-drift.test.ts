import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NATIVE_CREDENTIAL_TARGET_IDS } from "../src/adapters/node/native-credential-store.js";
import { NATIVE_CREDENTIAL_PACKAGE_BY_TARGET } from "../src/adapters/node/native-credential-package.js";
import { CLI_VERSION } from "../src/version.js";
import {
  RECOGNIZED_RUNTIME_TARGETS,
  RELEASED_RUNTIME_TARGETS,
  SUPPORTED_NODE_RUNTIME_RANGES,
} from "../src/system/runtime-support.js";

interface NativeWorkflowRow {
  readonly os: string;
  readonly architecture: "arm64" | "x64";
  readonly target: string;
  readonly rustHost: string;
}

interface NativeWorkflowStep {
  readonly name: string | null;
  readonly lines: readonly string[];
}

const workflow = source("../../../.github/workflows/ci.yml");
const rustTargetMap = source("../native/credential-store/src/target_map.rs");
const abiConformance = source(
  "../native/credential-store/tests/abi-conformance.mjs",
);
const prepareIsolation = source(
  "../native/credential-store/tests/prepare-isolation.mjs",
);
const isolatedCargoRunner = source(
  "../native/credential-store/tests/run-isolated-cargo.mjs",
);
const nativePackageAssembler = source(
  "../native/credential-store/tests/assemble-native-package.mjs",
);
const nativeBuildScript = source("../native/credential-store/build.rs");
const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as Readonly<{
  optionalDependencies?: Readonly<Record<string, string>>;
}>;
const packageLock = JSON.parse(
  readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
) as Readonly<{
  packages: Readonly<
    Record<
      string,
      Readonly<{
        version?: string;
        cpu?: readonly string[];
        libc?: readonly string[];
        license?: string;
        optional?: boolean;
        os?: readonly string[];
        engines?: Readonly<{ node?: string }>;
        optionalDependencies?: Readonly<Record<string, string>>;
      }>
    >
  >;
}>;

const nativeLockPlatformByTarget = Object.freeze({
  "darwin-arm64": Object.freeze({ os: "darwin", cpu: "arm64", libc: null }),
  "darwin-x64": Object.freeze({ os: "darwin", cpu: "x64", libc: null }),
  "linux-arm64-gnu": Object.freeze({
    os: "linux",
    cpu: "arm64",
    libc: "glibc",
  }),
  "linux-x64-gnu": Object.freeze({
    os: "linux",
    cpu: "x64",
    libc: "glibc",
  }),
  "win32-x64-msvc": Object.freeze({ os: "win32", cpu: "x64", libc: null }),
} as const);

function source(relativePath: string): readonly string[] {
  const text = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const normalized = text.replaceAll("\r\n", "\n");
  if (normalized.includes("\r")) {
    throw new Error(`${relativePath} contains a noncanonical line ending`);
  }
  return normalized.split("\n");
}

function uniqueLine(lines: readonly string[], expected: string): number {
  const matches = lines.flatMap((line, index) =>
    line === expected ? [index] : [],
  );
  if (matches.length !== 1) {
    throw new Error(`expected one exact line ${JSON.stringify(expected)}`);
  }
  return matches[0] as number;
}

function uniqueFollowingLine(
  lines: readonly string[],
  expected: string,
  after: number,
): number {
  const matches = lines.flatMap((line, index) =>
    index > after && line === expected ? [index] : [],
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected one exact ${JSON.stringify(expected)} line after ${after}`,
    );
  }
  return matches[0] as number;
}

function exactUnique(values: readonly string[], label: string): string[] {
  const unique = new Set(values);
  if (unique.size !== values.length) {
    throw new Error(`${label} contains a duplicate`);
  }
  return [...unique].sort();
}

function exactMap(
  entries: readonly (readonly [string, string])[],
  label: string,
): ReadonlyMap<string, string> {
  const keys = exactUnique(
    entries.map(([key]) => key),
    `${label} keys`,
  );
  const values = exactUnique(
    entries.map(([, value]) => value),
    `${label} values`,
  );
  if (keys.length !== entries.length || values.length !== entries.length) {
    throw new Error(`${label} is not one-to-one`);
  }
  return new Map(entries);
}

function sortedEntries(map: ReadonlyMap<string, string>): string[][] {
  return [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, value]);
}

function parseNativeWorkflowJob(lines: readonly string[]): readonly string[] {
  const jobStart = uniqueLine(lines, "  native-credential-abi:");
  const nextJobOffset = lines
    .slice(jobStart + 1)
    .findIndex((line) => /^  [a-z][a-z0-9-]*:$/u.test(line));
  const jobEnd =
    nextJobOffset === -1 ? lines.length : jobStart + nextJobOffset + 1;
  return lines.slice(jobStart, jobEnd);
}

function parseWorkflowRows(job: readonly string[]): NativeWorkflowRow[] {
  const include = uniqueLine(job, "        include:");
  const defaults = uniqueFollowingLine(job, "    defaults:", include);
  const rowLines = job.slice(include + 1, defaults);
  if (rowLines.length === 0) {
    throw new Error("native credential ABI matrix has no rows");
  }

  const rows: Array<Record<string, string>> = [];
  let current: Record<string, string> | undefined;
  for (const line of rowLines) {
    const first = /^          - ([a-z_]+): ([^\s].*)$/u.exec(line);
    const continuation = /^            ([a-z_]+): ([^\s].*)$/u.exec(line);
    const match = first ?? continuation;
    if (match === null || (first === null && current === undefined)) {
      throw new Error(`invalid native matrix row line: ${JSON.stringify(line)}`);
    }
    if (first !== null) {
      current = Object.create(null) as Record<string, string>;
      rows.push(current);
    }
    const key = match[1];
    const value = match[2];
    if (
      current === undefined ||
      key === undefined ||
      value === undefined ||
      !["os", "architecture", "target", "rust_host"].includes(key) ||
      Object.hasOwn(current, key)
    ) {
      throw new Error(`invalid native matrix field: ${JSON.stringify(line)}`);
    }
    current[key] = value;
  }

  const normalized = rows.map((row) => {
    if (
      Object.keys(row).length !== 4 ||
      typeof row.os !== "string" ||
      (row.architecture !== "arm64" && row.architecture !== "x64") ||
      typeof row.target !== "string" ||
      typeof row.rust_host !== "string" ||
      !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(row.os) ||
      !/^(?:darwin-(?:arm64|x64)|linux-(?:arm64|x64)-(?:gnu|musl)|win32-(?:arm64|x64)-msvc)$/u.test(
        row.target,
      ) ||
      !/^(?:aarch64|x86_64)-(?:apple-darwin|unknown-linux-(?:gnu|musl)|pc-windows-msvc)$/u.test(
        row.rust_host,
      )
    ) {
      throw new Error("native credential ABI matrix row is malformed");
    }
    return Object.freeze({
      os: row.os,
      architecture: row.architecture,
      target: row.target,
      rustHost: row.rust_host,
    });
  });
  exactUnique(
    normalized.map(({ target }) => target),
    "native workflow targets",
  );
  exactUnique(
    normalized.map(({ rustHost }) => rustHost),
    "native workflow Rust hosts",
  );
  return normalized;
}

function exactLineCount(lines: readonly string[], expected: string): number {
  return lines.filter((line) => line === expected).length;
}

function parseWorkflowSteps(job: readonly string[]): NativeWorkflowStep[] {
  const start = uniqueLine(job, "    steps:");
  const body = [...job.slice(start + 1)];
  while (body.at(-1) === "") {
    body.pop();
  }
  const steps: Array<{ name: string | null; lines: string[] }> = [];
  let current: { name: string | null; lines: string[] } | undefined;
  for (const line of body) {
    const stepStart = /^      - (?:name: (.+)|uses: .+)$/u.exec(line);
    if (stepStart !== null) {
      current = {
        name: stepStart[1] ?? null,
        lines: [line],
      };
      steps.push(current);
      continue;
    }
    if (current === undefined || !/^ {8,}\S/u.test(line)) {
      throw new Error(`invalid native workflow step line: ${JSON.stringify(line)}`);
    }
    current.lines.push(line);
  }
  if (steps.length === 0) {
    throw new Error("native workflow has no steps");
  }
  return steps.map(({ name, lines }) =>
    Object.freeze({ name, lines: Object.freeze(lines) }),
  );
}

function uniqueNamedStep(
  steps: readonly NativeWorkflowStep[],
  name: string,
): NativeWorkflowStep {
  const matches = steps.filter((step) => step.name === name);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(`expected one native workflow step ${JSON.stringify(name)}`);
  }
  return matches[0];
}

function uniqueStepContaining(
  steps: readonly NativeWorkflowStep[],
  expectedLine: string,
): NativeWorkflowStep {
  const matches = steps.filter((step) => step.lines.includes(expectedLine));
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(
      `expected one native workflow step containing ${JSON.stringify(expectedLine)}`,
    );
  }
  return matches[0];
}

function parseRustTargetMap(
  lines: readonly string[],
): ReadonlyMap<string, string> {
  const start = uniqueLine(lines, "    match rust_target {");
  const fallback = uniqueFollowingLine(lines, "        _ => None,", start);
  if (lines[fallback + 1] !== "    }" || lines[fallback + 2] !== "}") {
    throw new Error("Rust target map has an unexpected closing shape");
  }
  const entries = lines.slice(start + 1, fallback).map((line) => {
    const match =
      /^        "([^"]+)" => Some\("([^"]+)"\),$/u.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error(`invalid Rust target mapping: ${JSON.stringify(line)}`);
    }
    return [match[1], match[2]] as const;
  });
  if (entries.length === 0) {
    throw new Error("Rust target map is empty");
  }
  return exactMap(entries, "Rust target map");
}

function parseJavascriptMap(
  lines: readonly string[],
  declaration: string,
): ReadonlyMap<string, string> {
  const start = uniqueLine(lines, declaration);
  const end = uniqueFollowingLine(lines, "});", start);
  const entries = lines.slice(start + 1, end).map((line) => {
    const match = /^  "([^"]+)": "([^"]+)",$/u.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error(`invalid JavaScript mapping: ${JSON.stringify(line)}`);
    }
    return [match[1], match[2]] as const;
  });
  if (entries.length === 0) {
    throw new Error(`${declaration} is empty`);
  }
  return exactMap(entries, declaration);
}

function parseJavascriptSet(
  lines: readonly string[],
  declaration: string,
): string[] {
  const start = uniqueLine(lines, declaration);
  const end = uniqueFollowingLine(lines, "]);", start);
  const values = lines.slice(start + 1, end).map((line) => {
    const match = /^  "([^"]+)",$/u.exec(line);
    if (match?.[1] === undefined) {
      throw new Error(`invalid JavaScript set entry: ${JSON.stringify(line)}`);
    }
    return match[1];
  });
  if (values.length === 0) {
    throw new Error(`${declaration} is empty`);
  }
  return exactUnique(values, declaration);
}

function parsePrepareRuntimeMap(
  lines: readonly string[],
): ReadonlyMap<string, string> {
  const start = uniqueLine(lines, "const expectedRustHost = {");
  const end = uniqueFollowingLine(
    lines,
    "}[`${process.platform}-${process.arch}`];",
    start,
  );
  const entries = lines.slice(start + 1, end).map((line) => {
    const match = /^  "([^"]+)": "([^"]+)",$/u.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error(
        `invalid prepare-isolation runtime mapping: ${JSON.stringify(line)}`,
      );
    }
    return [match[1], match[2]] as const;
  });
  return exactMap(entries, "prepare-isolation runtime map");
}

function runtimeTarget(target: string): string {
  return target.replace(/-(?:gnu|musl|msvc)$/u, "");
}

function targetOsMatchesRunner(target: string, os: string): boolean {
  return (
    (target.startsWith("darwin-") && os.startsWith("macos-")) ||
    (target.startsWith("linux-") && os.startsWith("ubuntu-")) ||
    (target.startsWith("win32-") && os.startsWith("windows-"))
  );
}

describe("native release target drift", () => {
  const nativeWorkflowJob = parseNativeWorkflowJob(workflow);
  const workflowRows = parseWorkflowRows(nativeWorkflowJob);
  const workflowSteps = parseWorkflowSteps(nativeWorkflowJob);
  const nativeTargets = exactUnique(
    NATIVE_CREDENTIAL_TARGET_IDS,
    "native credential target IDs",
  );
  const recognizedTargets = exactUnique(
    RECOGNIZED_RUNTIME_TARGETS,
    "recognized runtime targets",
  );
  const releasedTargets = exactUnique(
    RELEASED_RUNTIME_TARGETS,
    "released runtime targets",
  );
  const rustTargets = parseRustTargetMap(rustTargetMap);
  const abiTargets = parseJavascriptMap(
    abiConformance,
    "const rustHostTargets = Object.freeze({",
  );
  const preparedRustHosts = parseJavascriptSet(
    prepareIsolation,
    "const rustHosts = new Set([",
  );
  const preparedRuntimeHosts = parsePrepareRuntimeMap(prepareIsolation);

  it("keeps released runtime targets equal to the five native CI rows", () => {
    expect(RELEASED_RUNTIME_TARGETS).toHaveLength(5);
    expect(workflowRows).toHaveLength(5);
    expect(
      exactUnique(
        Object.keys(NATIVE_CREDENTIAL_PACKAGE_BY_TARGET),
        "native package targets",
      ),
    ).toEqual(releasedTargets);
    expect(
      exactUnique(
        Object.values(NATIVE_CREDENTIAL_PACKAGE_BY_TARGET),
        "native package names",
      ),
    ).toHaveLength(5);
    expect(packageMetadata.optionalDependencies).toEqual(
      Object.fromEntries(
        Object.values(NATIVE_CREDENTIAL_PACKAGE_BY_TARGET).map((name) => [
          name,
          CLI_VERSION,
        ]),
      ),
    );
    expect(
      exactUnique(
        workflowRows.map(({ target }) => target),
        "native workflow targets",
      ),
    ).toEqual(releasedTargets);
    expect(
      RELEASED_RUNTIME_TARGETS.every((target) =>
        NATIVE_CREDENTIAL_TARGET_IDS.includes(target),
      ),
    ).toBe(true);

    for (const row of workflowRows) {
      expect(row.target).toContain(`-${row.architecture}`);
      expect(targetOsMatchesRunner(row.target, row.os)).toBe(true);
    }
  });

  it("keeps every native optional dependency represented in the npm lock", () => {
    const packageNames = exactUnique(
      Object.values(NATIVE_CREDENTIAL_PACKAGE_BY_TARGET),
      "native package names",
    );
    const expectedLockPaths = packageNames.map(
      (name) => `node_modules/${name}`,
    );
    const nativeLockPaths = Object.keys(packageLock.packages)
      .filter((path) => path.startsWith("node_modules/@dunelabs/plurum-native-"))
      .sort();

    expect(packageLock.packages[""]?.optionalDependencies).toEqual(
      packageMetadata.optionalDependencies,
    );
    expect(nativeLockPaths).toEqual(expectedLockPaths);

    for (const target of RELEASED_RUNTIME_TARGETS) {
      const name = NATIVE_CREDENTIAL_PACKAGE_BY_TARGET[target];
      const platform = nativeLockPlatformByTarget[target];
      const locked = packageLock.packages[`node_modules/${name}`];

      expect(locked).toBeDefined();
      expect(locked?.version).toBe(CLI_VERSION);
      expect(locked?.license).toBe("Apache-2.0");
      expect(locked?.optional).toBe(true);
      expect(locked?.os).toEqual([platform.os]);
      expect(locked?.cpu).toEqual([platform.cpu]);
      expect(locked?.libc).toEqual(
        platform.libc === null ? undefined : [platform.libc],
      );
      expect(locked?.engines).toEqual({
        node: SUPPORTED_NODE_RUNTIME_RANGES.join(" || "),
      });
    }
  });

  it("keeps the native CI matrix bound to build and ABI verification", () => {
    expect(exactLineCount(nativeWorkflowJob, "    runs-on: ${{ matrix.os }}")).toBe(1);
    expect(
      exactLineCount(
        nativeWorkflowJob,
        "    name: native credential ABI (${{ matrix.target }})",
      ),
    ).toBe(1);

    const node22 = uniqueStepContaining(
      workflowSteps,
      '          node-version: "22.12.0"',
    );
    const node24 = uniqueStepContaining(
      workflowSteps,
      '          node-version: "24.0.0"',
    );
    for (const step of [node22, node24]) {
      expect(step.lines[0]).toMatch(
        /^      - uses: actions\/setup-node@[0-9a-f]{40} # v4\.4\.0$/u,
      );
      expect(step.lines.at(-1)).toBe(
        "          architecture: ${{ matrix.architecture }}",
      );
    }

    expect(
      uniqueNamedStep(workflowSteps, "Prepare isolated native test paths").lines,
    ).toEqual([
      "      - name: Prepare isolated native test paths",
      "        run: node native/credential-store/tests/prepare-isolation.mjs",
      "        env:",
      "          PLURUM_NATIVE_ISOLATION_ROOT: ${{ runner.temp }}/plurum-native-isolation",
      "          PLURUM_NATIVE_RUST_HOST: ${{ matrix.rust_host }}",
    ]);
    expect(
      uniqueNamedStep(workflowSteps, "Build the native foundation").lines,
    ).toEqual([
      "      - name: Build the native foundation",
      "        run: node native/credential-store/tests/run-isolated-cargo.mjs build",
    ]);
    expect(
      uniqueNamedStep(workflowSteps, "Verify the Node 22.12 ABI floor").lines,
    ).toEqual([
      "      - name: Verify the Node 22.12 ABI floor",
      "        run: node native/credential-store/tests/abi-conformance.mjs",
      "        env:",
      '          PLURUM_NATIVE_EXPECTED_NODE: "22.12.0"',
      "          PLURUM_NATIVE_EXPECTED_TARGET: ${{ matrix.target }}",
    ]);
    expect(
      uniqueNamedStep(
        workflowSteps,
        "Verify the Node 22.12 installed native package",
      ).lines,
    ).toEqual([
      "      - name: Verify the Node 22.12 installed native package",
      "        run: npm run verify-native-package",
      "        env:",
      '          PLURUM_NATIVE_EXPECTED_NODE: "22.12.0"',
      "          PLURUM_NATIVE_EXPECTED_TARGET: ${{ matrix.target }}",
    ]);
    expect(
      uniqueNamedStep(workflowSteps, "Verify the Node 24 ABI").lines,
    ).toEqual([
      "      - name: Verify the Node 24 ABI",
      "        run: node native/credential-store/tests/abi-conformance.mjs",
      "        env:",
      '          PLURUM_NATIVE_EXPECTED_NODE: "24.0.0"',
      "          PLURUM_NATIVE_EXPECTED_TARGET: ${{ matrix.target }}",
    ]);
    expect(
      uniqueNamedStep(
        workflowSteps,
        "Verify the Node 24 installed native package",
      ).lines,
    ).toEqual([
      "      - name: Verify the Node 24 installed native package",
      "        run: npm run verify-native-package",
      "        env:",
      '          PLURUM_NATIVE_EXPECTED_NODE: "24.0.0"',
      "          PLURUM_NATIVE_EXPECTED_TARGET: ${{ matrix.target }}",
    ]);
    expect(
      uniqueNamedStep(workflowSteps, "Verify the unwired CLI package").lines,
    ).toEqual([
      "      - name: Verify the unwired CLI package",
      "        run: npm run check",
    ]);
    expect(
      uniqueNamedStep(workflowSteps, "Recheck the npm package on Node 24").lines,
    ).toEqual([
      "      - name: Recheck the npm package on Node 24",
      "        run: npm run verify-package",
    ]);
    expect(
      uniqueNamedStep(
        workflowSteps,
        "Verify no native artifact entered the package tree",
      ).lines,
    ).toEqual([
      "      - name: Verify no native artifact entered the package tree",
      "        run: node native/credential-store/tests/artifact-conformance.mjs",
    ]);
  });

  it("keeps the CI release build path-remapped before package assembly", () => {
    expect(
      uniqueNamedStep(workflowSteps, "Build the native foundation").lines,
    ).toEqual([
      "      - name: Build the native foundation",
      "        run: node native/credential-store/tests/run-isolated-cargo.mjs build",
    ]);

    const remapFunction = uniqueLine(
      isolatedCargoRunner,
      "function encodedReleaseBuildRustFlags(mode, isolationRoot) {",
    );
    const buildOnlyGuard = uniqueFollowingLine(
      isolatedCargoRunner,
      '  if (mode !== "build") {',
      remapFunction,
    );
    const sourceRemap = uniqueFollowingLine(
      isolatedCargoRunner,
      "      ...remapSourceSpellings(sourceWorkspaceRoot).map((source) =>",
      buildOnlyGuard,
    );
    const isolationRemap = uniqueFollowingLine(
      isolatedCargoRunner,
      "      ...remapSourceSpellings(isolationRoot).map((source) =>",
      sourceRemap,
    );
    expect(
      uniqueFollowingLine(
        isolatedCargoRunner,
        "    ].sort(compareRemapSources),",
        isolationRemap,
      ),
    ).toBeGreaterThan(isolationRemap);
    expect(
      exactLineCount(
        isolatedCargoRunner,
        "    left.length - right.length || (left < right ? -1 : left > right ? 1 : 0)",
      ),
    ).toBe(1);
    const encodedFlags = uniqueFollowingLine(
      isolatedCargoRunner,
      "  return flags.join(encodedRustflagSeparator);",
      isolationRemap,
    );
    const configuredFlags = uniqueFollowingLine(
      isolatedCargoRunner,
      "const releaseBuildRustFlags = encodedReleaseBuildRustFlags(mode, isolationRoot);",
      encodedFlags,
    );
    expect(
      uniqueFollowingLine(
        isolatedCargoRunner,
        "    : { CARGO_ENCODED_RUSTFLAGS: releaseBuildRustFlags }),",
        configuredFlags,
      ),
    ).toBeGreaterThan(configuredFlags);
    expect(
      exactLineCount(
        isolatedCargoRunner,
        'const encodedRustflagSeparator = "\\x1f";',
      ),
    ).toBe(1);
    expect(
      exactLineCount(
        isolatedCargoRunner,
        "  const namespaced = toNamespacedPath(source);",
      ),
    ).toBe(1);
    expect(
      exactLineCount(
        isolatedCargoRunner,
        '    spellings.add(spelling.replaceAll("\\\\", "/"));',
      ),
    ).toBe(1);
    expect(
      exactLineCount(
        isolatedCargoRunner,
        "      const driveIndex = drive[0].length - 3;",
      ),
    ).toBe(1);
    expect(
      exactLineCount(
        isolatedCargoRunner,
        'const remappedSourceRoot = "/plurum/source";',
      ),
    ).toBe(1);
    expect(
      exactLineCount(
        isolatedCargoRunner,
        'const remappedIsolationRoot = "/plurum/native-isolation";',
      ),
    ).toBe(1);
    expect(
      exactLineCount(
        isolatedCargoRunner,
        'const sourceWorkspaceRoot = realpathSync(resolve(crateRoot, "../../../.."));',
      ),
    ).toBe(1);

    const macosTargetGuard = uniqueLine(
      nativeBuildScript,
      '        "aarch64-apple-darwin" | "x86_64-apple-darwin"',
    );
    expect(
      nativeBuildScript.slice(macosTargetGuard - 2, macosTargetGuard + 4),
    ).toEqual([
      "    if matches!(",
      "        rust_target.as_str(),",
      '        "aarch64-apple-darwin" | "x86_64-apple-darwin"',
      "    ) {",
      '        println!("cargo:rustc-cdylib-link-arg=-Wl,-install_name,@rpath/credential-store.node");',
      "    }",
    ]);
    expect(
      nativeBuildScript.filter((line) =>
        line.includes("cargo:rustc-cdylib-link-arg="),
      ),
    ).toHaveLength(1);

    const artifactRead = uniqueLine(
      nativePackageAssembler,
      "  const cargoBytes = readFileSync(cargoBinary);",
    );
    expect(
      exactLineCount(
        nativePackageAssembler,
        '    Object.freeze({ label: "source workspace", path: sourceWorkspaceRoot }),',
      ),
    ).toBe(1);
    expect(
      exactLineCount(
        nativePackageAssembler,
        '    Object.freeze({ label: "native isolation", path: isolationRoot }),',
      ),
    ).toBe(1);
    const artifactScan = uniqueFollowingLine(
      nativePackageAssembler,
      "  assertNoSensitiveBuildPaths(cargoBytes, isolation.root);",
      artifactRead,
    );
    const artifactDigest = uniqueFollowingLine(
      nativePackageAssembler,
      "  const cargoDigest = sha256(cargoBytes);",
      artifactScan,
    );
    const artifactCopy = uniqueFollowingLine(
      nativePackageAssembler,
      "    copyFileSync(cargoBinary, stagedArtifact, fsConstants.COPYFILE_EXCL);",
      artifactDigest,
    );
    expect(artifactRead).toBeLessThan(artifactScan);
    expect(artifactScan).toBeLessThan(artifactDigest);
    expect(artifactDigest).toBeLessThan(artifactCopy);
    expect(
      exactLineCount(
        nativePackageAssembler,
        '      for (const encoding of ["utf8", "utf16le"]) {',
      ),
    ).toBe(1);
    const artifactPathRejection = uniqueLine(
      nativePackageAssembler,
      "          artifactBytes.indexOf(needle),",
    );
    expect(nativePackageAssembler[artifactPathRejection + 1]).toBe(
      "          -1,",
    );
    expect(
      exactLineCount(
        nativePackageAssembler,
        "  const variants = new Set([path, toNamespacedPath(path)]);",
      ),
    ).toBe(1);
    expect(
      exactLineCount(
        nativePackageAssembler,
        '    variants.add(variant.replaceAll("\\\\", "/"));',
      ),
    ).toBe(1);
    expect(
      exactLineCount(
        nativePackageAssembler,
        '    variants.add(variant.replaceAll("/", "\\\\"));',
      ),
    ).toBe(1);
    for (const name of [
      "HOME",
      "USERPROFILE",
      "CARGO_HOME",
      "RUSTUP_HOME",
      "GITHUB_WORKSPACE",
    ]) {
      expect(exactLineCount(nativePackageAssembler, `  "${name}",`)).toBe(1);
    }
    expect(
      exactLineCount(
        nativePackageAssembler,
        "    const canonicalPath = realpathSync(value);",
      ),
    ).toBe(1);
  });

  it("keeps Windows path and descriptor identity reconciliation narrowly scoped", () => {
    const stableReadStart = uniqueLine(
      nativePackageAssembler,
      "function readStableBounded(path, maxBytes, label) {",
    );
    const stableReadEnd = uniqueFollowingLine(
      nativePackageAssembler,
      "function sha256(bytes) {",
      stableReadStart,
    );
    const stableRead = nativePackageAssembler.slice(
      stableReadStart,
      stableReadEnd,
    );
    expect(
      stableRead.filter(
        (line) => line.trim() === "assertPathAndDescriptorIdentity(",
      ),
    ).toHaveLength(2);
    expect(stableRead).toContain(
      "    assert.deepEqual(openedAfter, openedBefore, `${label} changed while reading`);",
    );

    const bridgeStart = uniqueLine(
      nativePackageAssembler,
      "function assertPathAndDescriptorIdentity(",
    );
    const bridgeEnd = uniqueFollowingLine(
      nativePackageAssembler,
      "function digest(bytes, algorithm, encoding) {",
      bridgeStart,
    );
    const bridge = nativePackageAssembler.slice(bridgeStart, bridgeEnd);
    expect(bridge).toContain('  if (process.platform === "win32") {');
    expect(bridge).toContain(
      "  assert.deepEqual(pathIdentity, descriptorIdentity, message);",
    );
    expect(bridge.filter((line) => line.includes(".device"))).toHaveLength(0);
    for (const field of ["inode", "links", "size", "modified", "changed"]) {
      expect(bridge).toContain(`        ${field}: pathIdentity.${field},`);
      expect(bridge).toContain(
        `        ${field}: descriptorIdentity.${field},`,
      );
    }
  });

  it("limits Cargo's non-macOS release hard-link allowance to its isolated sibling", () => {
    const strictFileCheck = uniqueLine(
      nativePackageAssembler,
      "function assertDirectRegularFile(path, label, maxBytes) {",
    );
    const cargoFileCheck = uniqueFollowingLine(
      nativePackageAssembler,
      "function assertControlledCargoArtifact(path, cargoTarget, descriptor) {",
      strictFileCheck,
    );
    const nextFileCheck = uniqueFollowingLine(
      nativePackageAssembler,
      "function assertPortablePackageFileMode(metadata, label) {",
      cargoFileCheck,
    );
    const strictFileCheckBody = nativePackageAssembler.slice(
      strictFileCheck,
      cargoFileCheck,
    );
    const cargoFileCheckBody = nativePackageAssembler.slice(
      cargoFileCheck,
      nextFileCheck,
    );

    expect(strictFileCheckBody).toContain(
      "  assert.equal(metadata.nlink, 1, `${label} must have one link`);",
    );
    expect(strictFileCheckBody).not.toContain("metadata.nlink === 2");
    expect(cargoFileCheckBody).toContain(
      '    join(releaseDirectory, descriptor.binary),',
    );
    expect(cargoFileCheckBody).toContain(
      '    process.platform === "linux" || process.platform === "win32",',
    );
    expect(cargoFileCheckBody).toContain(
      "    `${label} may only use Cargo's second release link on Linux or Windows`,",
    );
    expect(cargoFileCheckBody).toContain(
      "  assert.equal(metadata.nlink, 2, `${label} must have one or two links`);",
    );
    expect(cargoFileCheckBody).toContain(
      '  const dependenciesDirectory = join(releaseDirectory, "deps");',
    );
    expect(cargoFileCheckBody).toContain(
      "  const dependencyArtifact = join(dependenciesDirectory, descriptor.binary);",
    );
    expect(cargoFileCheckBody).toContain(
      '    "Cargo dependency artifact must account for the second release link",',
    );
    expect(cargoFileCheckBody).toContain(
      '    "Cargo release links must identify the same artifact",',
    );
    expect(
      nativePackageAssembler.filter((line) =>
        line.includes("assertDirectOwnedRegularFile("),
      ),
    ).toHaveLength(4);

    expect(
      exactLineCount(
        nativePackageAssembler,
        "  const cargoMetadata = assertControlledCargoArtifact(",
      ),
    ).toBe(1);
    expect(
      nativePackageAssembler.filter(
        (line) => line.trim() === "assertControlledCargoArtifact(",
      ),
    ).toHaveLength(2);
    expect(
      exactLineCount(
        nativePackageAssembler,
        "    const stagedMetadata = assertDirectRegularFile(",
      ),
    ).toBe(1);
  });

  it("keeps every recognized native target synchronized across TypeScript, Rust, and ABI tests", () => {
    expect(recognizedTargets).toEqual(nativeTargets);
    expect(exactUnique([...rustTargets.values()], "Rust mapped targets")).toEqual(
      nativeTargets,
    );
    expect(exactUnique([...abiTargets.values()], "ABI mapped targets")).toEqual(
      nativeTargets,
    );
    expect(sortedEntries(abiTargets)).toEqual(sortedEntries(rustTargets));
  });

  it("keeps prepare-isolation hosts and runtime rows limited to released targets", () => {
    const workflowRustHosts = exactUnique(
      workflowRows.map(({ rustHost }) => rustHost),
      "native workflow Rust hosts",
    );
    expect(preparedRustHosts).toEqual(workflowRustHosts);

    const workflowRuntimeHosts = exactMap(
      workflowRows.map(({ target, rustHost }) => [
        runtimeTarget(target),
        rustHost,
      ] as const),
      "native workflow runtime hosts",
    );
    expect(sortedEntries(preparedRuntimeHosts)).toEqual(
      sortedEntries(workflowRuntimeHosts),
    );
    for (const row of workflowRows) {
      expect(rustTargets.get(row.rustHost)).toBe(row.target);
    }
  });
});
