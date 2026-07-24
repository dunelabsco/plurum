import { describe, expect, it } from "vitest";

import {
  observeDoctor,
  type DoctorObservationDependencies,
} from "../src/commands/doctor-observation.js";
import type {
  DoctorCheckId,
  DoctorFinding,
  DoctorFindingReason,
  DoctorReportV1,
} from "../src/commands/doctor-contracts.js";
import {
  DOCTOR_CHECK_IDS,
  DOCTOR_FINDING_OUTCOMES,
  DOCTOR_FINDING_REASONS,
  DOCTOR_GUIDANCE_CODES,
} from "../src/commands/doctor-contracts.js";
import {
  serializeCredentialDocument,
  validateCredentialDocument,
} from "../src/credentials/schema.js";
import type {
  LegacyCredentialAdapterReadResult,
  LegacyCredentialReadAdapter,
  LegacyCredentialSource,
} from "../src/credentials/legacy-reader-contracts.js";
import type {
  CodexDotenvProjectionStatus,
} from "../src/credentials/codex-dotenv-contracts.js";
import type {
  CodexDotenvStatusObservationAdapter,
} from "../src/credentials/codex-dotenv-status.js";
import { DEFAULT_API_ORIGIN } from "../src/credentials/origin.js";
import {
  CLAUDE_CODE_DESIRED_CONFIGURATION,
} from "../src/hosts/claude-code/configuration.js";
import {
  CODEX_DESIRED_CONFIGURATION,
} from "../src/hosts/codex/configuration.js";
import type {
  DesiredHostConfiguration,
  HostConfiguration,
  HostId,
  HostInspection,
  HostMutationSupport,
} from "../src/hosts/contracts.js";
import { doctorScope } from "../src/system/scopes.js";
import type {
  CredentialEnvironmentSnapshot,
  DoctorCapabilities,
  NetworkResponse,
  ReadOnlyNetworkRequest,
} from "../src/system/contracts.js";
import type {
  RuntimeSupportObservation,
  RuntimeSupportObservationAdapter,
} from "../src/system/runtime-support.js";
import {
  createInMemoryCredentialStore,
  secureDirectoryAttestation,
  type InMemoryCredentialStore,
} from "./support/in-memory-credential-store.js";
import { createTestSystem } from "./support/system.js";

const KEY_A = "plrm_live_DOCTOR_OBSERVATION_AAAAAAAAAAAAAAAAA";
const KEY_B = "plrm_live_DOCTOR_OBSERVATION_BBBBBBBBBBBBBBBBB";
const AGENT_A = "00000000-0000-4000-8000-000000000001";
const AGENT_B = "00000000-0000-4000-8000-000000000002";
const REQUEST_ID = "7ef67d46-c4d7-45dc-b7e4-bff6928011f2";
const CREATED_AT = "2026-07-22T08:00:00.000Z";
const ACTIVATED_AT = "2026-07-22T08:01:00.000Z";
const PATH_CANARY = "/Users/private-owner/PRIVATE_DOCTOR_PATH_CANARY";
const BODY_CANARY = "PRIVATE_DOCTOR_BODY_CANARY";
const ERROR_CANARY = "PRIVATE_DOCTOR_ERROR_CANARY";

const FULL_SUPPORT: HostMutationSupport = Object.freeze({
  addMarketplace: true,
  removeMarketplace: true,
  installPlugin: true,
  removePlugin: true,
  updatePlugin: true,
  restorePlugin: true,
  enablePlugin: true,
  disablePlugin: true,
});

interface AgentFixture {
  readonly id: string;
  readonly name: string;
  readonly username: string;
}

type McpFixture = "healthy" | "unhealthy" | "unavailable";
type ApiFixture = "healthy" | "unhealthy" | "unavailable";
type LegacyFixture = LegacyCredentialAdapterReadResult | Error;

interface HarnessOptions {
  readonly runtime?: RuntimeSupportObservation | Error;
  readonly platformOs?: "darwin" | "linux" | "win32" | "unsupported";
  readonly platformArch?: string;
  readonly canonical?: InMemoryCredentialStore;
  readonly environment?: CredentialEnvironmentSnapshot;
  readonly legacy?: Partial<Record<LegacyCredentialSource, LegacyFixture>>;
  readonly agents?: Readonly<Record<string, AgentFixture>>;
  readonly agentFailure?: "invalid" | "unavailable";
  readonly api?: ApiFixture;
  readonly mcp?: McpFixture;
  readonly hosts?: Partial<Record<HostId, HostInspection | Error>>;
  readonly codexProjection?: CodexDotenvProjectionStatus | "throw";
}

interface NetworkAuditEntry {
  readonly url: string;
  readonly method: string;
  readonly headerNames: readonly string[];
}

