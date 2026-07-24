import { describe, expect, it } from "vitest";

import { createPlatformPathAdapter } from "../src/adapters/node/platform.js";
import {
  CODEX_DESIRED_CONFIGURATION,
  createCodexAdapter,
} from "../src/hosts/codex/adapter.js";
import { CODEX_MUTATION_SUPPORT } from "../src/hosts/codex/configuration.js";
import type {
  CodexAdapterDependencies,
  CodexNativeSpawnRequest,
  CodexProcessExecutionResult,
  CodexSlotEvidence,
  CodexStateEvidence,
  CodexStateEvidenceRequest,
} from "../src/hosts/codex/contracts.js";
import type {
  HostAction,
  HostApplyRequest,
  HostConfiguration,
  HostExecutableAttestation,
  HostExecutableCandidateObservation,
  HostExecutableCandidateRequest,
  HostInspectionRequest,
  HostRollbackRequest,
} from "../src/hosts/contracts.js";
import type { SafeHostProcessRequest } from "../src/hosts/process-policy.js";
import type {
  PlatformAdapter,
  RuntimeEnvironment,
} from "../src/system/contracts.js";

const CANARY = "plrm_live_CODEX_ADAPTER_CANARY_DO_NOT_EXPOSE";
const PROJECT = "/isolated/project";
const NEUTRAL = "/isolated/neutral";
const CODEX = "/trusted/bin/codex";
const INSPECTION_REQUEST: HostInspectionRequest = Object.freeze({
  host: "codex",
  scope: "user",
  excludedProjectDirectory: PROJECT,
});
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function cloneConfiguration(
  configuration: HostConfiguration,
): HostConfiguration {
  return structuredClone(configuration);
}

function absentConfiguration(): HostConfiguration {
  return {
    marketplace: { status: "absent" },
    plugin: { status: "absent" },
    pluginMcp: { status: "absent" },
    directMcp: { status: "absent" },
  };
}

function marketplaceConfiguration(): HostConfiguration {
  return {
    ...absentConfiguration(),
    marketplace: {
      status: "present",
      value: {
        name: "plurum",
        source: "https://github.com/dunelabsco/plurum.git",
      },
    },
  };
}

function installedConfiguration(): HostConfiguration {
  return {
    ...marketplaceConfiguration(),
    plugin: {
      status: "present",
      value: {
        name: "plurum",
        source: "plurum@plurum",
        version: "0.1.0",
        enabled: true,
      },
    },
    pluginMcp: {
      status: "present",
      value: {
        name: "plurum",
        endpoint: "https://mcp.plurum.ai/mcp",
      },
    },
  };
}

function executable(revision = "codex-executable-1"): HostExecutableAttestation {
  return {
    sourcePath: CODEX,
    resolvedPath: CODEX,
    revision,
    chain: [
      {
        path: CODEX,
        kind: "binary",
        owner: "current-user",
        access: "not-broadly-writable",
        binding: "canonical",
        link: "direct",
        revision: `${revision}-chain`,
      },
    ],
    launch: {
      executable: CODEX,
      argumentPrefix: [],
      shell: false,
    },
  };
}

function platform(
  overrides: Partial<PlatformAdapter> = {},
  environmentOverrides: Readonly<Record<string, unknown>> = {},
): PlatformAdapter {
  const os = overrides.os ?? "linux";
  const environment = {
    PATH: "/trusted/bin",
    HOME: "/isolated/home",
    CODEX_HOME: "/isolated/codex-home",
    PLURUM_HOME: `/isolated/${CANARY}/plurum-home`,
    PLURUM_TEST_ROOT: `/isolated/${CANARY}/test-root`,
    PLURUM_API_KEY: CANARY,
    NODE_OPTIONS: `--require=${CANARY}`,
    ...environmentOverrides,
  } as unknown as RuntimeEnvironment;
  return Object.freeze({
    os,
    arch: "synthetic",
    cwd: PROJECT,
    environment,
    elevation: "standard",
    paths: createPlatformPathAdapter(os),
    ...overrides,
  });
}

function slotEvidence(
  slot: HostConfiguration["marketplace"] | HostConfiguration["pluginMcp"],
): CodexSlotEvidence {
  if (slot.status === "absent" || slot.status === "ambiguous") {
    return { status: slot.status };
  }
  return { status: "exact" };
}

