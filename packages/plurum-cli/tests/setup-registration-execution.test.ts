import { describe, expect, it } from "vitest";

import { nodeHash } from "../src/adapters/node/hash.js";
import { createSetupApprovalAuthority } from "../src/commands/setup-approval.js";
import { createSetupInteractiveSessionPorts } from "../src/commands/setup-confirmation.js";
import {
  discardSetupHostConfigurationGrant,
  type SetupRegistrationExecutionAttempt,
  type SetupRegistrationExecutionDependencies,
} from "../src/commands/setup-registration-execution.js";
import {
  retainFramedSetupCredentialInput,
} from "../src/commands/setup-credential-input.js";
import { createSetupPreflightSnapshot } from "../src/commands/setup-preflight.js";
import { renderSetupApplyPlan } from "../src/commands/setup-output.js";
import type {
  CodexDotenvNativeAdapter,
  CodexDotenvProjectionStatus,
} from "../src/credentials/codex-dotenv-contracts.js";
import { createCodexDotenvProjectionAdapter } from "../src/credentials/codex-dotenv-projection.js";
import {
  createCodexDotenvSetupObservationAuthority,
  type CodexDotenvSetupObservationAuthority,
} from "../src/credentials/codex-dotenv-setup-observation.js";
import type { LegacyCredentialReadAdapter } from "../src/credentials/legacy-reader-contracts.js";
import { DEFAULT_API_ORIGIN } from "../src/credentials/origin.js";
import {
  parseCredentialDocument,
  serializeCredentialDocument,
  validateCredentialDocument,
  type ActiveCredentialV1,
  type CredentialV1,
  type PendingCredentialV1,
} from "../src/credentials/schema.js";
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
  NetworkAdapter,
  NetworkRequest,
  NetworkResponse,
  RandomAdapter,
  SystemCapabilities,
} from "../src/system/contracts.js";
import { snapshotPlatformAdapter } from "../src/system/platform-snapshot.js";
import { createInMemoryCredentialMutationStore } from "./support/in-memory-credential-mutation-store.js";
import { createInMemoryCredentialObservationStore } from "./support/in-memory-credential-observation-store.js";
import { createTestSystem } from "./support/system.js";

const KEY_A = `plrm_live_${"A".repeat(43)}`;
const KEY_B = `plrm_live_${"B".repeat(43)}`;
const AGENT_A = "00000000-0000-4000-8000-000000000011";
const AGENT_B = "00000000-0000-4000-8000-000000000012";
const OPERATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const RETRY_OPERATION_ID = "123e4567-e89b-42d3-a456-426614174001";
const REQUEST_ID = "ca908d9f-d901-4dac-b396-7f84377adfc8";
const CREATED_AT = "2026-07-21T09:10:11.123Z";
const RETRY_CREATED_AT = "2026-07-21T09:12:11.123Z";
const ACTIVATED_AT = "2026-07-21T09:11:11.123Z";
const BASE_TIME = Date.parse("2026-07-21T12:00:00.000Z");
const DIRECTORY = "/isolated/plurum";
const TEST_PLATFORM = snapshotPlatformAdapter(createTestSystem().platform);

interface AgentIdentity {
  readonly id: string;
  readonly name: string;
  readonly username: string | null;
}

type PostMode =
  | "normal"
  | "username_unavailable"
  | "rate_limit"
  | "unavailable";

interface FakeServerOptions {
  readonly agents?: Readonly<Record<string, AgentIdentity>>;
  readonly usernameAvailable?:
    | boolean
    | ((call: number, username: string) => boolean);
  readonly suggestions?: readonly string[];
  readonly postMode?:
    | PostMode
    | ((call: number, body: Readonly<Record<string, unknown>>) => PostMode);
  readonly onEvent?: (event: string) => void;
  readonly meOverride?: (
    call: number,
    apiKey: string,
  ) => NetworkResponse | undefined;
}

interface FakeServer {
  readonly network: NetworkAdapter;
  readonly control: Readonly<{
    events(): readonly string[];
    meCalls(): number;
    usernameCalls(): number;
    postCalls(): number;
    postBodies(): readonly Readonly<Record<string, unknown>>[];
  }>;
}

interface DeterministicRandom extends RandomAdapter {
  readonly counters: Readonly<{
    bytes(): number;
    uuids(): number;
  }>;
}

function encodedJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function jsonResponse(status: number, value: unknown): NetworkResponse {
  return Object.freeze({
    status,
    headers: Object.freeze({ "content-type": "application/json" }),
    body: encodedJson(value),
  });
}

function bearerKey(request: NetworkRequest): string {
  const value = request.headers.Authorization;
  if (typeof value !== "string" || !value.startsWith("Bearer ")) {
    throw new Error("expected fake bearer credential");
  }
  return value.slice("Bearer ".length);
}

function requestObject(
  request: NetworkRequest,
): Readonly<Record<string, unknown>> {
  if (!(request.body instanceof Uint8Array)) {
    throw new Error("expected fake JSON request body");
  }
  const copy = request.body.slice();
  try {
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(copy),
    ) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected fake JSON object body");
    }
    return Object.freeze({ ...(parsed as Record<string, unknown>) });
  } finally {
    copy.fill(0);
  }
}

