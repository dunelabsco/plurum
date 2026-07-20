import { describe, expect, it } from "vitest";

import { nodeHash } from "../src/adapters/node/hash.js";
import { createPlatformPathAdapter } from "../src/adapters/node/platform.js";
import {
  discoverCredentials,
  type CredentialDiscoveryDependencies,
  type CredentialDiscoveryResult,
  type CredentialDiscoverySource,
} from "../src/credentials/discovery.js";
import {
  MAX_LEGACY_CREDENTIAL_BYTES,
  type LegacyCredentialAdapterReadResult,
  type LegacyCredentialReadAdapter,
  type LegacyCredentialReadOptions,
  type LegacyCredentialSource,
} from "../src/credentials/legacy-reader-contracts.js";
import {
  DEFAULT_API_ORIGIN,
} from "../src/credentials/origin.js";
import {
  serializeCredentialDocument,
  validateCredentialDocument,
} from "../src/credentials/schema.js";
import type {
  CredentialEnvironmentSnapshot,
  HashAdapter,
  NetworkResponse,
  PlatformAdapter,
  ReadOnlyNetworkAdapter,
  ReadOnlyNetworkRequest,
} from "../src/system/contracts.js";
import {
  createInMemoryCredentialStore,
  type InMemoryCredentialStore,
} from "./support/in-memory-credential-store.js";

const KEY_A = "plrm_live_discovery_key_AAAAAAAAAAAA";
const KEY_B = "plrm_live_discovery_key_BBBBBBBBBBBB";
const KEY_C = "plrm_live_discovery_key_CCCCCCCCCCCC";
const KEY_D = "plrm_live_discovery_key_DDDDDDDDDDDD";
const AGENT_A = "00000000-0000-4000-8000-000000000001";
const AGENT_B = "00000000-0000-4000-8000-000000000002";
const AGENT_C = "00000000-0000-4000-8000-000000000003";
const AGENT_D = "00000000-0000-4000-8000-000000000004";
const REQUEST_ID = "ca908d9f-d901-4dac-b396-7f84377adfc8";
const CREATED_AT = "2026-07-20T12:00:00.000Z";
const ACTIVATED_AT = "2026-07-20T12:01:00.000Z";
const SERVER_CANARY = "plrm_live_SERVER_BODY_CANARY_123456";
const PATH_CANARY = "PRIVATE_PATH_CANARY";
const ERROR_CANARY = "plrm_live_ADAPTER_ERROR_CANARY_12345";

interface LegacyReadCall {
  readonly source: LegacyCredentialSource;
  readonly path: string;
  readonly options: LegacyCredentialReadOptions;
}

type LegacyFixture =
  | LegacyCredentialAdapterReadResult
  | Error
  | (() => LegacyCredentialAdapterReadResult | Promise<LegacyCredentialAdapterReadResult>);

interface DiscoveryHarness {
  readonly dependencies: CredentialDiscoveryDependencies;
  readonly canonical: InMemoryCredentialStore;
  readonly environmentReads: () => number;
  readonly legacyCalls: readonly LegacyReadCall[];
  readonly networkRequests: readonly ReadOnlyNetworkRequest[];
  readonly hashCalls: () => number;
}

interface HarnessOptions {
  readonly environment?: CredentialEnvironmentSnapshot;
  readonly canonical?: InMemoryCredentialStore;
  readonly legacy?: Partial<Record<LegacyCredentialSource, LegacyFixture>>;
  readonly network?: (
    request: ReadOnlyNetworkRequest,
  ) => NetworkResponse | Promise<NetworkResponse>;
  readonly hash?: HashAdapter;
  readonly platform?: PlatformAdapter;
}

function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function encodeJson(value: unknown): Uint8Array {
  return encodeText(JSON.stringify(value));
}

function response(
  status: number,
  body: Uint8Array = new Uint8Array(),
  headers: Readonly<Record<string, string>> = Object.freeze({
    "content-type": "application/json",
  }),
): NetworkResponse {
  return Object.freeze({ status, headers, body });
}

function agentBody(
  id: string,
  username: string,
  name = "Codex",
  extra: Record<string, unknown> = {},
): Uint8Array {
  return encodeJson({
    id,
    name,
    username,
    api_key_prefix: SERVER_CANARY,
    is_active: true,
    ...extra,
  });
}

function authorizationKey(request: ReadOnlyNetworkRequest): string {
  const authorization = request.headers.Authorization;
  return authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
}

function defaultAgentForKey(key: string): {
  readonly id: string;
  readonly username: string;
} {
  if (key === KEY_B) {
    return { id: AGENT_B, username: "agent-beta" };
  }
  if (key === KEY_C) {
    return { id: AGENT_C, username: "agent-charlie" };
  }
  if (key === KEY_D) {
    return { id: AGENT_D, username: "agent-delta" };
  }
  return { id: AGENT_A, username: "agent-alpha" };
}

