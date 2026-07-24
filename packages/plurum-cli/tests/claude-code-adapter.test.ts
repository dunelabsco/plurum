import { describe, expect, it } from "vitest";

import { createPlatformPathAdapter } from "../src/adapters/node/platform.js";
import {
  createClaudeCodeAdapter,
} from "../src/hosts/claude-code/adapter.js";
import {
  CLAUDE_CODE_DESIRED_CONFIGURATION,
  CLAUDE_CODE_MUTATION_SUPPORT,
} from "../src/hosts/claude-code/configuration.js";
import type {
  ClaudeCodeAdapterDependencies,
  ClaudeCodeMcpEvidence,
  ClaudeCodeNativeSpawnRequest,
  ClaudeCodeProcessExecutionResult,
  ClaudeCodeStateEvidence,
  ClaudeCodeStateEvidenceRequest,
} from "../src/hosts/claude-code/contracts.js";
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
import type {
  SafeHostProcessRequest,
} from "../src/hosts/process-policy.js";
import type {
  PlatformAdapter,
  RuntimeEnvironment,
  SupportedOs,
} from "../src/system/contracts.js";

const CANARY = "plrm_live_CLAUDE_ADAPTER_CANARY_DO_NOT_EXPOSE";
const PROJECT = "/isolated/project";
const NEUTRAL = "/isolated/neutral";
const CLAUDE = "/trusted/bin/claude";
const INSPECTION_REQUEST: HostInspectionRequest = Object.freeze({
  host: "claude-code",
  scope: "user",
  excludedProjectDirectory: PROJECT,
});
const encoder = new TextEncoder();

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

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
        source: "dunelabsco/plurum",
      },
    },
  };
}

function installedConfiguration(
  enabled = true,
  version = "0.2.0",
): HostConfiguration {
  return {
    ...marketplaceConfiguration(),
    plugin: {
      status: "present",
      value: {
        name: "plurum",
        source: "plurum@plurum",
        version,
        enabled,
      },
    },
    pluginMcp: enabled
      ? {
          status: "present",
          value: {
            name: "plurum",
            endpoint: "https://mcp.plurum.ai/mcp",
          },
        }
      : { status: "absent" },
  };
}

