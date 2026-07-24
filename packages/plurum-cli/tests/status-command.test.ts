import { Readable } from "node:stream";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";
import { createStatusCommand } from "../src/commands/status.js";
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
import { createInMemoryCredentialStore } from "./support/in-memory-credential-store.js";
import { snapshotIsolatedTree } from "./support/isolated-tree-snapshot.js";
import { createTestSystem } from "./support/system.js";
import {
  createIsolatedTestRoot,
  isIsolatedTestEnvironmentSafe,
} from "./support/test-root.js";

const ORIGIN = "https://api.plurum.ai";
const KEY = "plrm_live_STATUS_COMMAND_CANONICAL_KEY";
const AGENT_ID = "00000000-0000-4000-8000-000000000049";
const AGENT_NAME = "Codex";
const USERNAME = "status-agent";
const TIMESTAMP = "2026-07-21T12:01:00.000Z";
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
    host === "claude-code" ? "/trusted/bin/claude" : "/trusted/bin/codex";
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

function createFixture(projection: CodexDotenvProjectionStatus) {
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
      created_at: "2026-07-21T12:00:00.000Z",
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
  const state = deepFreeze({
    filesystem: { revision: "memory-fs-v1", entries: [] as readonly string[] },
    credential: { document, legacy: "missing", codexProjection: projection },
    hosts: inspections,
  });

  const filesystemMutation = vi.fn(async (): Promise<never> => {
    throw new Error("status must not mutate the filesystem");
  });
  const processRun = vi.fn(async (): Promise<never> => {
    throw new Error("status must not run a process");
  });
  const random = vi.fn((): never => {
    throw new Error("status must not use randomness");
  });
  const hostApply = vi.fn(async (): Promise<never> => {
    throw new Error("status must not apply host changes");
  });
  const hostRollback = vi.fn(async (): Promise<never> => {
    throw new Error("status must not roll back host changes");
  });
  const scopeObservations: unknown[] = [];
  const base = createTestSystem();
  const inspection = Object.freeze({
    "claude-code": Object.freeze<HostInspectionAdapter>({
      async inspect() {
        return inspections["claude-code"];
      },
    }),
    codex: Object.freeze<HostInspectionAdapter>({
      async inspect() {
        return inspections.codex;
      },
    }),
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
    credentialEnvironment: Object.freeze({
      read: () => Object.freeze({}),
    }),
    network: Object.freeze({
      async request(request: NetworkRequest) {
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

  const statusCommand = createStatusCommand(
    Object.freeze({
      canonicalStore: canonical.adapter,
      legacyStore: Object.freeze<LegacyCredentialReadAdapter>({
        async read() {
          return Object.freeze({ status: "missing" as const });
        },
      }),
      codexProjection: Object.freeze({
        async observe() {
          return Object.freeze({ status: projection });
        },
      }),
    }),
  );
  const handlers = Object.freeze<CommandHandlers>({
    setup: () => {
      throw new Error("unexpected setup");
    },
    doctor: () => {
      throw new Error("unexpected doctor");
    },
    status(invocation) {
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
      return statusCommand(invocation);
    },
  });

  return Object.freeze({
    system,
    handlers,
    scopeObservations,
    forbidden: Object.freeze({
      filesystemMutation,
      processRun,
      random,
      hostApply,
      hostRollback,
    }),
    snapshot: () =>
      deepFreeze({
        ...state,
        credential: {
          ...state.credential,
          bytes: [...credentialBytes],
        },
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

function expectSafeAndUnchanged(fixture: Fixture, before: unknown): void {
  expect(fixture.scopeObservations).toHaveLength(2);
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
  const after = fixture.snapshot();
  expectDeepFrozen(after);
  expect(after).toEqual(before);
}

describe("status command integration", () => {
  it("repeats a fully healthy canonical text observation without input or mutation", async () => {
    const fixture = createFixture("exact");
    const before = fixture.snapshot();
    expectDeepFrozen(before);

    const first = await invoke(fixture, ["status"]);
    const second = await invoke(fixture, ["status"]);

    expect(second).toEqual(first);
    expect(first.exitCode).toBe(ExitCode.Success);
    expect(first.stdinReads).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.stdout).toContain("overall: healthy");
    expect(first.stdout).toContain(
      "No local configuration changes were made.",
    );
    expect(first.stdout).not.toContain(KEY);
    expectSafeAndUnchanged(fixture, before);
  });

  it("repeats an ok:true attention JSON observation with exit 1", async () => {
    const fixture = createFixture("absent");
    const before = fixture.snapshot();
    expectDeepFrozen(before);

    const first = await invoke(fixture, ["status", "--json"]);
    const second = await invoke(fixture, ["status", "--json"]);

    expect(second).toEqual(first);
    expect(first.exitCode).toBe(ExitCode.OperationalFailure);
    expect(first.stdinReads).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.stdout).not.toContain(KEY);
    expect(JSON.parse(first.stdout)).toMatchObject({
      schema_version: 1,
      ok: true,
      command: "status",
      result: {
        overall: "attention-required",
        credential: { state: "ready", sources: ["canonical"] },
        clients: [
          { client: "claude-code", status: "healthy" },
          {
            client: "codex",
            status: "healthy",
            credential_projection: "absent",
          },
        ],
      },
    });
    expectSafeAndUnchanged(fixture, before);
  });
});

describe.runIf(isIsolatedTestEnvironmentSafe())(
  "status command disposable-home boundary",
  () => {
    it("leaves an actual sentinel-protected temporary home byte-for-byte unchanged", async () => {
      const isolated = await createIsolatedTestRoot();
      try {
        await writeFile(
          join(isolated.paths.plurum, "status-marker.txt"),
          "status must leave this disposable home unchanged\n",
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
        const baseFixture = createFixture("exact");
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

        const first = await invoke(fixture, ["status"]);
        const second = await invoke(fixture, ["status"]);

        expect(first.exitCode).toBe(ExitCode.Success);
        expect(second).toEqual(first);
        expectSafeAndUnchanged(fixture, semanticBefore);
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
