import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";
import { createDoctorCommand } from "../src/commands/doctor.js";
import type { CommandHandlers } from "../src/commands/types.js";
import type { CodexDotenvProjectionStatus } from "../src/credentials/codex-dotenv-contracts.js";
import type { LegacyCredentialReadAdapter } from "../src/credentials/legacy-reader-contracts.js";
import {
  serializeCredentialDocument,
  validateCredentialDocument,
} from "../src/credentials/schema.js";
import { ExitCode } from "../src/exit-codes.js";
import {
  CLAUDE_CODE_DESIRED_CONFIGURATION,
  CLAUDE_CODE_MUTATION_SUPPORT,
} from "../src/hosts/claude-code/configuration.js";
import {
  CODEX_DESIRED_CONFIGURATION,
  CODEX_MUTATION_SUPPORT,
} from "../src/hosts/codex/configuration.js";
import type {
  DesiredHostConfiguration,
  HostConfiguration,
  HostId,
  HostInspection,
  HostInspectionAdapter,
  HostMutationAdapter,
} from "../src/hosts/contracts.js";
import type { CliRuntime } from "../src/runtime.js";
import type {
  NetworkRequest,
  NetworkResponse,
  SystemCapabilities,
} from "../src/system/contracts.js";
import type {
  RuntimeSupportObservation,
} from "../src/system/runtime-support.js";
import { createInMemoryCredentialStore } from "./support/in-memory-credential-store.js";
import { snapshotIsolatedTree } from "./support/isolated-tree-snapshot.js";
import { createTestSystem } from "./support/system.js";
import {
  createIsolatedTestRoot,
  isIsolatedTestEnvironmentSafe,
} from "./support/test-root.js";

const ORIGIN = "https://api.plurum.ai";
const MCP_ENDPOINT = "https://mcp.plurum.ai/mcp";
const KEY = "plrm_live_DOCTOR_COMMAND_CANONICAL_KEY";
const AGENT_ID = "00000000-0000-4000-8000-000000000050";
const AGENT_NAME = "Codex";
const USERNAME = "doctor-agent";
const TIMESTAMP = "2026-07-22T12:01:00.000Z";
const DESIRED: Readonly<Record<HostId, DesiredHostConfiguration>> =
  Object.freeze({
    "claude-code": CLAUDE_CODE_DESIRED_CONFIGURATION,
    codex: CODEX_DESIRED_CONFIGURATION,
  });
const FILESYSTEM_MUTATIONS = Object.freeze([
  "createDirectory",
  "open",
  "rename",
  "unlink",
  "openDirectory",
] as const);

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  Object.values(value).forEach((child) => deepFreeze(child, seen));
  return Object.freeze(value);
}

function expectDeepFrozen(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return;
  }
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  Object.values(value).forEach((child) => expectDeepFrozen(child, seen));
}

function jsonResponse(body: unknown): NetworkResponse {
  return Object.freeze({
    status: 200,
    headers: Object.freeze({ "content-type": "application/json" }),
    body: new TextEncoder().encode(JSON.stringify(body)),
  });
}

function mcpChallengeResponse(): NetworkResponse {
  return Object.freeze({
    status: 401,
    headers: Object.freeze({
      "www-authenticate": 'Bearer realm="plurum"',
    }),
    body: new TextEncoder().encode("authentication required"),
  });
}

function healthyConfiguration(host: HostId): HostConfiguration {
  const desired = DESIRED[host];
  return deepFreeze({
    marketplace: {
      status: "present" as const,
      value: { ...desired.marketplace },
    },
    plugin: {
      status: "present" as const,
      value: {
        name: "plurum" as const,
        source: desired.plugin.source,
        version: desired.plugin.version,
        enabled: true,
      },
    },
    pluginMcp: {
      status: "present" as const,
      value: { ...desired.mcp },
    },
    directMcp: { status: "absent" as const },
  });
}