function pluginMcpEvidence(
  configuration: HostConfiguration,
): CodexSlotEvidence {
  if (
    configuration.pluginMcp.status === "absent" ||
    configuration.pluginMcp.status === "ambiguous"
  ) {
    return { status: configuration.pluginMcp.status };
  }
  return {
    status:
      configuration.pluginMcp.value.endpoint ===
      "https://mcp.plurum.ai/mcp"
        ? "exact"
        : "mismatched",
  };
}

function pluginEvidence(
  configuration: HostConfiguration,
): CodexStateEvidence["plugin"] {
  if (
    configuration.plugin.status === "absent" ||
    configuration.plugin.status === "ambiguous"
  ) {
    return { status: configuration.plugin.status };
  }
  return {
    status:
      configuration.plugin.value.source === "plurum@plurum"
        ? "exact"
        : "mismatched",
    version: configuration.plugin.value.version,
    enabled: configuration.plugin.value.enabled,
  };
}

interface HarnessOptions {
  readonly initial?: HostConfiguration;
  readonly version?: string;
  readonly candidate?: (
    call: number,
    request: HostExecutableCandidateRequest,
    current: HostExecutableAttestation,
  ) =>
    | HostExecutableCandidateObservation
    | Promise<HostExecutableCandidateObservation>;
  readonly process?: (
    call: number,
    request: CodexNativeSpawnRequest,
  ) =>
    | CodexProcessExecutionResult
    | undefined
    | Promise<CodexProcessExecutionResult | undefined>;
  readonly evidence?: (
    call: number,
    fallback: CodexStateEvidence,
  ) => unknown | Promise<unknown>;
  readonly directMcp?: CodexSlotEvidence;
  readonly mutateSemantics?: boolean;
  readonly advanceRevision?: boolean;
  readonly mutationReceipt?: string | null;
  readonly swapExecutableAfterMutation?: boolean;
  readonly platform?: PlatformAdapter;
}

interface Harness {
  readonly adapter: ReturnType<typeof createCodexAdapter>;
  readonly processRequests: SafeHostProcessRequest[];
  readonly nativeRequests: CodexNativeSpawnRequest[];
  readonly candidateRequests: HostExecutableCandidateRequest[];
  readonly stateRequests: CodexStateEvidenceRequest[];
  readonly events: string[];
  readonly mutations: string[];
  configuration(): HostConfiguration;
}

function harness(options: HarnessOptions = {}): Harness {
  let configuration = cloneConfiguration(
    options.initial ?? absentConfiguration(),
  );
  let stateRevision = "codex-state-1";
  let stateCounter = 1;
  let executableRevision = "codex-executable-1";
  let candidateCalls = 0;
  let processCalls = 0;
  let evidenceCalls = 0;
  const processRequests: SafeHostProcessRequest[] = [];
  const nativeRequests: CodexNativeSpawnRequest[] = [];
  const candidateRequests: HostExecutableCandidateRequest[] = [];
  const stateRequests: CodexStateEvidenceRequest[] = [];
  const events: string[] = [];
  const mutations: string[] = [];
  const selectedPlatform = options.platform ?? platform();

  function currentExecutable(): HostExecutableAttestation {
    return executable(executableRevision);
  }

  function completed(revision: string | null): CodexProcessExecutionResult {
    return {
      status: "completed",
      stateRevision: revision,
    } as CodexProcessExecutionResult;
  }

  function mutate(command: string): void {
    mutations.push(command);
    if (options.mutateSemantics !== false) {
      switch (command) {
        case "add-marketplace":
          configuration = marketplaceConfiguration();
          break;
        case "remove-marketplace":
          configuration = absentConfiguration();
          break;
        case "install-plugin":
          configuration = installedConfiguration();
          break;
        case "uninstall-plugin":
          configuration = marketplaceConfiguration();
          break;
      }
    }
    if (options.advanceRevision !== false) {
      stateCounter += 1;
      stateRevision = `codex-state-${stateCounter}`;
    }
    if (options.swapExecutableAfterMutation === true) {
      executableRevision = "codex-executable-replaced";
    }
  }

  const dependencies: CodexAdapterDependencies = Object.freeze({
    native: Object.freeze({
      async inspectCandidate(
        request: HostExecutableCandidateRequest,
      ): Promise<HostExecutableCandidateObservation> {
        events.push("attest");
        candidateRequests.push(request);
        const current = currentExecutable();
        const result =
          options.candidate === undefined
            ? { status: "verified" as const, executable: current }
            : await options.candidate(candidateCalls, request, current);
        candidateCalls += 1;
        return result;
      },
      async run(
        request: CodexNativeSpawnRequest,
      ): Promise<CodexProcessExecutionResult> {
        events.push(`process:${request.command}`);
        processRequests.push(request.process);
        nativeRequests.push(request);
        const overridden = await options.process?.(processCalls, request);
        processCalls += 1;
        if (overridden !== undefined) {
          return overridden;
        }
        switch (request.command) {
          case "add-marketplace":
          case "remove-marketplace":
          case "install-plugin":
          case "uninstall-plugin":
            mutate(request.command);
            return completed(
              options.mutationReceipt === undefined
                ? stateRevision
                : options.mutationReceipt,
            );
        }
      },
      async observe(
        request: CodexStateEvidenceRequest,
      ): Promise<CodexStateEvidence> {
        events.push("state");
        stateRequests.push(request);
        const fallback: CodexStateEvidence = {
          revision: stateRevision,
          version: options.version ?? "0.144.5",
          marketplace: slotEvidence(configuration.marketplace),
          plugin: pluginEvidence(configuration),
          pluginMcp: pluginMcpEvidence(configuration),
          directMcp: options.directMcp ?? { status: "absent" },
        };
        const result =
          options.evidence === undefined
            ? fallback
            : await options.evidence(evidenceCalls, fallback);
        evidenceCalls += 1;
        return result as CodexStateEvidence;
      },
    }),
    neutralWorkingDirectory: NEUTRAL,
  });

  return {
    adapter: createCodexAdapter(dependencies, selectedPlatform),
    processRequests,
    nativeRequests,
    candidateRequests,
    stateRequests,
    events,
    mutations,
    configuration: () => cloneConfiguration(configuration),
  };
}