function defaultNetwork(request: ReadOnlyNetworkRequest): NetworkResponse {
  const agent = defaultAgentForKey(authorizationKey(request));
  return response(200, agentBody(agent.id, agent.username));
}

function fakePlatform(
  environment: PlatformAdapter["environment"] = Object.freeze({
    HOME: "/isolated/home",
    PLURUM_HOME: "/isolated/plurum",
    PLURUM_TEST_ROOT: "/isolated",
    PLURUM_TEST_RUN_ID: "discovery-test-run",
  }),
): PlatformAdapter {
  return Object.freeze({
    os: "linux",
    arch: "test",
    cwd: "/isolated/neutral",
    environment,
    elevation: "standard",
    paths: createPlatformPathAdapter("linux"),
  });
}

function missingCanonical(): InMemoryCredentialStore {
  return createInMemoryCredentialStore({ directoryMissing: true });
}

function activeCredentialBytes(
  apiKey: string,
  agentId = AGENT_A,
  apiOrigin: string = DEFAULT_API_ORIGIN,
): Uint8Array {
  return encodeText(
    serializeCredentialDocument(
      validateCredentialDocument({
        schema_version: 1,
        state: "active",
        api_origin: apiOrigin,
        api_key: apiKey,
        agent_id: agentId,
        agent_name: "Codex",
        username: "agent-alpha",
        registration_request_id: REQUEST_ID,
        created_at: CREATED_AT,
        updated_at: ACTIVATED_AT,
        activated_at: ACTIVATED_AT,
      }),
      apiOrigin.startsWith("http:")
        ? "explicit-loopback-development"
        : "https-only",
    ),
  );
}

function pendingCredentialBytes(
  apiKey: string,
  apiOrigin: string = DEFAULT_API_ORIGIN,
): Uint8Array {
  return encodeText(
    serializeCredentialDocument(
      validateCredentialDocument(
        {
          schema_version: 1,
          state: "pending",
          api_origin: apiOrigin,
          api_key: apiKey,
          agent_id: null,
          agent_name: "Codex",
          username: "agent-alpha",
          registration_request_id: REQUEST_ID,
          created_at: CREATED_AT,
          updated_at: CREATED_AT,
          activated_at: null,
        },
        apiOrigin.startsWith("http:")
          ? "explicit-loopback-development"
          : "https-only",
      ),
      apiOrigin.startsWith("http:")
        ? "explicit-loopback-development"
        : "https-only",
    ),
  );
}

function legacyDocument(
  source: LegacyCredentialSource,
  apiKey: string,
  apiOrigin?: string,
): LegacyCredentialAdapterReadResult {
  const document =
    source === "removed-cli"
      ? {
          apiKey,
          ...(apiOrigin === undefined ? {} : { apiUrl: apiOrigin }),
          unrelated: "preserved-but-ignored",
        }
      : {
          api_key: apiKey,
          ...(source === "hermes" && apiOrigin !== undefined
            ? { api_url: apiOrigin }
            : {}),
          unrelated: "preserved-but-ignored",
        };
  return Object.freeze({
    status: "loaded",
    bytes: encodeJson(document),
  });
}

function createHarness(options: HarnessOptions = {}): DiscoveryHarness {
  const environment = options.environment ?? Object.freeze({});
  const canonical = options.canonical ?? missingCanonical();
  const legacyCalls: LegacyReadCall[] = [];
  const networkRequests: ReadOnlyNetworkRequest[] = [];
  let environmentReadCount = 0;
  let hashCallCount = 0;

  const credentialEnvironment = Object.freeze({
    read(): CredentialEnvironmentSnapshot {
      environmentReadCount += 1;
      return environment;
    },
  });

  const legacyStore = Object.freeze<LegacyCredentialReadAdapter>({
    async read(source, path, readOptions) {
      legacyCalls.push(
        Object.freeze({
          source,
          path,
          options: readOptions,
        }),
      );
      const fixture = options.legacy?.[source];
      if (fixture === undefined) {
        return Object.freeze({ status: "missing" as const });
      }
      if (fixture instanceof Error) {
        throw fixture;
      }
      return typeof fixture === "function" ? await fixture() : fixture;
    },
  });

  const network = Object.freeze<ReadOnlyNetworkAdapter>({
    async request(request) {
      networkRequests.push(request);
      return (options.network ?? defaultNetwork)(request);
    },
  });

  const delegateHash = options.hash ?? nodeHash;
  const hash = Object.freeze<HashAdapter>({
    sha256(data) {
      hashCallCount += 1;
      return delegateHash.sha256(data);
    },
  });

  return Object.freeze({
    dependencies: Object.freeze({
      credentialEnvironment,
      canonicalStore: canonical.adapter,
      legacyStore,
      network,
      hash,
      platform: options.platform ?? fakePlatform(),
    }),
    canonical,
    environmentReads: () => environmentReadCount,
    legacyCalls,
    networkRequests,
    hashCalls: () => hashCallCount,
  });
}