function createFakeServer(options: FakeServerOptions = {}): FakeServer {
  const agents = new Map<string, AgentIdentity>(
    Object.entries(options.agents ?? {}),
  );
  const events: string[] = [];
  const postBodies: Readonly<Record<string, unknown>>[] = [];
  let meCalls = 0;
  let usernameCalls = 0;
  let postCalls = 0;
  let candidateKey: string | undefined;

  function event(value: string): void {
    events.push(value);
    options.onEvent?.(value);
  }

  const network: NetworkAdapter = Object.freeze({
    async request(request: NetworkRequest): Promise<NetworkResponse> {
      if (
        request.method === "GET" &&
        request.url === `${DEFAULT_API_ORIGIN}/api/v1/agents/me`
      ) {
        meCalls += 1;
        const apiKey = bearerKey(request);
        candidateKey = apiKey;
        event(`me:${meCalls}`);
        const override = options.meOverride?.(meCalls, apiKey);
        if (override !== undefined) {
          return override;
        }
        const agent = agents.get(apiKey);
        return agent === undefined
          ? jsonResponse(401, { error: "invalid" })
          : jsonResponse(200, {
              ...agent,
              is_active: true,
            });
      }

      if (
        request.method === "GET" &&
        request.url.startsWith(
          `${DEFAULT_API_ORIGIN}/api/v1/agents/check-username?username=`,
        )
      ) {
        usernameCalls += 1;
        event(`username:${usernameCalls}`);
        const username = decodeURIComponent(
          request.url.slice(request.url.indexOf("=") + 1),
        );
        const available =
          typeof options.usernameAvailable === "function"
            ? options.usernameAvailable(usernameCalls, username)
            : options.usernameAvailable !== false;
        return jsonResponse(200, {
          available,
          suggestions: available ? [] : [...(options.suggestions ?? [])],
        });
      }

      if (
        request.method !== "POST" ||
        request.url !== `${DEFAULT_API_ORIGIN}/api/v1/agents/register/cli`
      ) {
        throw new Error("unexpected fake network request");
      }
      postCalls += 1;
      event(`post:${postCalls}`);
      const body = requestObject(request);
      postBodies.push(body);
      const postMode =
        typeof options.postMode === "function"
          ? options.postMode(postCalls, body)
          : options.postMode ?? "normal";
      if (postMode === "rate_limit") {
        return jsonResponse(429, { error: "rate_limited" });
      }
      if (postMode === "username_unavailable") {
        return jsonResponse(409, { error: "username_unavailable" });
      }
      if (postMode === "unavailable") {
        throw new Error("simulated fake registration outage");
      }
      if (candidateKey === undefined) {
        throw new Error("registration must validate its pending key first");
      }
      const agent = Object.freeze({
        id: AGENT_A,
        name: String(body.name),
        username: String(body.username),
      });
      agents.set(candidateKey, agent);
      return jsonResponse(200, {
        agent_id: agent.id,
        disposition: "created",
      });
    },
  });

  return Object.freeze({
    network,
    control: Object.freeze({
      events: () => Object.freeze([...events]),
      meCalls: () => meCalls,
      usernameCalls: () => usernameCalls,
      postCalls: () => postCalls,
      postBodies: () => Object.freeze([...postBodies]),
    }),
  });
}

function createRandom(): DeterministicRandom {
  let byteCalls = 0;
  let uuidCalls = 0;
  return Object.freeze({
    bytes(length: number): Uint8Array {
      byteCalls += 1;
      return new Uint8Array(length).fill(0x41 + byteCalls - 1);
    },
    uuid(): string {
      uuidCalls += 1;
      return `00000000-0000-4000-8000-${uuidCalls
        .toString()
        .padStart(12, "0")}`;
    },
    counters: Object.freeze({
      bytes: () => byteCalls,
      uuids: () => uuidCalls,
    }),
  });
}

function createClock() {
  let calls = 0;
  return Object.freeze({
    now(): number {
      const value = BASE_TIME + calls * 1_000;
      calls += 1;
      return value;
    },
  });
}

function activeCredential(
  apiKey = KEY_A,
  agent: AgentIdentity = Object.freeze({
    id: AGENT_A,
    name: "Codex",
    username: "agent-alpha",
  }),
): ActiveCredentialV1 {
  const credential = validateCredentialDocument({
    schema_version: 1,
    state: "active",
    api_origin: DEFAULT_API_ORIGIN,
    api_key: apiKey,
    agent_id: agent.id,
    agent_name: agent.name,
    username: agent.username,
    registration_request_id: REQUEST_ID,
    created_at: CREATED_AT,
    updated_at: ACTIVATED_AT,
    activated_at: ACTIVATED_AT,
  });
  if (credential.state !== "active") {
    throw new Error("expected active fixture");
  }
  return credential;
}

function pendingCredential(apiKey = KEY_A): PendingCredentialV1 {
  const credential = validateCredentialDocument({
    schema_version: 1,
    state: "pending",
    api_origin: DEFAULT_API_ORIGIN,
    api_key: apiKey,
    agent_id: null,
    agent_name: "Codex",
    username: "codex-agent",
    registration_request_id: REQUEST_ID,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    activated_at: null,
  });
  if (credential.state !== "pending") {
    throw new Error("expected pending fixture");
  }
  return credential;
}

function credentialBytes(credential: CredentialV1): Uint8Array {
  return new TextEncoder().encode(serializeCredentialDocument(credential));
}

