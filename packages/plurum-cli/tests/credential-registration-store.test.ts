import { describe, expect, it } from "vitest";

import { DEFAULT_API_ORIGIN } from "../src/credentials/origin.js";
import {
  serializeCredentialDocument,
  type ActiveCredentialV1,
  type CanonicalTimestamp,
  type PendingCredentialV1,
  type RegistrationRequestId,
  type Username,
  validateCredentialDocument,
} from "../src/credentials/schema.js";
import { parseCredentialDocumentBytes } from "../src/credentials/store-codec.js";
import {
  runExclusiveCredentialRegistration,
  type CredentialStoreWriterDependencies,
  type ExclusiveCredentialRegistrationSession,
  type VerifiedRegistrationAgent,
} from "../src/credentials/store-writer.js";
import {
  createInMemoryCredentialMutationStore,
  type InMemoryCredentialMutationStore,
} from "./support/in-memory-credential-mutation-store.js";

const LOCATIONS = Object.freeze({ directory: "/isolated/plurum" });
const CREATED_AT = "2026-07-20T10:00:00.000Z";
const ACTIVATED_AT = "2026-07-20T10:01:00.000Z";
const BACKWARD_CLOCK_AT = "2026-07-20T09:59:00.000Z";
const REQUEST_ID = "ca908d9f-d901-4dac-b396-7f84377adfc8";
const REPLACEMENT_REQUEST_ID =
  "d62b27b2-7de9-4e56-a642-0fe20dbce487";
const AGENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const API_KEY = `plrm_live_${"A".repeat(43)}`;
const OTHER_API_KEY = `plrm_live_${"B".repeat(43)}`;
const NONCE_1 = "11111111-1111-4111-8111-111111111111";
const TRANSACTION_1 = "22222222-2222-4222-8222-222222222222";
const NONCE_2 = "33333333-3333-4333-8333-333333333333";
const TRANSACTION_2 = "44444444-4444-4444-8444-444444444444";

const VERIFIED_AGENT: VerifiedRegistrationAgent = Object.freeze({
  id: AGENT_ID,
  name: "Codex",
  username: "codex-42",
});

function pendingCredential(
  createdAt: string = CREATED_AT,
  apiKey: string = API_KEY,
  agentName = "Codex",
): PendingCredentialV1 {
  const credential = validateCredentialDocument({
    schema_version: 1,
    state: "pending",
    api_origin: DEFAULT_API_ORIGIN,
    api_key: apiKey,
    agent_id: null,
    agent_name: agentName,
    username: "codex-42",
    registration_request_id: REQUEST_ID,
    created_at: createdAt,
    updated_at: createdAt,
    activated_at: null,
  });
  if (credential.state !== "pending") {
    throw new Error("test fixture did not create a pending credential");
  }
  return credential;
}

function activeCredential(
  pending: PendingCredentialV1,
  activatedAt: string = ACTIVATED_AT,
): ActiveCredentialV1 {
  const credential = validateCredentialDocument({
    schema_version: pending.schema_version,
    state: "active",
    api_origin: pending.api_origin,
    api_key: pending.api_key,
    agent_id: AGENT_ID,
    agent_name: pending.agent_name,
    username: pending.username,
    registration_request_id: pending.registration_request_id,
    created_at: pending.created_at,
    updated_at: activatedAt,
    activated_at: activatedAt,
  });
  if (credential.state !== "active") {
    throw new Error("test fixture did not create an active credential");
  }
  return credential;
}

function credentialBytes(
  credential: PendingCredentialV1 | ActiveCredentialV1,
): Uint8Array {
  return new TextEncoder().encode(serializeCredentialDocument(credential));
}

function durableCredential(
  fake: InMemoryCredentialMutationStore,
): PendingCredentialV1 | ActiveCredentialV1 {
  const bytes = fake.control.readDurableCredential();
  if (bytes === undefined) {
    throw new Error("test credential is missing");
  }
  try {
    return parseCredentialDocumentBytes(bytes);
  } finally {
    bytes.fill(0);
  }
}

interface DependencyProbe {
  readonly dependencies: CredentialStoreWriterDependencies;
  readonly uuidCalls: () => number;
  readonly clockCalls: () => number;
}

