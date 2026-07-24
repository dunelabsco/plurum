import { describe, expect, it } from "vitest";

import { DEFAULT_API_ORIGIN } from "../src/credentials/origin.js";
import {
  serializeCredentialDocument,
  validateCredentialDocument,
  type CredentialV1,
} from "../src/credentials/schema.js";
import type { CredentialStoreWholePassEvidence } from "../src/credentials/store-contracts.js";
import type {
  CredentialSetupLeaseNonce,
  CredentialTemporaryEntry,
} from "../src/credentials/store-mutation-contracts.js";
import {
  runExclusiveObservedCredentialSetup,
  type CleanCredentialStoreObservation,
  type ObservedCredentialStoreWriterDependencies,
} from "../src/credentials/store-writer.js";
import { createInMemoryCredentialMutationStore } from "./support/in-memory-credential-mutation-store.js";

const DIRECTORY = "/isolated/observed-plurum";
const LOCATIONS = Object.freeze({ directory: DIRECTORY });
const API_KEY_A = `plrm_live_${"A".repeat(43)}`;
const API_KEY_B = `plrm_live_${"B".repeat(43)}`;
const TRANSACTION_IDS = Object.freeze([
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
] as const);

function activeCredential(apiKey = API_KEY_A): CredentialV1 {
  return validateCredentialDocument({
    schema_version: 1,
    state: "active",
    api_origin: DEFAULT_API_ORIGIN,
    api_key: apiKey,
    agent_id: "123e4567-e89b-42d3-a456-426614174000",
    agent_name: "Codex",
    username: "codex-42",
    registration_request_id: null,
    created_at: "2026-07-21T10:00:00.000Z",
    updated_at: "2026-07-21T10:00:00.000Z",
    activated_at: "2026-07-21T10:00:00.000Z",
  });
}

function pendingCredential(): CredentialV1 {
  return validateCredentialDocument({
    schema_version: 1,
    state: "pending",
    api_origin: DEFAULT_API_ORIGIN,
    api_key: API_KEY_A,
    agent_id: null,
    agent_name: "Codex",
    username: "codex-42",
    registration_request_id: "40000000-0000-4000-8000-000000000001",
    created_at: "2026-07-21T10:00:00.000Z",
    updated_at: "2026-07-21T10:00:00.000Z",
    activated_at: null,
  });
}

function credentialBytes(credential: CredentialV1): Uint8Array {
  return new TextEncoder().encode(serializeCredentialDocument(credential));
}

function cleanObservation(
  evidence: CredentialStoreWholePassEvidence,
  credential: CredentialV1 | null,
): CleanCredentialStoreObservation {
  return Object.freeze({
    credential,
    transaction: null,
    temporaryEntries: "empty",
    evidence,
  });
}

function dependencies(
  store: ReturnType<typeof createInMemoryCredentialMutationStore>,
): Readonly<{
  value: ObservedCredentialStoreWriterDependencies;
  uuidCalls(): number;
  clockCalls(): number;
}> {
  let uuidCalls = 0;
  let clockCalls = 0;
  return Object.freeze({
    value: Object.freeze({
      storage: store.adapter,
      random: Object.freeze({
        uuid() {
          const value = TRANSACTION_IDS[uuidCalls];
          uuidCalls += 1;
          if (value === undefined) {
            throw new Error("unexpected UUID request");
          }
          return value;
        },
      }),
      clock: Object.freeze({
        now() {
          clockCalls += 1;
          return Date.parse("2026-07-21T10:05:00.000Z");
        },
      }),
    }),
    uuidCalls: () => uuidCalls,
    clockCalls: () => clockCalls,
  });
}

function mutationOperations(values: readonly string[]): readonly string[] {
  return values.filter(
    (value) =>
      value.startsWith("create:") ||
      value.startsWith("move:") ||
      value.startsWith("remove:") ||
      value === "sync-directory",
  );
}