function readCredential(bytes: Uint8Array | undefined): CredentialV1 | null {
  if (bytes === undefined) {
    return null;
  }
  try {
    return parseCredentialDocument(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } finally {
    bytes.fill(0);
  }
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
      throw new Error("registration execution must not mutate a host");
    },
    async rollback() {
      throw new Error("registration execution must not mutate a host");
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

function projectionAdapter(status: CodexDotenvProjectionStatus) {
  const native: CodexDotenvNativeAdapter = Object.freeze({
    async observe() {
      return Object.freeze({
        revision: "projection-private-revision",
        status,
      });
    },
    async synchronize() {
      throw new Error("registration execution must not mutate the projection");
    },
  });
  return createCodexDotenvProjectionAdapter(native);
}

interface PreparedExecution {
  readonly authority: CodexDotenvSetupObservationAuthority;
  readonly attempt: SetupRegistrationExecutionAttempt;
  readonly mutation: ReturnType<typeof createInMemoryCredentialMutationStore>;
  readonly random: DeterministicRandom;
}

interface PrepareExecutionOptions {
  readonly credential: CredentialV1 | null;
  readonly server: FakeServer;
  readonly registration?: Readonly<{
    readonly agentName: string;
    readonly username: string;
  }>;
  readonly protectedKey?: string;
  readonly projectionStatus?: CodexDotenvProjectionStatus;
  readonly failRelease?: boolean;
  readonly onStoreOperation?: (operation: string) => void;
}

async function prepareExecution(
  options: PrepareExecutionOptions,
): Promise<PreparedExecution> {
  const initialBytes =
    options.credential === null
      ? undefined
      : credentialBytes(options.credential);
  const mutation = createInMemoryCredentialMutationStore({
    ...(initialBytes === undefined ? {} : { initialCredential: initialBytes }),
    ...(options.failRelease === true ? { failRelease: true } : {}),
    ...(options.onStoreOperation === undefined
      ? {}
      : { onOperation: options.onStoreOperation }),
  });
  initialBytes?.fill(0);
  const observedStore = createInMemoryCredentialObservationStore({
    directoryMissing() {
      const bytes = mutation.control.readDurableCredential();
      try {
        return bytes === undefined;
      } finally {
        bytes?.fill(0);
      }
    },
    credentialBytes() {
      return mutation.control.readDurableCredential();
    },
    finishEvidence() {
      return mutation.control.observeWholePass();
    },
  });
  const store = createCredentialStoreObservationAuthority(
    observedStore.adapter,
  );
  const random = createRandom();
  const dependencies: SetupRegistrationExecutionDependencies = Object.freeze({
    storage: mutation.adapter,
    network: options.server.network,
    clock: createClock(),
    random,
    hash: nodeHash,
  });
  const legacy: LegacyCredentialReadAdapter = Object.freeze({
    async read() {
      return Object.freeze({ status: "missing" as const });
    },
  });
  const authority = createCodexDotenvSetupObservationAuthority({
    approval: createSetupApprovalAuthority(),
    store,
    discovery: Object.freeze({
      credentialEnvironment: Object.freeze({
        read: () => Object.freeze({}),
      }),
      legacyStore: legacy,
      hash: nodeHash,
      platform: TEST_PLATFORM,
      network: options.server.network,
    }),
    execution: dependencies,
    codexProjection: projectionAdapter(
      options.projectionStatus ??
        (options.credential === null ? "absent" : "exact"),
    ),
    preflight: await preflight(),
  });
  const inspected = await authority.inspect();
  if (inspected.status !== "available") {
    throw new Error("expected available setup observation");
  }
  let identity = inspected.identity;
  if (options.protectedKey !== undefined) {
    const retained = retainFramedSetupCredentialInput(
      new TextEncoder().encode(`${options.protectedKey}\n`),
      "interactive-line",
    );
    if (retained === undefined) {
      throw new Error("expected protected input fixture");
    }
    const resolved = await authority.resolveCredentialInput({
      identity,
      credential: retained,
    });
    if (resolved.status !== "available") {
      throw new Error("expected resolved protected input");
    }
    identity = resolved.identity;
  }
  const prepared = await authority.prepare({
    identity,
    decision: Object.freeze({
      selectedCandidateId: null,
      registration: options.registration ?? null,
    }),
    operationId: OPERATION_ID,
    createdAt: CREATED_AT,
  });
  if (prepared.status !== "prepared") {
    throw new Error(`expected prepared setup plan: ${prepared.status}`);
  }
  const ports = createSetupInteractiveSessionPorts(
    async () => "presented",
    async () => "confirmed",
  );
  const approved = await authority
    .createConfirmation(
      prepared.plan,
      prepared.sidecar,
      "interactive",
      ports.presenter,
      ports.confirmation,
    )
    .authorize();
  if (approved.status !== "approved") {
    throw new Error("expected approved setup plan");
  }
  return Object.freeze({
    authority,
    attempt: authority.createRegistrationExecution(
      prepared.plan,
      approved.grant,
    ),
    mutation,
    random,
  });
}

async function prepareApprovedRetry(
  authority: CodexDotenvSetupObservationAuthority,
  identity: Extract<
    Awaited<ReturnType<CodexDotenvSetupObservationAuthority["inspectUsernameConflict"]>>,
    { status: "available" }
  >["identity"],
  registration: Readonly<{ readonly agentName: string; readonly username: string }>,
) {
  const prepared = await authority.prepare({
    identity,
    decision: Object.freeze({
      selectedCandidateId: null,
      registration,
    }),
    operationId: RETRY_OPERATION_ID,
    createdAt: RETRY_CREATED_AT,
  });
  if (prepared.status !== "prepared") {
    throw new Error("expected prepared username retry");
  }
  const ports = createSetupInteractiveSessionPorts(
    async () => "presented",
    async () => "confirmed",
  );
  const approved = await authority
    .createConfirmation(
      prepared.plan,
      prepared.sidecar,
      "interactive",
      ports.presenter,
      ports.confirmation,
    )
    .authorize();
  if (approved.status !== "approved") {
    throw new Error("expected approved username retry");
  }
  return Object.freeze({
    plan: prepared.plan,
    attempt: authority.createRegistrationExecution(
      prepared.plan,
      approved.grant,
    ),
  });
}

describe("approved setup registration execution", () => {
  it("reuses the exact canonical credential and grants host setup only after final verification", async () => {
    const agent = Object.freeze({
      id: AGENT_A,
      name: "Codex",
      username: "agent-alpha",
    });
    const credential = activeCredential(KEY_A, agent);
    const server = createFakeServer({ agents: { [KEY_A]: agent } });
    const prepared = await prepareExecution({ credential, server });

    const result = await prepared.attempt.execute();

    expect(result).toMatchObject({ status: "ready", agent });
    expect(JSON.stringify(result)).not.toContain(KEY_A);
    expect(server.control.meCalls()).toBe(3);
    expect(server.control.usernameCalls()).toBe(0);
    expect(server.control.postCalls()).toBe(0);
    expect(prepared.random.counters.bytes()).toBe(0);
    expect(prepared.random.counters.uuids()).toBe(0);
    expect(
      prepared.mutation.trace
        .operations()
        .some((operation) => operation.startsWith("write:")),
    ).toBe(false);
    expect(readCredential(prepared.mutation.control.readCredential())).toEqual(
      credential,
    );
    if (result.status !== "ready") {
      throw new Error("expected host continuation grant");
    }
    expect(JSON.stringify(result.grant)).toBeUndefined();
    expect(discardSetupHostConfigurationGrant(result.grant)).toEqual({
      status: "discarded",
    });
    expect(discardSetupHostConfigurationGrant(result.grant)).toEqual({
      status: "precondition-failed",
    });
    await expect(prepared.attempt.execute()).resolves.toEqual({
      status: "precondition-failed",
    });
  });

  it("accepts owner-edited active profile labels while keeping stable agent-ID identity", async () => {
    const storedAgent = Object.freeze({
      id: AGENT_A,
      name: "Codex",
      username: "agent-alpha",
    });
    const liveAgent = Object.freeze({
      id: AGENT_A,
      name: "Renamed Codex",
      username: "agent-renamed",
    });
    const credential = activeCredential(KEY_A, storedAgent);
    const server = createFakeServer({ agents: { [KEY_A]: liveAgent } });
    const prepared = await prepareExecution({ credential, server });

    const result = await prepared.attempt.execute();

    expect(result).toMatchObject({ status: "ready", agent: liveAgent });
    expect(readCredential(prepared.mutation.control.readCredential())).toEqual(
      credential,
    );
  });

  it("safely adopts protected input, persists it durably, and re-attests its exact identity", async () => {
    const agent = Object.freeze({
      id: AGENT_B,
      name: "Claude Code",
      username: "agent-beta",
    });
    const server = createFakeServer({ agents: { [KEY_B]: agent } });
    const prepared = await prepareExecution({
      credential: null,
      protectedKey: KEY_B,
      server,
    });

    const result = await prepared.attempt.execute();
    const persisted = readCredential(
      prepared.mutation.control.readDurableCredential(),
    );

    expect(result).toMatchObject({ status: "ready", agent });
    expect(JSON.stringify(result)).not.toContain(KEY_B);
    expect(persisted).toMatchObject({
      state: "active",
      api_key: KEY_B,
      agent_id: AGENT_B,
      registration_request_id: null,
    });
    expect(server.control.meCalls()).toBe(3);
    expect(server.control.postCalls()).toBe(0);
    expect(
      prepared.mutation.trace
        .operations()
        .some((operation) => operation.startsWith("write:")),
    ).toBe(true);
  });

  it("rejects a protected key whose stable agent identity changes after approval", async () => {
    const plannedAgent = Object.freeze({
      id: AGENT_B,
      name: "Claude Code",
      username: "agent-beta",
    });
    const server = createFakeServer({
      agents: { [KEY_B]: plannedAgent },
      meOverride(call, apiKey) {
        return call === 2 && apiKey === KEY_B
          ? jsonResponse(200, {
              id: AGENT_A,
              name: "Different agent",
              username: "different-agent",
              is_active: true,
            })
          : undefined;
      },
    });
    const prepared = await prepareExecution({
      credential: null,
      protectedKey: KEY_B,
      server,
    });

    await expect(prepared.attempt.execute()).resolves.toEqual({
      status: "blocked",
      reason: "identity_mismatch",
    });
    expect(server.control.meCalls()).toBe(2);
    expect(prepared.mutation.control.readDurableCredential()).toBeUndefined();
    expect(
      prepared.mutation.trace
        .operations()
        .some((operation) => operation.startsWith("write:")),
    ).toBe(false);
  });

  it("revalidates an invalid-canonical replacement premise before destroying the old key", async () => {
    const oldAgent = Object.freeze({
      id: AGENT_A,
      name: "Codex",
      username: "agent-alpha",
    });
    const replacementAgent = Object.freeze({
      id: AGENT_B,
      name: "Claude Code",
      username: "agent-beta",
    });
    const credential = activeCredential(KEY_A, oldAgent);
    const server = createFakeServer({
      agents: { [KEY_B]: replacementAgent },
      meOverride(call, apiKey) {
        return call === 3 && apiKey === KEY_A
          ? jsonResponse(200, { ...oldAgent, is_active: true })
          : undefined;
      },
    });
    const prepared = await prepareExecution({
      credential,
      protectedKey: KEY_B,
      server,
      projectionStatus: "mismatched",
    });

    await expect(prepared.attempt.execute()).resolves.toEqual({
      status: "precondition-failed",
    });
    expect(readCredential(prepared.mutation.control.readCredential())).toEqual(
      credential,
    );
    expect(
      prepared.mutation.trace
        .operations()
        .some((operation) => operation.startsWith("write:")),
    ).toBe(false);
    expect(server.control.meCalls()).toBe(3);
  });

  it("creates pending state before registration, activates it, and returns only a post-release continuation", async () => {
    const timeline: string[] = [];
    const server = createFakeServer({
      onEvent: (event) => timeline.push(`network:${event}`),
    });
    const prepared = await prepareExecution({
      credential: null,
      server,
      registration: { agentName: "Codex", username: "codex-agent" },
      onStoreOperation: (operation) => timeline.push(`store:${operation}`),
    });

    const result = await prepared.attempt.execute();
    const persisted = readCredential(
      prepared.mutation.control.readDurableCredential(),
    );
    const firstPendingWrite = timeline.findIndex((entry) =>
      entry.startsWith("store:write:.credentials-candidate-"),
    );
    const post = timeline.indexOf("network:post:1");
    const release = timeline.lastIndexOf("store:release");

    expect(result).toMatchObject({
      status: "ready",
      agent: { id: AGENT_A, name: "Codex", username: "codex-agent" },
    });
    expect(persisted).toMatchObject({
      state: "active",
      agent_id: AGENT_A,
      agent_name: "Codex",
      username: "codex-agent",
    });
    expect(server.control.usernameCalls()).toBe(1);
    expect(server.control.postCalls()).toBe(1);
    expect(firstPendingWrite).toBeGreaterThan(-1);
    expect(firstPendingWrite).toBeLessThan(post);
    expect(release).toBeGreaterThan(post);
    expect(JSON.stringify(server.control.postBodies())).not.toContain(
      persisted?.state === "active" ? persisted.api_key : KEY_A,
    );
    expect(prepared.random.counters.bytes()).toBe(1);
    expect(prepared.random.counters.uuids()).toBeGreaterThan(0);
  });

  it("stops before randomness, persistence, or POST when the requested username is unavailable", async () => {
    const server = createFakeServer({
      usernameAvailable: false,
      suggestions: ["codex-agent-2", "codex-agent-3"],
    });
    const prepared = await prepareExecution({
      credential: null,
      server,
      registration: { agentName: "Codex", username: "codex-agent" },
    });

    const result = await prepared.attempt.execute();
    expect(result).toEqual({
      status: "blocked",
      reason: "username_unavailable",
      suggestions: ["codex-agent-2", "codex-agent-3"],
    });
    expect(
      result.status === "blocked" ? result.continuation : undefined,
    ).toBeUndefined();
    expect(server.control.usernameCalls()).toBe(1);
    expect(server.control.meCalls()).toBe(0);
    expect(server.control.postCalls()).toBe(0);
    expect(prepared.random.counters.bytes()).toBe(0);
    expect(prepared.random.counters.uuids()).toBe(0);
    expect(prepared.mutation.control.readCredential()).toBeUndefined();
  });

  it("retains one pending credential and never auto-selects a suggestion after a late username race", async () => {
    const server = createFakeServer({
      postMode: "username_unavailable",
      usernameAvailable: true,
    });
    const prepared = await prepareExecution({
      credential: null,
      server,
      registration: { agentName: "Codex", username: "codex-agent" },
    });

    const result = await prepared.attempt.execute();
    const persisted = readCredential(
      prepared.mutation.control.readDurableCredential(),
    );

    expect(result).toEqual({
      status: "blocked",
      reason: "username_unavailable",
    });
    expect(
      result.status === "blocked" ? result.continuation : undefined,
    ).toBeDefined();
    expect(server.control.usernameCalls()).toBe(2);
    expect(server.control.postCalls()).toBe(1);
    expect(persisted).toMatchObject({
      state: "pending",
      username: "codex-agent",
    });
    expect(prepared.random.counters.bytes()).toBe(1);
  });

  it("requires a fresh observation, plan, and approval before retrying an authoritative username conflict", async () => {
    const server = createFakeServer({
      postMode: (call) =>
        call === 1 ? "username_unavailable" : "normal",
      usernameAvailable: true,
    });
    const prepared = await prepareExecution({
      credential: null,
      server,
      registration: { agentName: "Codex", username: "codex-agent" },
    });

    const first = await prepared.attempt.execute();
    if (
      first.status !== "blocked" ||
      first.reason !== "username_unavailable" ||
      first.continuation === undefined
    ) {
      throw new Error("expected authoritative username continuation");
    }
    const pendingBefore = readCredential(
      prepared.mutation.control.readDurableCredential(),
    );
    if (pendingBefore?.state !== "pending") {
      throw new Error("expected exact retained pending credential");
    }
    expect(Object.keys(first.continuation)).toEqual([]);
    expect(JSON.stringify(first)).not.toContain(pendingBefore.api_key);
    expect(JSON.stringify(first)).not.toContain(
      pendingBefore.registration_request_id,
    );
    expect(server.control.postCalls()).toBe(1);

    const inspected = await prepared.authority.inspectUsernameConflict(
      first.continuation,
    );
    if (inspected.status !== "available") {
      throw new Error("expected fresh username-conflict observation");
    }
    expect(inspected.initial).toEqual({
      status: "registration-input-required",
      reason: "username-conflict",
      apiOrigin: DEFAULT_API_ORIGIN,
      canonicalEffect: "resume",
      invalidSources: ["canonical"],
    });
    await expect(
      prepared.authority.inspectUsernameConflict(first.continuation),
    ).resolves.toEqual({ status: "precondition-failed" });

    const retry = await prepareApprovedRetry(
      prepared.authority,
      inspected.identity,
      { agentName: "Codex", username: "codex-agent-2" },
    );
    expect(retry.plan.preview.credential.resolution).toMatchObject({
      acquisition: "username-conflict-retry",
      canonicalEffect: "resume",
      registration: {
        mode: "username-retry",
        previousUsername: "codex-agent",
        agent: { name: "Codex", username: "codex-agent-2" },
      },
    });
    const rendered = renderSetupApplyPlan(retry.plan);
    expect(rendered).toContain("registration mode: username-retry");
    expect(rendered).toContain('previous username: "codex-agent"');
    expect(rendered).toContain('username: "codex-agent-2"');
    expect(rendered).not.toContain(pendingBefore.api_key);
    expect(rendered).not.toContain(pendingBefore.registration_request_id);

    const second = await retry.attempt.execute();
    if (second.status !== "ready") {
      throw new Error(`expected ready retry, received ${second.status}`);
    }
    const active = readCredential(
      prepared.mutation.control.readDurableCredential(),
    );
    expect(active).toMatchObject({
      state: "active",
      api_key: pendingBefore.api_key,
      agent_name: "Codex",
      username: "codex-agent-2",
    });
    expect(active?.registration_request_id).not.toBe(
      pendingBefore.registration_request_id,
    );
    expect(server.control.postCalls()).toBe(2);
    expect(server.control.postBodies().map((body) => body.username)).toEqual([
      "codex-agent",
      "codex-agent-2",
    ]);
    expect(
      server.control.postBodies().map((body) => body.registration_request_id),
    ).toEqual([
      pendingBefore.registration_request_id,
      active?.registration_request_id,
    ]);
    expect(prepared.random.counters.bytes()).toBe(1);
    expect(prepared.random.counters.uuids()).toBeGreaterThan(1);
    expect(discardSetupHostConfigurationGrant(second.grant)).toEqual({
      status: "discarded",
    });
  });

  it("issues a new continuation when an approved replacement username loses an advisory race", async () => {
    const server = createFakeServer({
      postMode: "username_unavailable",
      usernameAvailable: (call) => call !== 3,
      suggestions: ["codex-agent-3"],
    });
    const prepared = await prepareExecution({
      credential: null,
      server,
      registration: { agentName: "Codex", username: "codex-agent" },
    });
    const first = await prepared.attempt.execute();
    if (
      first.status !== "blocked" ||
      first.reason !== "username_unavailable" ||
      first.continuation === undefined
    ) {
      throw new Error("expected first username conflict continuation");
    }
    const pendingBefore = readCredential(
      prepared.mutation.control.readDurableCredential(),
    );
    if (pendingBefore?.state !== "pending") {
      throw new Error("expected pending credential before retry");
    }
    const inspected = await prepared.authority.inspectUsernameConflict(
      first.continuation,
    );
    if (inspected.status !== "available") {
      throw new Error("expected retry observation");
    }
    const retry = await prepareApprovedRetry(
      prepared.authority,
      inspected.identity,
      { agentName: "Codex", username: "codex-agent-2" },
    );

    const second = await retry.attempt.execute();
    if (
      second.status !== "blocked" ||
      second.reason !== "username_unavailable" ||
      second.continuation === undefined
    ) {
      throw new Error("expected replacement username continuation");
    }
    expect(second.suggestions).toEqual(["codex-agent-3"]);
    expect(server.control.postCalls()).toBe(1);
    expect(readCredential(
      prepared.mutation.control.readDurableCredential(),
    )).toEqual(pendingBefore);
    expect(prepared.authority.discard(second.continuation)).toEqual({
      status: "discarded",
    });
  });

  it("binds a repeated authoritative conflict to the newly persisted pending generation", async () => {
    const server = createFakeServer({
      postMode: "username_unavailable",
      usernameAvailable: true,
    });
    const prepared = await prepareExecution({
      credential: null,
      server,
      registration: { agentName: "Codex", username: "codex-agent" },
    });
    const first = await prepared.attempt.execute();
    if (
      first.status !== "blocked" ||
      first.reason !== "username_unavailable" ||
      first.continuation === undefined
    ) {
      throw new Error("expected first authoritative conflict");
    }
    const oldPending = readCredential(
      prepared.mutation.control.readDurableCredential(),
    );
    if (oldPending?.state !== "pending") {
      throw new Error("expected old pending generation");
    }
    const inspected = await prepared.authority.inspectUsernameConflict(
      first.continuation,
    );
    if (inspected.status !== "available") {
      throw new Error("expected retry observation");
    }
    const retry = await prepareApprovedRetry(
      prepared.authority,
      inspected.identity,
      { agentName: "Codex", username: "codex-agent-2" },
    );

    const second = await retry.attempt.execute();
    if (
      second.status !== "blocked" ||
      second.reason !== "username_unavailable" ||
      second.continuation === undefined
    ) {
      throw new Error("expected second authoritative conflict");
    }
    const newPending = readCredential(
      prepared.mutation.control.readDurableCredential(),
    );
    expect(newPending).toMatchObject({
      state: "pending",
      api_key: oldPending.api_key,
      username: "codex-agent-2",
    });
    expect(newPending?.registration_request_id).not.toBe(
      oldPending.registration_request_id,
    );
    expect(server.control.postCalls()).toBe(2);
    expect(prepared.authority.discard(second.continuation)).toEqual({
      status: "discarded",
    });
  });

  it("burns a continuation presented to the wrong setup authority", async () => {
    const server = createFakeServer({
      postMode: "username_unavailable",
      usernameAvailable: true,
    });
    const prepared = await prepareExecution({
      credential: null,
      server,
      registration: { agentName: "Codex", username: "codex-agent" },
    });
    const result = await prepared.attempt.execute();
    if (
      result.status !== "blocked" ||
      result.reason !== "username_unavailable" ||
      result.continuation === undefined
    ) {
      throw new Error("expected authoritative conflict continuation");
    }
    const other = await prepareExecution({
      credential: null,
      server: createFakeServer(),
      registration: { agentName: "Other", username: "other-agent" },
    });

    await expect(
      other.authority.inspectUsernameConflict(result.continuation),
    ).resolves.toEqual({ status: "precondition-failed" });
    await expect(
      prepared.authority.inspectUsernameConflict(result.continuation),
    ).resolves.toEqual({ status: "precondition-failed" });
    expect(other.attempt.discard()).toEqual({ status: "discarded" });
  });

  it("rejects a continuation when the pending generation changed before reinspection", async () => {
    const server = createFakeServer({
      postMode: "username_unavailable",
      usernameAvailable: true,
    });
    const prepared = await prepareExecution({
      credential: null,
      server,
      registration: { agentName: "Codex", username: "codex-agent" },
    });
    const result = await prepared.attempt.execute();
    if (
      result.status !== "blocked" ||
      result.reason !== "username_unavailable" ||
      result.continuation === undefined
    ) {
      throw new Error("expected username conflict continuation");
    }
    const pending = readCredential(
      prepared.mutation.control.readDurableCredential(),
    );
    if (pending?.state !== "pending") {
      throw new Error("expected pending credential");
    }
    const changed = validateCredentialDocument({
      ...pending,
      username: "changed-outside-setup",
      updated_at: "2026-07-21T12:30:00.000Z",
    });
    const changedBytes = credentialBytes(changed);
    try {
      prepared.mutation.control.replaceCredentialUnrelated(changedBytes);
    } finally {
      changedBytes.fill(0);
    }

    await expect(
      prepared.authority.inspectUsernameConflict(result.continuation),
    ).resolves.toEqual({ status: "precondition-failed" });
    await expect(
      prepared.authority.inspectUsernameConflict(result.continuation),
    ).resolves.toEqual({ status: "precondition-failed" });
  });

  it("revalidates the fresh pending observation before an approved username retry does any work", async () => {
    const server = createFakeServer({
      postMode: (call) =>
        call === 1 ? "username_unavailable" : "normal",
      usernameAvailable: true,
    });
    const prepared = await prepareExecution({
      credential: null,
      server,
      registration: { agentName: "Codex", username: "codex-agent" },
    });
    const first = await prepared.attempt.execute();
    if (
      first.status !== "blocked" ||
      first.reason !== "username_unavailable" ||
      first.continuation === undefined
    ) {
      throw new Error("expected username conflict continuation");
    }
    const inspected = await prepared.authority.inspectUsernameConflict(
      first.continuation,
    );
    if (inspected.status !== "available") {
      throw new Error("expected retry observation");
    }
    const retry = await prepareApprovedRetry(
      prepared.authority,
      inspected.identity,
      { agentName: "Codex", username: "codex-agent-2" },
    );
    const replacementBytes = credentialBytes(activeCredential());
    try {
      prepared.mutation.control.replaceCredentialUnrelated(replacementBytes);
    } finally {
      replacementBytes.fill(0);
    }
    const eventsBefore = server.control.events().length;
    const uuidCallsBefore = prepared.random.counters.uuids();

    await expect(retry.attempt.execute()).resolves.toEqual({
      status: "precondition-failed",
    });
    expect(server.control.events()).toHaveLength(eventsBefore);
    expect(prepared.random.counters.uuids()).toBe(uuidCallsBefore);
    expect(server.control.postCalls()).toBe(1);
  });

  it("leaves pending metadata untouched when the key becomes active after retry approval", async () => {
    const remotelyActive = Object.freeze({
      id: AGENT_A,
      name: "Codex",
      username: "codex-agent",
    });
    const server = createFakeServer({
      postMode: "username_unavailable",
      usernameAvailable: true,
      meOverride(call) {
        return call === 3
          ? jsonResponse(200, {
              ...remotelyActive,
              is_active: true,
            })
          : undefined;
      },
    });
    const prepared = await prepareExecution({
      credential: null,
      server,
      registration: { agentName: "Codex", username: "codex-agent" },
    });
    const first = await prepared.attempt.execute();
    if (
      first.status !== "blocked" ||
      first.reason !== "username_unavailable" ||
      first.continuation === undefined
    ) {
      throw new Error("expected username conflict continuation");
    }
    const pending = readCredential(
      prepared.mutation.control.readDurableCredential(),
    );
    if (pending?.state !== "pending") {
      throw new Error("expected pending credential");
    }
    const inspected = await prepared.authority.inspectUsernameConflict(
      first.continuation,
    );
    if (inspected.status !== "available") {
      throw new Error("expected retry observation");
    }
    const retry = await prepareApprovedRetry(
      prepared.authority,
      inspected.identity,
      { agentName: "Codex", username: "codex-agent-2" },
    );
    const usernameCallsBefore = server.control.usernameCalls();
    const uuidCallsBefore = prepared.random.counters.uuids();
    const operationsBefore = prepared.mutation.trace.operations().length;

    await expect(retry.attempt.execute()).resolves.toEqual({
      status: "precondition-failed",
    });
    expect(server.control.postCalls()).toBe(1);
    expect(server.control.usernameCalls()).toBe(usernameCallsBefore);
    expect(prepared.random.counters.uuids()).toBe(uuidCallsBefore);
    expect(readCredential(
      prepared.mutation.control.readDurableCredential(),
    )).toEqual(pending);
    expect(
      prepared.mutation.trace
        .operations()
        .slice(operationsBefore)
        .some((operation) => operation.startsWith("write:")),
    ).toBe(false);
  });

  it("does not mint a continuation when release after a server conflict cannot be proven", async () => {
    const server = createFakeServer({
      postMode: "username_unavailable",
      usernameAvailable: true,
    });
    const prepared = await prepareExecution({
      credential: null,
      server,
      registration: { agentName: "Codex", username: "codex-agent" },
      failRelease: true,
    });

    const result = await prepared.attempt.execute();
    expect(result).toEqual({
      status: "retryable",
      reason: "credential_store_unavailable",
    });
    expect(
      result.status === "blocked" ? result.continuation : undefined,
    ).toBeUndefined();
    expect(server.control.postCalls()).toBe(1);
  });

  it("rejects stale observed state before network, randomness, or setup mutation", async () => {
    const server = createFakeServer();
    const prepared = await prepareExecution({
      credential: null,
      server,
      registration: { agentName: "Codex", username: "codex-agent" },
    });
    prepared.mutation.control.replaceCredentialUnrelated(
      credentialBytes(activeCredential()),
    );
    const operationsBefore = prepared.mutation.trace.operations().length;

    await expect(prepared.attempt.execute()).resolves.toEqual({
      status: "precondition-failed",
    });
    expect(server.control.events()).toEqual([]);
    expect(prepared.random.counters.bytes()).toBe(0);
    expect(prepared.random.counters.uuids()).toBe(0);
    expect(
      prepared.mutation.trace.operations().slice(operationsBefore),
    ).toEqual(["acquire-observed-lease"]);
  });

  it("does not mint host authority when final persisted identity proof disagrees", async () => {
    const agent = Object.freeze({
      id: AGENT_A,
      name: "Codex",
      username: "agent-alpha",
    });
    const server = createFakeServer({
      agents: { [KEY_A]: agent },
      meOverride(call) {
        return call === 3
          ? jsonResponse(200, {
              id: AGENT_B,
              name: "Codex",
              username: "agent-alpha",
              is_active: true,
            })
          : undefined;
      },
    });
    const prepared = await prepareExecution({
      credential: activeCredential(KEY_A, agent),
      server,
    });

    await expect(prepared.attempt.execute()).resolves.toEqual({
      status: "blocked",
      reason: "identity_mismatch",
    });
    expect(server.control.meCalls()).toBe(3);
  });

  it("withholds host authority when lease release cannot be proven", async () => {
    const agent = Object.freeze({
      id: AGENT_A,
      name: "Codex",
      username: "agent-alpha",
    });
    const server = createFakeServer({ agents: { [KEY_A]: agent } });
    const prepared = await prepareExecution({
      credential: activeCredential(KEY_A, agent),
      server,
      failRelease: true,
    });

    await expect(prepared.attempt.execute()).resolves.toEqual({
      status: "retryable",
      reason: "credential_store_unavailable",
    });
    expect(prepared.mutation.trace.operations()).toContain("release");
  });

  it("resumes an approved pending credential without generating replacement key material", async () => {
    const pending = pendingCredential();
    const agent = Object.freeze({
      id: AGENT_A,
      name: pending.agent_name,
      username: pending.username,
    });
    const server = createFakeServer({ agents: { [KEY_A]: agent } });
    const prepared = await prepareExecution({
      credential: pending,
      server,
      projectionStatus: "absent",
    });

    const result = await prepared.attempt.execute();
    const persisted = readCredential(
      prepared.mutation.control.readDurableCredential(),
    );

    expect(result).toMatchObject({ status: "ready", agent });
    expect(persisted).toMatchObject({
      state: "active",
      api_key: KEY_A,
      registration_request_id: REQUEST_ID,
      agent_id: AGENT_A,
    });
    expect(server.control.postCalls()).toBe(0);
    expect(prepared.random.counters.bytes()).toBe(0);
  });
});