interface Harness {
  readonly capabilities: DoctorCapabilities;
  readonly dependencies: DoctorObservationDependencies;
  readonly canonical: InMemoryCredentialStore;
  readonly runtimeCalls: () => number;
  readonly networkAudit: readonly NetworkAuditEntry[];
  readonly hostCalls: readonly HostId[];
  readonly codexCalls: () => number;
}

function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function encodeJson(value: unknown): Uint8Array {
  return encodeText(JSON.stringify(value));
}

function response(
  status: number,
  body: Uint8Array,
  headers: Readonly<Record<string, string>> = Object.freeze({
    "content-type": "application/json",
  }),
): NetworkResponse {
  return Object.freeze({ status, headers, body });
}

function activeCredentialBytes(
  apiKey: string = KEY_A,
  agentId: string = AGENT_A,
): Uint8Array {
  return encodeText(
    serializeCredentialDocument(
      validateCredentialDocument({
        schema_version: 1,
        state: "active",
        api_origin: DEFAULT_API_ORIGIN,
        api_key: apiKey,
        agent_id: agentId,
        agent_name: "Doctor Agent",
        username: "doctor-agent",
        registration_request_id: REQUEST_ID,
        created_at: CREATED_AT,
        updated_at: ACTIVATED_AT,
        activated_at: ACTIVATED_AT,
      }),
    ),
  );
}

function pendingCredentialBytes(): Uint8Array {
  return encodeText(
    serializeCredentialDocument(
      validateCredentialDocument({
        schema_version: 1,
        state: "pending",
        api_origin: DEFAULT_API_ORIGIN,
        api_key: KEY_A,
        agent_id: null,
        agent_name: "Doctor Agent",
        username: "doctor-agent",
        registration_request_id: REQUEST_ID,
        created_at: CREATED_AT,
        updated_at: CREATED_AT,
        activated_at: null,
      }),
    ),
  );
}

function legacyHermes(apiKey: string): LegacyCredentialAdapterReadResult {
  return Object.freeze({
    status: "loaded" as const,
    bytes: encodeJson({
      api_key: apiKey,
      api_url: DEFAULT_API_ORIGIN,
      ignored: `${BODY_CANARY}:${PATH_CANARY}`,
    }),
  });
}

function desired(host: HostId): DesiredHostConfiguration {
  return host === "claude-code"
    ? CLAUDE_CODE_DESIRED_CONFIGURATION
    : CODEX_DESIRED_CONFIGURATION;
}

function emptyConfiguration(): HostConfiguration {
  return Object.freeze({
    marketplace: Object.freeze({ status: "absent" as const }),
    plugin: Object.freeze({ status: "absent" as const }),
    pluginMcp: Object.freeze({ status: "absent" as const }),
    directMcp: Object.freeze({ status: "absent" as const }),
  });
}

function healthyConfiguration(host: HostId): HostConfiguration {
  const expected = desired(host);
  return Object.freeze({
    marketplace: Object.freeze({
      status: "present" as const,
      value: Object.freeze({ ...expected.marketplace }),
    }),
    plugin: Object.freeze({
      status: "present" as const,
      value: Object.freeze({
        name: expected.plugin.name,
        source: expected.plugin.source,
        version: expected.plugin.version,
        enabled: true,
      }),
    }),
    pluginMcp: Object.freeze({
      status: "present" as const,
      value: Object.freeze({ ...expected.mcp }),
    }),
    directMcp: Object.freeze({ status: "absent" as const }),
  });
}

function availableHost(
  host: HostId,
  configuration: HostConfiguration = healthyConfiguration(host),
  version = host === "claude-code" ? "2.1.212" : "0.144.5",
): HostInspection {
  const executableName = host === "claude-code" ? "claude" : "codex";
  const executablePath = `${PATH_CANARY}/${executableName}`;
  return Object.freeze({
    host,
    status: "available" as const,
    executable: Object.freeze({
      sourcePath: executablePath,
      resolvedPath: executablePath,
      revision: `${BODY_CANARY}-${host}-executable`,
      chain: Object.freeze([
        Object.freeze({
          path: executablePath,
          kind: "binary" as const,
          owner: "current-user" as const,
          access: "not-broadly-writable" as const,
          binding: "canonical" as const,
          link: "direct" as const,
          revision: `${BODY_CANARY}-${host}-chain`,
        }),
      ]),
      launch: Object.freeze({
        executable: executablePath,
        argumentPrefix: Object.freeze([]),
        shell: false as const,
      }),
    }),
    version,
    state: Object.freeze({
      revision: `${BODY_CANARY}-${host}-state`,
      configuration,
    }),
    mutationSupport: FULL_SUPPORT,
  });
}

function directOnlyConfiguration(host: HostId): HostConfiguration {
  return Object.freeze({
    ...emptyConfiguration(),
    directMcp: Object.freeze({
      status: "present" as const,
      value: Object.freeze({ ...desired(host).mcp }),
    }),
  });
}