function executable(revision = "claude-executable-1"): HostExecutableAttestation {
  return {
    sourcePath: CLAUDE,
    resolvedPath: CLAUDE,
    revision,
    chain: [
      {
        path: CLAUDE,
        kind: "binary",
        owner: "current-user",
        access: "not-broadly-writable",
        binding: "canonical",
        link: "direct",
        revision: `${revision}-chain`,
      },
    ],
    launch: {
      executable: CLAUDE,
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
    PLURUM_HOME: `/isolated/${CANARY}/plurum-home`,
    PLURUM_TEST_ROOT: `/isolated/${CANARY}/test-root`,
    PLURUM_TEST_RUN_ID: CANARY,
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

function marketplaceOutput(
  configuration: HostConfiguration,
): string {
  return configuration.marketplace.status === "present"
    ? JSON.stringify([
        {
          name: "plurum",
          source: {
            source: "github",
            repo: configuration.marketplace.value.source,
          },
        },
      ])
    : "[]";
}

function pluginOutput(configuration: HostConfiguration): string {
  return configuration.plugin.status === "present"
    ? JSON.stringify([
        {
          id: configuration.plugin.value.source,
          version: configuration.plugin.value.version,
          scope: "user",
          enabled: configuration.plugin.value.enabled,
        },
      ])
    : "[]";
}

function pluginMcpEvidence(
  configuration: HostConfiguration,
): ClaudeCodeStateEvidence["pluginMcp"] {
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

function commandKey(request: SafeHostProcessRequest): string {
  return request.args.join("\u0000");
}

const COMMANDS = Object.freeze({
  version: "--version",
  listMarketplaces: "plugin\u0000marketplace\u0000list\u0000--json",
  listPlugins: "plugin\u0000list\u0000--json",
  addMarketplace:
    "plugin\u0000marketplace\u0000add\u0000dunelabsco/plurum\u0000--scope\u0000user",
  removeMarketplace:
    "plugin\u0000marketplace\u0000remove\u0000plurum\u0000--scope\u0000user",
  installPlugin:
    "plugin\u0000install\u0000plurum@plurum\u0000--scope\u0000user",
  uninstallPlugin:
    "plugin\u0000uninstall\u0000plurum@plurum\u0000--scope\u0000user",
  updatePlugin:
    "plugin\u0000update\u0000plurum@plurum\u0000--scope\u0000user",
  enablePlugin:
    "plugin\u0000enable\u0000plurum@plurum\u0000--scope\u0000user",
  disablePlugin:
    "plugin\u0000disable\u0000plurum@plurum\u0000--scope\u0000user",
});

type HarnessEvent =
  | Readonly<{
      kind: "attest";
      request: HostExecutableCandidateRequest;
    }>
  | Readonly<{
      kind: "process";
      request: SafeHostProcessRequest;
    }>
  | Readonly<{ kind: "state" }>;

interface HarnessOptions {
  readonly initial?: HostConfiguration;
  readonly versionOutput?: string;
  readonly directMcp?: ClaudeCodeMcpEvidence;
  readonly candidate?: (
    call: number,
    request: HostExecutableCandidateRequest,
    current: HostExecutableAttestation,
  ) => HostExecutableCandidateObservation | Promise<HostExecutableCandidateObservation>;
  readonly process?: (
    call: number,
    request: SafeHostProcessRequest,
  ) =>
    | ClaudeCodeProcessExecutionResult
    | undefined
    | Promise<ClaudeCodeProcessExecutionResult | undefined>;
  readonly evidence?: (
    call: number,
    fallback: ClaudeCodeStateEvidence,
  ) => unknown | Promise<unknown>;
  readonly mutateSemantics?: boolean;
  readonly advanceRevision?: boolean;
  readonly mutationReceipt?: string | null;
  readonly swapExecutableAfterMutation?: boolean;
  readonly platform?: PlatformAdapter;
}

interface Harness {
  readonly adapter: ReturnType<typeof createClaudeCodeAdapter>;
  readonly events: HarnessEvent[];
  readonly processRequests: SafeHostProcessRequest[];
  readonly nativeSpawnRequests: ClaudeCodeNativeSpawnRequest[];
  readonly candidateRequests: HostExecutableCandidateRequest[];
  readonly stateEvidenceRequests: ClaudeCodeStateEvidenceRequest[];
  readonly mutationCommands: string[];
  configuration(): HostConfiguration;
  revision(): string;
  executableRevision(): string;
}

function harness(options: HarnessOptions = {}): Harness {
  let configuration = cloneConfiguration(
    options.initial ?? absentConfiguration(),
  );
  let stateRevision = "claude-state-1";
  let stateRevisionCounter = 1;
  let executableRevision = "claude-executable-1";
  let candidateCalls = 0;
  let processCalls = 0;
  let evidenceCalls = 0;
  const events: HarnessEvent[] = [];
  const processRequests: SafeHostProcessRequest[] = [];
  const nativeSpawnRequests: ClaudeCodeNativeSpawnRequest[] = [];
  const candidateRequests: HostExecutableCandidateRequest[] = [];
  const stateEvidenceRequests: ClaudeCodeStateEvidenceRequest[] = [];
  const mutationCommands: string[] = [];
  const selectedPlatform = options.platform ?? platform();

  function currentExecutable(): HostExecutableAttestation {
    return executable(executableRevision);
  }

  function complete(
    stdout: string,
    completedStateRevision: string | null = null,
  ): ClaudeCodeProcessExecutionResult {
    return {
      status: "completed",
      exitCode: 0,
      stdout: bytes(stdout),
      stderr: new Uint8Array(),
      stateRevision: completedStateRevision,
    };
  }

  function mutate(command: string): void {
    mutationCommands.push(command);
    if (options.mutateSemantics !== false) {
      switch (command) {
        case COMMANDS.addMarketplace:
          configuration = marketplaceConfiguration();
          break;
        case COMMANDS.removeMarketplace:
          configuration = absentConfiguration();
          break;
        case COMMANDS.installPlugin:
        case COMMANDS.updatePlugin:
          configuration = installedConfiguration(true);
          break;
        case COMMANDS.uninstallPlugin:
          configuration = marketplaceConfiguration();
          break;
        case COMMANDS.enablePlugin:
          configuration = installedConfiguration(true);
          break;
        case COMMANDS.disablePlugin:
          configuration = installedConfiguration(false);
          break;
        default:
          break;
      }
    }
    if (options.advanceRevision !== false) {
      stateRevisionCounter += 1;
      stateRevision = `claude-state-${stateRevisionCounter}`;
    }
    if (options.swapExecutableAfterMutation === true) {
      executableRevision = "claude-executable-replaced";
    }
  }

  const dependencies: ClaudeCodeAdapterDependencies = Object.freeze({
    native: Object.freeze({
      async inspectCandidate(
        request: HostExecutableCandidateRequest,
      ): Promise<HostExecutableCandidateObservation> {
        events.push({ kind: "attest", request });
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
        nativeRequest: ClaudeCodeNativeSpawnRequest,
      ): Promise<ClaudeCodeProcessExecutionResult> {
        const request = nativeRequest.process;
        events.push({ kind: "process", request });
        processRequests.push(request);
        nativeSpawnRequests.push(nativeRequest);
        const overridden = await options.process?.(processCalls, request);
        processCalls += 1;
        if (overridden !== undefined) {
          return overridden;
        }

        const command = commandKey(request);
        switch (command) {
          case COMMANDS.version:
            return complete(options.versionOutput ?? "2.1.212\n");
          case COMMANDS.listMarketplaces:
            return complete(marketplaceOutput(configuration));
          case COMMANDS.listPlugins:
            return complete(pluginOutput(configuration));
          case COMMANDS.addMarketplace:
          case COMMANDS.removeMarketplace:
          case COMMANDS.installPlugin:
          case COMMANDS.uninstallPlugin:
          case COMMANDS.updatePlugin:
          case COMMANDS.enablePlugin:
          case COMMANDS.disablePlugin:
            mutate(command);
            return complete(
              "",
              options.mutationReceipt === undefined
                ? stateRevision
                : options.mutationReceipt,
            );
          default:
            return { status: "failed" as const };
        }
      },
      async observe(
        request: ClaudeCodeStateEvidenceRequest,
      ): Promise<ClaudeCodeStateEvidence> {
        events.push({ kind: "state" });
        stateEvidenceRequests.push(request);
        const fallback: ClaudeCodeStateEvidence = {
          revision: stateRevision,
          pluginMcp: pluginMcpEvidence(configuration),
          directMcp: options.directMcp ?? { status: "absent" },
        };
        const result =
          options.evidence === undefined
            ? fallback
            : await options.evidence(evidenceCalls, fallback);
        evidenceCalls += 1;
        return result as ClaudeCodeStateEvidence;
      },
    }),
    neutralWorkingDirectory: NEUTRAL,
  });

  return {
    adapter: createClaudeCodeAdapter(dependencies, selectedPlatform),
    events,
    processRequests,
    nativeSpawnRequests,
    candidateRequests,
    stateEvidenceRequests,
    mutationCommands,
    configuration: () => cloneConfiguration(configuration),
    revision: () => stateRevision,
    executableRevision: () => executableRevision,
  };
}

function action(
  kind: HostAction["kind"],
  before: HostConfiguration,
  after: HostConfiguration,
  rollback: HostAction["rollback"],
): HostAction {
  return deepFreeze({
    id: `claude-code:01:${kind}`,
    host: "claude-code",
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
    host: "claude-code",
    executableRevision: "claude-executable-1",
    expectedBeforeRevision: "claude-state-1",
    expectedBefore: cloneConfiguration(selectedAction.before),
    action: selectedAction,
    ...overrides,
  });
}

function rollbackRequest(
  selectedAction: HostAction,
  expectedAfterRevision = "claude-state-1",
  overrides: Partial<HostRollbackRequest> = {},
): HostRollbackRequest {
  return deepFreeze({
    host: "claude-code",
    executableRevision: "claude-executable-1",
    expectedAfterRevision,
    expectedAfter: cloneConfiguration(selectedAction.after),
    action: selectedAction,
    ...overrides,
  });
}

function mutationRequests(instance: Harness): SafeHostProcessRequest[] {
  const mutationCommandSet = new Set<string>([
    COMMANDS.addMarketplace,
    COMMANDS.removeMarketplace,
    COMMANDS.installPlugin,
    COMMANDS.uninstallPlugin,
    COMMANDS.updatePlugin,
    COMMANDS.enablePlugin,
    COMMANDS.disablePlugin,
  ]);
  return instance.processRequests.filter((request) =>
    mutationCommandSet.has(commandKey(request)),
  );
}

function expectNoCanary(value: unknown): void {
  expect(JSON.stringify(value)).not.toContain(CANARY);
}

describe("Claude Code adapter inspection", () => {
  it("reports an absent executable without spawning a process", async () => {
    const instance = harness({
      candidate: () => ({ status: "missing" }),
    });

    await expect(instance.adapter.inspect(INSPECTION_REQUEST)).resolves.toEqual({
      host: "claude-code",
      status: "absent",
    });
    expect(instance.processRequests).toHaveLength(0);
  });

  it("preserves a blocked unsafe candidate and never executes it", async () => {
    const instance = harness({
      candidate: () => ({
        status: "blocked",
        reason: "unsafe-executable",
      }),
    });

    await expect(instance.adapter.inspect(INSPECTION_REQUEST)).resolves.toEqual({
      host: "claude-code",
      status: "blocked",
      reason: "unsafe-executable",
      candidatePath: CLAUDE,
    });
    expect(instance.processRequests).toHaveLength(0);
  });

  it("blocks unsafe PATH entries before candidate inspection", async () => {
    const instance = harness({
      platform: platform({}, { PATH: PROJECT }),
    });

    await expect(instance.adapter.inspect(INSPECTION_REQUEST)).resolves.toEqual({
      host: "claude-code",
      status: "blocked",
      reason: "unsafe-path-entry",
      candidatePath: PROJECT,
    });
    expect(instance.candidateRequests).toHaveLength(0);
    expect(instance.processRequests).toHaveLength(0);
  });

  it.each(["elevated", "unknown"] as const)(
    "blocks %s execution without inspecting PATH",
    async (elevation) => {
      const instance = harness({
        platform: platform({ elevation }),
      });

      await expect(
        instance.adapter.inspect(INSPECTION_REQUEST),
      ).resolves.toEqual({
        host: "claude-code",
        status: "blocked",
        reason: "unverifiable-executable",
      });
      expect(instance.candidateRequests).toHaveLength(0);
      expect(instance.processRequests).toHaveLength(0);
    },
  );

  it("rejects a hostile inspection-request accessor without invoking it", async () => {
    let getterCalled = false;
    const hostile: Record<string, unknown> = {
      scope: "user",
      excludedProjectDirectory: PROJECT,
    };
    Object.defineProperty(hostile, "host", {
      enumerable: true,
      get() {
        getterCalled = true;
        throw new Error(CANARY);
      },
    });
    Object.freeze(hostile);
    const instance = harness();

    await expect(
      instance.adapter.inspect(hostile as unknown as HostInspectionRequest),
    ).resolves.toEqual({
      host: "claude-code",
      status: "blocked",
      reason: "unverifiable-executable",
    });
    expect(getterCalled).toBe(false);
    expect(instance.candidateRequests).toHaveLength(0);
    expect(instance.processRequests).toHaveLength(0);
  });

  it.each(["unsupported"] as const)(
    "blocks the %s platform without probing",
    async (os) => {
      const instance = harness({
        platform: platform({ os, paths: createPlatformPathAdapter(os) }),
      });

      await expect(
        instance.adapter.inspect(INSPECTION_REQUEST),
      ).resolves.toMatchObject({
        status: "blocked",
        reason: "unverifiable-executable",
      });
      expect(instance.candidateRequests).toHaveLength(0);
    },
  );

  it("returns an exact healthy minimum-version observation", async () => {
    const initial = installedConfiguration();
    const instance = harness({ initial });

    const result = await instance.adapter.inspect(INSPECTION_REQUEST);
    expect(result).toEqual({
      host: "claude-code",
      status: "available",
      executable: executable(),
      version: "2.1.212",
      state: {
        revision: "claude-state-1",
        configuration: initial,
      },
      mutationSupport: CLAUDE_CODE_MUTATION_SUPPORT,
    });
    expect(
      result.status === "available" && Object.isFrozen(result.state),
    ).toBe(true);
    expectNoCanary(result);
  });

  it.each([
    ["2.1.212", "2.1.212"],
    ["2.1.212\n", "2.1.212"],
    ["2.1.212\r\n", "2.1.212"],
    ["2.1.212 (Claude Code)", "2.1.212"],
    ["2.1.212 (Claude Code)\n", "2.1.212"],
    ["99.100.101\n", "99.100.101"],
  ])("accepts the exact version form %j", async (versionOutput, expected) => {
    const instance = harness({ versionOutput });
    const result = await instance.adapter.inspect(INSPECTION_REQUEST);

    expect(result).toMatchObject({
      status: "available",
      version: expected,
    });
  });

  it.each([
    "",
    "v2.1.212\n",
    " 2.1.212\n",
    "2.1.212 \n",
    "2.1\n",
    "2.1.212.0\n",
    "02.1.212\n",
    "2.1.212-beta\n",
    "2.1.212\n\n",
    "Claude Code 2.1.212\n",
    "2.1.212 (claude code)\n",
  ])("rejects the noncanonical version form %j", async (versionOutput) => {
    const instance = harness({ versionOutput });

    await expect(instance.adapter.inspect(INSPECTION_REQUEST)).resolves.toEqual({
      host: "claude-code",
      status: "unavailable",
      reason: "probe-output-invalid",
      executable: executable(),
    });
  });

  it("uses only fixed, shell-free read commands in a neutral directory", async () => {
    const instance = harness();

    await instance.adapter.inspect(INSPECTION_REQUEST);

    expect(
      instance.processRequests.map((request) => ({
        executable: request.executable,
        args: request.args,
        cwd: request.cwd,
        timeoutMs: request.timeoutMs,
        maxOutputBytes: request.maxOutputBytes,
        shell: request.shell,
      })),
    ).toEqual([
      {
        executable: CLAUDE,
        args: ["--version"],
        cwd: NEUTRAL,
        timeoutMs: 30_000,
        maxOutputBytes: 65_536,
        shell: false,
      },
      {
        executable: CLAUDE,
        args: ["plugin", "marketplace", "list", "--json"],
        cwd: NEUTRAL,
        timeoutMs: 30_000,
        maxOutputBytes: 65_536,
        shell: false,
      },
      {
        executable: CLAUDE,
        args: ["plugin", "list", "--json"],
        cwd: NEUTRAL,
        timeoutMs: 30_000,
        maxOutputBytes: 65_536,
        shell: false,
      },
    ]);
    expect(
      instance.nativeSpawnRequests.map((request) => ({
        kind: request.kind,
        command: request.command,
        executableRevision: request.executableRevision,
        expectedStateRevision: request.expectedStateRevision,
        excludedProjectDirectory: request.excludedProjectDirectory,
        executable: request.executable,
        sameProcessSnapshot:
          instance.processRequests.includes(request.process),
      })),
    ).toEqual([
      {
        kind: "claude-code-fixed-spawn",
        command: "version",
        executableRevision: "claude-executable-1",
        expectedStateRevision: null,
        excludedProjectDirectory: PROJECT,
        executable: executable(),
        sameProcessSnapshot: true,
      },
      {
        kind: "claude-code-fixed-spawn",
        command: "list-marketplaces",
        executableRevision: "claude-executable-1",
        expectedStateRevision: null,
        excludedProjectDirectory: PROJECT,
        executable: executable(),
        sameProcessSnapshot: true,
      },
      {
        kind: "claude-code-fixed-spawn",
        command: "list-plugins",
        executableRevision: "claude-executable-1",
        expectedStateRevision: null,
        excludedProjectDirectory: PROJECT,
        executable: executable(),
        sameProcessSnapshot: true,
      },
    ]);
  });

  it("constructs a minimal child environment without credentials or test paths", async () => {
    const instance = harness();

    await instance.adapter.inspect(INSPECTION_REQUEST);

    for (const request of instance.processRequests) {
      expect(request.env).toEqual({
        PATH: "/trusted/bin",
        NO_COLOR: "1",
        HOME: "/isolated/home",
      });
      expect(request.env).not.toHaveProperty("CLAUDE_CODE_PLUGIN_PREFER_HTTPS");
      expect(request.env).not.toHaveProperty("PLURUM_API_KEY");
      expect(request.env).not.toHaveProperty("PLURUM_HOME");
      expect(request.env).not.toHaveProperty("PLURUM_TEST_ROOT");
      expect(request.env).not.toHaveProperty("PLURUM_TEST_RUN_ID");
      expect(request.env).not.toHaveProperty("NODE_OPTIONS");
      expect(request.env).not.toHaveProperty("Authorization");
      expectNoCanary(request);
    }
  });

  it("rejects an accessor environment property without invoking it", async () => {
    let getterCalled = false;
    const environment = {
      PATH: "/trusted/bin",
    };
    Object.defineProperty(environment, "HOME", {
      enumerable: true,
      get() {
        getterCalled = true;
        return `/isolated/${CANARY}`;
      },
    });
    const instance = harness({
      platform: platform({
        environment: environment as RuntimeEnvironment,
      }),
    });

    const result = await instance.adapter.inspect(INSPECTION_REQUEST);

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "probe-output-invalid",
    });
    expect(getterCalled).toBe(false);
    expectNoCanary(result);
  });

  it("re-attests immediately before every read and state observation", async () => {
    const instance = harness();

    await instance.adapter.inspect(INSPECTION_REQUEST);

    expect(instance.candidateRequests).toHaveLength(6);
    expect(instance.events.map((event) => event.kind)).toEqual([
      "attest",
      "attest",
      "process",
      "attest",
      "state",
      "attest",
      "process",
      "attest",
      "process",
      "attest",
      "state",
    ]);
    for (const request of instance.candidateRequests) {
      expect(request).toEqual({
        host: "claude-code",
        candidatePath: CLAUDE,
        excludedProjectDirectory: PROJECT,
      });
    }
  });

  it("fails closed when the executable changes during inspection", async () => {
    const instance = harness({
      candidate: (call, _request, current) => ({
        status: "verified",
        executable:
          call === 0 ? current : executable("claude-executable-stale"),
      }),
    });

    await expect(instance.adapter.inspect(INSPECTION_REQUEST)).resolves.toEqual({
      host: "claude-code",
      status: "unavailable",
      reason: "probe-failed",
      executable: executable(),
    });
    expect(instance.processRequests).toHaveLength(0);
  });

  it.each([
    ["timeout", { status: "timeout" }, "probe-timeout"],
    [
      "adapter output limit",
      { status: "output-too-large" },
      "probe-output-too-large",
    ],
    ["spawn failure", { status: "failed" }, "probe-failed"],
    [
      "nonzero exit",
      {
        status: "completed",
        exitCode: 1,
        stdout: bytes(CANARY),
        stderr: new Uint8Array(),
        stateRevision: null,
      },
      "probe-failed",
    ],
    [
      "nonempty stderr",
      {
        status: "completed",
        exitCode: 0,
        stdout: new Uint8Array(),
        stderr: bytes(CANARY),
        stateRevision: null,
      },
      "probe-failed",
    ],
    [
      "invalid exit",
      {
        status: "completed",
        exitCode: -1,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        stateRevision: null,
      },
      "probe-output-invalid",
    ],
    [
      "invalid UTF-8",
      {
        status: "completed",
        exitCode: 0,
        stdout: new Uint8Array([0xff]),
        stderr: new Uint8Array(),
        stateRevision: null,
      },
      "probe-output-invalid",
    ],
    [
      "oversized stdout",
      {
        status: "completed",
        exitCode: 0,
        stdout: new Uint8Array(65_537),
        stderr: new Uint8Array(),
        stateRevision: null,
      },
      "probe-output-too-large",
    ],
    [
      "sensitive stdout",
      {
        status: "completed",
        exitCode: 0,
        stdout: bytes(CANARY),
        stderr: new Uint8Array(),
        stateRevision: null,
      },
      "probe-output-invalid",
    ],
  ] as const)(
    "maps %s to a bounded generic probe result",
    async (_label, processResult, reason) => {
      const instance = harness({
        process: () =>
          processResult as unknown as ClaudeCodeProcessExecutionResult,
      });

      const result = await instance.adapter.inspect(INSPECTION_REQUEST);

      expect(result).toEqual({
        host: "claude-code",
        status: "unavailable",
        reason,
        executable: executable(),
      });
      expectNoCanary(result);
    },
  );

  it("rejects a process-result accessor without invoking it", async () => {
    let getterCalled = false;
    const hostile = {};
    Object.defineProperty(hostile, "status", {
      enumerable: true,
      get() {
        getterCalled = true;
        return CANARY;
      },
    });
    const instance = harness({
      process: () =>
        hostile as unknown as ClaudeCodeProcessExecutionResult,
    });

    const result = await instance.adapter.inspect(INSPECTION_REQUEST);

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "probe-output-invalid",
    });
    expect(getterCalled).toBe(false);
    expectNoCanary(result);
  });

  it("wipes transferred process buffers after making private copies", async () => {
    const stdout = bytes("2.1.212\n");
    const stderr = new Uint8Array();
    const instance = harness({
      process: (call) =>
        call === 0
          ? {
              status: "completed",
              exitCode: 0,
              stdout,
              stderr,
              stateRevision: null,
            }
          : undefined,
    });

    const result = await instance.adapter.inspect(INSPECTION_REQUEST);

    expect(result).toMatchObject({ status: "available", version: "2.1.212" });
    expect([...stdout]).toEqual(new Array(stdout.byteLength).fill(0));
    expect([...stderr]).toEqual(new Array(stderr.byteLength).fill(0));
  });

  it("rejects aliased stdout/stderr and wipes the transferred buffer", async () => {
    const aliased = bytes(CANARY);
    const instance = harness({
      process: () => ({
        status: "completed",
        exitCode: 0,
        stdout: aliased,
        stderr: aliased,
        stateRevision: null,
      }),
    });

    const result = await instance.adapter.inspect(INSPECTION_REQUEST);

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "probe-output-invalid",
    });
    expect([...aliased]).toEqual(new Array(aliased.byteLength).fill(0));
    expectNoCanary(result);
  });

  it("wipes transferred buffers even when the completed exit code is invalid", async () => {
    const stdout = bytes(CANARY);
    const stderr = bytes(CANARY);
    const instance = harness({
      process: () => ({
        status: "completed",
        exitCode: -1,
        stdout,
        stderr,
        stateRevision: null,
      }),
    });

    const result = await instance.adapter.inspect(INSPECTION_REQUEST);

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "probe-output-invalid",
    });
    expect([...stdout]).toEqual(new Array(stdout.byteLength).fill(0));
    expect([...stderr]).toEqual(new Array(stderr.byteLength).fill(0));
    expectNoCanary(result);
  });

  it("wipes transferred buffers when a completed result has extra fields", async () => {
    const stdout = bytes(CANARY);
    const stderr = bytes(CANARY);
    const hostile = {
      status: "completed",
      exitCode: 0,
      stdout,
      stderr,
      stateRevision: null,
      raw: CANARY,
    };
    const instance = harness({
      process: () =>
        hostile as unknown as ClaudeCodeProcessExecutionResult,
    });

    const result = await instance.adapter.inspect(INSPECTION_REQUEST);

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "probe-output-invalid",
    });
    expect([...stdout]).toEqual(new Array(stdout.byteLength).fill(0));
    expect([...stderr]).toEqual(new Array(stderr.byteLength).fill(0));
    expectNoCanary(result);
  });

  it.each([
    {
      label: "ambiguous",
      directMcp: { status: "ambiguous" } as const,
      expectedDirectMcp: { status: "ambiguous" } as const,
    },
    {
      label: "mismatched",
      directMcp: { status: "mismatched" } as const,
      expectedDirectMcp: {
        status: "present",
        value: {
          name: "plurum",
          endpoint: "https://mismatched.invalid/",
        },
      } as const,
    },
  ])("preserves a $label direct MCP observation for planning", async ({
    directMcp,
    expectedDirectMcp,
  }) => {
    const instance = harness({ directMcp });
    const result = await instance.adapter.inspect(INSPECTION_REQUEST);

    expect(result).toMatchObject({
      status: "available",
      state: {
        configuration: { directMcp: expectedDirectMcp },
      },
    });
  });

  it("rejects raw mismatched MCP evidence without retaining its value", async () => {
    const instance = harness({
      evidence: (_call, fallback) => ({
        ...fallback,
        directMcp: {
          status: "mismatched",
          endpoint: `https://example.test/${CANARY}`,
        },
      }),
    });

    const result = await instance.adapter.inspect(INSPECTION_REQUEST);

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "probe-output-invalid",
    });
    expectNoCanary(result);
  });

  it("passes exact executable evidence to the state observer", async () => {
    const instance = harness();

    await instance.adapter.inspect(INSPECTION_REQUEST);

    expect(instance.stateEvidenceRequests).toEqual([
      {
        executable: executable(),
        executableRevision: "claude-executable-1",
        excludedProjectDirectory: PROJECT,
        scope: "user",
      },
      {
        executable: executable(),
        executableRevision: "claude-executable-1",
        excludedProjectDirectory: PROJECT,
        scope: "user",
      },
    ]);
    expect(instance.events.at(-1)).toEqual({ kind: "state" });
  });

  it("maps thrown, malformed, accessor, and sensitive state evidence safely", async () => {
    let getterCalled = false;
    const getterEvidence = {
      pluginMcp: { status: "absent" },
      directMcp: { status: "absent" },
    };
    Object.defineProperty(getterEvidence, "revision", {
      enumerable: true,
      get() {
        getterCalled = true;
        return CANARY;
      },
    });
    const cases: readonly [
      string,
      () => unknown | Promise<unknown>,
      string,
    ][] = [
      ["throw", () => Promise.reject(new Error(CANARY)), "probe-failed"],
      [
        "extra field",
        () => ({
          revision: "revision",
          pluginMcp: { status: "absent" },
          directMcp: { status: "absent" },
          raw: CANARY,
        }),
        "probe-output-invalid",
      ],
      [
        "sensitive revision",
        () => ({
          revision: CANARY,
          pluginMcp: { status: "absent" },
          directMcp: { status: "absent" },
        }),
        "probe-output-invalid",
      ],
      [
        "accessor",
        () => getterEvidence,
        "probe-output-invalid",
      ],
      [
        "invalid direct endpoint",
        () => ({
          revision: "revision",
          pluginMcp: { status: "absent" },
          directMcp: {
            status: "present",
            value: {
              name: "plurum",
              endpoint: `https://example.test/${CANARY}`,
            },
          },
        }),
        "probe-output-invalid",
      ],
    ];

    for (const [, evidence, reason] of cases) {
      const instance = harness({ evidence: () => evidence() });
      const result = await instance.adapter.inspect(INSPECTION_REQUEST);
      expect(result).toMatchObject({ status: "unavailable", reason });
      expectNoCanary(result);
    }
    expect(getterCalled).toBe(false);
  });

  it("rejects state evidence that changes across one observation transaction", async () => {
    const instance = harness({
      evidence: (call, fallback) =>
        call === 0
          ? fallback
          : {
              ...fallback,
              revision: "claude-state-raced",
            },
    });

    await expect(instance.adapter.inspect(INSPECTION_REQUEST)).resolves.toEqual({
      host: "claude-code",
      status: "unavailable",
      reason: "probe-output-invalid",
      executable: executable(),
    });
    expect(instance.stateEvidenceRequests).toHaveLength(2);
  });
});