function action(
  kind: HostAction["kind"],
  before: HostConfiguration,
  after: HostConfiguration,
  rollback: HostAction["rollback"],
): HostAction {
  return deepFreeze({
    id: `codex:01:${kind}`,
    host: "codex",
    kind,
    before: cloneConfiguration(before),
    after: cloneConfiguration(after),
    rollback,
    display: `synthetic ${kind}`,
  });
}

function applyRequest(
  selectedAction: HostAction,
  overrides: Partial<HostApplyRequest> = {},
): HostApplyRequest {
  return deepFreeze({
    host: "codex",
    executableRevision: "codex-executable-1",
    expectedBeforeRevision: "codex-state-1",
    expectedBefore: cloneConfiguration(selectedAction.before),
    action: selectedAction,
    ...overrides,
  });
}

function rollbackRequest(
  selectedAction: HostAction,
  overrides: Partial<HostRollbackRequest> = {},
): HostRollbackRequest {
  return deepFreeze({
    host: "codex",
    executableRevision: "codex-executable-1",
    expectedAfterRevision: "codex-state-1",
    expectedAfter: cloneConfiguration(selectedAction.after),
    action: selectedAction,
    ...overrides,
  });
}

const ADD = action(
  "add-marketplace",
  absentConfiguration(),
  marketplaceConfiguration(),
  { kind: "remove-cli-created-marketplace" },
);
const INSTALL = action(
  "install-plugin",
  marketplaceConfiguration(),
  installedConfiguration(),
  { kind: "remove-cli-created-plugin" },
);

function expectNoCanary(value: unknown): void {
  expect(JSON.stringify(value)).not.toContain(CANARY);
}

