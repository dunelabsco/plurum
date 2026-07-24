import { describe, expect, it } from "vitest";

import { nodeHash } from "../src/adapters/node/hash.js";
import { CredentialError } from "../src/credentials/errors.js";
import { DEFAULT_API_ORIGIN } from "../src/credentials/origin.js";
import {
  parseApiKey,
  parseCredentialDocument,
  serializeCredentialDocument,
  type ActiveCredentialV1,
  type AgentName,
  type CanonicalTimestamp,
  type CredentialV1,
  type PendingCredentialV1,
  type Username,
  validateCredentialDocument,
} from "../src/credentials/schema.js";
import type {
  ExclusiveObservedCredentialSetupSession,
  VerifiedRegistrationAgent,
} from "../src/credentials/store-writer.js";
import { deriveRegistrationKeyCommitment } from "../src/registration/key-material.js";
import {
  prepareUsernameConflictRetry,
  runRecoverableAgentRegistration,
  runRecoverableAgentRegistrationInSession,
  type RecoverableRegistrationDependencies,
  type RecoverableRegistrationInput,
  type RecoverableRegistrationOperationDependencies,
} from "../src/registration/state-machine.js";
import type {
  NetworkAdapter,
  NetworkRequest,
  NetworkResponse,
  RandomAdapter,
} from "../src/system/contracts.js";
import {
  createInMemoryCredentialMutationStore,
  type InMemoryCredentialMutationStore,
  type InMemoryCredentialMutationStoreOptions,
} from "./support/in-memory-credential-mutation-store.js";

const LOCATIONS = Object.freeze({ directory: "/isolated/plurum" });
const INPUT: RecoverableRegistrationInput = Object.freeze({
  apiOrigin: DEFAULT_API_ORIGIN,
  agentName: "Codex" as AgentName,
  username: "codex-42" as Username,
});
const AGENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_AGENT_ID = "123e4567-e89b-42d3-a456-426614174001";
const BASE_TIME = Date.parse("2026-07-20T12:00:00.000Z");

type RegistrationConflict =
  | "idempotency_conflict"
  | "username_unavailable"
  | "credential_conflict";

type PostMode =
  | "normal"
  | "rate-limit"
  | "unavailable-before-commit"
  | "unavailable-after-commit"
  | RegistrationConflict;

interface DeterministicRandom extends RandomAdapter {
  readonly counters: Readonly<{
    bytes(): number;
    uuids(): number;
  }>;
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

interface RegistrationServerOptions {
  readonly postMode?: PostMode;
  readonly unavailableGetCalls?: readonly number[];
  readonly agentId?: string;
  readonly registrationAgentId?: string;
  readonly agentName?: string;
  readonly username?: string | null;
  readonly postGate?: Promise<void>;
  readonly onPost?: (body: Readonly<Record<string, unknown>>) => void;
}

interface RegistrationServer {
  readonly network: NetworkAdapter;
  readonly control: Readonly<{
    getCalls(): number;
    postCalls(): number;
    createdAgents(): number;
    postBodies(): readonly Readonly<Record<string, unknown>>[];
    deactivate(): void;
    setPostMode(mode: PostMode): void;
    setAgentProfile(name: string, username: string | null): void;
  }>;
}

interface MutationBoundary {
  readonly operation: string;
  readonly occurrence: number;
}

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return Object.freeze({
    promise,
    resolve(): void {
      resolvePromise?.();
    },
  });
}

