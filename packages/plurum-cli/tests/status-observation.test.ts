import { describe, expect, it } from "vitest";

import { statusScope } from "../src/system/scopes.js";
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
import {
  DEFAULT_API_ORIGIN,
} from "../src/credentials/origin.js";
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
import type {
  CredentialEnvironmentSnapshot,
  NetworkResponse,
  ReadOnlyNetworkRequest,
  StatusCapabilities,
} from "../src/system/contracts.js";
import {
  observeStatus,
  type StatusObservationDependencies,
} from "../src/commands/status-observation.js";
import type {
  StatusCredentialState,
  StatusReportV1,
} from "../src/commands/status-contracts.js";
import type { ClientTarget } from "../src/commands/types.js";
import {
  createInMemoryCredentialStore,
  type InMemoryCredentialStore,
} from "./support/in-memory-credential-store.js";
import { createTestSystem } from "./support/system.js";

const KEY_A = "plrm_live_STATUS_OBSERVATION_AAAAAAAAAAAAAAAA";
const KEY_B = "plrm_live_STATUS_OBSERVATION_BBBBBBBBBBBBBBBB";
const PREFIXED_ORIGIN_KEY = "plrm_live_statusoriginabcdefghij";
const AGENT_A = "00000000-0000-4000-8000-000000000001";
const AGENT_B = "00000000-0000-4000-8000-000000000002";
const REQUEST_ID = "ca908d9f-d901-4dac-b396-7f84377adfc8";
const CREATED_AT = "2026-07-20T12:00:00.000Z";
const ACTIVATED_AT = "2026-07-20T12:01:00.000Z";
const PERSONAL_PATH = "/Users/private-owner/PRIVATE_STATUS_PATH_CANARY";
const BODY_CANARY = "PRIVATE_STATUS_BODY_CANARY";
const ERROR_CANARY = "PRIVATE_STATUS_ERROR_CANARY";

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

type ApiHealthFixture = "healthy" | "unhealthy" | "unavailable";

interface AgentFixture {
  readonly id: string;
  readonly name: string;
  readonly username: string;
}

type LegacyFixture = LegacyCredentialAdapterReadResult | Error;

interface ObservationHarnessOptions {
  readonly environment?: CredentialEnvironmentSnapshot;
  readonly canonical?: InMemoryCredentialStore;
  readonly legacy?: Partial<Record<LegacyCredentialSource, LegacyFixture>>;
  readonly agents?: Readonly<Record<string, AgentFixture>>;
  readonly agentFailure?: "invalid" | "unavailable";
  readonly apiHealth?: ApiHealthFixture;
  readonly hosts?: Partial<Record<HostId, HostInspection | Error>>;
  readonly codexStatus?: CodexDotenvProjectionStatus | "throw";
}

interface ObservationHarness {
  readonly capabilities: StatusCapabilities;
  readonly dependencies: StatusObservationDependencies;
  readonly networkAudit: readonly Readonly<{
    url: string;
    method: string;
    headerNames: readonly string[];
  }>[];
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

function missingCanonical(): InMemoryCredentialStore {
  return createInMemoryCredentialStore({ directoryMissing: true });
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
        agent_name: "Stored Status Agent",
        username: "status-agent",
        registration_request_id: REQUEST_ID,
        created_at: CREATED_AT,
        updated_at: ACTIVATED_AT,
        activated_at: ACTIVATED_AT,
      }),
    ),
  );
}

function pendingCredentialBytes(apiKey: string = KEY_A): Uint8Array {
  return encodeText(
    serializeCredentialDocument(
      validateCredentialDocument({
        schema_version: 1,
        state: "pending",
        api_origin: DEFAULT_API_ORIGIN,
        api_key: apiKey,
        agent_id: null,
        agent_name: "Pending Status Agent",
        username: "pending-status-agent",
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
      ignored: BODY_CANARY,
    }),
  });
}

