import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NATIVE_CREDENTIAL_TARGET_IDS } from "../src/adapters/node/native-credential-store.js";
import {
  RECOGNIZED_RUNTIME_TARGETS,
  RELEASED_RUNTIME_TARGETS,
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
      uniqueNamedStep(workflowSteps, "Verify the Node 24 ABI").lines,
    ).toEqual([
      "      - name: Verify the Node 24 ABI",
      "        run: node native/credential-store/tests/abi-conformance.mjs",
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