function duplicateConfiguration(host: HostId): HostConfiguration {
  return Object.freeze({
    ...healthyConfiguration(host),
    directMcp: Object.freeze({
      status: "present" as const,
      value: Object.freeze({ ...desired(host).mcp }),
    }),
  });
}

function mismatchedConfiguration(host: HostId): HostConfiguration {
  return Object.freeze({
    ...healthyConfiguration(host),
    pluginMcp: Object.freeze({
      status: "present" as const,
      value: Object.freeze({
        name: "plurum" as const,
        endpoint: "https://different.invalid/mcp",
      }),
    }),
  });
}

function ambiguousConfiguration(host: HostId): HostConfiguration {
  return Object.freeze({
    ...healthyConfiguration(host),
    pluginMcp: Object.freeze({ status: "ambiguous" as const }),
  });
}

function incompleteMarketplaceConfiguration(host: HostId): HostConfiguration {
  return Object.freeze({
    ...healthyConfiguration(host),
    marketplace: Object.freeze({ status: "absent" as const }),
  });
}

function wrongSourceDisabledConfiguration(host: HostId): HostConfiguration {
  const configuration = healthyConfiguration(host);
  return Object.freeze({
    ...configuration,
    plugin: Object.freeze({
      status: "present" as const,
      value: Object.freeze({
        ...(configuration.plugin.status === "present"
          ? configuration.plugin.value
          : desired(host).plugin),
        source: "untrusted@source",
        version: "0.1.0",
        enabled: false,
      }),
    }),
  });
}

function directDisabledConfiguration(host: HostId): HostConfiguration {
  const configuration = healthyConfiguration(host);
  return Object.freeze({
    ...configuration,
    plugin: Object.freeze({
      status: "present" as const,
      value: Object.freeze({
        ...(configuration.plugin.status === "present"
          ? configuration.plugin.value
          : desired(host).plugin),
        enabled: false,
      }),
    }),
    pluginMcp: Object.freeze({ status: "absent" as const }),
    directMcp: Object.freeze({
      status: "present" as const,
      value: Object.freeze({ ...desired(host).mcp }),
    }),
  });
}

function authorizationKey(request: ReadOnlyNetworkRequest): string {
  const authorization = request.headers.Authorization;
  return authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
}