describe("Claude Code adapter apply", () => {
  const add = action(
    "add-marketplace",
    absentConfiguration(),
    marketplaceConfiguration(),
    { kind: "remove-cli-created-marketplace" },
  );
  const install = action(
    "install-plugin",
    marketplaceConfiguration(),
    installedConfiguration(),
    { kind: "remove-cli-created-plugin" },
  );
  const enable = action(
    "enable-plugin",
    installedConfiguration(false),
    installedConfiguration(true),
    { kind: "restore-plugin-disabled" },
  );

  it.each([
    [
      "add marketplace",
      add,
      COMMANDS.addMarketplace,
      "add-marketplace",
      true,
    ],
    [
      "install plugin",
      install,
      COMMANDS.installPlugin,
      "install-plugin",
      true,
    ],
    [
      "enable plugin",
      enable,
      COMMANDS.enablePlugin,
      "enable-plugin",
      false,
    ],
  ] as const)(
    "applies %s only after semantic preflight and verifies a fresh revision",
    async (
      _label,
      selectedAction,
      expectedCommand,
      expectedNativeCommand,
      preferHttps,
    ) => {
      const instance = harness({ initial: selectedAction.before });

      const result = await instance.adapter.apply(
        applyRequest(selectedAction),
      );

      expect(result).toEqual({
        status: "changed",
        stateRevision: "claude-state-2",
      });
      expect(instance.configuration()).toEqual(selectedAction.after);
      expect(instance.mutationCommands).toEqual([expectedCommand]);
      const mutations = mutationRequests(instance);
      expect(mutations).toHaveLength(1);
      expect(commandKey(mutations[0]!)).toBe(expectedCommand);
      expect(mutations[0]).toMatchObject({
        executable: CLAUDE,
        cwd: NEUTRAL,
        timeoutMs: preferHttps ? 120_000 : 30_000,
        maxOutputBytes: 65_536,
        shell: false,
      });
      expect(
        mutations[0]!.env.CLAUDE_CODE_PLUGIN_PREFER_HTTPS,
      ).toBe(preferHttps ? "1" : undefined);
      expect(
        instance.nativeSpawnRequests.find(
          (request) => request.process === mutations[0],
        ),
      ).toMatchObject({
        kind: "claude-code-fixed-spawn",
        command: expectedNativeCommand,
        executableRevision: "claude-executable-1",
        expectedStateRevision: "claude-state-1",
        excludedProjectDirectory: PROJECT,
      });
      for (const request of instance.processRequests) {
        if (request !== mutations[0]) {
          expect(request.env).not.toHaveProperty(
            "CLAUDE_CODE_PLUGIN_PREFER_HTTPS",
          );
        }
        expectNoCanary(request);
      }
      expectNoCanary(result);
    },
  );

  it("re-attests directly before every apply process", async () => {
    const instance = harness({ initial: add.before });

    await instance.adapter.apply(applyRequest(add));

    const events = instance.events;
    for (let index = 0; index < events.length; index += 1) {
      if (events[index]?.kind === "process") {
        expect(events[index - 1]?.kind).toBe("attest");
      }
    }
    expect(instance.processRequests).toHaveLength(7);
    expect(instance.candidateRequests).toHaveLength(13);
  });

  it.each([
    [
      "state revision",
      { expectedBeforeRevision: "stale-state" },
    ],
    [
      "executable revision",
      { executableRevision: "stale-executable" },
    ],
  ] as const)(
    "refuses a stale %s without a mutation",
    async (_label, overrides) => {
      const instance = harness({ initial: add.before });

      const result = await instance.adapter.apply(
        applyRequest(add, overrides),
      );

      expect(result).toEqual({ status: "precondition-failed" });
      expect(instance.mutationCommands).toHaveLength(0);
      expect(instance.configuration()).toEqual(add.before);
    },
  );

  it("refuses a mismatched request/action baseline before any process", async () => {
    const instance = harness({ initial: add.before });

    const result = await instance.adapter.apply(
      applyRequest(add, {
        expectedBefore: marketplaceConfiguration(),
      }),
    );

    expect(result).toEqual({ status: "failed" });
    expect(instance.processRequests).toHaveLength(0);
    expect(instance.mutationCommands).toHaveLength(0);
  });

  it("propagates a native mutation CAS precondition without claiming a change", async () => {
    const instance = harness({
      initial: add.before,
      process: (_call, request) =>
        commandKey(request) === COMMANDS.addMarketplace
          ? { status: "precondition-failed" }
          : undefined,
    });

    const result = await instance.adapter.apply(applyRequest(add));

    expect(result).toEqual({ status: "precondition-failed" });
    expect(instance.mutationCommands).toHaveLength(0);
    expect(instance.configuration()).toEqual(add.before);
    expect(mutationRequests(instance)).toHaveLength(1);
    expectNoCanary(result);
  });

  it("refuses update because an exact historical rollback is unavailable", async () => {
    const update = action(
      "update-plugin",
      installedConfiguration(true, "0.1.0"),
      installedConfiguration(true, "0.2.0"),
      {
        kind: "restore-plugin-version",
        pluginVersion: "0.1.0",
      },
    );
    const instance = harness({ initial: update.before });

    const result = await instance.adapter.apply(applyRequest(update));

    expect(result).toEqual({ status: "failed" });
    expect(instance.processRequests).toHaveLength(0);
    expect(instance.mutationCommands).toHaveLength(0);
  });

  it("fails when a successful command does not produce the requested semantics", async () => {
    const instance = harness({
      initial: add.before,
      mutateSemantics: false,
    });

    const result = await instance.adapter.apply(applyRequest(add));

    expect(result).toEqual({ status: "failed" });
    expect(instance.mutationCommands).toEqual([COMMANDS.addMarketplace]);
    expect(instance.configuration()).toEqual(add.before);
  });

  it("fails when semantic state changes without a fresh durable revision", async () => {
    const instance = harness({
      initial: add.before,
      advanceRevision: false,
    });

    const result = await instance.adapter.apply(applyRequest(add));

    expect(result).toEqual({ status: "failed" });
    expect(instance.configuration()).toEqual(add.after);
  });

  it.each([
    ["unchanged", "claude-state-1"],
    ["mismatched", "claude-state-unrelated"],
    ["missing", null],
  ] as const)(
    "fails when the native mutation receipt is %s",
    async (_label, mutationReceipt) => {
      const instance = harness({
        initial: add.before,
        mutationReceipt,
      });

      const result = await instance.adapter.apply(applyRequest(add));

      expect(result).toEqual({ status: "failed" });
      expect(instance.mutationCommands).toEqual([COMMANDS.addMarketplace]);
      expect(instance.configuration()).toEqual(add.after);
      expectNoCanary(result);
    },
  );

  it("fails generically when the mutation process fails", async () => {
    const instance = harness({
      initial: add.before,
      process: (_call, request) =>
        commandKey(request) === COMMANDS.addMarketplace
          ? { status: "failed" }
          : undefined,
    });

    const result = await instance.adapter.apply(applyRequest(add));

    expect(result).toEqual({ status: "failed" });
    expect(instance.configuration()).toEqual(add.before);
    expectNoCanary(result);
  });

  it("fails closed if the executable is replaced after mutation", async () => {
    const instance = harness({
      initial: add.before,
      swapExecutableAfterMutation: true,
    });

    const result = await instance.adapter.apply(applyRequest(add));

    expect(result).toEqual({ status: "failed" });
    expect(instance.executableRevision()).toBe("claude-executable-replaced");
  });

  it("rejects a forged semantic transition before mutating host state", async () => {
    const forged = action(
      "add-marketplace",
      absentConfiguration(),
      absentConfiguration(),
      { kind: "remove-cli-created-marketplace" },
    );
    const instance = harness({ initial: forged.before });

    const result = await instance.adapter.apply(applyRequest(forged));

    expect(result).toEqual({ status: "failed" });
    expect(instance.mutationCommands).toHaveLength(0);
    expect(instance.configuration()).toEqual(forged.before);
  });

  it("contains hostile request accessors and never reflects their secret", async () => {
    let getterCalled = false;
    const hostile = {
      ...applyRequest(add),
    } as Record<string, unknown>;
    Object.defineProperty(hostile, "host", {
      enumerable: true,
      get() {
        getterCalled = true;
        throw new Error(CANARY);
      },
    });
    const instance = harness({ initial: add.before });

    const result = await instance.adapter.apply(
      hostile as unknown as HostApplyRequest,
    );

    expect(result).toEqual({ status: "failed" });
    expect(getterCalled).toBe(false);
    expect(instance.processRequests).toHaveLength(0);
    expectNoCanary(result);
  });
});