function healthyInspection(host: HostId): HostInspection {
  const desired = DESIRED[host];
  const executable =
    host === "claude-code" ? "/fake/bin/claude" : "/fake/bin/codex";
  return deepFreeze({
    host,
    status: "available" as const,
    executable: {
      sourcePath: executable,
      resolvedPath: executable,
      revision: `${host}-executable-revision`,
      chain: [
        {
          path: executable,
          kind: "binary" as const,
          owner: "current-user" as const,
          access: "not-broadly-writable" as const,
          binding: "canonical" as const,
          link: "direct" as const,
          revision: `${host}-chain-revision`,
        },
      ],
      launch: { executable, argumentPrefix: [], shell: false as const },
    },
    version: desired.minimumHostVersion,
    state: {
      revision: `${host}-state-revision`,
      configuration: healthyConfiguration(host),
    },
    mutationSupport:
      host === "claude-code"
        ? CLAUDE_CODE_MUTATION_SUPPORT
        : CODEX_MUTATION_SUPPORT,
  });
}

function createFixture(
  runtimeObservation: RuntimeSupportObservation = Object.freeze({
    status: "available" as const,
    runtime: "node" as const,
    version: "22.12.0",
    target: "darwin-arm64",
  }),
  projection: CodexDotenvProjectionStatus = "exact",
) {
  const document = serializeCredentialDocument(
    validateCredentialDocument({
      schema_version: 1,
      state: "active",
      api_origin: ORIGIN,
      api_key: KEY,
      agent_id: AGENT_ID,
      agent_name: AGENT_NAME,
      username: USERNAME,
      registration_request_id: null,
      created_at: "2026-07-22T12:00:00.000Z",
      updated_at: TIMESTAMP,
      activated_at: TIMESTAMP,
    }),
  );
  const credentialBytes = new TextEncoder().encode(document);
  const canonical = createInMemoryCredentialStore({ bytes: credentialBytes });
  const inspections = deepFreeze({
    "claude-code": healthyInspection("claude-code"),
    codex: healthyInspection("codex"),
  });
  const semanticState = deepFreeze({
    credential: { document, legacy: "missing", codexProjection: projection },
    hosts: inspections,
  });

  const filesystemMutation = vi.fn(async (): Promise<never> => {
    throw new Error("doctor must not mutate the filesystem");
  });
  const processRun = vi.fn(async (): Promise<never> => {
    throw new Error("doctor must not run a process");
  });
  const random = vi.fn((): never => {
    throw new Error("doctor must not use randomness");
  });
  const hostApply = vi.fn(async (): Promise<never> => {
    throw new Error("doctor must not apply host changes");
  });
  const hostRollback = vi.fn(async (): Promise<never> => {
    throw new Error("doctor must not roll back host changes");
  });
  const networkRequests: NetworkRequest[] = [];
  const scopeObservations: unknown[] = [];
  const runtimeObserve = vi.fn(async () => runtimeObservation);
  const legacyRead = vi.fn(async () =>
    Object.freeze({ status: "missing" as const })
  );
  const projectionObserve = vi.fn(async () =>
    Object.freeze({ status: projection })
  );
  const inspectClaude = vi.fn(async () => inspections["claude-code"]);
  const inspectCodex = vi.fn(async () => inspections.codex);
  const base = createTestSystem();
  const inspection = Object.freeze({
    "claude-code": Object.freeze<HostInspectionAdapter>({
      inspect: inspectClaude,
    }),
    codex: Object.freeze<HostInspectionAdapter>({ inspect: inspectCodex }),
  });
  const mutableHost = (host: HostId): HostMutationAdapter =>
    Object.freeze({
      inspect: inspection[host].inspect,
      apply: hostApply,
      rollback: hostRollback,
    });
  const system = Object.freeze<SystemCapabilities>({
    ...base,
    filesystem: Object.freeze({
      ...base.filesystem,
      createDirectory: filesystemMutation,
      open: filesystemMutation,
      rename: filesystemMutation,
      unlink: filesystemMutation,
      openDirectory: filesystemMutation,
    }),
    processes: Object.freeze({ run: processRun }),
    random: Object.freeze({ bytes: random, uuid: random }),
    hash: Object.freeze({
      sha256: () => new Uint8Array(32).fill(0x2a),
    }),
    platform: Object.freeze({
      ...base.platform,
      os: "darwin" as const,
      arch: "arm64",
    }),
    credentialEnvironment: Object.freeze({ read: () => Object.freeze({}) }),
    network: Object.freeze({
      async request(request: NetworkRequest) {
        networkRequests.push(request);
        if (request.url === `${ORIGIN}/api/v1/agents/me`) {
          return jsonResponse({
            id: AGENT_ID,
            name: AGENT_NAME,
            username: USERNAME,
            is_active: true,
          });
        }
        if (request.url === `${ORIGIN}/health`) {
          return jsonResponse({ status: "healthy", version: "0.2.0" });
        }
        if (request.url === MCP_ENDPOINT) {
          return mcpChallengeResponse();
        }
        throw new Error("unexpected fake network request");
      },
    }),
    hosts: Object.freeze({
      inspection,
      mutation: Object.freeze({
        "claude-code": mutableHost("claude-code"),
        codex: mutableHost("codex"),
      }),
    }),
  });

  const doctorCommand = createDoctorCommand(
    Object.freeze({
      runtimeSupport: Object.freeze({ observe: runtimeObserve }),
      canonicalStore: canonical.adapter,
      legacyStore: Object.freeze<LegacyCredentialReadAdapter>({
        read: legacyRead,
      }),
      codexProjection: Object.freeze({ observe: projectionObserve }),
    }),
  );
  const handlers = Object.freeze<CommandHandlers>({
    setup: () => {
      throw new Error("unexpected setup");
    },
    status: () => {
      throw new Error("unexpected status");
    },
    doctor(invocation) {
      const scoped = invocation.runtime.system;
      const hostAdapters = Object.values(scoped.hosts.inspection);
      scopeObservations.push(
        Object.freeze({
          stdin: "stdin" in invocation.runtime,
          process: "processes" in scoped,
          random: "random" in scoped,
          hostMutation: "mutation" in scoped.hosts,
          filesystemMutation: FILESYSTEM_MUTATIONS.some(
            (method) => method in scoped.filesystem,
          ),
          hostApply: hostAdapters.some((adapter) => "apply" in adapter),
          hostRollback: hostAdapters.some((adapter) => "rollback" in adapter),
        }),
      );
      return doctorCommand(invocation);
    },
  });

  return Object.freeze({
    system,
    handlers,
    scopeObservations,
    networkRequests,
    canonical,
    observers: Object.freeze({
      runtimeObserve,
      legacyRead,
      projectionObserve,
      inspectClaude,
      inspectCodex,
    }),
    forbidden: Object.freeze({
      filesystemMutation,
      processRun,
      random,
      hostApply,
      hostRollback,
    }),
    snapshot: () =>
      deepFreeze({
        ...semanticState,
        credentialBytes: [...credentialBytes],
      }),
  });
}