describe("Codex adapter inspection", () => {
  it("reports an absent executable without executing a process", async () => {
    const instance = harness({
      candidate: () => ({ status: "missing" }),
    });

    await expect(instance.adapter.inspect(INSPECTION_REQUEST)).resolves.toEqual({
      host: "codex",
      status: "absent",
    });
    expect(instance.processRequests).toHaveLength(0);
  });

  it("reports a fully normalized healthy observation", async () => {
    const instance = harness({ initial: installedConfiguration() });

    await expect(instance.adapter.inspect(INSPECTION_REQUEST)).resolves.toEqual({
      host: "codex",
      status: "available",
      executable: executable(),
      version: "0.144.5",
      state: {
        revision: "codex-state-1",
        configuration: installedConfiguration(),
      },
      mutationSupport: CODEX_MUTATION_SUPPORT,
    });
    expect(instance.stateRequests).toHaveLength(1);
    expect(instance.stateRequests.every((request) => request.scope === "user"))
      .toBe(true);
    expect(instance.processRequests).toHaveLength(0);
  });

  it("uses one native semantic snapshot and never invokes the Codex CLI", async () => {
    const instance = harness();

    await instance.adapter.inspect(INSPECTION_REQUEST);

    expect(instance.nativeRequests).toHaveLength(0);
    expect(instance.processRequests).toHaveLength(0);
    expect(instance.events).toEqual(["attest", "attest", "state"]);
    expect(instance.stateRequests).toHaveLength(1);
    expect(instance.candidateRequests[0]).toMatchObject({
      host: "codex",
      candidatePath: CODEX,
    });
  });

  it("fails closed on an executable race", async () => {
    const executableRace = harness({
      candidate: (call, _request, current) =>
        call === 0
          ? { status: "verified", executable: current }
          : { status: "verified", executable: executable("replaced") },
    });

    await expect(
      executableRace.adapter.inspect(INSPECTION_REQUEST),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "probe-failed",
    });
  });

  it.each(["0.144.5-alpha.1", "v0.144.5", "0.144.5\n"])(
    "rejects a noncanonical native version %j",
    async (version) => {
      const instance = harness({ version });
      await expect(
        instance.adapter.inspect(INSPECTION_REQUEST),
      ).resolves.toMatchObject({
        status: "unavailable",
        reason: "probe-output-invalid",
      });
    },
  );

  it("maps exact and mismatched semantic evidence without retaining raw state", async () => {
    const instance = harness({
      evidence: (_call, fallback) => ({
        ...fallback,
        marketplace: { status: "mismatched" },
        plugin: {
          status: "mismatched",
          version: "0.1.0",
          enabled: false,
        },
        pluginMcp: { status: "mismatched" },
      }),
    });

    const observation = await instance.adapter.inspect(INSPECTION_REQUEST);
    expect(observation).toMatchObject({
      status: "available",
      state: {
        configuration: {
          marketplace: {
            status: "present",
            value: { source: "https://mismatched.invalid/" },
          },
          plugin: {
            status: "present",
            value: {
              source: "mismatched@invalid",
              version: "0.1.0",
              enabled: false,
            },
          },
          pluginMcp: {
            status: "present",
            value: { endpoint: "https://mismatched.invalid/" },
          },
        },
      },
    });
    expectNoCanary(observation);
  });

  it("snapshots each plugin evidence descriptor exactly once", async () => {
    let ownKeysCalls = 0;
    const descriptorCalls = new Map<PropertyKey, number>();
    const plugin = new Proxy(
      {
        status: "exact" as const,
        version: "0.1.0",
        enabled: true,
      },
      {
        ownKeys(target) {
          ownKeysCalls += 1;
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, key) {
          descriptorCalls.set(key, (descriptorCalls.get(key) ?? 0) + 1);
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    const instance = harness({
      initial: installedConfiguration(),
      evidence: (_call, fallback) => ({ ...fallback, plugin }),
    });

    await expect(instance.adapter.inspect(INSPECTION_REQUEST)).resolves.toMatchObject({
      status: "available",
    });
    expect(ownKeysCalls).toBe(1);
    expect(Object.fromEntries(descriptorCalls)).toEqual({
      status: 1,
      version: 1,
      enabled: 1,
    });
  });

  it("rejects accessor-backed plugin evidence without invoking accessors", async () => {
    let getterCalls = 0;
    const plugin = Object.defineProperty(
      { version: "0.1.0", enabled: true },
      "status",
      {
        enumerable: true,
        get() {
          getterCalls += 1;
          return "exact";
        },
      },
    );
    const instance = harness({
      evidence: (_call, fallback) => ({ ...fallback, plugin }),
    });

    await expect(instance.adapter.inspect(INSPECTION_REQUEST)).resolves.toMatchObject({
      status: "unavailable",
      reason: "probe-output-invalid",
    });
    expect(getterCalls).toBe(0);
  });

  it("rejects malformed or accessor-backed snapshots without invoking accessors", async () => {
    let getterCalls = 0;
    const hostile = Object.defineProperty(
      {
        version: "0.144.5",
        marketplace: { status: "absent" },
        plugin: { status: "absent" },
        pluginMcp: { status: "absent" },
        directMcp: { status: "absent" },
      },
      "revision",
      {
        enumerable: true,
        get() {
          getterCalls += 1;
          return CANARY;
        },
      },
    );
    const instance = harness({ evidence: () => hostile });

    await expect(instance.adapter.inspect(INSPECTION_REQUEST)).resolves.toMatchObject({
      status: "unavailable",
      reason: "probe-output-invalid",
    });
    expect(getterCalls).toBe(0);
  });

  it.each([
    ["unknown marketplace status", { marketplace: { status: "present" } }],
    [
      "incomplete plugin evidence",
      { plugin: { status: "exact", version: "0.1.0" } },
    ],
    [
      "metadata on an absent plugin",
      {
        plugin: {
          status: "absent",
          version: "0.1.0",
          enabled: true,
        },
      },
    ],
    ["unexpected native field", { rawPath: `/isolated/${CANARY}` }],
  ])("rejects %s", async (_label, override) => {
    const instance = harness({
      evidence: (_call, fallback) => ({ ...fallback, ...override }),
    });
    await expect(instance.adapter.inspect(INSPECTION_REQUEST)).resolves.toMatchObject({
      status: "unavailable",
      reason: "probe-output-invalid",
    });
    expect(instance.nativeRequests).toHaveLength(0);
  });

  it("contains native observer failures without falling back to CLI reads", async () => {
    const instance = harness({
      evidence: () => {
        throw new Error(CANARY);
      },
    });
    await expect(instance.adapter.inspect(INSPECTION_REQUEST)).resolves.toMatchObject({
      status: "unavailable",
      reason: "probe-failed",
    });
    expect(instance.nativeRequests).toHaveLength(0);
    expect(instance.processRequests).toHaveLength(0);
  });
});

describe("Codex adapter mutations", () => {
  it.each([
    [ADD, "add-marketplace", 120_000],
    [INSTALL, "install-plugin", 30_000],
  ] as const)(
    "applies only the reversible %s transition with a native CAS receipt",
    async (selectedAction, command, timeoutMs) => {
      const instance = harness({ initial: selectedAction.before });

      await expect(
        instance.adapter.apply(applyRequest(selectedAction)),
      ).resolves.toEqual({
        status: "changed",
        stateRevision: "codex-state-2",
      });
      expect(instance.mutations).toEqual([command]);
      const mutation = instance.nativeRequests.find(
        (request) => request.command === command,
      );
      expect(mutation).toMatchObject({
        kind: "codex-fixed-spawn",
        command,
        executableRevision: "codex-executable-1",
        expectedStateRevision: "codex-state-1",
        excludedProjectDirectory: PROJECT,
        process: {
          executable: CODEX,
          cwd: NEUTRAL,
          timeoutMs,
          shell: false,
        },
      });
      expect(instance.nativeRequests.map((request) => request.command)).toEqual([
        command,
      ]);
      expect(instance.stateRequests).toHaveLength(2);
      expect(mutation?.process.env).toEqual({
        PATH: "/trusted/bin",
        NO_COLOR: "1",
        CODEX_HOME: "/isolated/codex-home",
        HOME: "/isolated/home",
      });
      expect(mutation?.process.env).not.toHaveProperty("PLURUM_API_KEY");
      expect(mutation?.process.args.join(" ")).not.toContain("config.toml");
      expect(mutation?.process.args.join(" ")).not.toContain(" mcp ");
      expectNoCanary(mutation);
    },
  );

  it("never maps update or enable actions to Codex commands", async () => {
    const update = action(
      "update-plugin",
      installedConfiguration(),
      {
        ...installedConfiguration(),
        plugin: {
          status: "present",
          value: {
            name: "plurum",
            source: "plurum@plurum",
            version: "0.1.1",
            enabled: true,
          },
        },
      },
      { kind: "restore-plugin-version", pluginVersion: "0.1.0" },
    );
    const enable = action(
      "enable-plugin",
      {
        ...installedConfiguration(),
        plugin: {
          status: "present",
          value: {
            name: "plurum",
            source: "plurum@plurum",
            version: "0.1.0",
            enabled: false,
          },
        },
        pluginMcp: { status: "absent" },
      },
      installedConfiguration(),
      { kind: "restore-plugin-disabled" },
    );

    for (const selectedAction of [update, enable]) {
      const instance = harness({ initial: selectedAction.before });
      await expect(
        instance.adapter.apply(applyRequest(selectedAction)),
      ).resolves.toEqual({ status: "failed" });
      expect(instance.processRequests).toHaveLength(0);
      expect(instance.mutations).toHaveLength(0);
    }
  });

  it.each([
    ["stale state", { expectedBeforeRevision: "stale-state" }],
    ["stale executable", { executableRevision: "stale-executable" }],
  ] as const)("rejects a %s before mutation", async (_label, overrides) => {
    const instance = harness({ initial: ADD.before });

    await expect(
      instance.adapter.apply(applyRequest(ADD, overrides)),
    ).resolves.toEqual({ status: "precondition-failed" });
    expect(instance.mutations).toHaveLength(0);
  });

  it("propagates a native mutation CAS failure", async () => {
    const instance = harness({
      initial: ADD.before,
      process: (_call, request) =>
        request.command === "add-marketplace"
          ? { status: "precondition-failed" }
          : undefined,
    });

    await expect(instance.adapter.apply(applyRequest(ADD))).resolves.toEqual({
      status: "precondition-failed",
    });
    expect(instance.mutations).toHaveLength(0);
  });

  it.each([
    ["timeout", { status: "timeout" as const }],
    ["oversized output", { status: "output-too-large" as const }],
    ["reported failure", { status: "failed" as const }],
  ])("never claims ownership after a native %s", async (_label, result) => {
    const instance = harness({
      initial: ADD.before,
      process: (_call, request) =>
        request.command === "add-marketplace" ? result : undefined,
    });

    await expect(instance.adapter.apply(applyRequest(ADD))).resolves.toEqual({
      status: "failed",
    });
    expect(instance.mutations).toHaveLength(0);
    expect(instance.processRequests).toHaveLength(1);
    expect(instance.stateRequests).toHaveLength(1);
  });

  it("never claims ownership when native execution throws", async () => {
    const instance = harness({
      initial: ADD.before,
      process: () => {
        throw new Error(CANARY);
      },
    });

    await expect(instance.adapter.apply(applyRequest(ADD))).resolves.toEqual({
      status: "failed",
    });
    expect(instance.mutations).toHaveLength(0);
    expect(instance.processRequests).toHaveLength(1);
    expect(instance.stateRequests).toHaveLength(1);
  });

  it("snapshots each native mutation result descriptor exactly once", async () => {
    let ownKeysCalls = 0;
    const descriptorCalls = new Map<PropertyKey, number>();
    const result = new Proxy(
      {
        status: "completed" as const,
        stateRevision: "codex-state-2",
      },
      {
        ownKeys(target) {
          ownKeysCalls += 1;
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, key) {
          descriptorCalls.set(key, (descriptorCalls.get(key) ?? 0) + 1);
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    const instance = harness({
      initial: ADD.before,
      process: (_call, request) =>
        request.command === "add-marketplace" ? result : undefined,
    });

    await expect(instance.adapter.apply(applyRequest(ADD))).resolves.toEqual({
      status: "failed",
    });
    expect(ownKeysCalls).toBe(1);
    expect(Object.fromEntries(descriptorCalls)).toEqual({
      status: 1,
      stateRevision: 1,
    });
  });

  it("rejects accessor-backed mutation results without invoking accessors", async () => {
    let getterCalls = 0;
    const result = Object.defineProperty(
      { stateRevision: "codex-state-2" },
      "status",
      {
        enumerable: true,
        get() {
          getterCalls += 1;
          return "completed";
        },
      },
    );
    const instance = harness({
      initial: ADD.before,
      process: (_call, request) =>
        request.command === "add-marketplace"
          ? (result as CodexProcessExecutionResult)
          : undefined,
    });

    await expect(instance.adapter.apply(applyRequest(ADD))).resolves.toEqual({
      status: "failed",
    });
    expect(getterCalls).toBe(0);
  });

  it.each([
    ["missing receipt", null],
    ["reused receipt", "codex-state-1"],
    ["wrong receipt", "codex-state-other"],
  ] as const)("rejects a $0", async (_label, mutationReceipt) => {
    const instance = harness({
      initial: ADD.before,
      mutationReceipt,
    });

    await expect(instance.adapter.apply(applyRequest(ADD))).resolves.toEqual({
      status: "failed",
    });
  });

  it("requires the exact requested postinspection semantics", async () => {
    const instance = harness({
      initial: ADD.before,
      mutateSemantics: false,
    });

    await expect(instance.adapter.apply(applyRequest(ADD))).resolves.toEqual({
      status: "failed",
    });
    expect(instance.mutations).toEqual(["add-marketplace"]);
  });

  it("fails closed when the executable changes after mutation", async () => {
    const instance = harness({
      initial: ADD.before,
      swapExecutableAfterMutation: true,
    });

    await expect(instance.adapter.apply(applyRequest(ADD))).resolves.toEqual({
      status: "failed",
    });
  });

  it("contains hostile request accessors without invoking them", async () => {
    let getterCalls = 0;
    const hostile = Object.defineProperty(
      {
        host: "codex",
        executableRevision: "codex-executable-1",
        expectedBeforeRevision: "codex-state-1",
        expectedBefore: absentConfiguration(),
        action: ADD,
      },
      "expectedBeforeRevision",
      {
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new Error(CANARY);
        },
      },
    );
    const instance = harness();

    await expect(
      instance.adapter.apply(hostile as HostApplyRequest),
    ).resolves.toEqual({ status: "failed" });
    expect(getterCalls).toBe(0);
    expect(instance.processRequests).toHaveLength(0);
  });
});

describe("Codex adapter rollback", () => {
  it.each([
    [ADD, "remove-marketplace"],
    [INSTALL, "uninstall-plugin"],
  ] as const)(
    "restores only the paired %s mutation and verifies its receipt",
    async (selectedAction, command) => {
      const instance = harness({ initial: selectedAction.after });

      await expect(
        instance.adapter.rollback(rollbackRequest(selectedAction)),
      ).resolves.toEqual({
        status: "changed",
        stateRevision: "codex-state-2",
      });
      expect(instance.configuration()).toEqual(selectedAction.before);
      expect(instance.mutations).toEqual([command]);
      expect(
        instance.nativeRequests.find(
          (request) => request.command === command,
        ),
      ).toMatchObject({
        expectedStateRevision: "codex-state-1",
      });
    },
  );

  it("rejects unsupported and forged rollback recipes before execution", async () => {
    const unsupported = action(
      "enable-plugin",
      marketplaceConfiguration(),
      installedConfiguration(),
      { kind: "restore-plugin-disabled" },
    );
    const forged = action(
      "install-plugin",
      absentConfiguration(),
      marketplaceConfiguration(),
      { kind: "remove-cli-created-marketplace" },
    );

    for (const selectedAction of [unsupported, forged]) {
      const instance = harness({ initial: selectedAction.after });
      await expect(
        instance.adapter.rollback(rollbackRequest(selectedAction)),
      ).resolves.toEqual({ status: "failed" });
      expect(instance.processRequests).toHaveLength(0);
      expect(instance.mutations).toHaveLength(0);
    }
  });

  it("fails rollback on semantic, revision, and executable races", async () => {
    const semantic = harness({
      initial: ADD.after,
      mutateSemantics: false,
    });
    const revision = harness({
      initial: ADD.after,
      advanceRevision: false,
    });
    const executableSwap = harness({
      initial: ADD.after,
      swapExecutableAfterMutation: true,
    });

    await expect(
      semantic.adapter.rollback(rollbackRequest(ADD)),
    ).resolves.toEqual({ status: "failed" });
    await expect(
      revision.adapter.rollback(rollbackRequest(ADD)),
    ).resolves.toEqual({ status: "failed" });
    await expect(
      executableSwap.adapter.rollback(rollbackRequest(ADD)),
    ).resolves.toEqual({ status: "failed" });
  });

  it("propagates a native rollback CAS failure without claiming a change", async () => {
    const instance = harness({
      initial: ADD.after,
      process: (_call, request) =>
        request.command === "remove-marketplace"
          ? { status: "precondition-failed" }
          : undefined,
    });

    await expect(
      instance.adapter.rollback(rollbackRequest(ADD)),
    ).resolves.toEqual({ status: "precondition-failed" });
    expect(instance.mutations).toHaveLength(0);
    expect(instance.processRequests).toHaveLength(1);
    expect(instance.stateRequests).toHaveLength(1);
  });
});

describe("Codex adapter public boundary", () => {
  it("exports the locked planner configuration and a frozen adapter", () => {
    expect(CODEX_DESIRED_CONFIGURATION.host).toBe("codex");
    expect(Object.isFrozen(harness().adapter)).toBe(true);
  });
});