describe("Claude Code adapter rollback", () => {
  const add = action(
    "add-marketplace",
    absentConfiguration(),
    marketplaceConfiguration(),
    { kind: "remove-cli-created-marketplace" },
  );
  const install = action(
    "install-plugin",
    marketplaceConfiguration(),
    installedConfiguration(),
    { kind: "remove-cli-created-plugin" },
  );
  const enable = action(
    "enable-plugin",
    installedConfiguration(false),
    installedConfiguration(true),
    { kind: "restore-plugin-disabled" },
  );

  it.each([
    ["CLI-created marketplace", add, COMMANDS.removeMarketplace],
    ["CLI-created plugin", install, COMMANDS.uninstallPlugin],
    ["previously disabled plugin", enable, COMMANDS.disablePlugin],
  ] as const)(
    "rolls back only the %s recipe and verifies restored semantics",
    async (_label, selectedAction, expectedCommand) => {
      const instance = harness({ initial: selectedAction.after });

      const result = await instance.adapter.rollback(
        rollbackRequest(selectedAction),
      );

      expect(result).toEqual({
        status: "changed",
        stateRevision: "claude-state-2",
      });
      expect(instance.configuration()).toEqual(selectedAction.before);
      expect(instance.mutationCommands).toEqual([expectedCommand]);
      const mutation = mutationRequests(instance)[0]!;
      expect(commandKey(mutation)).toBe(expectedCommand);
      expect(mutation.env).not.toHaveProperty(
        "CLAUDE_CODE_PLUGIN_PREFER_HTTPS",
      );
      expectNoCanary(result);
      expectNoCanary(mutation);
    },
  );

  it("refuses historical-version restoration without executing Claude", async () => {
    const update = action(
      "update-plugin",
      installedConfiguration(true, "0.1.0"),
      installedConfiguration(true, "0.2.0"),
      {
        kind: "restore-plugin-version",
        pluginVersion: "0.1.0",
      },
    );
    const instance = harness({ initial: update.after });

    const result = await instance.adapter.rollback(rollbackRequest(update));

    expect(result).toEqual({ status: "failed" });
    expect(instance.processRequests).toHaveLength(0);
    expect(instance.mutationCommands).toHaveLength(0);
  });

  it.each([
    [
      "state revision",
      { expectedAfterRevision: "stale-state" },
    ],
    [
      "executable revision",
      { executableRevision: "stale-executable" },
    ],
  ] as const)(
    "refuses a stale rollback %s without mutation",
    async (_label, overrides) => {
      const instance = harness({ initial: add.after });

      const result = await instance.adapter.rollback(
        rollbackRequest(add, "claude-state-1", overrides),
      );

      expect(result).toEqual({ status: "precondition-failed" });
      expect(instance.mutationCommands).toHaveLength(0);
      expect(instance.configuration()).toEqual(add.after);
    },
  );

  it("fails if rollback semantics are not restored", async () => {
    const instance = harness({
      initial: add.after,
      mutateSemantics: false,
    });

    const result = await instance.adapter.rollback(rollbackRequest(add));

    expect(result).toEqual({ status: "failed" });
    expect(instance.mutationCommands).toEqual([COMMANDS.removeMarketplace]);
    expect(instance.configuration()).toEqual(add.after);
  });

  it("fails if rollback reuses the pre-mutation revision", async () => {
    const instance = harness({
      initial: add.after,
      advanceRevision: false,
    });

    const result = await instance.adapter.rollback(rollbackRequest(add));

    expect(result).toEqual({ status: "failed" });
    expect(instance.configuration()).toEqual(add.before);
  });

  it("rejects a forged rollback recipe before mutating host state", async () => {
    const forged = action(
      "install-plugin",
      absentConfiguration(),
      marketplaceConfiguration(),
      { kind: "remove-cli-created-marketplace" },
    );
    const instance = harness({ initial: forged.after });

    const result = await instance.adapter.rollback(
      rollbackRequest(forged),
    );

    expect(result).toEqual({ status: "failed" });
    expect(instance.mutationCommands).toHaveLength(0);
    expect(instance.configuration()).toEqual(forged.after);
  });

  it("fails closed if the executable is replaced after rollback", async () => {
    const instance = harness({
      initial: add.after,
      swapExecutableAfterMutation: true,
    });

    const result = await instance.adapter.rollback(rollbackRequest(add));

    expect(result).toEqual({ status: "failed" });
    expect(instance.executableRevision()).toBe("claude-executable-replaced");
  });
});