function createHarness(options: HarnessOptions = {}): Harness {
  const base = doctorScope(
    createTestSystem(
      "standard",
      options.platformOs ?? "linux",
    ),
  );
  const canonical = options.canonical ?? createInMemoryCredentialStore({
    bytes: activeCredentialBytes(),
  });
  const networkAudit: NetworkAuditEntry[] = [];
  const hostCalls: HostId[] = [];
  let runtimeCallCount = 0;
  let codexCallCount = 0;

  const runtimeSupport: RuntimeSupportObservationAdapter = Object.freeze({
    async observe(): Promise<RuntimeSupportObservation> {
      runtimeCallCount += 1;
      const fixture = options.runtime ?? Object.freeze({
        status: "available" as const,
        runtime: "node" as const,
        version: "22.12.0",
        target: "linux-x64-gnu",
      });
      if (fixture instanceof Error) {
        throw fixture;
      }
      return fixture;
    },
  });

  const legacyStore: LegacyCredentialReadAdapter = Object.freeze({
    async read(source: LegacyCredentialSource) {
      const fixture = options.legacy?.[source];
      if (fixture instanceof Error) {
        throw fixture;
      }
      return fixture ?? Object.freeze({ status: "missing" as const });
    },
  });

  const network = Object.freeze({
    async request(request: ReadOnlyNetworkRequest): Promise<NetworkResponse> {
      networkAudit.push(Object.freeze({
        url: request.url,
        method: request.method,
        headerNames: Object.freeze(Object.keys(request.headers).sort()),
      }));

      if (request.url.endsWith("/api/v1/agents/me")) {
        if (options.agentFailure === "unavailable") {
          throw new Error(`${ERROR_CANARY}:${BODY_CANARY}:${PATH_CANARY}`);
        }
        if (options.agentFailure === "invalid") {
          return response(401, encodeText(`${BODY_CANARY}:${KEY_A}`));
        }
        const apiKey = authorizationKey(request);
        const agent = options.agents?.[apiKey] ??
          (apiKey === KEY_B
            ? Object.freeze({
                id: AGENT_B,
                name: "Second Doctor Agent",
                username: "second-doctor-agent",
              })
            : Object.freeze({
                id: AGENT_A,
                name: "Doctor Agent",
                username: "doctor-agent",
              }));
        return response(200, encodeJson({
          ...agent,
          is_active: true,
          ignored: `${BODY_CANARY}:${PATH_CANARY}`,
        }));
      }

      if (request.url.endsWith("/health")) {
        if (options.api === "unavailable") {
          throw new Error(`${ERROR_CANARY}:${BODY_CANARY}:${PATH_CANARY}`);
        }
        if (options.api === "unhealthy") {
          return response(503, encodeText(`${BODY_CANARY}:${KEY_A}`));
        }
        return response(200, encodeJson({ status: "healthy" }));
      }

      if (request.url === "https://mcp.plurum.ai/mcp") {
        if (options.mcp === "unavailable") {
          throw new Error(`${ERROR_CANARY}:${BODY_CANARY}:${PATH_CANARY}`);
        }
        if (options.mcp === "unhealthy") {
          return response(401, encodeText(`${BODY_CANARY}:${KEY_A}`), {
            "content-type": "application/json",
            "www-authenticate": "Bearer realm=wrong",
          });
        }
        return response(401, encodeText(`${BODY_CANARY}:${KEY_A}`), {
          "content-type": "application/json",
          "www-authenticate": 'Bearer realm="plurum"',
        });
      }

      throw new Error(`unexpected request:${ERROR_CANARY}`);
    },
  });

  const hostAdapter = (host: HostId) => Object.freeze({
    async inspect(): Promise<HostInspection> {
      hostCalls.push(host);
      const fixture = options.hosts?.[host] ??
        (host === "claude-code"
          ? availableHost(host)
          : Object.freeze({ host, status: "absent" as const }));
      if (fixture instanceof Error) {
        throw fixture;
      }
      return fixture;
    },
  });

  const codexProjection: CodexDotenvStatusObservationAdapter = Object.freeze({
    async observe() {
      codexCallCount += 1;
      if (options.codexProjection === "throw") {
        throw new Error(`${ERROR_CANARY}:${BODY_CANARY}:${PATH_CANARY}`);
      }
      return Object.freeze({ status: options.codexProjection ?? "exact" });
    },
  });

  const capabilities: DoctorCapabilities = Object.freeze({
    ...base,
    platform: Object.freeze({
      ...base.platform,
      arch: options.platformArch ?? "x64",
    }),
    credentialEnvironment: Object.freeze({
      read(): CredentialEnvironmentSnapshot {
        return options.environment ?? Object.freeze({});
      },
    }),
    network,
    hosts: Object.freeze({
      inspection: Object.freeze({
        "claude-code": hostAdapter("claude-code"),
        codex: hostAdapter("codex"),
      }),
    }),
  });

  return Object.freeze({
    capabilities,
    dependencies: Object.freeze({
      runtimeSupport,
      canonicalStore: canonical.adapter,
      legacyStore,
      codexProjection,
    }),
    canonical,
    runtimeCalls: () => runtimeCallCount,
    networkAudit,
    hostCalls,
    codexCalls: () => codexCallCount,
  });
}

async function observe(
  harness: Harness,
  client: "claude-code" | "codex" | "all" = "claude-code",
): Promise<DoctorReportV1> {
  return observeDoctor(
    Object.freeze({ client, json: false }),
    harness.capabilities,
    harness.dependencies,
  );
}

function findingFor(
  report: DoctorReportV1,
  check: DoctorCheckId,
  client: HostId | null = null,
): DoctorFinding {
  const matches = report.findings.filter(
    (entry) => entry.check === check && entry.client === client,
  );
  expect(matches).toHaveLength(1);
  const match = matches[0];
  if (match === undefined) {
    throw new Error("missing doctor finding");
  }
  return match;
}

function keyFragments(value: string, length = 10): readonly string[] {
  const fragments: string[] = [];
  for (let index = 0; index + length <= value.length; index += 1) {
    fragments.push(value.slice(index, index + length));
  }
  return Object.freeze(fragments);
}

function expectDeepPlainFrozen(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return;
  }
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.getPrototypeOf(value)).toBe(
    Array.isArray(value) ? Array.prototype : Object.prototype,
  );
  expect(Object.getOwnPropertySymbols(value)).toEqual([]);
  for (const key of Reflect.ownKeys(value)) {
    expect(typeof key).toBe("string");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    expect(descriptor).toBeDefined();
    expect(descriptor?.get).toBeUndefined();
    expect(descriptor?.set).toBeUndefined();
    expect(Object.hasOwn(descriptor ?? {}, "value")).toBe(true);
    expect(typeof descriptor?.value).not.toBe("function");
    if (!Array.isArray(value) || key !== "length") {
      expect(descriptor?.enumerable).toBe(true);
    }
    expectDeepPlainFrozen(descriptor?.value, seen);
  }
}

function expectNoPrivateMaterial(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const key of [KEY_A, KEY_B]) {
    for (const fragment of keyFragments(key)) {
      expect(serialized).not.toContain(fragment);
    }
  }
  for (const canary of [PATH_CANARY, BODY_CANARY, ERROR_CANARY]) {
    expect(serialized).not.toContain(canary);
  }
  expect(serialized).not.toContain("Authorization");
  expect(serialized).not.toMatch(/plrm_(?:live|test)_/iu);
}