function dependencyProbe(
  fake: InMemoryCredentialMutationStore,
  uuids: readonly string[],
  timestamps: readonly string[],
): DependencyProbe {
  let uuidIndex = 0;
  let clockIndex = 0;
  return Object.freeze({
    dependencies: Object.freeze({
      storage: fake.adapter,
      random: Object.freeze({
        uuid(): string {
          const value = uuids[uuidIndex];
          uuidIndex += 1;
          if (value === undefined) {
            throw new Error("unexpected test UUID request");
          }
          return value;
        },
      }),
      clock: Object.freeze({
        now(): number {
          const value = timestamps[clockIndex];
          clockIndex += 1;
          if (value === undefined) {
            throw new Error("unexpected test clock request");
          }
          return Date.parse(value);
        },
      }),
    }),
    uuidCalls: () => uuidIndex,
    clockCalls: () => clockIndex,
  });
}

async function expectCredentialError(
  operation: Promise<unknown>,
  code:
    | "credential_store_busy"
    | "credential_store_conflict"
    | "credential_store_unavailable",
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain(API_KEY);
    expect(String(error)).not.toContain(OTHER_API_KEY);
    return;
  }
  throw new Error("credential registration-store operation unexpectedly succeeded");
}

describe("exclusive credential registration store", () => {
  it("lazily creates and durably verifies a missing pending credential", async () => {
    const fake = createInMemoryCredentialMutationStore();
    const probe = dependencyProbe(
      fake,
      [NONCE_1, TRANSACTION_1],
      [CREATED_AT],
    );
    let factoryCalls = 0;
    let receivedTimestamp: CanonicalTimestamp | undefined;

    const result = await runExclusiveCredentialRegistration(
      probe.dependencies,
      LOCATIONS,
      async (session) => {
        expect(Object.isFrozen(session)).toBe(true);
        expect(Object.keys(session).sort()).toEqual([
          "activateExactPending",
          "readOrCreatePending",
          "replaceUsernameAfterConflict",
        ]);
        return session.readOrCreatePending((createdAt) => {
          factoryCalls += 1;
          receivedTimestamp = createdAt;
          return pendingCredential(createdAt);
        });
      },
    );

    expect(result).toEqual({
      status: "pending-created",
      credential: pendingCredential(),
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(factoryCalls).toBe(1);
    expect(receivedTimestamp).toBe(CREATED_AT);
    expect(probe.uuidCalls()).toBe(2);
    expect(probe.clockCalls()).toBe(1);
    expect(durableCredential(fake)).toEqual(pendingCredential());
    expect(fake.control.entries().map((entry) => entry.name)).toEqual([
      "credentials.json",
    ]);
    expect(fake.trace.operations().at(-1)).toBe("release");
    expect(JSON.stringify(fake.trace.operations())).not.toContain(API_KEY);
  });

  it("resumes the exact pending credential without invoking the factory or clock", async () => {
    const pending = pendingCredential();
    const fake = createInMemoryCredentialMutationStore({
      initialCredential: credentialBytes(pending),
    });
    const probe = dependencyProbe(fake, [NONCE_1], []);
    let factoryCalls = 0;

    const result = await runExclusiveCredentialRegistration(
      probe.dependencies,
      LOCATIONS,
      async (session) =>
        session.readOrCreatePending((_createdAt) => {
          factoryCalls += 1;
          throw new Error("pending factory must remain lazy");
        }),
    );

    expect(result).toEqual({
      status: "pending-resumed",
      credential: pending,
    });
    expect(factoryCalls).toBe(0);
    expect(probe.uuidCalls()).toBe(1);
    expect(probe.clockCalls()).toBe(0);
    expect(durableCredential(fake)).toEqual(pending);
    expect(
      fake.trace
        .operations()
        .some(
          (operation) =>
            operation.startsWith("create:") ||
            operation.startsWith("move:") ||
            operation.startsWith("remove:"),
        ),
    ).toBe(false);
  });

  it("returns an existing active credential without invoking the pending factory", async () => {
    const active = activeCredential(pendingCredential());
    const fake = createInMemoryCredentialMutationStore({
      initialCredential: credentialBytes(active),
    });
    const probe = dependencyProbe(fake, [NONCE_1], []);
    let factoryCalls = 0;

    const result = await runExclusiveCredentialRegistration(
      probe.dependencies,
      LOCATIONS,
      async (session) =>
        session.readOrCreatePending((_createdAt) => {
          factoryCalls += 1;
          throw new Error("active credential must bypass pending creation");
        }),
    );

    expect(result).toEqual({
      status: "existing-active",
      credential: active,
    });
    expect(factoryCalls).toBe(0);
    expect(probe.uuidCalls()).toBe(1);
    expect(probe.clockCalls()).toBe(0);
    expect(durableCredential(fake)).toEqual(active);
  });

  it("atomically activates only the exact pending credential and verified identity", async () => {
    const pending = pendingCredential();
    const fake = createInMemoryCredentialMutationStore({
      initialCredential: credentialBytes(pending),
    });
    const probe = dependencyProbe(
      fake,
      [NONCE_1, TRANSACTION_1],
      [ACTIVATED_AT],
    );

    const result = await runExclusiveCredentialRegistration(
      probe.dependencies,
      LOCATIONS,
      async (session) =>
        session.activateExactPending(pending, VERIFIED_AGENT),
    );

    const expected = activeCredential(pending);
    expect(result).toEqual({ status: "activated", credential: expected });
    expect(result.credential.updated_at).toBe(ACTIVATED_AT);
    expect(result.credential.activated_at).toBe(ACTIVATED_AT);
    expect(result.credential.api_key).toBe(pending.api_key);
    expect(result.credential.registration_request_id).toBe(
      pending.registration_request_id,
    );
    expect(result.credential.created_at).toBe(pending.created_at);
    expect(probe.uuidCalls()).toBe(2);
    expect(probe.clockCalls()).toBe(1);
    expect(durableCredential(fake)).toEqual(expected);
    expect(fake.control.entries().map((entry) => entry.name)).toEqual([
      "credentials.json",
    ]);
  });

  it("clamps activation to the pending timestamp when the wall clock moves backward", async () => {
    const pending = pendingCredential();
    const fake = createInMemoryCredentialMutationStore({
      initialCredential: credentialBytes(pending),
    });
    const probe = dependencyProbe(
      fake,
      [NONCE_1, TRANSACTION_1],
      [BACKWARD_CLOCK_AT],
    );

    const result = await runExclusiveCredentialRegistration(
      probe.dependencies,
      LOCATIONS,
      async (session) =>
        session.activateExactPending(pending, VERIFIED_AGENT),
    );

    const expected = activeCredential(pending, pending.updated_at);
    expect(result).toEqual({ status: "activated", credential: expected });
    expect(durableCredential(fake)).toEqual(expected);
    expect(probe.clockCalls()).toBe(1);
  });

  it("treats the exact already-active registration as an idempotent no-op", async () => {
    const pending = pendingCredential();
    const active = activeCredential(pending);
    const fake = createInMemoryCredentialMutationStore({
      initialCredential: credentialBytes(active),
    });
    const probe = dependencyProbe(fake, [NONCE_1], []);

    const result = await runExclusiveCredentialRegistration(
      probe.dependencies,
      LOCATIONS,
      async (session) =>
        session.activateExactPending(pending, VERIFIED_AGENT),
    );

    expect(result).toEqual({
      status: "already-active",
      credential: active,
    });
    expect(probe.uuidCalls()).toBe(1);
    expect(probe.clockCalls()).toBe(0);
    expect(durableCredential(fake)).toEqual(active);
  });

  it("explicitly replaces only username and request ID after a deterministic conflict", async () => {
    const pending = pendingCredential();
    const fake = createInMemoryCredentialMutationStore({
      initialCredential: credentialBytes(pending),
    });
    const probe = dependencyProbe(
      fake,
      [NONCE_1, TRANSACTION_1],
      [ACTIVATED_AT],
    );
    let requestFactoryCalls = 0;

    const result = await runExclusiveCredentialRegistration(
      probe.dependencies,
      LOCATIONS,
      async (session) =>
        session.replaceUsernameAfterConflict(
          "codex-43" as Username,
          () => {
            requestFactoryCalls += 1;
            return REPLACEMENT_REQUEST_ID as RegistrationRequestId;
          },
        ),
    );

    expect(result.status).toBe("pending-replaced");
    if (result.status !== "pending-replaced") {
      throw new Error("expected pending replacement");
    }
    expect(result.credential.api_key).toBe(pending.api_key);
    expect(result.credential.api_origin).toBe(pending.api_origin);
    expect(result.credential.agent_name).toBe(pending.agent_name);
    expect(result.credential.created_at).toBe(pending.created_at);
    expect(result.credential.updated_at).toBe(ACTIVATED_AT);
    expect(result.credential.username).toBe("codex-43");
    expect(result.credential.registration_request_id).toBe(
      REPLACEMENT_REQUEST_ID,
    );
    expect(requestFactoryCalls).toBe(1);
    expect(durableCredential(fake)).toEqual(result.credential);

    const retryProbe = dependencyProbe(fake, [NONCE_2], []);
    await expect(
      runExclusiveCredentialRegistration(
        retryProbe.dependencies,
        LOCATIONS,
        async (session) =>
          session.replaceUsernameAfterConflict(
            "codex-43" as Username,
            () => {
              requestFactoryCalls += 1;
              return REQUEST_ID as RegistrationRequestId;
            },
          ),
      ),
    ).resolves.toEqual({
      status: "pending-unchanged",
      credential: result.credential,
    });
    expect(requestFactoryCalls).toBe(1);
    expect(retryProbe.clockCalls()).toBe(0);
  });

  it("never regresses the pending timestamp during a backward-clock username retry", async () => {
    const original = pendingCredential();
    const pending = validateCredentialDocument({
      ...original,
      updated_at: ACTIVATED_AT,
    });
    if (pending.state !== "pending") {
      throw new Error("expected pending credential");
    }
    const fake = createInMemoryCredentialMutationStore({
      initialCredential: credentialBytes(pending),
    });
    const probe = dependencyProbe(
      fake,
      [NONCE_1, TRANSACTION_1],
      [BACKWARD_CLOCK_AT],
    );

    const result = await runExclusiveCredentialRegistration(
      probe.dependencies,
      LOCATIONS,
      async (session) =>
        session.replaceUsernameAfterConflict(
          "codex-43" as Username,
          () => REPLACEMENT_REQUEST_ID as RegistrationRequestId,
        ),
    );

    expect(result.status).toBe("pending-replaced");
    if (result.status !== "pending-replaced") {
      throw new Error("expected pending replacement");
    }
    expect(result.credential.updated_at).toBe(ACTIVATED_AT);
    expect(result.credential.api_key).toBe(pending.api_key);
    expect(durableCredential(fake)).toEqual(result.credential);
    expect(probe.clockCalls()).toBe(1);
  });

  it("does not invoke username-retry randomness without a pending credential", async () => {
    for (const initialCredential of [
      undefined,
      credentialBytes(activeCredential(pendingCredential())),
    ]) {
      const fake = createInMemoryCredentialMutationStore(
        initialCredential === undefined
          ? {}
          : { initialCredential },
      );
      const probe = dependencyProbe(fake, [NONCE_1], []);
      let requestFactoryCalls = 0;

      const result = await runExclusiveCredentialRegistration(
        probe.dependencies,
        LOCATIONS,
        async (session) =>
          session.replaceUsernameAfterConflict(
            "codex-43" as Username,
            () => {
              requestFactoryCalls += 1;
              return REPLACEMENT_REQUEST_ID as RegistrationRequestId;
            },
          ),
      );

      expect(result).toEqual({ status: "no-pending" });
      expect(requestFactoryCalls).toBe(0);
      expect(probe.clockCalls()).toBe(0);
    }
  });

  it("fails closed for a mismatched expected pending credential or verified identity", async () => {
    const pending = pendingCredential();

    const mismatchedExpectedFake = createInMemoryCredentialMutationStore({
      initialCredential: credentialBytes(pending),
    });
    const mismatchedExpectedProbe = dependencyProbe(
      mismatchedExpectedFake,
      [NONCE_1],
      [],
    );
    await expectCredentialError(
      runExclusiveCredentialRegistration(
        mismatchedExpectedProbe.dependencies,
        LOCATIONS,
        async (session) =>
          session.activateExactPending(
            pendingCredential(CREATED_AT, OTHER_API_KEY),
            VERIFIED_AGENT,
          ),
      ),
      "credential_store_conflict",
    );
    expect(durableCredential(mismatchedExpectedFake)).toEqual(pending);

    const mismatchedAgentFake = createInMemoryCredentialMutationStore({
      initialCredential: credentialBytes(pending),
    });
    const mismatchedAgentProbe = dependencyProbe(
      mismatchedAgentFake,
      [NONCE_2],
      [],
    );
    await expectCredentialError(
      runExclusiveCredentialRegistration(
        mismatchedAgentProbe.dependencies,
        LOCATIONS,
        async (session) =>
          session.activateExactPending(
            pending,
            Object.freeze({ ...VERIFIED_AGENT, name: "Claude Code" }),
          ),
      ),
      "credential_store_conflict",
    );
    expect(durableCredential(mismatchedAgentFake)).toEqual(pending);

    const unrelatedActive = activeCredential(
      pendingCredential(CREATED_AT, OTHER_API_KEY),
    );
    const unrelatedActiveFake = createInMemoryCredentialMutationStore({
      initialCredential: credentialBytes(unrelatedActive),
    });
    const unrelatedActiveProbe = dependencyProbe(
      unrelatedActiveFake,
      [NONCE_1],
      [],
    );
    await expectCredentialError(
      runExclusiveCredentialRegistration(
        unrelatedActiveProbe.dependencies,
        LOCATIONS,
        async (session) =>
          session.activateExactPending(pending, VERIFIED_AGENT),
      ),
      "credential_store_conflict",
    );
    expect(durableCredential(unrelatedActiveFake)).toEqual(unrelatedActive);
  });

  it("refuses a canonical credential changed while the exclusive callback is running", async () => {
    const pending = pendingCredential();
    const unrelated = pendingCredential(CREATED_AT, OTHER_API_KEY, "Other");
    const fake = createInMemoryCredentialMutationStore({
      initialCredential: credentialBytes(pending),
    });
    const probe = dependencyProbe(fake, [NONCE_1], []);

    await expectCredentialError(
      runExclusiveCredentialRegistration(
        probe.dependencies,
        LOCATIONS,
        async (session) => {
          fake.control.replaceCredentialUnrelated(
            credentialBytes(unrelated),
          );
          return session.activateExactPending(pending, VERIFIED_AGENT);
        },
      ),
      "credential_store_conflict",
    );

    expect(durableCredential(fake)).toEqual(unrelated);
  });

  it("keeps the setup lease held across the complete callback", async () => {
    const fake = createInMemoryCredentialMutationStore();
    const firstProbe = dependencyProbe(fake, [NONCE_1], []);
    const secondProbe = dependencyProbe(fake, [NONCE_2], []);
    let entered!: () => void;
    const callbackEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let unblock!: () => void;
    const callbackGate = new Promise<void>((resolve) => {
      unblock = resolve;
    });

    const first = runExclusiveCredentialRegistration(
      firstProbe.dependencies,
      LOCATIONS,
      async () => {
        entered();
        await callbackGate;
        return "first-complete";
      },
    );
    await callbackEntered;

    await expectCredentialError(
      runExclusiveCredentialRegistration(
        secondProbe.dependencies,
        LOCATIONS,
        async () => "second-must-not-enter",
      ),
      "credential_store_busy",
    );

    unblock();
    await expect(first).resolves.toBe("first-complete");
    expect(firstProbe.uuidCalls()).toBe(1);
    expect(secondProbe.uuidCalls()).toBe(1);
    expect(
      fake.trace.operations().filter((value) => value === "release"),
    ).toHaveLength(1);
  });

  it("releases the lease after a callback failure and sanitizes the failure", async () => {
    const fake = createInMemoryCredentialMutationStore();
    const firstProbe = dependencyProbe(fake, [NONCE_1], []);
    const secondProbe = dependencyProbe(fake, [NONCE_2], []);
    const secret = `callback-${API_KEY}`;

    await expectCredentialError(
      runExclusiveCredentialRegistration(
        firstProbe.dependencies,
        LOCATIONS,
        async () => {
          throw new Error(secret);
        },
      ),
      "credential_store_unavailable",
    );

    await expect(
      runExclusiveCredentialRegistration(
        secondProbe.dependencies,
        LOCATIONS,
        async () => "reacquired",
      ),
    ).resolves.toBe("reacquired");
    expect(
      fake.trace.operations().filter((value) => value === "release"),
    ).toHaveLength(2);
  });

  it("revokes every narrow session method after the callback settles", async () => {
    const fake = createInMemoryCredentialMutationStore();
    const probe = dependencyProbe(fake, [NONCE_1], []);
    let captured: ExclusiveCredentialRegistrationSession | undefined;

    await runExclusiveCredentialRegistration(
      probe.dependencies,
      LOCATIONS,
      async (session) => {
        captured = session;
      },
    );
    if (captured === undefined) {
      throw new Error("test session was not captured");
    }
    const revoked = captured;
    let factoryCalls = 0;

    await expectCredentialError(
      revoked.readOrCreatePending((createdAt) => {
        factoryCalls += 1;
        return pendingCredential(createdAt);
      }),
      "credential_store_unavailable",
    );
    await expectCredentialError(
      revoked.activateExactPending(pendingCredential(), VERIFIED_AGENT),
      "credential_store_unavailable",
    );
    await expectCredentialError(
      revoked.replaceUsernameAfterConflict(
        "codex-43" as Username,
        () => REPLACEMENT_REQUEST_ID as RegistrationRequestId,
      ),
      "credential_store_unavailable",
    );
    expect(factoryCalls).toBe(0);
    expect(probe.uuidCalls()).toBe(1);
    expect(probe.clockCalls()).toBe(0);
    expect(fake.control.entries()).toEqual([]);
  });
});