function desired(host: HostId): DesiredHostConfiguration {
  return host === "claude-code"
    ? CLAUDE_CODE_DESIRED_CONFIGURATION
    : CODEX_DESIRED_CONFIGURATION;
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

function healthyHost(host: HostId): HostInspection {
  const executable = host === "claude-code" ? "claude" : "codex";
  const sourcePath = `${PERSONAL_PATH}/${executable}`;
  return Object.freeze({
    host,
    status: "available" as const,
    executable: Object.freeze({
      sourcePath,
      resolvedPath: sourcePath,
      revision: `${BODY_CANARY}-${host}-executable`,
      chain: Object.freeze([
        Object.freeze({
          path: sourcePath,
          kind: "binary" as const,
          owner: "current-user" as const,
          access: "not-broadly-writable" as const,
          binding: "canonical" as const,
          link: "direct" as const,
          revision: `${BODY_CANARY}-${host}-chain`,
        }),
      ]),
      launch: Object.freeze({
        executable: sourcePath,
        argumentPrefix: Object.freeze([]),
        shell: false as const,
      }),
    }),
    version: host === "claude-code" ? "2.1.212" : "0.144.5",
    state: Object.freeze({
      revision: `${BODY_CANARY}-${host}-state`,
      configuration: healthyConfiguration(host),
    }),
    mutationSupport: FULL_SUPPORT,
  });
}

function authorizationKey(request: ReadOnlyNetworkRequest): string {
  const authorization = request.headers.Authorization;
  return authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
}

function createHarness(
  options: ObservationHarnessOptions = {},
): ObservationHarness {
  const base = statusScope(createTestSystem());
  const canonical = options.canonical ?? missingCanonical();
  const networkAudit: Array<Readonly<{
    url: string;
    method: string;
    headerNames: readonly string[];
  }>> = [];
  const hostCalls: HostId[] = [];
  let codexCallCount = 0;

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

      if (request.url.endsWith("/health")) {
        if (options.apiHealth === "unavailable") {
          throw new Error(`${ERROR_CANARY}:${BODY_CANARY}:${PERSONAL_PATH}`);
        }
        if (options.apiHealth === "unhealthy") {
          return response(503, encodeText(`${BODY_CANARY}:${KEY_A}`));
        }
        return response(200, encodeJson({ status: "healthy" }));
      }

      if (!request.url.endsWith("/api/v1/agents/me")) {
        throw new Error("unexpected test request");
      }
      if (options.agentFailure === "unavailable") {
        throw new Error(`${ERROR_CANARY}:${BODY_CANARY}:${PERSONAL_PATH}`);
      }
      if (options.agentFailure === "invalid") {
        return response(401, encodeText(`${BODY_CANARY}:${KEY_A}`));
      }

      const apiKey = authorizationKey(request);
      const agent = options.agents?.[apiKey] ??
        (apiKey === KEY_B
          ? {
              id: AGENT_B,
              name: "Second Status Agent",
              username: "second-status-agent",
            }
          : {
              id: AGENT_A,
              name: "Stored Status Agent",
              username: "status-agent",
            });
      return response(
        200,
        encodeJson({
          ...agent,
          is_active: true,
          ignored_server_field: BODY_CANARY,
        }),
      );
    },
  });

  const hostAdapter = (host: HostId) => Object.freeze({
    async inspect(): Promise<HostInspection> {
      hostCalls.push(host);
      const fixture = options.hosts?.[host] ??
        Object.freeze({ host, status: "absent" as const });
      if (fixture instanceof Error) {
        throw fixture;
      }
      return fixture;
    },
  });

  const codexProjection: CodexDotenvStatusObservationAdapter = Object.freeze({
    async observe() {
      codexCallCount += 1;
      if (options.codexStatus === "throw") {
        throw new Error(`${ERROR_CANARY}:${BODY_CANARY}:${PERSONAL_PATH}`);
      }
      return Object.freeze({ status: options.codexStatus ?? "exact" });
    },
  });

  const capabilities: StatusCapabilities = Object.freeze({
    ...base,
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
      canonicalStore: canonical.adapter,
      legacyStore,
      codexProjection,
    }),
    networkAudit,
    hostCalls,
    codexCalls: () => codexCallCount,
  });
}

