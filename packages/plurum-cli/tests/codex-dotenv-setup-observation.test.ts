import { describe, expect, it } from "vitest";

import { nodeHash } from "../src/adapters/node/hash.js";
import { createSetupApprovalAuthority } from "../src/commands/setup-approval.js";
import {
  createSetupInteractiveSessionPorts,
} from "../src/commands/setup-confirmation.js";
import { createSetupPreflightSnapshot } from "../src/commands/setup-preflight.js";
import type {
  CodexDotenvNativeAdapter,
  CodexDotenvProjectionAdapter,
  CodexDotenvProjectionStatus,
} from "../src/credentials/codex-dotenv-contracts.js";
import { createCodexDotenvProjectionAdapter } from "../src/credentials/codex-dotenv-projection.js";
import {
  createCodexDotenvSetupObservationAuthority,
  type CodexDotenvSetupDiscoveryDependencies,
  type CodexDotenvSetupObservationOptions,
  type CodexDotenvSetupPrepareRequest,
} from "../src/credentials/codex-dotenv-setup-observation.js";
import type { LegacyCredentialReadAdapter } from "../src/credentials/legacy-reader-contracts.js";
import { DEFAULT_API_ORIGIN } from "../src/credentials/origin.js";
import {
  serializeCredentialDocument,
  validateCredentialDocument,
  type CredentialV1,
} from "../src/credentials/schema.js";
import type { CredentialStoreObservationAuthority } from "../src/credentials/store-observation-contracts.js";
import { createCredentialStoreObservationAuthority } from "../src/credentials/store-observer.js";
import type {
  HostConfiguration,
  HostExecutableAttestation,
  HostInspection,
  HostMutationAdapter,
} from "../src/hosts/contracts.js";
import {
  CODEX_DESIRED_CONFIGURATION,
  CODEX_MUTATION_SUPPORT,
} from "../src/hosts/codex/configuration.js";
import { setupPreflightScope } from "../src/system/scopes.js";
import type {
  CredentialEnvironmentSnapshot,
  NetworkResponse,
  PlatformAdapter,
  ReadOnlyNetworkRequest,
  SystemCapabilities,
} from "../src/system/contracts.js";
import { snapshotPlatformAdapter } from "../src/system/platform-snapshot.js";
import { createInMemoryCredentialObservationStore } from "./support/in-memory-credential-observation-store.js";
import { createTestSystem } from "./support/system.js";

const KEY_A = "plrm_live_SETUP_OBSERVATION_AAAAAAAAA";
const KEY_B = "plrm_live_SETUP_OBSERVATION_BBBBBBBBB";
const AGENT_A = "00000000-0000-4000-8000-000000000011";
const AGENT_B = "00000000-0000-4000-8000-000000000012";
const REQUEST_ID = "ca908d9f-d901-4dac-b396-7f84377adfc8";
const CREATED_AT = "2026-07-21T09:10:11.123Z";
const ACTIVATED_AT = "2026-07-21T09:11:11.123Z";
const OPERATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const DIRECTORY = "/isolated/plurum";
const TEST_PLATFORM = snapshotPlatformAdapter(createTestSystem().platform);
const CWD = TEST_PLATFORM.cwd;
const STORE_EVIDENCE_CANARY = "store-native-revision-private-canary";

function activeCredential(apiKey = KEY_A): CredentialV1 {
  return validateCredentialDocument({
    schema_version: 1,
    state: "active",
    api_origin: DEFAULT_API_ORIGIN,
    api_key: apiKey,
    agent_id: AGENT_A,
    agent_name: "Codex",
    username: "agent-alpha",
    registration_request_id: REQUEST_ID,
    created_at: CREATED_AT,
    updated_at: ACTIVATED_AT,
    activated_at: ACTIVATED_AT,
  });
}

function pendingCredential(): CredentialV1 {
  return validateCredentialDocument({
    schema_version: 1,
    state: "pending",
    api_origin: DEFAULT_API_ORIGIN,
    api_key: KEY_A,
    agent_id: null,
    agent_name: "Codex",
    username: "agent-alpha",
    registration_request_id: REQUEST_ID,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    activated_at: null,
  });
}