function blockerReasons(result: CredentialDiscoveryResult): readonly string[] {
  return result.status === "blocked"
    ? result.blockers.map((entry) => entry.reason)
    : [];
}

function publicJson(result: CredentialDiscoveryResult): string {
  return JSON.stringify(result);
}

function expectNoCanaries(value: string): void {
  for (const canary of [
    KEY_A,
    KEY_B,
    KEY_C,
    KEY_D,
    SERVER_CANARY,
    PATH_CANARY,
    ERROR_CANARY,
  ]) {
    expect(value).not.toContain(canary);
  }
}

function expectFrozenSummary(
  summary: Readonly<{
    agent: object;
    sources: readonly CredentialDiscoverySource[];
  }>,
): void {
  expect(Object.isFrozen(summary)).toBe(true);
  expect(Object.isFrozen(summary.agent)).toBe(true);
  expect(Object.isFrozen(summary.sources)).toBe(true);
}

function expectFrozenPublicResult(result: CredentialDiscoveryResult): void {
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.invalidSources)).toBe(true);
  if (result.status === "ready") {
    expectFrozenSummary(result.candidate);
    expect(Object.isFrozen(result.credential)).toBe(true);
    expect(Object.isFrozen(result.credential.agent)).toBe(true);
    expect(Object.isFrozen(result.credential.sources)).toBe(true);
  } else if (result.status === "selection-required") {
    expect(Object.isFrozen(result.candidates)).toBe(true);
    result.candidates.forEach(expectFrozenSummary);
  } else if (result.status === "blocked") {
    expect(Object.isFrozen(result.blockers)).toBe(true);
    expect(Object.isFrozen(result.validCandidates)).toBe(true);
    result.blockers.forEach((entry) => {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.sources)).toBe(true);
    });
    result.validCandidates.forEach(expectFrozenSummary);
  }
}