describe("exclusive observed credential setup store", () => {
  it("verifies a clean missing observation before an exact write and reread", async () => {
    const store = createInMemoryCredentialMutationStore();
    const evidence = store.control.observeWholePass();
    const probe = dependencies(store);
    const credential = activeCredential();

    const result = await runExclusiveObservedCredentialSetup(
      probe.value,
      LOCATIONS,
      cleanObservation(evidence, null),
      async (session) => {
        expect(Object.isFrozen(session)).toBe(true);
        expect(Object.keys(session).sort()).toEqual([
          "activateExactPending",
          "readActiveCredential",
          "readExactCredential",
          "readOrCreatePending",
          "replaceUsernameAfterConflict",
          "writeExactCredential",
        ]);
        expect(probe.uuidCalls()).toBe(0);
        expect(probe.clockCalls()).toBe(0);
        await expect(session.readExactCredential(null)).resolves.toBeNull();
        await expect(
          session.writeExactCredential(null, credential),
        ).resolves.toEqual({ status: "written" });
        await expect(
          session.readExactCredential(credential),
        ).resolves.toEqual(credential);
        await expect(session.readActiveCredential()).resolves.toEqual(
          credential,
        );
        return "ready";
      },
    );

    expect(result).toEqual({ status: "completed", value: "ready" });
    expect(probe.uuidCalls()).toBe(1);
    expect(probe.clockCalls()).toBe(1);
    expect(store.control.readCredential()).toEqual(
      credentialBytes(credential),
    );
    expect(store.trace.operations().at(-1)).toBe("release");
  });

  it("returns precondition-failed before callback, randomness, or writes when evidence is stale", async () => {
    const store = createInMemoryCredentialMutationStore();
    const evidence = store.control.observeWholePass();
    store.control.seedCredential(credentialBytes(activeCredential()));
    const operationsBeforeAttempt = store.trace.operations().length;
    const probe = dependencies(store);
    let callbackCalls = 0;

    const result = await runExclusiveObservedCredentialSetup(
      probe.value,
      LOCATIONS,
      cleanObservation(evidence, null),
      async () => {
        callbackCalls += 1;
      },
    );

    expect(result).toEqual({ status: "precondition-failed" });
    expect(callbackCalls).toBe(0);
    expect(probe.uuidCalls()).toBe(0);
    expect(probe.clockCalls()).toBe(0);
    const attempted = store.trace.operations().slice(operationsBeforeAttempt);
    expect(attempted).toEqual(["acquire-observed-lease"]);
    expect(mutationOperations(attempted)).toEqual([]);
  });

  it("releases without invoking callback when retained canonical bytes do not match", async () => {
    const before = activeCredential(API_KEY_A);
    const store = createInMemoryCredentialMutationStore({
      initialCredential: credentialBytes(before),
    });
    const evidence = store.control.observeWholePass();
    const probe = dependencies(store);
    let callbackCalls = 0;

    const result = await runExclusiveObservedCredentialSetup(
      probe.value,
      LOCATIONS,
      cleanObservation(evidence, activeCredential(API_KEY_B)),
      async () => {
        callbackCalls += 1;
      },
    );

    expect(result).toEqual({ status: "precondition-failed" });
    expect(callbackCalls).toBe(0);
    expect(probe.uuidCalls()).toBe(0);
    expect(probe.clockCalls()).toBe(0);
    expect(store.trace.operations().at(-1)).toBe("release");
    expect(store.control.readCredential()).toEqual(credentialBytes(before));
    expect(mutationOperations(store.trace.operations())).toEqual([]);
  });

  it.each(["transaction", "temporary"] as const)(
    "does not recover or clean an observed %s before approval revalidation",
    async (kind) => {
      const store = createInMemoryCredentialMutationStore();
      if (kind === "transaction") {
        store.control.seedTransaction(new Uint8Array([0x7b]));
      } else {
        const temporary: CredentialTemporaryEntry = Object.freeze({
          kind: "temporary",
          role: "credential-candidate",
          transactionId:
            "20000000-0000-4000-8000-000000000001" as never,
        });
        store.control.seedTemporary(temporary, new Uint8Array([0x7b]));
      }
      const evidence = store.control.observeWholePass();
      const operationsBeforeAttempt = store.trace.operations().length;
      const probe = dependencies(store);

      const result = await runExclusiveObservedCredentialSetup(
        probe.value,
        LOCATIONS,
        cleanObservation(evidence, null),
        async () => "must-not-run",
      );

      expect(result).toEqual({ status: "precondition-failed" });
      expect(probe.uuidCalls()).toBe(0);
      expect(probe.clockCalls()).toBe(0);
      const attempted = store.trace.operations().slice(operationsBeforeAttempt);
      expect(mutationOperations(attempted)).toEqual([]);
      expect(store.control.entries()).toHaveLength(1);
      expect(attempted.at(-1)).toBe("release");
    },
  );

  it("distinguishes a busy observed lease and burns the supplied evidence", async () => {
    const store = createInMemoryCredentialMutationStore();
    const evidence = store.control.observeWholePass();
    const held = await store.adapter.acquireSetupLease(DIRECTORY, {
      noFollow: true,
      createDirectory: true,
      nonce:
        "30000000-0000-4000-8000-000000000001" as CredentialSetupLeaseNonce,
    });
    if (held.status !== "acquired") {
      throw new Error("expected held lease");
    }
    const probe = dependencies(store);

    await expect(
      runExclusiveObservedCredentialSetup(
        probe.value,
        LOCATIONS,
        cleanObservation(evidence, null),
        async () => "must-not-run",
      ),
    ).resolves.toEqual({ status: "busy" });
    expect(probe.uuidCalls()).toBe(0);
    expect(probe.clockCalls()).toBe(0);
    await held.lease.release();

    await expect(
      runExclusiveObservedCredentialSetup(
        probe.value,
        LOCATIONS,
        cleanObservation(evidence, null),
        async () => "must-not-run",
      ),
    ).resolves.toEqual({ status: "precondition-failed" });
  });

  it("requires the exact current state for every in-lease write", async () => {
    const before = activeCredential(API_KEY_A);
    const store = createInMemoryCredentialMutationStore({
      initialCredential: credentialBytes(before),
    });
    const evidence = store.control.observeWholePass();
    const probe = dependencies(store);

    await expect(
      runExclusiveObservedCredentialSetup(
        probe.value,
        LOCATIONS,
        cleanObservation(evidence, before),
        async (session) =>
          session.writeExactCredential(
            activeCredential(API_KEY_B),
            activeCredential(API_KEY_B),
          ),
      ),
    ).rejects.toMatchObject({
      code: "credential_store_conflict",
    });
    expect(probe.uuidCalls()).toBe(0);
    expect(probe.clockCalls()).toBe(0);
    expect(store.control.readCredential()).toEqual(credentialBytes(before));
    expect(store.trace.operations().at(-1)).toBe("release");
  });

  it("returns only a re-attested active canonical credential", async () => {
    const pending = pendingCredential();
    const store = createInMemoryCredentialMutationStore({
      initialCredential: credentialBytes(pending),
    });
    const evidence = store.control.observeWholePass();
    const probe = dependencies(store);

    await expect(
      runExclusiveObservedCredentialSetup(
        probe.value,
        LOCATIONS,
        cleanObservation(evidence, pending),
        async (session) => session.readActiveCredential(),
      ),
    ).rejects.toMatchObject({
      code: "credential_store_conflict",
    });
    expect(probe.uuidCalls()).toBe(0);
    expect(probe.clockCalls()).toBe(0);
    expect(store.control.readCredential()).toEqual(
      credentialBytes(pending),
    );
    expect(store.trace.operations().at(-1)).toBe("release");
  });

  it("does not report completion when exact lease release is unconfirmed", async () => {
    const store = createInMemoryCredentialMutationStore({
      failRelease: true,
    });
    const evidence = store.control.observeWholePass();
    const probe = dependencies(store);

    await expect(
      runExclusiveObservedCredentialSetup(
        probe.value,
        LOCATIONS,
        cleanObservation(evidence, null),
        async () => "locally-ready",
      ),
    ).rejects.toMatchObject({
      code: "credential_store_unavailable",
    });
    expect(probe.uuidCalls()).toBe(0);
    expect(probe.clockCalls()).toBe(0);
    expect(store.trace.operations().at(-1)).toBe("release");
  });
});