function storeAuthority(
  credential: CredentialV1 | null,
  available = true,
): Readonly<{
  authority: CredentialStoreObservationAuthority;
  inspections(): number;
  directories(): readonly string[];
  operations(): readonly string[];
}> {
  const memory = createInMemoryCredentialObservationStore({
    ...(credential === null
      ? {}
      : {
          credentialBytes: new TextEncoder().encode(
            serializeCredentialDocument(credential),
          ),
        }),
    ...(available ? {} : { failAt: ["open-directory" as const] }),
    finishEvidence: Object.freeze({
      revision: STORE_EVIDENCE_CANARY,
    }),
  });
  return Object.freeze({
    authority: createCredentialStoreObservationAuthority(memory.adapter),
    inspections: () =>
      memory.operations().filter((operation) => operation === "open-directory")
        .length,
    directories: memory.directories,
    operations: memory.operations,
  });
}

function jsonResponse(body: unknown): NetworkResponse {
  return Object.freeze({
    status: 200,
    headers: Object.freeze({ "content-type": "application/json" }),
    body: new TextEncoder().encode(JSON.stringify(body)),
  });
}

function keyFromRequest(request: ReadOnlyNetworkRequest): string {
  return request.headers.Authorization?.slice("Bearer ".length) ?? "";
}

function discoveryDependencies(
  environment: CredentialEnvironmentSnapshot = Object.freeze({}),
  legacy: LegacyCredentialReadAdapter = Object.freeze({
    async read() {
      return Object.freeze({ status: "missing" as const });
    },
  }),
  platform: PlatformAdapter = TEST_PLATFORM,
): CodexDotenvSetupDiscoveryDependencies {
  return Object.freeze({
    credentialEnvironment: Object.freeze({ read: () => environment }),
    legacyStore: legacy,
    hash: nodeHash,
    platform,
    network: Object.freeze({
      async request(request: ReadOnlyNetworkRequest) {
        const key = keyFromRequest(request);
        return jsonResponse({
          id: key === KEY_B ? AGENT_B : AGENT_A,
          name: key === KEY_B ? "Claude Code" : "Codex",
          username: key === KEY_B ? "agent-beta" : "agent-alpha",
          is_active: true,
        });
      },
    }),
  });
}

function projectionAdapter(
  status: CodexDotenvProjectionStatus,
): Readonly<{
  adapter: ReturnType<typeof createCodexDotenvProjectionAdapter>;
  observations: readonly Parameters<CodexDotenvNativeAdapter["observe"]>[0][];
  mutations(): number;
}> {
  const observations: Parameters<CodexDotenvNativeAdapter["observe"]>[0][] = [];
  let mutations = 0;
  const native: CodexDotenvNativeAdapter = Object.freeze({
    async observe(
      request: Parameters<CodexDotenvNativeAdapter["observe"]>[0],
    ) {
      observations.push(request);
      return Object.freeze({ revision: "projection-private-revision", status });
    },
    async synchronize() {
      mutations += 1;
      throw new Error("observation must not mutate the projection");
    },
  });
  return Object.freeze({
    adapter: createCodexDotenvProjectionAdapter(native),
    observations,
    mutations: () => mutations,
  });
}

function absentConfiguration(): HostConfiguration {
  return {
    marketplace: { status: "absent" },
    plugin: { status: "absent" },
    pluginMcp: { status: "absent" },
    directMcp: { status: "absent" },
  };
}

function executable(): HostExecutableAttestation {
  return {
    sourcePath: "/trusted/bin/codex",
    resolvedPath: "/trusted/bin/codex",
    revision: "codex-executable-revision",
    chain: [
      {
        path: "/trusted/bin/codex",
        kind: "binary",
        owner: "current-user",
        access: "not-broadly-writable",
        binding: "canonical",
        link: "direct",
        revision: "codex-chain-revision",
      },
    ],
    launch: {
      executable: "/trusted/bin/codex",
      argumentPrefix: [],
      shell: false,
    },
  };
}

function codexInspection(): HostInspection {
  return {
    host: "codex",
    status: "available",
    executable: executable(),
    version: CODEX_DESIRED_CONFIGURATION.minimumHostVersion,
    state: {
      revision: "codex-state-revision",
      configuration: absentConfiguration(),
    },
    mutationSupport: CODEX_MUTATION_SUPPORT,
  };
}