type Fixture = ReturnType<typeof createFixture>;

async function invoke(
  fixture: Fixture,
  args: readonly string[],
): Promise<Readonly<{
  exitCode: ExitCode;
  stdout: string;
  stderr: string;
  stdinReads: number;
}>> {
  let stdinReads = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const runtime: CliRuntime = {
    stdin: new Readable({
      read() {
        stdinReads += 1;
        this.push(null);
      },
    }),
    stdout: { write: (text) => stdout.push(text) },
    stderr: { write: (text) => stderr.push(text) },
    system: fixture.system,
  };
  const exitCode = await runCli(args, runtime, fixture.handlers);
  return Object.freeze({
    exitCode,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    stdinReads,
  });
}

function expectScopeSafe(fixture: Fixture, expectedRuns: number): void {
  expect(fixture.scopeObservations).toHaveLength(expectedRuns);
  for (const observation of fixture.scopeObservations) {
    expect(observation).toEqual({
      stdin: false,
      process: false,
      random: false,
      hostMutation: false,
      filesystemMutation: false,
      hostApply: false,
      hostRollback: false,
    });
  }
  Object.values(fixture.forbidden).forEach((spy) =>
    expect(spy).not.toHaveBeenCalled(),
  );
}

describe("doctor command integration", () => {
  it("repeats a healthy text diagnosis through only read-only fake capabilities", async () => {
    const fixture = createFixture();
    const before = fixture.snapshot();
    expectDeepFrozen(before);

    const first = await invoke(fixture, ["doctor"]);
    const second = await invoke(fixture, ["doctor"]);

    expect(second).toEqual(first);
    expect(first.exitCode).toBe(ExitCode.Success);
    expect(first.stdinReads).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.stdout).toContain("overall: healthy");
    expect(first.stdout).toContain(
      "MCP protocol initialization and tool inventory were not checked.",
    );
    expect(first.stdout).toMatch(
      /No local configuration changes were made\.\n$/u,
    );
    expect(first.stdout).not.toContain(KEY);
    expectScopeSafe(fixture, 2);
    expect(fixture.snapshot()).toEqual(before);
    expect(fixture.observers.runtimeObserve).toHaveBeenCalledTimes(2);
    expect(fixture.observers.inspectClaude).toHaveBeenCalledTimes(2);
    expect(fixture.observers.inspectCodex).toHaveBeenCalledTimes(2);

    const mcpRequests = fixture.networkRequests.filter(
      (request) => request.url === MCP_ENDPOINT,
    );
    expect(mcpRequests).toHaveLength(2);
    for (const request of mcpRequests) {
      expect(request).toEqual({
        url: MCP_ENDPOINT,
        method: "GET",
        headers: { Accept: "application/json" },
        timeoutMs: 12_000,
        maxResponseBytes: 4_096,
        redirect: "error",
      });
      expect(request.headers).not.toHaveProperty("Authorization");
      expect(request).not.toHaveProperty("body");
    }
  });

  it("short-circuits unsupported runtime before credentials, hosts, or network", async () => {
    const fixture = createFixture(Object.freeze({
      status: "available" as const,
      runtime: "node" as const,
      version: "20.19.0",
      target: "darwin-arm64",
    }));
    const before = fixture.snapshot();

    const first = await invoke(fixture, ["doctor", "--json"]);
    const second = await invoke(fixture, ["doctor", "--json"]);

    expect(second).toEqual(first);
    expect(first.exitCode).toBe(ExitCode.OperationalFailure);
    expect(first.stdinReads).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.stdout).not.toContain(KEY);
    expect(JSON.parse(first.stdout)).toMatchObject({
      schema_version: 1,
      ok: true,
      command: "doctor",
      result: {
        overall: "attention-required",
        runtime_platform: {
          status: "unsupported",
          reason: "node-version",
        },
        status: null,
        mcp: null,
        findings: [
          {
            check: "runtime-platform",
            outcome: "attention",
            guidance: ["update-runtime"],
          },
          { check: "status", outcome: "not-checked" },
          {
            check: "mcp-authentication-boundary",
            outcome: "not-checked",
          },
          { check: "mcp-protocol", outcome: "not-checked" },
        ],
      },
    });
    expectScopeSafe(fixture, 2);
    expect(fixture.snapshot()).toEqual(before);
    expect(fixture.observers.runtimeObserve).toHaveBeenCalledTimes(2);
    expect(fixture.canonical.trace.operations()).toEqual([]);
    expect(fixture.observers.legacyRead).not.toHaveBeenCalled();
    expect(fixture.observers.projectionObserve).not.toHaveBeenCalled();
    expect(fixture.observers.inspectClaude).not.toHaveBeenCalled();
    expect(fixture.observers.inspectCodex).not.toHaveBeenCalled();
    expect(fixture.networkRequests).toEqual([]);
  });

  it("separates host/plugin health from unsafe Codex projection", async () => {
    const fixture = createFixture(
      Object.freeze({
        status: "available" as const,
        runtime: "node" as const,
        version: "22.12.0",
        target: "darwin-arm64",
      }),
      "unsafe",
    );

    const result = await invoke(fixture, ["doctor", "--json"]);
    const envelope = JSON.parse(result.stdout);
    const codexFindings = envelope.result.findings.filter(
      (entry: { client: string | null }) => entry.client === "codex",
    );

    expect(result.exitCode).toBe(ExitCode.OperationalFailure);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(KEY);
    expect(codexFindings).toEqual([
      {
        check: "host",
        outcome: "pass",
        reason: "host-supported",
        client: "codex",
        guidance: [],
      },
      {
        check: "plugin-configuration",
        outcome: "pass",
        reason: "plugin-configuration-healthy",
        client: "codex",
        guidance: [],
      },
      {
        check: "local-registration",
        outcome: "pass",
        reason: "local-plugin-registration-healthy",
        client: "codex",
        guidance: [],
      },
      {
        check: "credential-projection",
        outcome: "attention",
        reason: "credential-projection-unsafe",
        client: "codex",
        guidance: ["secure-credential-source-manually"],
      },
    ]);
    expectScopeSafe(fixture, 1);
  });

  it("keeps setup guidance within the requested client scope", async () => {
    const fixture = createFixture(
      Object.freeze({
        status: "available" as const,
        runtime: "node" as const,
        version: "22.12.0",
        target: "darwin-arm64",
      }),
      "absent",
    );

    const result = await invoke(fixture, [
      "doctor",
      "--client",
      "codex",
    ]);

    expect(result.exitCode).toBe(ExitCode.OperationalFailure);
    expect(result.stdout).toContain("plurum setup --client codex");
    expect(result.stdout).not.toContain("plurum setup --client all");
    expect(fixture.observers.inspectClaude).not.toHaveBeenCalled();
    expect(fixture.observers.inspectCodex).toHaveBeenCalledOnce();
    expectScopeSafe(fixture, 1);
  });
});