describe("Claude Code adapter public boundary", () => {
  it("exports the same locked desired configuration used by planning", async () => {
    const instance = harness();
    const module = await import("../src/hosts/claude-code/adapter.js");

    expect(module.CLAUDE_CODE_DESIRED_CONFIGURATION).toBe(
      CLAUDE_CODE_DESIRED_CONFIGURATION,
    );
    expect(Object.isFrozen(instance.adapter)).toBe(true);
  });

  it("never exposes a credential canary across representative failures", async () => {
    const inspections = [
      await harness({
        versionOutput: CANARY,
      }).adapter.inspect(INSPECTION_REQUEST),
      await harness({
        evidence: () => Promise.reject(new Error(CANARY)),
      }).adapter.inspect(INSPECTION_REQUEST),
      await harness({
        process: () => {
          throw new Error(CANARY);
        },
      }).adapter.inspect(INSPECTION_REQUEST),
    ];
    const add = action(
      "add-marketplace",
      absentConfiguration(),
      marketplaceConfiguration(),
      { kind: "remove-cli-created-marketplace" },
    );
    const mutation = await harness({
      initial: add.before,
      process: (_call, request) => {
        if (commandKey(request) === COMMANDS.addMarketplace) {
          throw new Error(CANARY);
        }
        return undefined;
      },
    }).adapter.apply(applyRequest(add));

    expectNoCanary({ inspections, mutation });
    expect(inspections.every((result) => result.status === "unavailable")).toBe(
      true,
    );
    expect(mutation).toEqual({ status: "failed" });
  });

  it.each(["darwin", "linux"] as const)(
    "keeps all synthetic execution isolated on %s",
    async (os: SupportedOs) => {
      const selectedPlatform = platform({
        os,
        paths: createPlatformPathAdapter(os),
      });
      const instance = harness({ platform: selectedPlatform });

      await instance.adapter.inspect(INSPECTION_REQUEST);

      expect(instance.processRequests).toHaveLength(3);
      for (const request of instance.processRequests) {
        expect(request.executable).toBe(CLAUDE);
        expect(request.cwd).toBe(NEUTRAL);
        expect(request.shell).toBe(false);
      }
    },
  );
});