async function preflight() {
  const base = createTestSystem();
  const adapter: HostMutationAdapter = Object.freeze({
    async inspect() {
      return codexInspection();
    },
    async apply() {
      throw new Error("setup observation must not mutate hosts");
    },
    async rollback() {
      throw new Error("setup observation must not mutate hosts");
    },
  });
  const system: SystemCapabilities = Object.freeze({
    ...base,
    platform: TEST_PLATFORM,
    hosts: Object.freeze({
      inspection: base.hosts.inspection,
      mutation: Object.freeze({
        "claude-code": base.hosts.mutation["claude-code"],
        codex: adapter,
      }),
    }),
  });
  return createSetupPreflightSnapshot("codex", setupPreflightScope(system));
}

describe("setup observation composition", () => {
  it("prepares one selected-key-relative plan and binds private evidence to one sidecar", async () => {
    const store = storeAuthority(activeCredential());
    const projection = projectionAdapter("exact");
    const approval = createSetupApprovalAuthority();
    const snapshot = await preflight();
    const authority = createCodexDotenvSetupObservationAuthority({
      approval,
      store: store.authority,
      discovery: discoveryDependencies(),
      codexProjection: projection.adapter,
      preflight: snapshot,
    });

    const inspected = await authority.inspect();
    expect(inspected.status).toBe("available");
    if (inspected.status !== "available") {
      throw new Error("expected an available setup observation");
    }
    expect(inspected.initial).toMatchObject({
      status: "resolved",
      acquisition: "existing",
      canonicalEffect: "unchanged",
    });
    expect(store.inspections()).toBe(1);
    expect(store.directories()).toEqual([DIRECTORY]);
    expect(JSON.stringify(inspected)).not.toContain(KEY_A);
    expect(JSON.stringify(inspected)).not.toContain(REQUEST_ID);
    expect(JSON.stringify(inspected.identity)).toBeUndefined();

    const prepared = await authority.prepare({
      identity: inspected.identity,
      decision: { selectedCandidateId: null, registration: null },
      operationId: OPERATION_ID,
      createdAt: CREATED_AT,
    });
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") {
      throw new Error("expected a prepared setup plan");
    }
    expect(prepared.plan.preview.credential.codexProjection).toMatchObject({
      effect: "unchanged",
      reason: "projection-matches-selected-credential",
    });
    expect(projection.observations).toHaveLength(1);
    expect(projection.observations[0]?.expectation).toEqual({
      kind: "known",
      apiKey: KEY_A,
    });
    expect(projection.observations[0]?.excludedProjectDirectory).toBe(CWD);
    expect(projection.mutations()).toBe(0);
    const serialized = JSON.stringify(prepared);
    expect(serialized).not.toContain(KEY_A);
    expect(serialized).not.toContain(REQUEST_ID);
    expect(serialized).not.toContain("projection-private-revision");
    expect(serialized).not.toContain(STORE_EVIDENCE_CANARY);

    const ports = createSetupInteractiveSessionPorts(
      async () => "presented",
      async () => "confirmed",
    );
    const confirmation = authority.createConfirmation(
      prepared.plan,
      prepared.sidecar,
      "interactive",
      ports.presenter,
      ports.confirmation,
    );
    const consumed = await confirmation.authorize();
    expect(consumed).toMatchObject({
      status: "approved",
      source: "interactive",
    });
    if (consumed.status !== "approved") {
      throw new Error("expected approved execution evidence");
    }
    expect(JSON.stringify(consumed.grant)).toBeUndefined();
    expect(authority.discard(consumed.grant)).toEqual({ status: "discarded" });
    expect(
      await authority.prepare({
        identity: inspected.identity,
        decision: { selectedCandidateId: null, registration: null },
        operationId: OPERATION_ID,
        createdAt: CREATED_AT,
      }),
    ).toEqual({ status: "precondition-failed" });
    expect(await authority.inspect()).toEqual({
      status: "precondition-failed",
    });
    expect(store.inspections()).toBe(1);
  });

  it("uses deferred projection observation for a new registration without performing I/O mutations", async () => {
    const store = storeAuthority(null);
    const projection = projectionAdapter("exact");
    const approval = createSetupApprovalAuthority();
    const snapshot = await preflight();
    const authority = createCodexDotenvSetupObservationAuthority({
      approval,
      store: store.authority,
      discovery: discoveryDependencies(),
      codexProjection: projection.adapter,
      preflight: snapshot,
    });

    const inspected = await authority.inspect();
    expect(inspected.status).toBe("available");
    if (inspected.status !== "available") {
      throw new Error("expected an available setup observation");
    }
    expect(inspected.initial).toMatchObject({
      status: "registration-input-required",
      canonicalEffect: "create",
    });
    const prepared = await authority.prepare({
      identity: inspected.identity,
      decision: {
        selectedCandidateId: null,
        registration: {
          agentName: "Codex",
          username: "codex-agent",
        },
      },
      operationId: OPERATION_ID,
      createdAt: CREATED_AT,
    });

    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") {
      throw new Error("expected a prepared setup plan");
    }
    expect(projection.observations[0]?.expectation).toEqual({
      kind: "deferred-registration",
    });
    expect(prepared.plan.preview.credential.codexProjection).toMatchObject({
      effect: "replace",
      reason: "projection-replacement-required",
    });
    expect(projection.mutations()).toBe(0);
    expect(JSON.stringify(prepared)).not.toContain("projection-private-revision");
  });

  it("requires the inspection result to be fully resolved before the one prepare attempt", async () => {
    const store = storeAuthority(null);
    const projection = projectionAdapter("absent");
    const snapshot = await preflight();
    const authority = createCodexDotenvSetupObservationAuthority({
      approval: createSetupApprovalAuthority(),
      store: store.authority,
      discovery: discoveryDependencies(),
      codexProjection: projection.adapter,
      preflight: snapshot,
    });
    const inspected = await authority.inspect();
    if (inspected.status !== "available") {
      throw new Error("expected available observation");
    }
    expect(inspected.initial.status).toBe("registration-input-required");

    await expect(
      authority.prepare({
        identity: inspected.identity,
        decision: { selectedCandidateId: null, registration: null },
        operationId: OPERATION_ID,
        createdAt: CREATED_AT,
      }),
    ).resolves.toEqual({ status: "precondition-failed" });
    await expect(
      authority.prepare({
        identity: inspected.identity,
        decision: {
          selectedCandidateId: null,
          registration: {
            agentName: "Codex",
            username: "codex-agent",
          },
        },
        operationId: OPERATION_ID,
        createdAt: CREATED_AT,
      }),
    ).resolves.toEqual({ status: "precondition-failed" });
    expect(projection.observations).toHaveLength(0);
  });

  it("removes the pending canonical candidate, renumbers alternatives, and resumes with the pending key", async () => {
    const legacy: LegacyCredentialReadAdapter = Object.freeze({
      async read(source: Parameters<LegacyCredentialReadAdapter["read"]>[0]) {
        if (source !== "hermes") {
          return Object.freeze({ status: "missing" as const });
        }
        return Object.freeze({
          status: "loaded" as const,
          bytes: new TextEncoder().encode(
            JSON.stringify({
              api_key: KEY_B,
              api_url: DEFAULT_API_ORIGIN,
            }),
          ),
        });
      },
    });
    const store = storeAuthority(pendingCredential());
    const projection = projectionAdapter("absent");
    const approval = createSetupApprovalAuthority();
    const snapshot = await preflight();
    const authority = createCodexDotenvSetupObservationAuthority({
      approval,
      store: store.authority,
      discovery: discoveryDependencies(
        Object.freeze({
          PLURUM_API_KEY: KEY_A,
          PLURUM_API_URL: DEFAULT_API_ORIGIN,
        }),
        legacy,
      ),
      codexProjection: projection.adapter,
      preflight: snapshot,
    });

    const inspected = await authority.inspect();
    expect(inspected.status).toBe("available");
    if (inspected.status !== "available") {
      throw new Error("expected an available pending observation");
    }
    expect(inspected.observation.canonical).toMatchObject({
      status: "pending",
      sources: ["environment", "canonical"],
      resumeEvidence: "authenticated-match",
    });
    expect(inspected.observation.candidates).toEqual([
      expect.objectContaining({
        selectionId: "credential-1",
        sources: ["hermes"],
      }),
    ]);
    expect(inspected.initial).toMatchObject({
      status: "resolved",
      acquisition: "resume-registration",
    });
    expect(JSON.stringify(inspected)).not.toContain(KEY_A);
    expect(JSON.stringify(inspected)).not.toContain(REQUEST_ID);

    const prepared = await authority.prepare({
      identity: inspected.identity,
      decision: { selectedCandidateId: null, registration: null },
      operationId: OPERATION_ID,
      createdAt: CREATED_AT,
    });
    expect(prepared.status).toBe("prepared");
    expect(projection.observations[0]?.expectation).toEqual({
      kind: "known",
      apiKey: KEY_A,
    });

  });

  it("returns sanitized unavailable and projection-blocked results without minting executable plans", async () => {
    const unavailableStore = storeAuthority(null, false);
    const approval = createSetupApprovalAuthority();
    const unavailableSnapshot = await preflight();
    const unavailable = createCodexDotenvSetupObservationAuthority({
      approval,
      store: unavailableStore.authority,
      discovery: discoveryDependencies(),
      preflight: unavailableSnapshot,
    });
    const unavailableResult = await unavailable.inspect();
    expect(unavailableResult).toMatchObject({
      status: "unavailable",
      initial: {
        status: "blocked",
        reason: "credential-recovery-unavailable",
      },
    });
    expect(JSON.stringify(unavailableResult)).not.toContain(KEY_A);
    expect(unavailableStore.operations()).toEqual(["open-directory"]);

    const store = storeAuthority(activeCredential());
    const unsafeProjection = projectionAdapter("unsafe");
    const blockedSnapshot = await preflight();
    const blocked = createCodexDotenvSetupObservationAuthority({
      approval: createSetupApprovalAuthority(),
      store: store.authority,
      discovery: discoveryDependencies(),
      codexProjection: unsafeProjection.adapter,
      preflight: blockedSnapshot,
    });
    const inspected = await blocked.inspect();
    if (inspected.status !== "available") {
      throw new Error("expected an available credential observation");
    }
    const blockedResult = await blocked.prepare({
      identity: inspected.identity,
      decision: { selectedCandidateId: null, registration: null },
      operationId: OPERATION_ID,
      createdAt: CREATED_AT,
    });
    expect(blockedResult).toEqual({
      status: "blocked",
      stage: "codex-projection",
      projection: {
        status: "blocked",
        client: "codex",
        method: "user-dotenv",
        reason: "projection-unsafe",
      },
    });
    expect(JSON.stringify(blockedResult)).not.toContain(KEY_A);
    expect(unsafeProjection.mutations()).toBe(0);
  });

  it("rejects mixed platform provenance and releases cancelled observations", async () => {
    const snapshot = await preflight();
    const store = storeAuthority(activeCredential());
    const projection = projectionAdapter("exact");
    const foreignPlatform = createTestSystem().platform;
    expect(() =>
      createCodexDotenvSetupObservationAuthority({
        approval: createSetupApprovalAuthority(),
        store: store.authority,
        discovery: discoveryDependencies(
          Object.freeze({}),
          Object.freeze({
            async read() {
              return Object.freeze({ status: "missing" as const });
            },
          }),
          foreignPlatform,
        ),
        codexProjection: projection.adapter,
        preflight: snapshot,
      }),
    ).toThrow("The setup observation could not be composed safely.");
    expect(store.inspections()).toBe(0);
    expect(projection.observations).toHaveLength(0);

    const cancellationStore = storeAuthority(activeCredential());
    const cancellation = createCodexDotenvSetupObservationAuthority({
      approval: createSetupApprovalAuthority(),
      store: cancellationStore.authority,
      discovery: discoveryDependencies(),
      codexProjection: projection.adapter,
      preflight: snapshot,
    });
    const cancellationInspection = await cancellation.inspect();
    if (cancellationInspection.status !== "available") {
      throw new Error("expected a cancellable credential observation");
    }
    expect(cancellation.discard(cancellationInspection.identity)).toEqual({
      status: "discarded",
    });
    expect(
      await cancellation.prepare({
        identity: cancellationInspection.identity,
        decision: { selectedCandidateId: null, registration: null },
        operationId: OPERATION_ID,
        createdAt: CREATED_AT,
      }),
    ).toEqual({ status: "precondition-failed" });
  });

  it("rejects structural authority lookalikes without invoking proxy traps", async () => {
    const snapshot = await preflight();
    const store = storeAuthority(activeCredential());
    const projection = projectionAdapter("exact");
    let traps = 0;
    const handler: ProxyHandler<object> = {
      get() {
        traps += 1;
        throw new Error("authority lookalikes must not be read");
      },
      getOwnPropertyDescriptor() {
        traps += 1;
        throw new Error("authority lookalikes must not be inspected");
      },
      getPrototypeOf() {
        traps += 1;
        throw new Error("authority lookalikes must not be inspected");
      },
      ownKeys() {
        traps += 1;
        throw new Error("authority lookalikes must not be inspected");
      },
    };
    const storeProxy = new Proxy(store.authority, handler);
    const projectionProxy = new Proxy(projection.adapter, handler);

    expect(() =>
      createCodexDotenvSetupObservationAuthority({
        approval: createSetupApprovalAuthority(),
        store: storeProxy as CredentialStoreObservationAuthority,
        discovery: discoveryDependencies(),
        codexProjection: projection.adapter,
        preflight: snapshot,
      }),
    ).toThrow("The setup observation could not be composed safely.");
    expect(() =>
      createCodexDotenvSetupObservationAuthority({
        approval: createSetupApprovalAuthority(),
        store: store.authority,
        discovery: discoveryDependencies(),
        codexProjection: projectionProxy as CodexDotenvProjectionAdapter,
        preflight: snapshot,
      }),
    ).toThrow("The setup observation could not be composed safely.");
    expect(traps).toBe(0);
    expect(store.inspections()).toBe(0);
    expect(projection.observations).toHaveLength(0);
  });

  it("rejects option and request accessors without invoking them or burning valid evidence", async () => {
    const snapshot = await preflight();
    const store = storeAuthority(activeCredential());
    const projection = projectionAdapter("exact");
    const approval = createSetupApprovalAuthority();
    let optionGetterCalls = 0;
    const accessorOptions: Record<string, unknown> = {
      store: store.authority,
      discovery: discoveryDependencies(),
      codexProjection: projection.adapter,
      preflight: snapshot,
    };
    Object.defineProperty(accessorOptions, "approval", {
      enumerable: true,
      get() {
        optionGetterCalls += 1;
        return approval;
      },
    });
    expect(() =>
      createCodexDotenvSetupObservationAuthority(
        accessorOptions as unknown as CodexDotenvSetupObservationOptions,
      ),
    ).toThrow("The setup observation could not be composed safely.");
    expect(optionGetterCalls).toBe(0);

    const authority = createCodexDotenvSetupObservationAuthority({
      approval,
      store: store.authority,
      discovery: discoveryDependencies(),
      codexProjection: projection.adapter,
      preflight: snapshot,
    });
    const inspected = await authority.inspect();
    if (inspected.status !== "available") {
      throw new Error("expected available observation");
    }
    let requestGetterCalls = 0;
    const accessorRequest: Record<string, unknown> = {
      decision: Object.freeze({
        selectedCandidateId: null,
        registration: null,
      }),
      operationId: OPERATION_ID,
      createdAt: CREATED_AT,
    };
    Object.defineProperty(accessorRequest, "identity", {
      enumerable: true,
      get() {
        requestGetterCalls += 1;
        return inspected.identity;
      },
    });
    await expect(
      authority.prepare(
        accessorRequest as unknown as CodexDotenvSetupPrepareRequest,
      ),
    ).resolves.toEqual({ status: "precondition-failed" });
    expect(requestGetterCalls).toBe(0);

    await expect(
      authority.prepare({
        identity: inspected.identity,
        decision: { selectedCandidateId: null, registration: null },
        operationId: OPERATION_ID,
        createdAt: CREATED_AT,
      }),
    ).resolves.toMatchObject({ status: "prepared" });
  });
});