async function observe(
  harness: ObservationHarness,
  client: ClientTarget = "claude-code",
): Promise<StatusReportV1> {
  return observeStatus(
    Object.freeze({ client, json: false }),
    harness.capabilities,
    harness.dependencies,
  );
}

function keyFragments(value: string, length = 10): readonly string[] {
  const fragments: string[] = [];
  for (let index = 0; index + length <= value.length; index += 1) {
    fragments.push(value.slice(index, index + length));
  }
  return Object.freeze(fragments);
}

const FORBIDDEN_DTO_FIELDS = new Set([
  "apikey",
  "identity",
  "path",
  "revision",
  "body",
  "header",
  "headers",
  "stdout",
  "stderr",
  "output",
  "executable",
]);

function expectNoPrivateString(value: string): void {
  expect(value).not.toMatch(/plrm_(?:live|test)_[A-Za-z0-9_-]{10,200}/iu);
  for (const key of [KEY_A, KEY_B, PREFIXED_ORIGIN_KEY]) {
    for (const candidate of [key, key.toLowerCase()]) {
      for (const fragment of keyFragments(candidate)) {
        expect(value).not.toContain(fragment);
      }
    }
  }
  for (const canary of [
    PERSONAL_PATH,
    "PRIVATE_STATUS_PATH_CANARY",
    BODY_CANARY,
    ERROR_CANARY,
  ]) {
    expect(value).not.toContain(canary);
  }
}

function expectDeepPlainFrozenPublicDto(
  value: unknown,
  seen = new WeakSet<object>(),
): void {
  if (typeof value === "string") {
    expectNoPrivateString(value);
    return;
  }
  if (typeof value === "symbol") {
    expectNoPrivateString(value.description ?? "");
    expect(typeof value).not.toBe("symbol");
    return;
  }
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return;
  }
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.getPrototypeOf(value)).toBe(
    Array.isArray(value) ? Array.prototype : Object.prototype,
  );
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    expect(descriptor).toBeDefined();
    if (descriptor === undefined) {
      continue;
    }
    expect(descriptor?.get).toBeUndefined();
    expect(descriptor?.set).toBeUndefined();
    expect(Object.hasOwn(descriptor ?? {}, "value")).toBe(true);
    expect(typeof descriptor?.value).not.toBe("function");
    expectDeepPlainFrozenPublicDto(descriptor?.value, seen);

    const name = typeof key === "string" ? key : key.description ?? "";
    expectNoPrivateString(name);
    expect(typeof key).toBe("string");
    if (typeof key !== "string") {
      continue;
    }
    if (!Array.isArray(value) || key !== "length") {
      const normalized = key.replace(/[_-]/gu, "").toLowerCase();
      expect(FORBIDDEN_DTO_FIELDS.has(normalized)).toBe(false);
      expect(descriptor.enumerable).toBe(true);
    } else {
      expect(descriptor.enumerable).toBe(false);
    }
  }
  expect(Object.getOwnPropertySymbols(value)).toEqual([]);
}

function expectNoPrivateCanaries(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const key of [KEY_A, KEY_B, PREFIXED_ORIGIN_KEY]) {
    for (const fragment of keyFragments(key)) {
      expect(serialized).not.toContain(fragment);
    }
  }
  for (const canary of [PERSONAL_PATH, "PRIVATE_STATUS_PATH_CANARY", BODY_CANARY, ERROR_CANARY]) {
    expect(serialized).not.toContain(canary);
  }
}