describe.runIf(isIsolatedTestEnvironmentSafe())(
  "doctor command disposable-home boundary",
  () => {
    it("leaves a sentinel-protected temporary home byte-for-byte unchanged", async () => {
      const isolated = await createIsolatedTestRoot();
      try {
        await writeFile(
          join(isolated.paths.plurum, "doctor-marker.txt"),
          "doctor must leave this disposable home unchanged\n",
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
        const baseFixture = createFixture();
        const fixture: Fixture = Object.freeze({
          ...baseFixture,
          system: Object.freeze({
            ...baseFixture.system,
            platform: Object.freeze({
              ...baseFixture.system.platform,
              cwd: isolated.paths.neutral,
              environment: isolated.environment,
            }),
          }),
        });
        const semanticBefore = fixture.snapshot();
        const filesystemBefore = await snapshotIsolatedTree(
          isolated.paths.root,
        );

        const first = await invoke(fixture, ["doctor"]);
        const second = await invoke(fixture, ["doctor"]);

        expect(first.exitCode).toBe(ExitCode.Success);
        expect(second).toEqual(first);
        expectScopeSafe(fixture, 2);
        expect(fixture.snapshot()).toEqual(semanticBefore);
        expect(await snapshotIsolatedTree(isolated.paths.root)).toEqual(
          filesystemBefore,
        );
        expect(isolated.boundary.operations).toEqual([]);
      } finally {
        await isolated.cleanup();
      }
    });
  },
);