function createDeterministicRandom(seed = 0x41): DeterministicRandom {
  let byteCalls = 0;
  let uuidCalls = 0;
  return Object.freeze({
    bytes(length: number): Uint8Array {
      byteCalls += 1;
      return new Uint8Array(length).fill(
        (seed + byteCalls - 1) & 0xff,
      );
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

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function jsonResponse(
  status: number,
  value: unknown = {},
): NetworkResponse {
  return {
    status,
    headers: Object.freeze({ "content-type": "application/json" }),
    body: encodeJson(value),
  };
}

function snapshotBody(
  request: NetworkRequest,
): Readonly<Record<string, unknown>> {
  if (!(request.body instanceof Uint8Array)) {
    throw new Error("expected a request body");
  }
  const copied = request.body.slice();
  try {
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(copied),
    ) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error("expected an object request");
    }
    return Object.freeze({
      ...(parsed as Record<string, unknown>),
    });
  } finally {
    copied.fill(0);
  }
}

function bearerKey(request: NetworkRequest): string {
  const authorization = request.headers.Authorization;
  if (
    typeof authorization !== "string" ||
    !authorization.startsWith("Bearer ")
  ) {
    throw new Error("expected bearer authorization");
  }
  return authorization.slice("Bearer ".length);
}

function createRegistrationServer(
  options: RegistrationServerOptions = {},
): RegistrationServer {
  let getCalls = 0;
  let postCalls = 0;
  let createdAgents = 0;
  let postMode: PostMode = options.postMode ?? "normal";
  let candidateKey: string | undefined;
  let committedKey: string | undefined;
  let committedBody: Readonly<Record<string, unknown>> | undefined;
  let active = true;
  let currentAgentName = options.agentName;
  let currentUsername = options.username;
  const postBodies: Readonly<Record<string, unknown>>[] = [];
  const unavailableGetCalls = new Set(options.unavailableGetCalls ?? []);

  const agentId = options.agentId ?? AGENT_ID;
  const registrationAgentId =
    options.registrationAgentId ?? agentId;
  const network: NetworkAdapter = Object.freeze({
    async request(request: NetworkRequest): Promise<NetworkResponse> {
      if (
        request.method === "GET" &&
        request.url ===
          "https://api.plurum.ai/api/v1/agents/me"
      ) {
        getCalls += 1;
        const key = bearerKey(request);
        candidateKey = key;
        if (unavailableGetCalls.has(getCalls)) {
          return jsonResponse(503, { error: "unavailable" });
        }
        if (!active || committedKey !== key) {
          return jsonResponse(401, { error: "invalid" });
        }
        return jsonResponse(200, {
          id: agentId,
          name:
            currentAgentName ??
            committedBody?.name ??
            INPUT.agentName,
          username:
            currentUsername !== undefined
              ? currentUsername
              : committedBody?.username ?? INPUT.username,
          api_key_prefix: "not-consumed",
          is_active: true,
        });
      }

      if (
        request.method !== "POST" ||
        request.url !==
          "https://api.plurum.ai/api/v1/agents/register/cli"
      ) {
        throw new Error("unexpected fake-network request");
      }

      postCalls += 1;
      const body = snapshotBody(request);
      postBodies.push(body);
      options.onPost?.(body);
      await options.postGate;

      if (postMode === "rate-limit") {
        return jsonResponse(429, { error: "rate_limited" });
      }
      if (
        postMode === "idempotency_conflict" ||
        postMode === "username_unavailable" ||
        postMode === "credential_conflict"
      ) {
        return jsonResponse(409, { error: postMode });
      }
      if (postMode === "unavailable-before-commit") {
        throw new Error("simulated fixed transport failure");
      }
      if (candidateKey === undefined) {
        throw new Error("registration was not preceded by validation");
      }
      const commitment = deriveRegistrationKeyCommitment(
        parseApiKey(candidateKey),
        nodeHash,
      );
      if (
        body.api_key_hash !== commitment.apiKeyHash ||
        body.api_key_prefix !== commitment.apiKeyPrefix
      ) {
        return jsonResponse(409, { error: "credential_conflict" });
      }

      let createdThisCall = false;
      if (committedBody === undefined) {
        committedBody = body;
        committedKey = candidateKey;
        createdAgents += 1;
        createdThisCall = true;
      } else if (
        JSON.stringify(committedBody) !== JSON.stringify(body)
      ) {
        return jsonResponse(409, { error: "idempotency_conflict" });
      }

      if (postMode === "unavailable-after-commit") {
        throw new Error("simulated lost response");
      }
      return jsonResponse(200, {
        agent_id: registrationAgentId,
        disposition: createdThisCall ? "created" : "replayed",
      });
    },
  });

  return Object.freeze({
    network,
    control: Object.freeze({
      getCalls: () => getCalls,
      postCalls: () => postCalls,
      createdAgents: () => createdAgents,
      postBodies: () => Object.freeze([...postBodies]),
      deactivate(): void {
        active = false;
      },
      setPostMode(mode: PostMode): void {
        postMode = mode;
      },
      setAgentProfile(name: string, username: string | null): void {
        currentAgentName = name;
        currentUsername = username;
      },
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

function dependencies(
  store: InMemoryCredentialMutationStore,
  server: RegistrationServer,
  random = createDeterministicRandom(),
): RecoverableRegistrationDependencies {
  return Object.freeze({
    storage: store.adapter,
    network: server.network,
    clock: createClock(),
    random,
    hash: nodeHash,
  });
}

function readCredential(
  store: InMemoryCredentialMutationStore,
): CredentialV1 | undefined {
  const bytes = store.control.readCredential();
  if (bytes === undefined) {
    return undefined;
  }
  try {
    return parseCredentialDocument(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } finally {
    bytes.fill(0);
  }
}

function credentialBytes(credential: CredentialV1): Uint8Array {
  return new TextEncoder().encode(
    serializeCredentialDocument(credential),
  );
}

function sameCredential(
  left: CredentialV1,
  right: CredentialV1,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pendingCredentialForSession(): PendingCredentialV1 {
  const credential = validateCredentialDocument({
    schema_version: 1,
    state: "pending",
    api_origin: DEFAULT_API_ORIGIN,
    api_key: `plrm_live_${"A".repeat(43)}`,
    agent_id: null,
    agent_name: INPUT.agentName,
    username: INPUT.username,
    registration_request_id:
      "5d18e9ab-23e1-4d22-8dd7-1f65530fc92c",
    created_at: "2026-07-20T11:00:00.000Z",
    updated_at: "2026-07-20T11:00:00.000Z",
    activated_at: null,
  });
  if (credential.state !== "pending") {
    throw new Error("expected pending test credential");
  }
  return credential;
}

function activeCredentialForSession(): ActiveCredentialV1 {
  const credential = validateCredentialDocument({
    ...pendingCredentialForSession(),
    state: "active",
    agent_id: OTHER_AGENT_ID,
    registration_request_id:
      "5d18e9ab-23e1-4d22-8dd7-1f65530fc92c",
    updated_at: "2026-07-20T11:00:01.000Z",
    activated_at: "2026-07-20T11:00:01.000Z",
  });
  if (credential.state !== "active") {
    throw new Error("expected active test credential");
  }
  return credential;
}

interface InSessionCredentialStore {
  readonly session: ExclusiveObservedCredentialSetupSession;
  readonly control: Readonly<{
    credential(): CredentialV1 | null;
    readExactCalls(): number;
    readOrCreateCalls(): number;
    writeExactCalls(): number;
    activationCalls(): number;
  }>;
}

function createInSessionCredentialStore(
  initial: CredentialV1 | null,
  onReadExact?: () => void,
  onWriteExact?: (
    expected: CredentialV1 | null,
    replacement: CredentialV1,
  ) => void,
): InSessionCredentialStore {
  let credential = initial;
  let readExactCalls = 0;
  let readOrCreateCalls = 0;
  let writeExactCalls = 0;
  let activationCalls = 0;

  function requireExact(expected: CredentialV1 | null): void {
    if (
      expected === null
        ? credential !== null
        : credential === null || !sameCredential(expected, credential)
    ) {
      throw new CredentialError("credential_store_conflict");
    }
  }

  const session: ExclusiveObservedCredentialSetupSession =
    Object.freeze({
      async readActiveCredential(): Promise<ActiveCredentialV1> {
        if (credential?.state !== "active") {
          throw new CredentialError("credential_store_conflict");
        }
        return credential;
      },
      async readExactCredential(
        expected: CredentialV1 | null,
      ): Promise<CredentialV1 | null> {
        readExactCalls += 1;
        onReadExact?.();
        requireExact(expected);
        return credential;
      },
      async writeExactCredential(
        expected: CredentialV1 | null,
        replacement: CredentialV1,
      ) {
        writeExactCalls += 1;
        onWriteExact?.(expected, replacement);
        requireExact(expected);
        const validated = validateCredentialDocument(replacement);
        if (
          credential !== null &&
          sameCredential(credential, validated)
        ) {
          return Object.freeze({ status: "unchanged" as const });
        }
        credential = validated;
        return Object.freeze({ status: "written" as const });
      },
      async readOrCreatePending(
        factory: (
          createdAt: CanonicalTimestamp,
        ) => PendingCredentialV1,
      ) {
        readOrCreateCalls += 1;
        if (credential?.state === "active") {
          return Object.freeze({
            status: "existing-active" as const,
            credential,
          });
        }
        if (credential?.state === "pending") {
          return Object.freeze({
            status: "pending-resumed" as const,
            credential,
          });
        }
        const createdAt =
          "2026-07-20T12:00:00.000Z" as CanonicalTimestamp;
        const created = validateCredentialDocument(factory(createdAt));
        if (
          created.state !== "pending" ||
          created.created_at !== createdAt ||
          created.updated_at !== createdAt
        ) {
          throw new CredentialError("credential_store_unavailable");
        }
        credential = created;
        return Object.freeze({
          status: "pending-created" as const,
          credential: created,
        });
      },
      async activateExactPending(
        expected: PendingCredentialV1,
        verifiedAgent: VerifiedRegistrationAgent,
      ) {
        activationCalls += 1;
        requireExact(expected);
        if (
          credential?.state !== "pending" ||
          verifiedAgent.name !== credential.agent_name ||
          verifiedAgent.username !== credential.username
        ) {
          throw new CredentialError("credential_store_conflict");
        }
        const activatedAt =
          "2026-07-20T12:00:01.000Z" as CanonicalTimestamp;
        const active = validateCredentialDocument({
          ...credential,
          state: "active",
          agent_id: verifiedAgent.id,
          updated_at: activatedAt,
          activated_at: activatedAt,
        });
        if (active.state !== "active") {
          throw new CredentialError("credential_store_unavailable");
        }
        credential = active;
        return Object.freeze({
          status: "activated" as const,
          credential: active,
        });
      },
      async replaceUsernameAfterConflict() {
        throw new Error("unexpected username replacement");
      },
    });

  return Object.freeze({
    session,
    control: Object.freeze({
      credential: () => credential,
      readExactCalls: () => readExactCalls,
      readOrCreateCalls: () => readOrCreateCalls,
      writeExactCalls: () => writeExactCalls,
      activationCalls: () => activationCalls,
    }),
  });
}

function inSessionDependencies(
  server: RegistrationServer,
  random: RandomAdapter = createDeterministicRandom(),
  clock = createClock(),
): RecoverableRegistrationOperationDependencies {
  return Object.freeze({
    network: server.network,
    clock,
    random,
    hash: nodeHash,
  });
}

function mutationBoundaries(
  operations: readonly string[],
): readonly MutationBoundary[] {
  const counts = new Map<string, number>();
  return Object.freeze(
    operations
      .filter(
        (operation) =>
          operation.startsWith("create:") ||
          operation.startsWith("write:") ||
          operation.startsWith("sync-file:") ||
          operation.startsWith("move:") ||
          operation.startsWith("remove:") ||
          operation === "sync-directory",
      )
      .map((operation) => {
        const occurrence = (counts.get(operation) ?? 0) + 1;
        counts.set(operation, occurrence);
        return Object.freeze({ operation, occurrence });
      }),
  );
}

describe("recoverable registration inside an observed setup session", () => {
  it("preserves the missing-credential registration flow without storage dependencies", async () => {
    const store = createInSessionCredentialStore(null);
    const server = createRegistrationServer();
    const random = createDeterministicRandom();

    await expect(
      runRecoverableAgentRegistrationInSession(
        inSessionDependencies(server, random),
        store.session,
        INPUT,
      ),
    ).resolves.toEqual({
      status: "active",
      source: "created",
      agent: {
        id: AGENT_ID,
        name: "Codex",
        username: "codex-42",
      },
    });

    expect(store.control.credential()?.state).toBe("active");
    expect(store.control.readOrCreateCalls()).toBe(1);
    expect(store.control.readExactCalls()).toBe(0);
    expect(store.control.writeExactCalls()).toBe(0);
    expect(store.control.activationCalls()).toBe(1);
    expect(server.control.getCalls()).toBe(2);
    expect(server.control.postCalls()).toBe(1);
    expect(random.counters.bytes()).toBe(1);
  });

  it("resumes an exact pending credential without generating replacement material", async () => {
    const pending = pendingCredentialForSession();
    const store = createInSessionCredentialStore(pending);
    const server = createRegistrationServer();
    const random = createDeterministicRandom();

    await expect(
      runRecoverableAgentRegistrationInSession(
        inSessionDependencies(server, random),
        store.session,
        INPUT,
      ),
    ).resolves.toMatchObject({
      status: "active",
      source: "created",
    });

    const active = store.control.credential();
    expect(active?.state).toBe("active");
    expect(active?.api_key).toBe(pending.api_key);
    expect(active?.registration_request_id).toBe(
      pending.registration_request_id,
    );
    expect(store.control.readOrCreateCalls()).toBe(1);
    expect(store.control.readExactCalls()).toBe(0);
    expect(store.control.writeExactCalls()).toBe(0);
    expect(random.counters.bytes()).toBe(0);
    expect(random.counters.uuids()).toBe(0);
  });

  it("re-attests an approved active credential before replacing it with recoverable pending state", async () => {
    const approved = activeCredentialForSession();
    const server = createRegistrationServer();
    const random = createDeterministicRandom();
    let clockCalls = 0;
    const clock = Object.freeze({
      now(): number {
        clockCalls += 1;
        return BASE_TIME;
      },
    });
    const store = createInSessionCredentialStore(
      approved,
      () => {
        expect(clockCalls).toBe(0);
        expect(random.counters.bytes()).toBe(0);
        expect(random.counters.uuids()).toBe(0);
        expect(server.control.getCalls()).toBe(0);
        expect(server.control.postCalls()).toBe(0);
      },
      (expected, replacement) => {
        expect(expected).toEqual(approved);
        expect(replacement).toMatchObject({
          state: "pending",
          api_origin: INPUT.apiOrigin,
          agent_name: INPUT.agentName,
          username: INPUT.username,
          created_at: "2026-07-20T12:00:00.000Z",
          updated_at: "2026-07-20T12:00:00.000Z",
        });
        expect(clockCalls).toBe(1);
        expect(random.counters.bytes()).toBe(1);
        expect(random.counters.uuids()).toBe(1);
        expect(server.control.getCalls()).toBe(0);
        expect(server.control.postCalls()).toBe(0);
      },
    );

    await expect(
      runRecoverableAgentRegistrationInSession(
        inSessionDependencies(server, random, clock),
        store.session,
        INPUT,
        approved,
      ),
    ).resolves.toEqual({
      status: "active",
      source: "created",
      agent: {
        id: AGENT_ID,
        name: "Codex",
        username: "codex-42",
      },
    });

    const active = store.control.credential();
    expect(active?.state).toBe("active");
    expect(active?.agent_id).toBe(AGENT_ID);
    expect(active?.api_key).not.toBe(approved.api_key);
    expect(store.control.readExactCalls()).toBe(1);
    expect(store.control.writeExactCalls()).toBe(1);
    expect(store.control.readOrCreateCalls()).toBe(0);
    expect(store.control.activationCalls()).toBe(1);
    expect(clockCalls).toBe(1);
    expect(random.counters.bytes()).toBe(1);
    expect(random.counters.uuids()).toBe(1);
    expect(server.control.getCalls()).toBe(2);
    expect(server.control.postCalls()).toBe(1);
  });

  it("retains one approved replacement key for a later in-session retry", async () => {
    const approved = activeCredentialForSession();
    const store = createInSessionCredentialStore(approved);
    const server = createRegistrationServer({ postMode: "rate-limit" });
    const random = createDeterministicRandom();
    const operationDependencies = inSessionDependencies(
      server,
      random,
    );

    await expect(
      runRecoverableAgentRegistrationInSession(
        operationDependencies,
        store.session,
        INPUT,
        approved,
      ),
    ).resolves.toEqual({
      status: "retryable",
      reason: "rate_limit",
    });
    const pending = store.control.credential();
    expect(pending?.state).toBe("pending");
    expect(store.control.writeExactCalls()).toBe(1);
    expect(store.control.activationCalls()).toBe(0);
    expect(random.counters.bytes()).toBe(1);

    server.control.setPostMode("normal");
    await expect(
      runRecoverableAgentRegistrationInSession(
        operationDependencies,
        store.session,
        INPUT,
      ),
    ).resolves.toMatchObject({
      status: "active",
      source: "created",
    });

    const active = store.control.credential();
    expect(active?.state).toBe("active");
    expect(active?.api_key).toBe(pending?.api_key);
    expect(active?.registration_request_id).toBe(
      pending?.registration_request_id,
    );
    expect(store.control.readExactCalls()).toBe(1);
    expect(store.control.writeExactCalls()).toBe(1);
    expect(store.control.readOrCreateCalls()).toBe(1);
    expect(random.counters.bytes()).toBe(1);
  });

  it("fails closed before randomness or network when approved active state is stale", async () => {
    const approved = activeCredentialForSession();
    const current = validateCredentialDocument({
      ...approved,
      api_key: `plrm_live_${"B".repeat(43)}`,
    });
    const server = createRegistrationServer();
    const random = createDeterministicRandom();
    let clockCalls = 0;
    const store = createInSessionCredentialStore(current, () => {
      expect(clockCalls).toBe(0);
      expect(random.counters.bytes()).toBe(0);
      expect(random.counters.uuids()).toBe(0);
      expect(server.control.getCalls()).toBe(0);
      expect(server.control.postCalls()).toBe(0);
    });

    await expect(
      runRecoverableAgentRegistrationInSession(
        inSessionDependencies(server, random, {
          now(): number {
            clockCalls += 1;
            return BASE_TIME;
          },
        }),
        store.session,
        INPUT,
        approved,
      ),
    ).resolves.toEqual({
      status: "blocked",
      reason: "local_credential_conflict",
    });

    expect(store.control.readExactCalls()).toBe(1);
    expect(store.control.writeExactCalls()).toBe(0);
    expect(store.control.readOrCreateCalls()).toBe(0);
    expect(store.control.activationCalls()).toBe(0);
    expect(clockCalls).toBe(0);
    expect(random.counters.bytes()).toBe(0);
    expect(random.counters.uuids()).toBe(0);
    expect(server.control.getCalls()).toBe(0);
    expect(server.control.postCalls()).toBe(0);
  });

  it("keeps existing-active validation on the normal in-session path", async () => {
    const active = activeCredentialForSession();
    const store = createInSessionCredentialStore(active);
    const random = createDeterministicRandom();
    let networkCalls = 0;
    const network: NetworkAdapter = Object.freeze({
      async request(request: NetworkRequest): Promise<NetworkResponse> {
        networkCalls += 1;
        expect(request.method).toBe("GET");
        expect(bearerKey(request)).toBe(active.api_key);
        return jsonResponse(200, {
          id: active.agent_id,
          name: active.agent_name,
          username: active.username,
          api_key_prefix: "not-consumed",
          is_active: true,
        });
      },
    });

    await expect(
      runRecoverableAgentRegistrationInSession(
        Object.freeze({
          network,
          clock: createClock(),
          random,
          hash: nodeHash,
        }),
        store.session,
        INPUT,
      ),
    ).resolves.toEqual({
      status: "active",
      source: "existing",
      agent: {
        id: OTHER_AGENT_ID,
        name: "Codex",
        username: "codex-42",
      },
    });

    expect(networkCalls).toBe(1);
    expect(store.control.readOrCreateCalls()).toBe(1);
    expect(store.control.readExactCalls()).toBe(0);
    expect(store.control.writeExactCalls()).toBe(0);
    expect(random.counters.bytes()).toBe(0);
    expect(random.counters.uuids()).toBe(0);
  });
});

describe("recoverable registration state machine", () => {
  it("persists pending before POST, verifies the key, and activates it", async () => {
    const store = createInMemoryCredentialMutationStore();
    let pendingAtPost: CredentialV1 | undefined;
    const server = createRegistrationServer({
      onPost() {
        pendingAtPost = readCredential(store);
      },
    });
    const random = createDeterministicRandom();

    const result = await runRecoverableAgentRegistration(
      dependencies(store, server, random),
      LOCATIONS,
      INPUT,
    );

    expect(result).toEqual({
      status: "active",
      source: "created",
      agent: {
        id: AGENT_ID,
        name: "Codex",
        username: "codex-42",
      },
    });
    expect(pendingAtPost?.state).toBe("pending");
    const active = readCredential(store);
    expect(active?.state).toBe("active");
    expect(active?.api_key).toBe(pendingAtPost?.api_key);
    expect(active?.registration_request_id).toBe(
      pendingAtPost?.registration_request_id,
    );
    expect(server.control.createdAgents()).toBe(1);
    expect(server.control.postCalls()).toBe(1);
    expect(random.counters.bytes()).toBe(1);

    const body = server.control.postBodies()[0];
    expect(Object.keys(body ?? {}).sort()).toEqual([
      "api_key_hash",
      "api_key_prefix",
      "name",
      "protocol_version",
      "registration_request_id",
      "username",
    ]);
    expect(JSON.stringify(body)).not.toContain(pendingAtPost?.api_key);
    expect(JSON.stringify(result)).not.toContain(pendingAtPost?.api_key);
    expect(store.trace.operations().at(-1)).toBe("release");
  });

  it("retains an exact pending credential on indeterminate validation and resumes it", async () => {
    const store = createInMemoryCredentialMutationStore();
    const server = createRegistrationServer({
      unavailableGetCalls: [1],
    });
    const random = createDeterministicRandom();
    const sharedDependencies = dependencies(store, server, random);

    await expect(
      runRecoverableAgentRegistration(
        sharedDependencies,
        LOCATIONS,
        INPUT,
      ),
    ).resolves.toEqual({
      status: "retryable",
      reason: "verification_unavailable",
    });
    const pending = readCredential(store);
    expect(pending?.state).toBe("pending");
    expect(server.control.postCalls()).toBe(0);
    expect(random.counters.bytes()).toBe(1);

    await expect(
      runRecoverableAgentRegistration(
        sharedDependencies,
        LOCATIONS,
        INPUT,
      ),
    ).resolves.toMatchObject({
      status: "active",
      source: "created",
    });

    const active = readCredential(store);
    expect(active?.state).toBe("active");
    expect(active?.api_key).toBe(pending?.api_key);
    expect(active?.registration_request_id).toBe(
      pending?.registration_request_id,
    );
    expect(random.counters.bytes()).toBe(1);
    expect(server.control.createdAgents()).toBe(1);
  });

  it("recovers a committed registration when its response is lost", async () => {
    const store = createInMemoryCredentialMutationStore();
    const server = createRegistrationServer({
      postMode: "unavailable-after-commit",
    });

    await expect(
      runRecoverableAgentRegistration(
        dependencies(store, server),
        LOCATIONS,
        INPUT,
      ),
    ).resolves.toMatchObject({
      status: "active",
      source: "recovered",
      agent: { id: AGENT_ID },
    });

    expect(readCredential(store)?.state).toBe("active");
    expect(server.control.createdAgents()).toBe(1);
    expect(server.control.postCalls()).toBe(1);
  });

  it("leaves pending after a committed response when verification is unavailable, then resumes through /me", async () => {
    const store = createInMemoryCredentialMutationStore();
    const server = createRegistrationServer({
      unavailableGetCalls: [2],
    });
    const random = createDeterministicRandom();
    const sharedDependencies = dependencies(store, server, random);

    await expect(
      runRecoverableAgentRegistration(
        sharedDependencies,
        LOCATIONS,
        INPUT,
      ),
    ).resolves.toEqual({
      status: "retryable",
      reason: "verification_unavailable",
    });
    const pending = readCredential(store);
    expect(pending?.state).toBe("pending");
    expect(server.control.createdAgents()).toBe(1);

    await expect(
      runRecoverableAgentRegistration(
        sharedDependencies,
        LOCATIONS,
        INPUT,
      ),
    ).resolves.toMatchObject({
      status: "active",
      source: "recovered",
    });

    const active = readCredential(store);
    expect(active?.api_key).toBe(pending?.api_key);
    expect(server.control.postCalls()).toBe(1);
    expect(server.control.createdAgents()).toBe(1);
    expect(random.counters.bytes()).toBe(1);
  });

  it.each([
    "idempotency_conflict",
    "username_unavailable",
    "credential_conflict",
  ] as const)(
    "fails closed on %s without replacing pending material",
    async (reason) => {
      const store = createInMemoryCredentialMutationStore();
      const server = createRegistrationServer({ postMode: reason });
      const random = createDeterministicRandom();

      const result = await runRecoverableAgentRegistration(
        dependencies(store, server, random),
        LOCATIONS,
        INPUT,
      );

      expect(result).toEqual({ status: "blocked", reason });
      expect(readCredential(store)?.state).toBe("pending");
      expect(random.counters.bytes()).toBe(1);
      expect(server.control.createdAgents()).toBe(0);
    },
  );

  it("supports an explicit user-approved username retry without replacing the key", async () => {
    const store = createInMemoryCredentialMutationStore();
    const server = createRegistrationServer({
      postMode: "username_unavailable",
    });
    const random = createDeterministicRandom();
    const sharedDependencies = dependencies(store, server, random);

    await expect(
      runRecoverableAgentRegistration(
        sharedDependencies,
        LOCATIONS,
        INPUT,
      ),
    ).resolves.toEqual({
      status: "blocked",
      reason: "username_unavailable",
    });
    const conflicted = readCredential(store);
    expect(conflicted?.state).toBe("pending");
    const networkCallsBeforeRetry = {
      gets: server.control.getCalls(),
      posts: server.control.postCalls(),
    };

    await expect(
      prepareUsernameConflictRetry(
        {
          storage: sharedDependencies.storage,
          clock: sharedDependencies.clock,
          random: sharedDependencies.random,
        },
        LOCATIONS,
        "codex-43" as Username,
      ),
    ).resolves.toEqual({ status: "ready" });

    const retried = readCredential(store);
    expect(retried?.state).toBe("pending");
    expect(retried?.api_key).toBe(conflicted?.api_key);
    expect(retried?.username).toBe("codex-43");
    expect(retried?.registration_request_id).not.toBe(
      conflicted?.registration_request_id,
    );
    expect(server.control.getCalls()).toBe(
      networkCallsBeforeRetry.gets,
    );
    expect(server.control.postCalls()).toBe(
      networkCallsBeforeRetry.posts,
    );
    expect(random.counters.bytes()).toBe(1);

    server.control.setPostMode("normal");
    await expect(
      runRecoverableAgentRegistration(
        sharedDependencies,
        LOCATIONS,
        INPUT,
      ),
    ).resolves.toMatchObject({
      status: "active",
      source: "created",
      agent: { username: "codex-43" },
    });

    const bodies = server.control.postBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.username).toBe("codex-43");
    expect(bodies[1]?.registration_request_id).toBe(
      retried?.registration_request_id,
    );
    expect(bodies[1]?.api_key_hash).toBe(bodies[0]?.api_key_hash);
    expect(bodies[1]?.api_key_prefix).toBe(
      bodies[0]?.api_key_prefix,
    );
    expect(readCredential(store)?.api_key).toBe(conflicted?.api_key);
    expect(server.control.createdAgents()).toBe(1);
    expect(random.counters.bytes()).toBe(1);
  });

  it("retains pending on rate limit without making an unnecessary verification request", async () => {
    const store = createInMemoryCredentialMutationStore();
    const server = createRegistrationServer({
      postMode: "rate-limit",
    });

    await expect(
      runRecoverableAgentRegistration(
        dependencies(store, server),
        LOCATIONS,
        INPUT,
      ),
    ).resolves.toEqual({
      status: "retryable",
      reason: "rate_limit",
    });

    expect(readCredential(store)?.state).toBe("pending");
    expect(server.control.getCalls()).toBe(1);
    expect(server.control.postCalls()).toBe(1);
    expect(server.control.createdAgents()).toBe(0);
  });

  it("retains pending when the request fails before the server commits", async () => {
    const store = createInMemoryCredentialMutationStore();
    const server = createRegistrationServer({
      postMode: "unavailable-before-commit",
    });
    const random = createDeterministicRandom();
    const sharedDependencies = dependencies(store, server, random);

    await expect(
      runRecoverableAgentRegistration(
        sharedDependencies,
        LOCATIONS,
        INPUT,
      ),
    ).resolves.toEqual({
      status: "retryable",
      reason: "registration_unavailable",
    });

    expect(readCredential(store)?.state).toBe("pending");
    expect(server.control.getCalls()).toBe(2);
    expect(server.control.createdAgents()).toBe(0);
    const pending = readCredential(store);
    const firstBody = server.control.postBodies()[0];

    server.control.setPostMode("normal");
    await expect(
      runRecoverableAgentRegistration(
        sharedDependencies,
        LOCATIONS,
        INPUT,
      ),
    ).resolves.toMatchObject({
      status: "active",
      source: "created",
    });

    const secondBody = server.control.postBodies()[1];
    expect(secondBody).toEqual(firstBody);
    expect(secondBody?.registration_request_id).toBe(
      pending?.registration_request_id,
    );
    expect(readCredential(store)?.api_key).toBe(pending?.api_key);
    expect(random.counters.bytes()).toBe(1);
    expect(server.control.createdAgents()).toBe(1);
  });

  it("never activates an unexpected authenticated identity", async () => {
    const store = createInMemoryCredentialMutationStore();
    const server = createRegistrationServer({
      agentId: OTHER_AGENT_ID,
      agentName: "Unexpected",
    });

    await expect(
      runRecoverableAgentRegistration(
        dependencies(store, server),
        LOCATIONS,
        INPUT,
      ),
    ).resolves.toEqual({
      status: "blocked",
      reason: "identity_mismatch",
    });

    expect(readCredential(store)?.state).toBe("pending");
    expect(server.control.createdAgents()).toBe(1);
  });

  it("never activates when the registration response and /me identify different agents", async () => {
    const store = createInMemoryCredentialMutationStore();
    const server = createRegistrationServer({
      registrationAgentId: OTHER_AGENT_ID,
    });

    await expect(
      runRecoverableAgentRegistration(
        dependencies(store, server),
        LOCATIONS,
        INPUT,
      ),
    ).resolves.toEqual({
      status: "blocked",
      reason: "identity_mismatch",
    });

    expect(readCredential(store)?.state).toBe("pending");
    expect(server.control.createdAgents()).toBe(1);
  });

  it("revalidates an existing active credential without registering again", async () => {
    const store = createInMemoryCredentialMutationStore();
    const server = createRegistrationServer();
    const random = createDeterministicRandom();
    const sharedDependencies = dependencies(store, server, random);

    await expect(
      runRecoverableAgentRegistration(
        sharedDependencies,
        LOCATIONS,
        INPUT,
      ),
    ).resolves.toMatchObject({ status: "active", source: "created" });
    const active = readCredential(store);
    if (active === undefined) {
      throw new Error("expected active credential");
    }
    const calls = {
      gets: server.control.getCalls(),
      posts: server.control.postCalls(),
      bytes: random.counters.bytes(),
    };

    await expect(
      runRecoverableAgentRegistration(
        sharedDependencies,
        LOCATIONS,
        INPUT,
      ),
    ).resolves.toMatchObject({ status: "active", source: "existing" });

    const after = readCredential(store);
    expect(after === undefined ? false : sameCredential(active, after)).toBe(
      true,
    );
    expect(server.control.getCalls()).toBe(calls.gets + 1);
    expect(server.control.postCalls()).toBe(calls.posts);
    expect(random.counters.bytes()).toBe(calls.bytes);
  });

  it("keeps active identity bound to stable agent ID when owners edit profile labels", async () => {
    const store = createInMemoryCredentialMutationStore();
    const server = createRegistrationServer();
    const sharedDependencies = dependencies(store, server);

    await expect(
      runRecoverableAgentRegistration(
        sharedDependencies,
        LOCATIONS,
        INPUT,
      ),
    ).resolves.toMatchObject({ status: "active", source: "created" });
    const stored = readCredential(store);
    server.control.setAgentProfile("Renamed Codex", "renamed-agent");

    await expect(
      runRecoverableAgentRegistration(
        sharedDependencies,
        LOCATIONS,
        INPUT,
      ),
    ).resolves.toEqual({
      status: "active",
      source: "existing",
      agent: {
        id: AGENT_ID,
        name: "Renamed Codex",
        username: "renamed-agent",
      },
    });
    const after = readCredential(store);
    expect(
      stored !== undefined &&
        after !== undefined &&
        sameCredential(stored, after),
    ).toBe(true);
  });

  it("never hands a deactivated active credential to host reconciliation", async () => {
    const store = createInMemoryCredentialMutationStore();
    const server = createRegistrationServer();
    const random = createDeterministicRandom();
    const sharedDependencies = dependencies(store, server, random);

    await expect(
      runRecoverableAgentRegistration(
        sharedDependencies,
        LOCATIONS,
        INPUT,
      ),
    ).resolves.toMatchObject({ status: "active" });
    const active = readCredential(store);
    server.control.deactivate();

    await expect(
      runRecoverableAgentRegistration(
        sharedDependencies,
        LOCATIONS,
        INPUT,
      ),
    ).resolves.toEqual({
      status: "blocked",
      reason: "active_credential_invalid",
    });

    const retained = readCredential(store);
    expect(
      active !== undefined &&
        retained !== undefined &&
        sameCredential(active, retained),
    ).toBe(true);
    expect(server.control.postCalls()).toBe(1);
    expect(random.counters.bytes()).toBe(1);
  });

  it("serializes concurrent setup so only one process registers and activates", async () => {
    const store = createInMemoryCredentialMutationStore();
    const gate = deferred();
    const postStarted = deferred();
    const server = createRegistrationServer({
      postGate: gate.promise,
      onPost() {
        postStarted.resolve();
      },
    });
    const random = createDeterministicRandom();
    const sharedDependencies = dependencies(store, server, random);

    const first = runRecoverableAgentRegistration(
      sharedDependencies,
      LOCATIONS,
      INPUT,
    );
    await postStarted.promise;

    await expect(
      runRecoverableAgentRegistration(
        sharedDependencies,
        LOCATIONS,
        INPUT,
      ),
    ).resolves.toEqual({ status: "busy" });

    gate.resolve();
    await expect(first).resolves.toMatchObject({
      status: "active",
      source: "created",
    });
    expect(server.control.postCalls()).toBe(1);
    expect(server.control.createdAgents()).toBe(1);
    expect(readCredential(store)?.state).toBe("active");
  });

  it("reports an exact local credential mutation as a blocked conflict", async () => {
    const store = createInMemoryCredentialMutationStore();
    const server = createRegistrationServer({
      onPost() {
        const current = readCredential(store);
        if (current?.state !== "pending") {
          throw new Error("expected pending credential");
        }
        const unrelated = validateCredentialDocument({
          ...current,
          api_key: `plrm_live_${"A".repeat(43)}`,
          registration_request_id:
            "5d18e9ab-23e1-4d22-8dd7-1f65530fc92c",
        });
        store.control.replaceCredentialUnrelated(
          credentialBytes(unrelated),
        );
      },
    });

    await expect(
      runRecoverableAgentRegistration(
        dependencies(store, server),
        LOCATIONS,
        INPUT,
      ),
    ).resolves.toEqual({
      status: "blocked",
      reason: "local_credential_conflict",
    });
    expect(server.control.createdAgents()).toBe(1);
    expect(readCredential(store)?.state).toBe("pending");
  });
});

describe("registration state-machine local fault recovery", () => {
  function runWithStoreOptions(
    options: InMemoryCredentialMutationStoreOptions,
  ): {
    readonly store: InMemoryCredentialMutationStore;
    readonly server: RegistrationServer;
    readonly random: DeterministicRandom;
    readonly dependencies: RecoverableRegistrationDependencies;
  } {
    const store = createInMemoryCredentialMutationStore(options);
    const server = createRegistrationServer();
    const random = createDeterministicRandom();
    return Object.freeze({
      store,
      server,
      random,
      dependencies: dependencies(store, server, random),
    });
  }

  it("makes no network request when pending persistence fails", async () => {
    const context = runWithStoreOptions({
      fault: {
        mode: "throw-before",
        operation:
          "create:.credentials-transaction-00000000-0000-4000-8000-000000000003.tmp",
        occurrence: 1,
      },
    });

    await expect(
      runRecoverableAgentRegistration(
        context.dependencies,
        LOCATIONS,
        INPUT,
      ),
    ).resolves.toEqual({
      status: "retryable",
      reason: "credential_store_unavailable",
    });
    expect(context.server.control.getCalls()).toBe(0);
    expect(context.server.control.postCalls()).toBe(0);
  });

  it("recovers from an active-transition crash without replacing the persisted pending key", async () => {
    const context = runWithStoreOptions({
      fault: {
        mode: "crash-before",
        operation:
          "create:.credentials-transaction-00000000-0000-4000-8000-000000000004.tmp",
        occurrence: 1,
      },
    });

    await expect(
      runRecoverableAgentRegistration(
        context.dependencies,
        LOCATIONS,
        INPUT,
      ),
    ).resolves.toMatchObject({ status: "retryable" });
    const pending = readCredential(context.store);
    expect(pending?.state).toBe("pending");
    expect(context.server.control.createdAgents()).toBe(1);

    await expect(
      runRecoverableAgentRegistration(
        context.dependencies,
        LOCATIONS,
        INPUT,
      ),
    ).resolves.toMatchObject({
      status: "active",
      source: "recovered",
    });
    const active = readCredential(context.store);
    expect(active?.state).toBe("active");
    expect(active?.api_key).toBe(pending?.api_key);
    expect(active?.registration_request_id).toBe(
      pending?.registration_request_id,
    );
    expect(context.random.counters.bytes()).toBe(1);
    expect(context.server.control.createdAgents()).toBe(1);
  });

  it("converges to one active credential across every local registration mutation crash", async () => {
    const probe = runWithStoreOptions({});
    await expect(
      runRecoverableAgentRegistration(
        probe.dependencies,
        LOCATIONS,
        INPUT,
      ),
    ).resolves.toMatchObject({ status: "active" });
    const boundaries = mutationBoundaries(
      probe.store.trace.operations(),
    );
    expect(boundaries.length).toBeGreaterThan(20);

    for (const boundary of boundaries) {
      for (const mode of ["crash-before", "crash-after"] as const) {
        for (const crashPolicy of [
          "discard-unsynced",
          "persist-unsynced",
        ] as const) {
          const context = runWithStoreOptions({
            crashPolicy,
            fault: Object.freeze({ ...boundary, mode }),
          });

          const first = await runRecoverableAgentRegistration(
            context.dependencies,
            LOCATIONS,
            INPUT,
          );
          expect(JSON.stringify(first)).not.toContain("plrm_live_");
          const firstCredential = readCredential(context.store);
          const serverCommittedBeforeRetry =
            context.server.control.createdAgents() === 1;
          if (serverCommittedBeforeRetry) {
            expect(firstCredential).toBeDefined();
          }

          await expect(
            runRecoverableAgentRegistration(
              context.dependencies,
              LOCATIONS,
              INPUT,
            ),
          ).resolves.toMatchObject({ status: "active" });

          const finalCredential = readCredential(context.store);
          expect(finalCredential?.state).toBe("active");
          expect(context.server.control.createdAgents()).toBe(1);
          if (
            serverCommittedBeforeRetry &&
            firstCredential !== undefined
          ) {
            expect(finalCredential?.api_key).toBe(
              firstCredential.api_key,
            );
            expect(finalCredential?.registration_request_id).toBe(
              firstCredential.registration_request_id,
            );
            expect(context.random.counters.bytes()).toBe(1);
          }
          expect(context.store.control.entries().map((entry) => entry.name)).toEqual([
            "credentials.json",
          ]);
          expect(
            JSON.stringify(context.store.trace.operations()),
          ).not.toContain("plrm_live_");
        }
      }
    }
  });
});