describe("credential discovery orchestration", () => {
  it("returns registration-safe not-found after inspecting only exact read sources", async () => {
    const harness = createHarness();

    const result = await discoverCredentials(harness.dependencies);

    expect(result).toEqual({
      status: "not-found",
      registrationAllowed: true,
      invalidSources: [],
    });
    expect(harness.environmentReads()).toBe(1);
    expect(harness.hashCalls()).toBe(0);
    expect(harness.networkRequests).toHaveLength(0);
    expect(harness.legacyCalls).toEqual([
      {
        source: "hermes",
        path: "/isolated/home/.hermes/plurum.json",
        options: {
          noFollow: true,
          maxBytes: MAX_LEGACY_CREDENTIAL_BYTES,
        },
      },
      {
        source: "openclaw",
        path: "/isolated/home/.openclaw/plurum.json",
        options: {
          noFollow: true,
          maxBytes: MAX_LEGACY_CREDENTIAL_BYTES,
        },
      },
      {
        source: "removed-cli",
        path: "/isolated/home/.plurum/config.json",
        options: {
          noFollow: true,
          maxBytes: MAX_LEGACY_CREDENTIAL_BYTES,
        },
      },
    ]);
    expect(
      harness.legacyCalls.every((call) => Object.isFrozen(call.options)),
    ).toBe(true);
    expect(harness.canonical.trace.operations()).toEqual(["open-directory"]);
    expectFrozenPublicResult(result);
  });

  it("maps hostile credential-environment getters to one fixed blocker", async () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error(`${ERROR_CANARY}:${KEY_A}:${PATH_CANARY}`);
        },
      },
    ) as CredentialEnvironmentSnapshot;
    const harness = createHarness({ environment: hostile });

    const result = await discoverCredentials(harness.dependencies);

    expect(result).toEqual({
      status: "blocked",
      registrationAllowed: false,
      blockers: [
        {
          reason: "credential_environment_invalid",
          sources: ["environment"],
        },
      ],
      validCandidates: [],
      invalidSources: [],
    });
    expect(harness.networkRequests).toHaveLength(0);
    expect(harness.legacyCalls).toHaveLength(0);
    expectNoCanaries(publicJson(result));
  });

  it.each([
    {
      label: "environment",
      environment: Object.freeze({ PLURUM_API_KEY: KEY_A }),
      canonical: missingCanonical(),
      legacy: {},
      expectedSource: "environment",
      expectedOrigin: "https://api.plurum.ai",
    },
    {
      label: "canonical",
      environment: Object.freeze({}),
      canonical: createInMemoryCredentialStore({
        bytes: activeCredentialBytes(KEY_A),
      }),
      legacy: {},
      expectedSource: "canonical",
      expectedOrigin: "https://api.plurum.ai",
    },
    {
      label: "Hermes",
      environment: Object.freeze({}),
      canonical: missingCanonical(),
      legacy: {
        hermes: legacyDocument(
          "hermes",
          KEY_A,
          "HTTPS://HERMES.EXAMPLE:443/",
        ),
      },
      expectedSource: "hermes",
      expectedOrigin: "https://hermes.example",
    },
    {
      label: "removed CLI",
      environment: Object.freeze({}),
      canonical: missingCanonical(),
      legacy: {
        "removed-cli": legacyDocument(
          "removed-cli",
          KEY_A,
          "HTTPS://CLI.EXAMPLE:443/",
        ),
      },
      expectedSource: "removed-cli",
      expectedOrigin: "https://cli.example",
    },
  ] as const)(
    "returns one validated ready candidate from the $label source",
    async ({
      environment,
      canonical,
      legacy,
      expectedSource,
      expectedOrigin,
    }) => {
      const harness = createHarness({ environment, canonical, legacy });

      const result = await discoverCredentials(harness.dependencies);

      expect(result.status).toBe("ready");
      if (result.status !== "ready") {
        return;
      }
      expect(result.candidate.sources).toEqual([expectedSource]);
      expect(result.credential.sources).toEqual([expectedSource]);
      expect(result.credential.apiOrigin).toBe(expectedOrigin);
      expect(result.credential.apiKey).toBe(KEY_A);
      expect(result.candidate.agent).toEqual({
        id: AGENT_A,
        name: "Codex",
        username: "agent-alpha",
      });
      expect(result.candidate.fingerprint).toMatch(
        /^plurum-fp-v1:[0-9a-f]{12}$/u,
      );
      expect(harness.networkRequests).toHaveLength(1);
      expect(harness.networkRequests[0]?.url).toBe(
        `${expectedOrigin}/api/v1/agents/me`,
      );
      expectNoCanaries(publicJson(result));
      expectFrozenPublicResult(result);
    },
  );

  it("withholds a valid source while any discovered legacy source is unsafe", async () => {
    const harness = createHarness({
      environment: Object.freeze({ PLURUM_API_KEY: KEY_A }),
      legacy: {
        hermes: Object.freeze({ status: "unsafe" as const }),
      },
    });

    const result = await discoverCredentials(harness.dependencies);

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") {
      return;
    }
    expect(result.blockers).toContainEqual({
      reason: "credential_source_unsafe",
      sources: ["hermes"],
    });
    expect(result.validCandidates).toHaveLength(1);
    expect(result.validCandidates[0]?.sources).toEqual(["environment"]);
    expect(result.registrationAllowed).toBe(false);
    expect(harness.networkRequests).toHaveLength(1);
    expectNoCanaries(publicJson(result));
  });

  it("never sends an originless OpenClaw key to an assumed API origin", async () => {
    const harness = createHarness({
      environment: Object.freeze({
        PLURUM_API_URL: "https://possibly-overridden.example",
      }),
      legacy: {
        openclaw: legacyDocument("openclaw", KEY_A),
      },
    });

    const result = await discoverCredentials(harness.dependencies);

    expect(result.status).toBe("blocked");
    expect(blockerReasons(result)).toContain("credential_origin_required");
    expect(harness.networkRequests).toHaveLength(0);
    expectNoCanaries(publicJson(result));
  });

  it("requires confirmation when one originless key matches multiple bound origins", async () => {
    const canonical = createInMemoryCredentialStore({
      bytes: activeCredentialBytes(
        KEY_A,
        AGENT_A,
        "https://canonical.example",
      ),
    });
    const harness = createHarness({
      environment: Object.freeze({
        PLURUM_API_KEY: KEY_A,
        PLURUM_API_URL: "https://environment.example",
      }),
      canonical,
      legacy: {
        openclaw: legacyDocument("openclaw", KEY_A),
      },
    });

    const result = await discoverCredentials(harness.dependencies);

    expect(result.status).toBe("blocked");
    expect(blockerReasons(result)).toContain("credential_origin_required");
    expect(harness.networkRequests).toHaveLength(2);
    expectNoCanaries(publicJson(result));
  });

  it("binds an originless legacy key only to the same key from one trusted source", async () => {
    const harness = createHarness({
      environment: Object.freeze({
        PLURUM_API_KEY: KEY_A,
        PLURUM_API_URL: "HTTPS://OPENCLAW.EXAMPLE:443/",
      }),
      legacy: {
        openclaw: legacyDocument("openclaw", KEY_A),
      },
    });

    const result = await discoverCredentials(harness.dependencies);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      return;
    }
    expect(result.candidate.sources).toEqual(["environment", "openclaw"]);
    expect(result.credential.apiOrigin).toBe("https://openclaw.example");
    expect(harness.networkRequests).toHaveLength(1);
    expectNoCanaries(publicJson(result));
  });

  it("applies exact per-source origin precedence and canonicalizes every request", async () => {
    const environmentOrigin = "HTTPS://ENV.EXAMPLE:443/";
    const hermesOrigin = "HTTPS://HERMES.EXAMPLE:443/";
    const harness = createHarness({
      environment: Object.freeze({
        PLURUM_API_KEY: KEY_A,
        PLURUM_API_URL: environmentOrigin,
      }),
      legacy: {
        hermes: legacyDocument("hermes", KEY_B, hermesOrigin),
        openclaw: legacyDocument("openclaw", KEY_A),
        "removed-cli": legacyDocument(
          "removed-cli",
          KEY_D,
          "https://ignored-cli.example",
        ),
      },
    });

    const result = await discoverCredentials(harness.dependencies);

    expect(result.status).toBe("selection-required");
    if (result.status !== "selection-required") {
      return;
    }
    expect(harness.networkRequests.map((request) => request.url)).toEqual([
      "https://env.example/api/v1/agents/me",
      "https://hermes.example/api/v1/agents/me",
      "https://env.example/api/v1/agents/me",
    ]);
    const selectedOrigins = Object.fromEntries(
      result.candidates.map((candidate) => [
        candidate.sources[0],
        result.select(candidate.selectionId).apiOrigin,
      ]),
    );
    expect(selectedOrigins).toEqual({
      environment: "https://env.example",
      hermes: "https://hermes.example",
      "removed-cli": "https://env.example",
    });
    expect(result.candidates[0]?.sources).toEqual([
      "environment",
      "openclaw",
    ]);
    expectNoCanaries(publicJson(result));
    expectFrozenPublicResult(result);
  });

  it("allows plaintext only for an explicit canonical numeric loopback policy", async () => {
    const environment = Object.freeze({
      PLURUM_API_KEY: KEY_A,
      PLURUM_API_URL: "http://127.0.0.1:43197/",
    });
    const strictHarness = createHarness({ environment });

    const strictResult = await discoverCredentials(strictHarness.dependencies);

    expect(strictResult.status).toBe("blocked");
    expect(blockerReasons(strictResult)).toContain(
      "credential_environment_invalid",
    );
    expect(strictHarness.networkRequests).toHaveLength(0);

    const developmentHarness = createHarness({ environment });
    const developmentResult = await discoverCredentials(
      developmentHarness.dependencies,
      "explicit-loopback-development",
    );

    expect(developmentResult.status).toBe("ready");
    if (developmentResult.status === "ready") {
      expect(developmentResult.credential.apiOrigin).toBe(
        "http://127.0.0.1:43197",
      );
    }
    expect(developmentHarness.networkRequests[0]?.url).toBe(
      "http://127.0.0.1:43197/api/v1/agents/me",
    );

    for (const rejectedOrigin of [
      "http://localhost:43197",
      "http://10.0.0.1:43197",
      "http://127.000.000.001:43197",
    ]) {
      const rejected = createHarness({
        environment: Object.freeze({
          PLURUM_API_KEY: KEY_A,
          PLURUM_API_URL: rejectedOrigin,
        }),
      });
      const rejectedResult = await discoverCredentials(
        rejected.dependencies,
        "explicit-loopback-development",
      );
      expect(rejectedResult.status).toBe("blocked");
      expect(rejected.networkRequests).toHaveLength(0);
    }
  });

  it("deduplicates one normalized origin-key pair across every source before hashing and validation", async () => {
    const canonical = createInMemoryCredentialStore({
      bytes: activeCredentialBytes(KEY_A),
    });
    const harness = createHarness({
      environment: Object.freeze({
        PLURUM_API_KEY: KEY_A,
        PLURUM_API_URL: "HTTPS://API.PLURUM.AI:443/",
      }),
      canonical,
      legacy: {
        hermes: legacyDocument(
          "hermes",
          KEY_A,
          "https://api.plurum.ai",
        ),
        openclaw: legacyDocument("openclaw", KEY_A),
        "removed-cli": legacyDocument(
          "removed-cli",
          KEY_A,
          "https://ignored.example",
        ),
      },
    });

    const result = await discoverCredentials(harness.dependencies);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      return;
    }
    expect(result.candidate.sources).toEqual([
      "environment",
      "canonical",
      "hermes",
      "openclaw",
      "removed-cli",
    ]);
    expect(harness.hashCalls()).toBe(1);
    expect(harness.networkRequests).toHaveLength(1);
    expectNoCanaries(publicJson(result));
  });

  it("isolates an invalid legacy override without suppressing canonical validation", async () => {
    const canonical = createInMemoryCredentialStore({
      bytes: activeCredentialBytes(KEY_A),
    });
    const harness = createHarness({
      environment: Object.freeze({
        HERMES_HOME: "../unsafe-relative-home",
      }),
      canonical,
    });

    const result = await discoverCredentials(harness.dependencies);

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") {
      return;
    }
    expect(result.blockers).toContainEqual({
      reason: "legacy_locations_invalid",
      sources: ["hermes"],
    });
    expect(result.validCandidates).toHaveLength(1);
    expect(result.validCandidates[0]?.sources).toEqual(["canonical"]);
    expect(harness.canonical.trace.operations()).toContain("read-file");
    expect(harness.legacyCalls.map(({ source }) => source)).toEqual([
      "openclaw",
      "removed-cli",
    ]);
    expect(harness.networkRequests).toHaveLength(1);
  });

  it("isolates an invalid canonical base without suppressing safe legacy validation", async () => {
    const canonical = missingCanonical();
    const harness = createHarness({
      canonical,
      platform: fakePlatform(
        Object.freeze({
          HOME: "/isolated/home",
          XDG_CONFIG_HOME: "../unsafe-relative-config",
        }),
      ),
      legacy: {
        hermes: legacyDocument(
          "hermes",
          KEY_A,
          "https://api.plurum.ai",
        ),
      },
    });

    const result = await discoverCredentials(harness.dependencies);

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") {
      return;
    }
    expect(result.blockers).toContainEqual({
      reason: "canonical_location_invalid",
      sources: ["canonical"],
    });
    expect(result.validCandidates).toHaveLength(1);
    expect(result.validCandidates[0]?.sources).toEqual(["hermes"]);
    expect(harness.canonical.trace.operations()).toEqual([]);
    expect(harness.legacyCalls.map(({ source }) => source)).toEqual([
      "hermes",
      "openclaw",
      "removed-cli",
    ]);
    expect(harness.networkRequests).toHaveLength(1);
  });

  it("keeps the same key at different canonical origins as distinct choices", async () => {
    const harness = createHarness({
      environment: Object.freeze({
        PLURUM_API_KEY: KEY_A,
        PLURUM_API_URL: "https://environment.example",
      }),
      legacy: {
        hermes: legacyDocument(
          "hermes",
          KEY_A,
          "https://hermes.example",
        ),
      },
    });

    const result = await discoverCredentials(harness.dependencies);

    expect(result.status).toBe("selection-required");
    if (result.status !== "selection-required") {
      return;
    }
    expect(harness.hashCalls()).toBe(2);
    expect(harness.networkRequests).toHaveLength(2);
    expect(
      result.candidates.map((candidate) =>
        result.select(candidate.selectionId).apiOrigin,
      ),
    ).toEqual([
      "https://environment.example",
      "https://hermes.example",
    ]);
    expect(result.candidates[0]?.fingerprint).not.toBe(
      result.candidates[1]?.fingerprint,
    );
  });

  it("allows registration only when every discovered key is conclusively invalid", async () => {
    const harness = createHarness({
      environment: Object.freeze({ PLURUM_API_KEY: KEY_A }),
      legacy: {
        hermes: legacyDocument(
          "hermes",
          KEY_B,
          "https://api.plurum.ai",
        ),
      },
      network: (request) => {
        const status = authorizationKey(request) === KEY_A ? 401 : 403;
        return {
          status,
          get headers(): Readonly<Record<string, string>> {
            throw new Error(SERVER_CANARY);
          },
          get body(): Uint8Array {
            throw new Error(SERVER_CANARY);
          },
        };
      },
    });

    const result = await discoverCredentials(harness.dependencies);

    expect(result).toEqual({
      status: "all-invalid",
      registrationAllowed: true,
      invalidSources: ["environment", "hermes"],
    });
    expect(harness.networkRequests).toHaveLength(2);
    expectNoCanaries(publicJson(result));
    expectFrozenPublicResult(result);
  });

  it.each([
    {
      label: "timeout",
      network: async () => {
        throw new Error(`timeout:${ERROR_CANARY}`);
      },
    },
    {
      label: "service failure",
      network: async () =>
        response(503, encodeText(`${SERVER_CANARY}:${ERROR_CANARY}`)),
    },
    {
      label: "malformed success",
      network: async () =>
        response(200, encodeText(`{"id":"${SERVER_CANARY}"`)),
    },
    {
      label: "redirect refusal",
      network: async () => {
        throw new Error(`redirect:${SERVER_CANARY}:${ERROR_CANARY}`);
      },
    },
  ])("blocks replacement registration after $label", async ({ network }) => {
    const harness = createHarness({
      environment: Object.freeze({ PLURUM_API_KEY: KEY_A }),
      network,
    });

    const result = await discoverCredentials(harness.dependencies);

    expect(result.status).toBe("blocked");
    expect(result.registrationAllowed).toBe(false);
    expect(blockerReasons(result)).toEqual([
      "credential_validation_unavailable",
    ]);
    expectNoCanaries(publicJson(result));
    expectFrozenPublicResult(result);
  });

  it.each([
    {
      label: "unsafe",
      fixture: Object.freeze({ status: "unsafe" as const }),
      expected: "credential_source_unsafe",
    },
    {
      label: "malformed",
      fixture: Object.freeze({
        status: "loaded" as const,
        bytes: encodeText(`{"api_key":"${KEY_A}","api_key":null}`),
      }),
      expected: "credential_source_malformed",
    },
    {
      label: "unavailable",
      fixture: new Error(`${ERROR_CANARY}:${PATH_CANARY}`),
      expected: "credential_source_unavailable",
    },
  ] as const)(
    "blocks instead of repairing or replacing an $label legacy source",
    async ({ fixture, expected }) => {
      const harness = createHarness({
        legacy: { hermes: fixture },
      });

      const result = await discoverCredentials(harness.dependencies);

      expect(result.status).toBe("blocked");
      expect(result.registrationAllowed).toBe(false);
      expect(blockerReasons(result)).toContain(expected);
      expect(harness.networkRequests).toHaveLength(0);
      expect(harness.legacyCalls).toHaveLength(3);
      expectNoCanaries(publicJson(result));
      expectFrozenPublicResult(result);
    },
  );

  it("blocks on a pending canonical credential even when its exact key validates", async () => {
    const canonical = createInMemoryCredentialStore({
      bytes: pendingCredentialBytes(KEY_A),
    });
    const harness = createHarness({ canonical });

    const result = await discoverCredentials(harness.dependencies);

    expect(result.status).toBe("blocked");
    expect(result.registrationAllowed).toBe(false);
    expect(blockerReasons(result)).toContain(
      "canonical_credential_pending",
    );
    if (result.status === "blocked") {
      expect(result.validCandidates).toHaveLength(1);
      expect(result.validCandidates[0]?.sources).toEqual(["canonical"]);
    }
    expect(harness.networkRequests).toHaveLength(1);
    expectNoCanaries(publicJson(result));
    expectFrozenPublicResult(result);
  });

  it("blocks an active canonical credential whose live agent identity changed", async () => {
    const canonical = createInMemoryCredentialStore({
      bytes: activeCredentialBytes(KEY_A, AGENT_A),
    });
    const harness = createHarness({
      canonical,
      network: () => response(200, agentBody(AGENT_B, "agent-beta")),
    });

    const result = await discoverCredentials(harness.dependencies);

    expect(result.status).toBe("blocked");
    expect(blockerReasons(result)).toContain(
      "canonical_identity_mismatch",
    );
    if (result.status === "blocked") {
      expect(result.validCandidates).toEqual([]);
    }
    expectNoCanaries(publicJson(result));
  });

  it("returns numbered fingerprint-and-username choices and resolves only an exact selection", async () => {
    const harness = createHarness({
      environment: Object.freeze({ PLURUM_API_KEY: KEY_A }),
      legacy: {
        hermes: legacyDocument(
          "hermes",
          KEY_B,
          "https://api.plurum.ai",
        ),
      },
    });

    const result = await discoverCredentials(harness.dependencies);

    expect(result.status).toBe("selection-required");
    if (result.status !== "selection-required") {
      return;
    }
    expect(result.candidates).toEqual([
      {
        selectionId: "credential-1",
        apiOrigin: "https://api.plurum.ai",
        fingerprint: expect.stringMatching(
          /^plurum-fp-v1:[0-9a-f]{12}$/u,
        ),
        agent: {
          id: AGENT_A,
          name: "Codex",
          username: "agent-alpha",
        },
        sources: ["environment"],
      },
      {
        selectionId: "credential-2",
        apiOrigin: "https://api.plurum.ai",
        fingerprint: expect.stringMatching(
          /^plurum-fp-v1:[0-9a-f]{12}$/u,
        ),
        agent: {
          id: AGENT_B,
          name: "Codex",
          username: "agent-beta",
        },
        sources: ["hermes"],
      },
    ]);
    const first = result.select("credential-1");
    const second = result.select("credential-2");
    expect(first.apiKey).toBe(KEY_A);
    expect(second.apiKey).toBe(KEY_B);
    for (const credential of [first, second]) {
      expect(Object.isFrozen(credential)).toBe(true);
      expect(Object.isFrozen(credential.agent)).toBe(true);
      expect(Object.isFrozen(credential.sources)).toBe(true);
      expect(Object.keys(credential)).not.toContain("apiKey");
    }
    expect(Object.keys(result)).not.toContain("select");

    const hostileSelection =
      `credential-does-not-exist:${KEY_A}:${PATH_CANARY}`;
    let failure: unknown;
    try {
      result.select(hostileSelection);
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toBe(
      "CredentialDiscoveryError: Plurum credentials could not be discovered safely.",
    );
    expectNoCanaries(String(failure));
    expectNoCanaries(publicJson(result));
    expectFrozenPublicResult(result);
  });

  it("fails closed when distinct raw candidates receive the same full digest", async () => {
    const collidingHash = Object.freeze<HashAdapter>({
      sha256() {
        return new Uint8Array(32).fill(0x42);
      },
    });
    const harness = createHarness({
      environment: Object.freeze({ PLURUM_API_KEY: KEY_A }),
      legacy: {
        hermes: legacyDocument(
          "hermes",
          KEY_B,
          "https://api.plurum.ai",
        ),
      },
      hash: collidingHash,
    });

    const result = await discoverCredentials(harness.dependencies);

    expect(result.status).toBe("blocked");
    expect(blockerReasons(result)).toContain(
      "credential_fingerprint_collision",
    );
    expect(result.registrationAllowed).toBe(false);
    expect(harness.hashCalls()).toBe(2);
    expect(harness.networkRequests).toHaveLength(1);
    expectNoCanaries(publicJson(result));
  });

  it("fails closed when distinct full digests share one short display fingerprint", async () => {
    let call = 0;
    const displayCollidingHash = Object.freeze<HashAdapter>({
      sha256() {
        call += 1;
        const digest = new Uint8Array(32).fill(call);
        digest.fill(0xa5, 0, 6);
        return digest;
      },
    });
    const harness = createHarness({
      environment: Object.freeze({ PLURUM_API_KEY: KEY_A }),
      legacy: {
        hermes: legacyDocument(
          "hermes",
          KEY_B,
          "https://api.plurum.ai",
        ),
      },
      hash: displayCollidingHash,
    });

    const result = await discoverCredentials(harness.dependencies);

    expect(result.status).toBe("blocked");
    expect(blockerReasons(result)).toContain(
      "credential_fingerprint_collision",
    );
    expect(result.registrationAllowed).toBe(false);
    expect(harness.hashCalls()).toBe(2);
    expect(harness.networkRequests).toHaveLength(2);
    expectNoCanaries(publicJson(result));
  });

  it("keeps key material non-enumerable and excludes hidden source values from public structures", async () => {
    const environment = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(environment, "PLURUM_API_KEY", {
      configurable: false,
      enumerable: false,
      value: KEY_A,
      writable: false,
    });
    const harness = createHarness({
      environment: environment as CredentialEnvironmentSnapshot,
    });

    const result = await discoverCredentials(harness.dependencies);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      return;
    }
    expect(result.credential.apiKey).toBe(KEY_A);
    expect(Object.keys(result.credential)).not.toContain("apiKey");
    expect(
      Object.getOwnPropertyDescriptor(result.credential, "apiKey"),
    ).toMatchObject({
      configurable: false,
      enumerable: false,
      writable: false,
    });
    expectNoCanaries(publicJson(result));
    expectNoCanaries(JSON.stringify(result.candidate));
    expectFrozenPublicResult(result);
  });

  it("never exposes raw network, adapter, or exact path canaries in a blocked result", async () => {
    const hermesHome = `/isolated/${PATH_CANARY}/hermes`;
    const harness = createHarness({
      environment: Object.freeze({
        PLURUM_API_KEY: KEY_A,
        HERMES_HOME: hermesHome,
      }),
      legacy: {
        hermes: Object.freeze({ status: "unsafe" as const }),
      },
      network: async () => {
        throw new Error(`${SERVER_CANARY}:${ERROR_CANARY}:${PATH_CANARY}`);
      },
    });

    const result = await discoverCredentials(harness.dependencies);

    expect(result.status).toBe("blocked");
    expect(harness.legacyCalls[0]?.path).toBe(
      `${hermesHome}/plurum.json`,
    );
    expectNoCanaries(publicJson(result));
    expectFrozenPublicResult(result);
  });

  it("uses only read-only injected ports and exposes no mutation surface in the legacy adapter", async () => {
    const harness = createHarness({
      legacy: {
        hermes: legacyDocument("hermes", KEY_A),
      },
    });

    await discoverCredentials(harness.dependencies);

    expect(Object.keys(harness.dependencies.legacyStore)).toEqual(["read"]);
    expect(
      harness.legacyCalls.map(({ source }) => source),
    ).toEqual(["hermes", "openclaw", "removed-cli"]);
    expect(
      harness.legacyCalls.every(
        ({ options }) =>
          options.noFollow &&
          options.maxBytes === MAX_LEGACY_CREDENTIAL_BYTES,
      ),
    ).toBe(true);
  });
});