describe("portable status observation", () => {
  it("maps a missing credential without inventing agent state", async () => {
    const report = await observe(createHarness());

    expect(report.credential).toEqual({
      state: "missing",
      sources: [],
      permissions: "not-applicable",
      fingerprint: null,
      candidateCount: 0,
    });
    expect(report.agent).toEqual({
      verification: "not-configured",
      id: null,
      displayName: null,
      username: null,
      active: null,
    });
  });

  it("maps conclusively rejected environment credentials to invalid", async () => {
    const report = await observe(createHarness({
      environment: Object.freeze({ PLURUM_API_KEY: KEY_A }),
      agentFailure: "invalid",
    }));

    expect(report.credential).toMatchObject({
      state: "invalid",
      sources: ["environment"],
      permissions: "not-applicable",
      candidateCount: 0,
    });
    expect(report.agent.verification).toBe("invalid-credential");
  });

  it("maps a pending canonical credential to pending", async () => {
    const report = await observe(createHarness({
      canonical: createInMemoryCredentialStore({
        bytes: pendingCredentialBytes(),
      }),
      agents: Object.freeze({
        [KEY_A]: Object.freeze({
          id: AGENT_A,
          name: "Pending Status Agent",
          username: "pending-status-agent",
        }),
      }),
    }));

    expect(report.credential).toMatchObject({
      state: "pending",
      sources: ["canonical"],
      permissions: "verified-user-only",
      candidateCount: 1,
    });
    expect(report.agent.verification).toBe("pending");
  });

  it("maps multiple live identities to selection-required in source order", async () => {
    const report = await observe(createHarness({
      environment: Object.freeze({ PLURUM_API_KEY: KEY_A }),
      legacy: Object.freeze({ hermes: legacyHermes(KEY_B) }),
    }));

    expect(report.credential).toEqual({
      state: "selection-required",
      sources: ["environment", "hermes"],
      permissions: "verified-user-only",
      fingerprint: null,
      candidateCount: 2,
    });
    expect(report.agent.verification).toBe("selection-required");
  });

  it("maps a canonical live-identity mismatch without exposing either identity", async () => {
    const report = await observe(createHarness({
      canonical: createInMemoryCredentialStore({
        bytes: activeCredentialBytes(),
      }),
      agents: Object.freeze({
        [KEY_A]: Object.freeze({
          id: AGENT_B,
          name: "Different Status Agent",
          username: "different-status-agent",
        }),
      }),
    }));

    expect(report.credential).toMatchObject({
      state: "mismatched",
      sources: ["canonical"],
      permissions: "unknown",
      candidateCount: 0,
    });
    expect(report.agent.verification).toBe("mismatched");
    expect(Reflect.ownKeys(report)).not.toContain("identity");
  });

  it("maps unsafe legacy evidence ahead of otherwise absent state", async () => {
    const report = await observe(createHarness({
      legacy: Object.freeze({
        hermes: Object.freeze({ status: "unsafe" as const }),
      }),
    }));

    expect(report.credential).toEqual({
      state: "unsafe",
      sources: ["hermes"],
      permissions: "unsafe",
      fingerprint: null,
      candidateCount: 0,
    });
    expect(report.agent.verification).toBe("unavailable");
  });

  it("maps indeterminate credential validation to unavailable", async () => {
    const report = await observe(createHarness({
      environment: Object.freeze({ PLURUM_API_KEY: KEY_A }),
      agentFailure: "unavailable",
    }));

    expect(report.credential).toMatchObject({
      state: "unavailable",
      sources: ["environment"],
      permissions: "unknown",
      candidateCount: 0,
    });
    expect(report.agent.verification).toBe("unavailable");
  });

  it("maps one validated canonical credential to ready and verified", async () => {
    const report = await observe(createHarness({
      canonical: createInMemoryCredentialStore({
        bytes: activeCredentialBytes(),
      }),
    }));

    expect(report.credential).toMatchObject({
      state: "ready",
      sources: ["canonical"],
      permissions: "verified-user-only",
      candidateCount: 1,
    });
    expect(report.credential.fingerprint).toMatch(
      /^plurum-fp-v1:[0-9a-f]{12}$/u,
    );
    expect(report.agent).toEqual({
      verification: "verified",
      id: AGENT_A,
      displayName: "Stored Status Agent",
      username: "status-agent",
      active: true,
    });
  });

  it.each([
    ["healthy", "reachable", "healthy"],
    ["unhealthy", "reachable", "unhealthy"],
    ["unavailable", "unavailable", "unknown"],
  ] as const)(
    "projects an API %s probe semantically",
    async (fixture, reachability, health) => {
      const report = await observe(createHarness({
        canonical: createInMemoryCredentialStore({
          bytes: activeCredentialBytes(),
        }),
        apiHealth: fixture,
      }));

      expect(report.api).toEqual({
        origin: DEFAULT_API_ORIGIN,
        reachability,
        health,
      });
      expectNoPrivateCanaries(report);
    },
  );

  it("rejects prefixed key material in a configured origin before networking", async () => {
    const harness = createHarness({
      environment: Object.freeze({
        PLURUM_API_KEY: PREFIXED_ORIGIN_KEY,
        PLURUM_API_URL: `https://x${PREFIXED_ORIGIN_KEY}`,
      }),
    });

    const report = await observe(harness);

    expect(report.api).toEqual({
      origin: null,
      reachability: "unknown",
      health: "unknown",
    });
    expect(harness.networkAudit).toEqual([]);
    expectDeepPlainFrozenPublicDto(report);
    expectNoPrivateCanaries(report);
  });

  it("filters one requested host and preserves canonical all-host order", async () => {
    const single = createHarness();
    const singleReport = await observe(single, "codex");
    expect(singleReport.requestedClient).toBe("codex");
    expect(singleReport.selectedClients).toEqual(["codex"]);
    expect(singleReport.clients.map(({ client }) => client)).toEqual(["codex"]);
    expect(single.hostCalls).toEqual(["codex"]);

    const all = createHarness();
    const allReport = await observe(all, "all");
    expect(allReport.selectedClients).toEqual(["claude-code", "codex"]);
    expect(allReport.clients.map(({ client }) => client)).toEqual([
      "claude-code",
      "codex",
    ]);
    expect(all.hostCalls).toEqual(["claude-code", "codex"]);
  });

  it("contains one throwing host and continues inspecting the other host", async () => {
    const harness = createHarness({
      hosts: Object.freeze({
        "claude-code": new Error(`${ERROR_CANARY}:${PERSONAL_PATH}`),
        codex: healthyHost("codex"),
      }),
    });

    const report = await observe(harness, "all");

    expect(harness.hostCalls).toEqual(["claude-code", "codex"]);
    expect(report.clients[0]).toMatchObject({
      client: "claude-code",
      status: "unknown",
      reason: "inspection-unavailable",
    });
    expect(report.clients[1]).toMatchObject({
      client: "codex",
      status: "incomplete",
      reason: "configuration-incomplete",
      credentialProjection: "unavailable",
    });
    expectNoPrivateCanaries(report);
  });

  it.each([
    ["exact", "exact", "healthy", "configuration-healthy"],
    ["absent", "absent", "incomplete", "configuration-incomplete"],
    ["mismatched", "mismatched", "mismatched", "configuration-mismatched"],
    ["ambiguous", "ambiguous", "duplicated", "ambiguous-configuration"],
    ["unsafe", "unsafe", "unknown", "inspection-unavailable"],
    ["credential-unavailable", "unavailable", "incomplete", "configuration-incomplete"],
  ] as const)(
    "maps Codex projection %s to public projection %s and host status %s",
    async (fixture, projection, status, reason) => {
      const harness = createHarness({
        canonical: createInMemoryCredentialStore({
          bytes: activeCredentialBytes(),
        }),
        hosts: Object.freeze({ codex: healthyHost("codex") }),
        codexStatus: fixture,
      });

      const report = await observe(harness, "codex");

      expect(harness.codexCalls()).toBe(1);
      expect(report.clients[0]).toMatchObject({
        client: "codex",
        status,
        reason,
        credentialProjection: projection,
      });
      expect(report.overall).toBe(
        fixture === "exact" ? "healthy" : "attention-required",
      );
      expectNoPrivateCanaries(report);
    },
  );

  it("maps a throwing Codex projection port to unavailable without details", async () => {
    const harness = createHarness({
      canonical: createInMemoryCredentialStore({
        bytes: activeCredentialBytes(),
      }),
      hosts: Object.freeze({ codex: healthyHost("codex") }),
      codexStatus: "throw",
    });

    const report = await observe(harness, "codex");

    expect(report.clients[0]).toMatchObject({
      status: "incomplete",
      reason: "configuration-incomplete",
      credentialProjection: "unavailable",
    });
    expectNoPrivateCanaries(report);
  });

  it("requires a ready canonical credential for an overall healthy result", async () => {
    const environmentOnly = await observe(createHarness({
      environment: Object.freeze({ PLURUM_API_KEY: KEY_A }),
      hosts: Object.freeze({ "claude-code": healthyHost("claude-code") }),
    }));
    expect(environmentOnly.credential).toMatchObject({
      state: "ready",
      sources: ["environment"],
    });
    expect(environmentOnly.clients[0]?.status).toBe("healthy");
    expect(environmentOnly.overall).toBe("attention-required");

    const canonical = await observe(createHarness({
      canonical: createInMemoryCredentialStore({
        bytes: activeCredentialBytes(),
      }),
      hosts: Object.freeze({ "claude-code": healthyHost("claude-code") }),
    }));
    expect(canonical.overall).toBe("healthy");
  });

  it("redacts a path-like live agent label and never exports private host evidence", async () => {
    const harness = createHarness({
      canonical: createInMemoryCredentialStore({
        bytes: activeCredentialBytes(),
      }),
      agents: Object.freeze({
        [KEY_A]: Object.freeze({
          id: AGENT_A,
          name: PERSONAL_PATH,
          username: "status-agent",
        }),
      }),
      hosts: Object.freeze({
        "claude-code": healthyHost("claude-code"),
        codex: healthyHost("codex"),
      }),
    });

    const report = await observe(harness, "all");

    expect(report.agent).toMatchObject({
      verification: "verified",
      displayName: null,
    });
    expectDeepPlainFrozenPublicDto(report);
    expectNoPrivateCanaries(report);
  });

  it("fails closed when a live agent label reflects the key", async () => {
    const report = await observe(createHarness({
      canonical: createInMemoryCredentialStore({
        bytes: activeCredentialBytes(),
      }),
      agents: Object.freeze({
        [KEY_A]: Object.freeze({
          id: AGENT_A,
          name: KEY_A,
          username: "status-agent",
        }),
      }),
    }));

    expect(report.credential.state).toBe("unavailable");
    expect(report.agent).toEqual({
      verification: "unavailable",
      id: null,
      displayName: null,
      username: null,
      active: null,
    });
    expectNoPrivateCanaries(report);
  });

  it("returns a deeply frozen plain DTO with no hidden secret-bearing fields", async () => {
    const harness = createHarness({
      canonical: createInMemoryCredentialStore({
        bytes: activeCredentialBytes(),
      }),
      hosts: Object.freeze({
        "claude-code": healthyHost("claude-code"),
        codex: healthyHost("codex"),
      }),
    });

    const report = await observe(harness, "all");

    expect(report.schemaVersion).toBe(1);
    expectDeepPlainFrozenPublicDto(report);
    expectNoPrivateCanaries(report);
    expect(harness.networkAudit.map(({ url }) => url)).toEqual([
      `${DEFAULT_API_ORIGIN}/api/v1/agents/me`,
      `${DEFAULT_API_ORIGIN}/health`,
    ]);
    expect(harness.networkAudit[0]?.headerNames).toContain("Authorization");
    expect(JSON.stringify(harness.networkAudit)).not.toContain(KEY_A);
  });
});