describe("portable doctor observation", () => {
  it("produces one healthy diagnostic from exactly one status observation", async () => {
    const harness = createHarness();

    const report = await observe(harness);

    expect(report.overall).toBe("healthy");
    expect(report.runtimePlatform).toEqual({
      status: "supported",
      runtime: "node",
      version: "22.12.0",
      target: "linux-x64-gnu",
    });
    expect(report.status?.overall).toBe("healthy");
    expect(report.mcp).toEqual({
      reachability: "reachable",
      health: "healthy",
    });
    expect(findingFor(report, "runtime-platform")).toMatchObject({
      outcome: "pass",
      reason: "runtime-platform-supported",
    });
    expect(findingFor(report, "mcp-protocol")).toMatchObject({
      outcome: "not-checked",
      reason: "mcp-protocol-not-verified",
    });
    expect(harness.runtimeCalls()).toBe(1);
    expect(harness.hostCalls).toEqual(["claude-code"]);
    expect(harness.networkAudit.map(({ url }) => url)).toEqual([
      `${DEFAULT_API_ORIGIN}/api/v1/agents/me`,
      `${DEFAULT_API_ORIGIN}/health`,
      "https://mcp.plurum.ai/mcp",
    ]);
    expect(harness.networkAudit[0]?.headerNames).toContain("Authorization");
    expect(harness.networkAudit[1]?.headerNames).not.toContain("Authorization");
    expect(harness.networkAudit[2]?.headerNames).not.toContain("Authorization");
    expectDeepPlainFrozen(report);
    expectNoPrivateMaterial(report);
  });

  it.each([
    [
      "unsupported Node",
      Object.freeze({
        status: "available" as const,
        runtime: "node" as const,
        version: "20.0.0",
        target: "linux-x64-gnu",
      }),
      "runtime-version-unsupported",
    ],
    [
      "unreleased platform",
      Object.freeze({
        status: "available" as const,
        runtime: "node" as const,
        version: "22.12.0",
        target: "linux-x64-musl",
      }),
      "platform-target-unsupported",
    ],
    [
      "unavailable observation",
      Object.freeze({ status: "unavailable" as const }),
      "runtime-platform-observation-unavailable",
    ],
    [
      "mismatched supported target",
      Object.freeze({
        status: "available" as const,
        runtime: "node" as const,
        version: "22.12.0",
        target: "darwin-x64",
      }),
      "runtime-platform-observation-mismatched",
    ],
  ] as const)(
    "short-circuits status, credentials, hosts, and MCP for %s",
    async (_label, runtime, reason) => {
      const harness = createHarness({ runtime });

      const report = await observe(harness);

      expect(report.overall).toBe("attention-required");
      expect(report.status).toBeNull();
      expect(report.mcp).toBeNull();
      expect(findingFor(report, "runtime-platform").reason).toBe(reason);
      expect(findingFor(report, "status")).toMatchObject({
        outcome: "not-checked",
        reason: "status-not-checked",
      });
      expect(findingFor(report, "mcp-authentication-boundary")).toMatchObject({
        outcome: "not-checked",
        reason: "mcp-authentication-boundary-not-checked",
      });
      expect(harness.runtimeCalls()).toBe(1);
      expect(harness.canonical.trace.operations()).toEqual([]);
      expect(harness.networkAudit).toEqual([]);
      expect(harness.hostCalls).toEqual([]);
      expect(harness.codexCalls()).toBe(0);
      expectDeepPlainFrozen(report);
      expectNoPrivateMaterial(report);
    },
  );

  it.each([
    [
      "an unsupported Node version on its actual target",
      Object.freeze({
        status: "available" as const,
        runtime: "node" as const,
        version: "20.0.0",
        target: "linux-x64-gnu",
      }),
      "linux",
      "x64",
      "runtime-version-unsupported",
    ],
    [
      "an unsupported Node version claiming another OS",
      Object.freeze({
        status: "available" as const,
        runtime: "node" as const,
        version: "20.0.0",
        target: "darwin-x64",
      }),
      "linux",
      "x64",
      "runtime-platform-observation-mismatched",
    ],
    [
      "a recognized Linux musl target on Linux",
      Object.freeze({
        status: "available" as const,
        runtime: "node" as const,
        version: "22.12.0",
        target: "linux-arm64-musl",
      }),
      "linux",
      "arm64",
      "platform-target-unsupported",
    ],
    [
      "a recognized Linux musl target claiming another architecture",
      Object.freeze({
        status: "available" as const,
        runtime: "node" as const,
        version: "22.12.0",
        target: "linux-arm64-musl",
      }),
      "linux",
      "x64",
      "runtime-platform-observation-mismatched",
    ],
    [
      "a recognized unreleased Windows target on Windows",
      Object.freeze({
        status: "available" as const,
        runtime: "node" as const,
        version: "22.12.0",
        target: "win32-arm64-msvc",
      }),
      "win32",
      "arm64",
      "platform-target-unsupported",
    ],
    [
      "an unknown target",
      Object.freeze({
        status: "available" as const,
        runtime: "node" as const,
        version: "22.12.0",
        target: "future-x64-libc",
      }),
      "linux",
      "x64",
      "platform-target-unsupported",
    ],
    [
      "an unknown target on an unsupported Node version",
      Object.freeze({
        status: "available" as const,
        runtime: "node" as const,
        version: "20.0.0",
        target: "future-x64-libc",
      }),
      "linux",
      "x64",
      "runtime-version-unsupported",
    ],
  ] as const)(
    "normalizes %s before deciding why doctor short-circuits",
    async (_label, runtime, platformOs, platformArch, reason) => {
      const harness = createHarness({
        runtime,
        platformOs,
        platformArch,
      });

      const report = await observe(harness);

      expect(report.overall).toBe("attention-required");
      expect(report.status).toBeNull();
      expect(report.mcp).toBeNull();
      expect(findingFor(report, "runtime-platform").reason).toBe(reason);
      expect(harness.canonical.trace.operations()).toEqual([]);
      expect(harness.networkAudit).toEqual([]);
      expect(harness.hostCalls).toEqual([]);
      expect(harness.codexCalls()).toBe(0);
      expectDeepPlainFrozen(report);
      expectNoPrivateMaterial(report);
    },
  );

  it.each([
    ["darwin-arm64", "darwin", "arm64"],
    ["darwin-x64", "darwin", "x64"],
    ["linux-arm64-gnu", "linux", "arm64"],
    ["linux-x64-gnu", "linux", "x64"],
    ["win32-x64-msvc", "win32", "x64"],
  ] as const)(
    "accepts released target %s only with its matching platform evidence",
    async (target, platformOs, platformArch) => {
      const harness = createHarness({
        runtime: Object.freeze({
          status: "available" as const,
          runtime: "node" as const,
          version: "22.12.0",
          target,
        }),
        platformOs,
        platformArch,
      });

      const report = await observe(harness);

      expect(report.runtimePlatform).toEqual({
        status: "supported",
        runtime: "node",
        version: "22.12.0",
        target,
      });
      expect(report.status).not.toBeNull();
      expect(report.mcp).not.toBeNull();
      expect(findingFor(report, "runtime-platform")).toMatchObject({
        outcome: "pass",
        reason: "runtime-platform-supported",
      });
      expectNoPrivateMaterial(report);
    },
  );

  it("maps a throwing runtime observer to a private, short-circuited unknown", async () => {
    const harness = createHarness({
      runtime: new Error(`${ERROR_CANARY}:${KEY_A}:${PATH_CANARY}`),
    });

    const report = await observe(harness);

    expect(report.runtimePlatform).toEqual({
      status: "unavailable",
      reason: "observation-unavailable",
      runtime: null,
      version: null,
      target: null,
    });
    expect(report.status).toBeNull();
    expect(report.mcp).toBeNull();
    expectNoPrivateMaterial(report);
  });

  it.each([
    ["healthy", "pass", "mcp-authentication-boundary-healthy"],
    ["unhealthy", "attention", "mcp-authentication-boundary-unhealthy"],
    ["unavailable", "unknown", "mcp-authentication-boundary-unavailable"],
  ] as const)(
    "projects the MCP authentication boundary %s without a credential",
    async (mcp, outcome, reason) => {
      const harness = createHarness({ mcp });

      const report = await observe(harness);

      expect(findingFor(report, "mcp-authentication-boundary")).toMatchObject({
        outcome,
        reason,
      });
      expect(report.overall).toBe(
        mcp === "healthy" ? "healthy" : "attention-required",
      );
      const request = harness.networkAudit.find(
        ({ url }) => url === "https://mcp.plurum.ai/mcp",
      );
      expect(request?.headerNames).not.toContain("Authorization");
      expectNoPrivateMaterial(report);
    },
  );

  it.each([
    [
      "pending",
      createInMemoryCredentialStore({ bytes: pendingCredentialBytes() }),
      Object.freeze({}),
      Object.freeze({}),
      "credential-pending",
    ],
    [
      "unsafe",
      createInMemoryCredentialStore({
        bytes: activeCredentialBytes(),
        directoryAttestations: Object.freeze([
          secureDirectoryAttestation({ access: "broader" }),
        ]),
      }),
      Object.freeze({}),
      Object.freeze({}),
      "credential-unsafe",
    ],
    [
      "selection-required",
      createInMemoryCredentialStore({ directoryMissing: true }),
      Object.freeze({ PLURUM_API_KEY: KEY_A }),
      Object.freeze({ hermes: legacyHermes(KEY_B) }),
      "credential-selection-required",
    ],
    [
      "canonical mismatch",
      createInMemoryCredentialStore({ bytes: activeCredentialBytes() }),
      Object.freeze({}),
      Object.freeze({}),
      "credential-mismatched",
    ],
  ] as const)(
    "diagnoses %s credentials without exposing local evidence",
    async (label, canonical, environment, legacy, reason) => {
      const agents = label === "canonical mismatch"
        ? Object.freeze({
            [KEY_A]: Object.freeze({
              id: AGENT_B,
              name: "Different Doctor Agent",
              username: "different-doctor-agent",
            }),
          })
        : undefined;
      const harness = createHarness({
        canonical,
        environment,
        legacy,
        ...(agents === undefined ? {} : { agents }),
      });

      const report = await observe(harness);

      expect(findingFor(report, "credential").reason).toBe(reason);
      expect(report.overall).toBe("attention-required");
      if (label === "unsafe") {
        expect(harness.canonical.trace.operations()).not.toContain(
          "open-credential",
        );
        expect(harness.canonical.trace.operations()).not.toContain(
          "read-file",
        );
      }
      expectDeepPlainFrozen(report);
      expectNoPrivateMaterial(report);
    },
  );

  it("distinguishes a safe environment credential from a canonical credential", async () => {
    const harness = createHarness({
      canonical: createInMemoryCredentialStore({ directoryMissing: true }),
      environment: Object.freeze({ PLURUM_API_KEY: KEY_A }),
    });

    const report = await observe(harness);

    expect(findingFor(report, "credential")).toMatchObject({
      outcome: "attention",
      reason: "canonical-credential-missing",
      guidance: ["run-setup"],
    });
    expectNoPrivateMaterial(report);
  });

  it.each([
    ["direct", directOnlyConfiguration("claude-code"), "direct-registration-only"],
    ["duplicate", duplicateConfiguration("claude-code"), "duplicate-local-registration"],
    ["ambiguous", ambiguousConfiguration("claude-code"), "ambiguous-local-registration"],
    ["mismatched", mismatchedConfiguration("claude-code"), "mismatched-local-registration"],
  ] as const)(
    "diagnoses %s local host registration without claiming a remote duplicate",
    async (_label, configuration, reason) => {
      const harness = createHarness({
        hosts: Object.freeze({
          "claude-code": availableHost("claude-code", configuration),
        }),
      });

      const report = await observe(harness);

      expect(findingFor(report, "local-registration", "claude-code")).toMatchObject({
        outcome: "attention",
        reason,
      });
      if (reason === "ambiguous-local-registration") {
        expect(findingFor(report, "plugin-configuration", "claude-code")).toMatchObject({
          outcome: "unknown",
          reason: "plugin-configuration-unknown",
        });
      }
      expect(report.findings.every((entry) =>
        !entry.reason.includes("remote") && !entry.reason.includes("latest")
      )).toBe(true);
      expectNoPrivateMaterial(report);
    },
  );

  it("diagnoses an outdated installed plugin relative to the CLI target", async () => {
    const configuration = healthyConfiguration("claude-code");
    const outdated = Object.freeze({
      ...configuration,
      plugin: Object.freeze({
        status: "present" as const,
        value: Object.freeze({
          ...(configuration.plugin.status === "present"
            ? configuration.plugin.value
            : desired("claude-code").plugin),
          version: "0.1.0",
          enabled: true,
        }),
      }),
    });
    const harness = createHarness({
      hosts: Object.freeze({
        "claude-code": availableHost("claude-code", outdated),
      }),
    });

    const report = await observe(harness);

    expect(findingFor(report, "plugin-configuration", "claude-code")).toEqual({
      check: "plugin-configuration",
      outcome: "attention",
      reason: "plugin-outdated",
      client: "claude-code",
      guidance: ["update-plugin-manually"],
    });
  });

  it("does not recommend enabling or updating a wrong-source plugin", async () => {
    const harness = createHarness({
      hosts: Object.freeze({
        "claude-code": availableHost(
          "claude-code",
          wrongSourceDisabledConfiguration("claude-code"),
        ),
      }),
    });

    const report = await observe(harness);
    const plugin = findingFor(
      report,
      "plugin-configuration",
      "claude-code",
    );

    expect(plugin).toMatchObject({
      outcome: "attention",
      reason: "plugin-configuration-mismatched",
      guidance: ["review-plugin-configuration"],
    });
    expect(plugin.guidance).not.toContain("enable-plugin");
    expect(plugin.guidance).not.toContain("update-plugin-manually");
    expectNoPrivateMaterial(report);
  });

  it("does not recommend enabling a plugin while direct MCP needs review", async () => {
    const harness = createHarness({
      hosts: Object.freeze({
        "claude-code": availableHost(
          "claude-code",
          directDisabledConfiguration("claude-code"),
        ),
      }),
    });

    const report = await observe(harness);
    const plugin = findingFor(
      report,
      "plugin-configuration",
      "claude-code",
    );

    expect(plugin).toMatchObject({
      outcome: "attention",
      reason: "plugin-configuration-incomplete",
      guidance: ["review-plugin-configuration"],
    });
    expect(plugin.guidance).not.toContain("enable-plugin");
    expect(
      findingFor(report, "local-registration", "claude-code"),
    ).toMatchObject({
      reason: "direct-registration-only",
      guidance: ["review-direct-registration"],
    });
    expectNoPrivateMaterial(report);
  });

  it.each([
    ["exact", "pass", "credential-projection-exact"],
    ["absent", "attention", "credential-projection-absent"],
    ["mismatched", "attention", "credential-projection-mismatched"],
    ["ambiguous", "attention", "credential-projection-ambiguous"],
    ["unsafe", "attention", "credential-projection-unsafe"],
    ["credential-unavailable", "unknown", "credential-projection-unavailable"],
  ] as const)(
    "projects Codex credential state %s without returning a key-derived value",
    async (codexProjection, outcome, reason) => {
      const harness = createHarness({
        hosts: Object.freeze({ codex: availableHost("codex") }),
        codexProjection,
      });

      const report = await observe(harness, "codex");

      expect(harness.codexCalls()).toBe(1);
      expect(findingFor(report, "credential-projection", "codex")).toMatchObject({
        outcome,
        reason,
      });
      if (codexProjection === "ambiguous" || codexProjection === "unsafe") {
        expect(findingFor(report, "host", "codex")).toMatchObject({
          outcome: "pass",
          reason: "host-supported",
        });
        expect(findingFor(report, "plugin-configuration", "codex")).toMatchObject({
          outcome: "pass",
          reason: "plugin-configuration-healthy",
        });
      }
      expect(report.overall).toBe(
        codexProjection === "exact" ? "healthy" : "attention-required",
      );
      expectNoPrivateMaterial(report);
    },
  );

  it("preserves a pre-existing plugin defect alongside a projection defect", async () => {
    const harness = createHarness({
      hosts: Object.freeze({
        codex: availableHost(
          "codex",
          incompleteMarketplaceConfiguration("codex"),
        ),
      }),
      codexProjection: "unsafe",
    });

    const report = await observe(harness, "codex");

    expect(report.status?.clients[0]).toMatchObject({
      status: "incomplete",
      reason: "configuration-incomplete",
      credentialProjection: "unsafe",
    });
    expect(findingFor(report, "plugin-configuration", "codex")).toMatchObject({
      outcome: "attention",
      reason: "plugin-configuration-incomplete",
      guidance: ["review-plugin-configuration"],
    });
    expect(findingFor(report, "credential-projection", "codex")).toMatchObject({
      outcome: "attention",
      reason: "credential-projection-unsafe",
    });
    expect(report.overall).toBe("attention-required");
    expectNoPrivateMaterial(report);
  });

  it("keeps findings enum-only and the complete DTO deeply frozen", async () => {
    const harness = createHarness({
      agents: Object.freeze({
        [KEY_A]: Object.freeze({
          id: AGENT_A,
          name: PATH_CANARY,
          username: "doctor-agent",
        }),
      }),
      hosts: Object.freeze({
        "claude-code": new Error(`${ERROR_CANARY}:${KEY_A}:${PATH_CANARY}`),
        codex: availableHost("codex"),
      }),
    });

    const report = await observe(harness, "all");

    expect(report.status?.agent.displayName).toBeNull();
    expect(Object.isFrozen(DOCTOR_CHECK_IDS)).toBe(true);
    expect(Object.isFrozen(DOCTOR_FINDING_OUTCOMES)).toBe(true);
    expect(Object.isFrozen(DOCTOR_FINDING_REASONS)).toBe(true);
    expect(Object.isFrozen(DOCTOR_GUIDANCE_CODES)).toBe(true);
    for (const entry of report.findings) {
      expect(Reflect.ownKeys(entry)).toEqual([
        "check",
        "outcome",
        "reason",
        "client",
        "guidance",
      ]);
      expect(DOCTOR_CHECK_IDS).toContain(entry.check);
      expect(DOCTOR_FINDING_OUTCOMES).toContain(entry.outcome);
      expect(DOCTOR_FINDING_REASONS).toContain(entry.reason);
      expect(entry.guidance.every((code) =>
        DOCTOR_GUIDANCE_CODES.includes(code)
      )).toBe(true);
    }
    expectDeepPlainFrozen(report);
    expectNoPrivateMaterial(report);
  });
});
