import { describe, expect, it } from "vitest";

import { DEFAULT_API_ORIGIN } from "../src/credentials/origin.js";
import {
  serializeCredentialDocument,
  type CredentialV1,
  validateCredentialDocument,
} from "../src/credentials/schema.js";
import type {
  CredentialSetupLeaseNonce,
  CredentialStoreMutationAdapter,
  CredentialTemporaryEntry,
} from "../src/credentials/store-mutation-contracts.js";
import {
  serializeCredentialTransactionDocumentBytes,
  validateCredentialTransactionDocument,
  validateCredentialTransactionId,
} from "../src/credentials/store-transaction.js";
import {
  recoverCredentialStore,
  writeCredentialStore,
  type CredentialStoreRecoveryDependencies,
  type CredentialStoreWriterDependencies,
} from "../src/credentials/store-writer.js";
import {
  createInMemoryCredentialMutationStore,
  type InMemoryCredentialMutationStore,
  type InMemoryCredentialMutationStoreOptions,
} from "./support/in-memory-credential-mutation-store.js";

const LOCATIONS = Object.freeze({ directory: "/isolated/plurum" });
const NONCE_1 = "11111111-1111-4111-8111-111111111111";
const TRANSACTION_1 = "22222222-2222-4222-8222-222222222222";
const NONCE_2 = "33333333-3333-4333-8333-333333333333";
const TRANSACTION_2 = "44444444-4444-4444-8444-444444444444";
const NONCE_3 = "55555555-5555-4555-8555-555555555555";
const CREATED_AT = "2026-07-19T12:00:00.000Z";
const UPDATED_AT = "2026-07-19T12:01:00.000Z";
const REQUEST_ID = "ca908d9f-d901-4dac-b396-7f84377adfc8";
const AGENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const OLD_KEY = `plrm_live_${"O".repeat(43)}`;
const NEW_KEY = `plrm_live_${"N".repeat(43)}`;
const UNRELATED_KEY = `plrm_live_${"U".repeat(43)}`;

function credential(
  apiKey: string,
  agentName = "Codex",
): CredentialV1 {
  return validateCredentialDocument({
    schema_version: 1,
    state: "active",
    api_origin: DEFAULT_API_ORIGIN,
    api_key: apiKey,
    agent_id: AGENT_ID,
    agent_name: agentName,
    username: "codex-42",
    registration_request_id: REQUEST_ID,
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
    activated_at: UPDATED_AT,
  });
}

function credentialBytes(value: CredentialV1): Uint8Array {
  return new TextEncoder().encode(serializeCredentialDocument(value));
}

function sameBytes(
  left: Uint8Array | undefined,
  right: Uint8Array | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function uuidSource(values: readonly string[]) {
  let index = 0;
  return Object.freeze({
    uuid(): string {
      const value = values[index];
      index += 1;
      if (value === undefined) {
        throw new Error("test UUID source exhausted");
      }
      return value;
    },
  });
}

function writerDependencies(
  fake: InMemoryCredentialMutationStore,
  values: readonly string[] = [NONCE_1, TRANSACTION_1],
): CredentialStoreWriterDependencies {
  return Object.freeze({
    storage: fake.adapter,
    random: uuidSource(values),
    clock: Object.freeze({ now: () => Date.parse(UPDATED_AT) }),
  });
}

function recoveryDependencies(
  fake: InMemoryCredentialMutationStore,
  nonce = NONCE_3,
): CredentialStoreRecoveryDependencies {
  return Object.freeze({
    storage: fake.adapter,
    random: uuidSource([nonce]),
  });
}

function transactionBytes(
  before: CredentialV1 | null,
  after: CredentialV1,
  transactionId = TRANSACTION_1,
): Uint8Array {
  return serializeCredentialTransactionDocumentBytes(
    validateCredentialTransactionDocument({
      schema_version: 1,
      kind: "credential-replace",
      transaction_id: transactionId,
      created_at: UPDATED_AT,
      before,
      after,
    }),
  );
}

function entryNames(fake: InMemoryCredentialMutationStore): readonly string[] {
  return fake.control.entries().map((entry) => entry.name);
}

interface MutationBoundary {
  readonly operation: string;
  readonly occurrence: number;
}

function mutationBoundaries(
  operations: readonly string[],
): readonly MutationBoundary[] {
  const mutating = operations.filter(
    (operation) =>
      operation.startsWith("create:") ||
      operation.startsWith("write:") ||
      operation.startsWith("sync-file:") ||
      operation.startsWith("move:") ||
      operation.startsWith("remove:") ||
      operation === "sync-directory",
  );
  const counts = new Map<string, number>();
  return Object.freeze(
    mutating.map((operation) => {
      const occurrence = (counts.get(operation) ?? 0) + 1;
      counts.set(operation, occurrence);
      return Object.freeze({ operation, occurrence });
    }),
  );
}

async function expectSafeStoreError(
  attempt: Promise<unknown>,
  expectedCode:
    | "credential_recovery_required"
    | "credential_store_busy"
    | "credential_store_conflict"
    | "credential_store_unavailable"
    | "unsupported_credential_transaction_schema",
): Promise<void> {
  try {
    await attempt;
  } catch (error) {
    expect(
      typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === expectedCode,
    ).toBe(true);
    const rendered = String(error);
    expect(rendered.includes(OLD_KEY)).toBe(false);
    expect(rendered.includes(NEW_KEY)).toBe(false);
    expect(rendered.includes(UNRELATED_KEY)).toBe(false);
    return;
  }
  throw new Error("credential-store operation unexpectedly succeeded");
}

describe("transactional credential-store writer", () => {
  it("durably installs a new credential and removes all recovery material", async () => {
    const fake = createInMemoryCredentialMutationStore();
    const next = credential(NEW_KEY);
    const expected = credentialBytes(next);

    await expect(
      writeCredentialStore(writerDependencies(fake), LOCATIONS, next),
    ).resolves.toEqual({ status: "written" });

    expect(sameBytes(fake.control.readCredential(), expected)).toBe(true);
    expect(sameBytes(fake.control.readDurableCredential(), expected)).toBe(
      true,
    );
    expect(entryNames(fake)).toEqual(["credentials.json"]);
    expect(fake.trace.operations().at(-1)).toBe("release");
    expect(JSON.stringify(fake.trace.operations()).includes(NEW_KEY)).toBe(
      false,
    );
  });

  it("atomically replaces an existing credential and treats exact state as a no-op", async () => {
    const old = credential(OLD_KEY);
    const next = credential(NEW_KEY);
    const fake = createInMemoryCredentialMutationStore({
      initialCredential: credentialBytes(old),
    });

    await expect(
      writeCredentialStore(writerDependencies(fake), LOCATIONS, next),
    ).resolves.toEqual({ status: "written" });
    expect(
      sameBytes(fake.control.readDurableCredential(), credentialBytes(next)),
    ).toBe(true);

    const beforeNoop = fake.trace.operations().length;
    await expect(
      writeCredentialStore(
        writerDependencies(fake, [NONCE_2, TRANSACTION_2]),
        LOCATIONS,
        next,
      ),
    ).resolves.toEqual({ status: "unchanged" });
    expect(
      fake.trace
        .operations()
        .slice(beforeNoop)
        .some((operation) => operation.startsWith("create:")),
    ).toBe(false);
    expect(entryNames(fake)).toEqual(["credentials.json"]);
  });

  it("snapshots caller input before the first await", async () => {
    const fake = createInMemoryCredentialMutationStore();
    const mutable = {
      schema_version: 1,
      state: "active",
      api_origin: DEFAULT_API_ORIGIN,
      api_key: NEW_KEY,
      agent_id: AGENT_ID,
      agent_name: "Codex",
      username: "codex-42",
      registration_request_id: REQUEST_ID,
      created_at: CREATED_AT,
      updated_at: UPDATED_AT,
      activated_at: UPDATED_AT,
    };
    const expected = credentialBytes(credential(NEW_KEY));

    const pending = writeCredentialStore(
      writerDependencies(fake),
      LOCATIONS,
      mutable as unknown as CredentialV1,
    );
    mutable.api_key = UNRELATED_KEY;
    mutable.agent_name = "mutated";

    await expect(pending).resolves.toEqual({ status: "written" });
    expect(sameBytes(fake.control.readCredential(), expected)).toBe(true);
  });

  it("reports live contention without creating transaction material", async () => {
    const fake = createInMemoryCredentialMutationStore();
    const held = await fake.adapter.acquireSetupLease(
      LOCATIONS.directory,
      Object.freeze({
        noFollow: true,
        createDirectory: true,
        nonce: NONCE_2 as CredentialSetupLeaseNonce,
      }),
    );
    expect(held.status).toBe("acquired");
    if (held.status !== "acquired") {
      throw new Error("test lease was not acquired");
    }

    await expectSafeStoreError(
      writeCredentialStore(
        writerDependencies(fake),
        LOCATIONS,
        credential(NEW_KEY),
      ),
      "credential_store_busy",
    );
    expect(entryNames(fake)).toEqual([]);
    await held.lease.release();
  });

  it("uses abandon, never release, when native lease evidence is explicitly lost", async () => {
    const fake = createInMemoryCredentialMutationStore({
      loseLeaseAtRenew: 1,
    });

    await expectSafeStoreError(
      writeCredentialStore(
        writerDependencies(fake),
        LOCATIONS,
        credential(NEW_KEY),
      ),
      "credential_recovery_required",
    );
    expect(fake.trace.operations()).toContain("abandon");
    expect(fake.trace.operations()).not.toContain("release");
    expect(entryNames(fake)).toEqual([]);
  });

  it("uses conditional release after malformed renewal evidence", async () => {
    const fake = createInMemoryCredentialMutationStore({
      malformedLeaseAtRenew: 1,
    });

    await expectSafeStoreError(
      writeCredentialStore(
        writerDependencies(fake),
        LOCATIONS,
        credential(NEW_KEY),
      ),
      "credential_store_unavailable",
    );
    expect(fake.trace.operations()).toContain("release");
    expect(fake.trace.operations()).not.toContain("abandon");
    expect(entryNames(fake)).toEqual([]);
  });

  it("leaves a committed credential recoverable when lease release reports failure", async () => {
    const next = credential(NEW_KEY);
    const nextBytes = credentialBytes(next);
    const fake = createInMemoryCredentialMutationStore({
      failRelease: true,
    });

    await expectSafeStoreError(
      writeCredentialStore(
        writerDependencies(fake),
        LOCATIONS,
        next,
      ),
      "credential_store_unavailable",
    );
    expect(
      sameBytes(fake.control.readDurableCredential(), nextBytes),
    ).toBe(true);
    expect(entryNames(fake)).toEqual(["credentials.json"]);
    const reacquired = await fake.adapter.acquireSetupLease(
      LOCATIONS.directory,
      Object.freeze({
        noFollow: true,
        createDirectory: true,
        nonce: NONCE_2 as CredentialSetupLeaseNonce,
      }),
    );
    expect(reacquired).toMatchObject({
      status: "acquired",
      priorLease: "proven-abandoned",
    });
    if (reacquired.status === "acquired") {
      await reacquired.lease.release();
    }
  });

  it("rejects invalid injected randomness before calling storage", async () => {
    const fake = createInMemoryCredentialMutationStore();
    await expectSafeStoreError(
      writeCredentialStore(
        Object.freeze({
          storage: fake.adapter,
          random: Object.freeze({ uuid: () => "../not-a-uuid" }),
          clock: Object.freeze({ now: () => Date.parse(UPDATED_AT) }),
        }),
        LOCATIONS,
        credential(NEW_KEY),
      ),
      "credential_store_unavailable",
    );
    expect(fake.trace.operations()).toEqual([]);
  });

  it("abandons a malformed acquired lease and closes a malformed opened handle", async () => {
    let abandoned = 0;
    const malformedLeaseAdapter = Object.freeze({
      async acquireSetupLease() {
        return Object.freeze({
          status: "acquired",
          priorLease: "absent",
          directory: "existing",
          lease: Object.freeze({
            async abandon() {
              abandoned += 1;
            },
          }),
        });
      },
    }) as unknown as CredentialStoreMutationAdapter;
    await expectSafeStoreError(
      writeCredentialStore(
        Object.freeze({
          storage: malformedLeaseAdapter,
          random: uuidSource([NONCE_1, TRANSACTION_1]),
          clock: Object.freeze({ now: () => Date.parse(UPDATED_AT) }),
        }),
        LOCATIONS,
        credential(NEW_KEY),
      ),
      "credential_store_unavailable",
    );
    expect(abandoned).toBe(1);

    const hostileAcquireAdapter = Object.freeze({
      async acquireSetupLease() {
        const result: Record<string, unknown> = {
          priorLease: "absent",
          directory: "existing",
          lease: Object.freeze({
            async abandon() {
              abandoned += 1;
            },
          }),
        };
        Object.defineProperty(result, "status", {
          enumerable: true,
          get(): never {
            throw new Error(NEW_KEY);
          },
        });
        return Object.freeze(result);
      },
    }) as unknown as CredentialStoreMutationAdapter;
    await expectSafeStoreError(
      recoverCredentialStore(
        Object.freeze({
          storage: hostileAcquireAdapter,
          random: uuidSource([NONCE_2]),
        }),
        LOCATIONS,
      ),
      "credential_store_unavailable",
    );
    expect(abandoned).toBe(2);

    let closed = 0;
    let released = 0;
    const directoryIdentity = Object.freeze({
      volume: "malformed-volume",
      object: "malformed-directory",
    });
    const malformedHandle = Object.freeze({
      async close() {
        closed += 1;
      },
    });
    const lease = Object.freeze({
      async attestDirectory() {
        return Object.freeze({
          kind: "directory" as const,
          identity: directoryIdentity,
          revision: "directory-revision-1",
          binding: "canonical-current" as const,
          owner: "current-user" as const,
          access: "user-only" as const,
          link: "direct" as const,
        });
      },
      async renew() {
        return Object.freeze({ status: "held" as const });
      },
      async observeEntry() {
        const result: Record<string, unknown> = {
          snapshot: Object.freeze({}),
          attestation: Object.freeze({
            kind: "regular-file" as const,
            identity: Object.freeze({
              volume: "malformed-volume",
              object: "malformed-file",
            }),
            parentIdentity: directoryIdentity,
            revision: "file-revision-1",
            binding: "canonical-current" as const,
            owner: "current-user" as const,
            access: "user-only" as const,
            link: "direct" as const,
            links: 1,
            size: 0,
          }),
          file: malformedHandle,
        };
        Object.defineProperty(result, "status", {
          enumerable: true,
          get(): never {
            throw new Error(NEW_KEY);
          },
        });
        return Object.freeze(result);
      },
      async listTemporaryEntries() {
        return Object.freeze([]);
      },
      async createTemporaryExclusive() {
        throw new Error("unreachable");
      },
      async moveTemporaryConditionally() {
        throw new Error("unreachable");
      },
      async removeConditionally() {
        throw new Error("unreachable");
      },
      async syncDirectory() {
        throw new Error("unreachable");
      },
      async release() {
        released += 1;
      },
      async abandon() {
        throw new Error("unreachable");
      },
    });
    const malformedHandleAdapter = Object.freeze({
      async acquireSetupLease() {
        return Object.freeze({
          status: "acquired" as const,
          priorLease: "absent" as const,
          directory: "existing" as const,
          lease,
        });
      },
    }) as unknown as CredentialStoreMutationAdapter;

    await expectSafeStoreError(
      recoverCredentialStore(
        Object.freeze({
          storage: malformedHandleAdapter,
          random: uuidSource([NONCE_2]),
        }),
        LOCATIONS,
      ),
      "credential_store_unavailable",
    );
    expect(closed).toBe(1);
    expect(released).toBe(1);
  });

  it("rolls an installed credential back from a durable journal", async () => {
    const old = credential(OLD_KEY);
    const next = credential(NEW_KEY);
    const fake = createInMemoryCredentialMutationStore({
      initialCredential: credentialBytes(next),
    });
    fake.control.seedTransaction(transactionBytes(old, next));

    await expect(
      recoverCredentialStore(recoveryDependencies(fake), LOCATIONS),
    ).resolves.toEqual({ status: "rolled-back" });
    expect(
      sameBytes(fake.control.readDurableCredential(), credentialBytes(old)),
    ).toBe(true);
    expect(entryNames(fake)).toEqual(["credentials.json"]);
  });

  it("restores original absence and aborts a journal whose old target is already present", async () => {
    const old = credential(OLD_KEY);
    const next = credential(NEW_KEY);

    const installed = createInMemoryCredentialMutationStore({
      initialCredential: credentialBytes(next),
    });
    installed.control.seedTransaction(transactionBytes(null, next));
    await expect(
      recoverCredentialStore(recoveryDependencies(installed), LOCATIONS),
    ).resolves.toEqual({ status: "rolled-back" });
    expect(installed.control.readDurableCredential()).toBeUndefined();
    expect(entryNames(installed)).toEqual([]);

    const untouched = createInMemoryCredentialMutationStore({
      initialCredential: credentialBytes(old),
    });
    untouched.control.seedTransaction(transactionBytes(old, next));
    await expect(
      recoverCredentialStore(recoveryDependencies(untouched), LOCATIONS),
    ).resolves.toEqual({ status: "rolled-back" });
    expect(
      sameBytes(
        untouched.control.readDurableCredential(),
        credentialBytes(old),
      ),
    ).toBe(true);
    expect(entryNames(untouched)).toEqual(["credentials.json"]);
  });

  it("cleans an orphaned recovery candidate before retrying rollback", async () => {
    const old = credential(OLD_KEY);
    const next = credential(NEW_KEY);
    const fake = createInMemoryCredentialMutationStore({
      initialCredential: credentialBytes(next),
    });
    fake.control.seedTransaction(transactionBytes(old, next));
    const recoveryEntry: CredentialTemporaryEntry = Object.freeze({
      kind: "temporary",
      role: "recovery-candidate",
      transactionId: validateCredentialTransactionId(TRANSACTION_1),
    });
    fake.control.seedTemporary(recoveryEntry, credentialBytes(old));

    await expect(
      recoverCredentialStore(recoveryDependencies(fake), LOCATIONS),
    ).resolves.toEqual({ status: "rolled-back" });
    expect(
      sameBytes(fake.control.readDurableCredential(), credentialBytes(old)),
    ).toBe(true);
    expect(entryNames(fake)).toEqual(["credentials.json"]);
  });

  it("never overwrites an unrelated target that changes before replacement", async () => {
    const old = credential(OLD_KEY);
    const next = credential(NEW_KEY);
    const unrelated = credential(UNRELATED_KEY, "unrelated");
    const unrelatedBytes = credentialBytes(unrelated);
    let injected = false;
    let fake: InMemoryCredentialMutationStore;
    const options: InMemoryCredentialMutationStoreOptions = {
      initialCredential: credentialBytes(old),
      onOperation(operation) {
        if (
          !injected &&
          operation.startsWith("move:.credentials-candidate-") &&
          operation.endsWith("->credentials.json")
        ) {
          injected = true;
          fake.control.replaceCredentialUnrelated(unrelatedBytes);
        }
      },
    };
    fake = createInMemoryCredentialMutationStore(options);

    await expectSafeStoreError(
      writeCredentialStore(
        writerDependencies(fake),
        LOCATIONS,
        next,
      ),
      "credential_recovery_required",
    );
    expect(injected).toBe(true);
    expect(
      sameBytes(fake.control.readDurableCredential(), unrelatedBytes),
    ).toBe(true);
    expect(entryNames(fake)).toContain("credentials-transaction.json");
  });

  it("keeps malformed or future journals protected and blocks mutation", async () => {
    const old = credential(OLD_KEY);
    const next = credential(NEW_KEY);
    const fake = createInMemoryCredentialMutationStore({
      initialCredential: credentialBytes(old),
    });
    const future = new TextEncoder().encode(
      new TextDecoder()
        .decode(transactionBytes(old, next))
        .replace('"schema_version": 1', '"schema_version": 2'),
    );
    fake.control.seedTransaction(future);

    await expectSafeStoreError(
      recoverCredentialStore(recoveryDependencies(fake), LOCATIONS),
      "unsupported_credential_transaction_schema",
    );
    expect(
      sameBytes(fake.control.readDurableCredential(), credentialBytes(old)),
    ).toBe(true);
    expect(entryNames(fake)).toContain("credentials-transaction.json");
  });

  it("durably confirms journal absence before reporting recovery clean", async () => {
    const old = credential(OLD_KEY);
    const next = credential(NEW_KEY);
    const oldBytes = credentialBytes(old);
    const nextBytes = credentialBytes(next);
    const probe = createInMemoryCredentialMutationStore({
      initialCredential: oldBytes,
    });
    await writeCredentialStore(
      writerDependencies(probe),
      LOCATIONS,
      next,
    );
    const syncCount = probe.trace
      .operations()
      .filter((operation) => operation === "sync-directory").length;
    expect(syncCount > 0).toBe(true);

    const fake = createInMemoryCredentialMutationStore({
      initialCredential: oldBytes,
      fault: Object.freeze({
        mode: "throw-before",
        operation: "sync-directory",
        occurrence: syncCount,
      }),
    });
    await expect(
      writeCredentialStore(
        writerDependencies(fake),
        LOCATIONS,
        next,
      ),
    ).rejects.toBeDefined();
    await expect(
      recoverCredentialStore(
        recoveryDependencies(fake, NONCE_2),
        LOCATIONS,
      ),
    ).resolves.toEqual({ status: "clean" });

    fake.control.crash();
    await expect(
      recoverCredentialStore(
        recoveryDependencies(fake, NONCE_3),
        LOCATIONS,
      ),
    ).resolves.toEqual({ status: "clean" });
    expect(
      sameBytes(fake.control.readDurableCredential(), nextBytes),
    ).toBe(true);
    expect(entryNames(fake)).toEqual(["credentials.json"]);
  });

  it("converges after every rollback and orphan-cleanup fault boundary", async () => {
    const old = credential(OLD_KEY);
    const next = credential(NEW_KEY);
    const oldBytes = credentialBytes(old);
    const nextBytes = credentialBytes(next);
    const orphanTransactionId =
      validateCredentialTransactionId(TRANSACTION_2);
    const modes = [
      "throw-before",
      "throw-after",
      "crash-before",
      "crash-after",
    ] as const;
    const scenarios = [
      Object.freeze({
        name: "existing",
        before: old,
        expected: oldBytes as Uint8Array | undefined,
        orphans: false,
      }),
      Object.freeze({
        name: "absent",
        before: null,
        expected: undefined,
        orphans: false,
      }),
      Object.freeze({
        name: "orphans",
        before: old,
        expected: oldBytes as Uint8Array | undefined,
        orphans: true,
      }),
    ] as const;

    function seedScenario(
      fake: InMemoryCredentialMutationStore,
      scenario: (typeof scenarios)[number],
    ): void {
      fake.control.seedTransaction(
        transactionBytes(scenario.before, next),
      );
      if (scenario.orphans) {
        for (const role of [
          "credential-candidate",
          "transaction-candidate",
          "recovery-candidate",
        ] as const) {
          fake.control.seedTemporary(
            Object.freeze({
              kind: "temporary",
              role,
              transactionId: orphanTransactionId,
            }),
            role === "transaction-candidate"
              ? transactionBytes(scenario.before, next, TRANSACTION_2)
              : oldBytes,
          );
        }
      }
    }

    for (const scenario of scenarios) {
      const probe = createInMemoryCredentialMutationStore({
        initialCredential: nextBytes,
      });
      seedScenario(probe, scenario);
      await recoverCredentialStore(
        recoveryDependencies(probe),
        LOCATIONS,
      );
      const boundaries = mutationBoundaries(probe.trace.operations());
      expect(boundaries.length > 2).toBe(true);
      if (scenario.name === "existing") {
        expect(
          boundaries.some((boundary) =>
            boundary.operation.includes(".credentials-recovery-"),
          ),
        ).toBe(true);
      }
      if (scenario.name === "absent") {
        expect(
          boundaries.some(
            (boundary) =>
              boundary.operation === "remove:credentials.json",
          ),
        ).toBe(true);
      }

      for (const boundary of boundaries) {
        for (const mode of modes) {
          const policies =
            mode === "crash-before" || mode === "crash-after"
              ? (["discard-unsynced", "persist-unsynced"] as const)
              : (["discard-unsynced"] as const);
          for (const crashPolicy of policies) {
            const fake = createInMemoryCredentialMutationStore({
              initialCredential: nextBytes,
              crashPolicy,
              fault: Object.freeze({ ...boundary, mode }),
            });
            seedScenario(fake, scenario);
            await expect(
              recoverCredentialStore(
                recoveryDependencies(fake),
                LOCATIONS,
              ),
            ).rejects.toBeDefined();

            await expect(
              recoverCredentialStore(
                recoveryDependencies(fake, NONCE_2),
                LOCATIONS,
              ),
            ).resolves.toMatchObject({
              status: expect.stringMatching(/^(?:clean|rolled-back)$/u),
            });

            fake.control.crash();
            await expect(
              recoverCredentialStore(
                recoveryDependencies(fake, NONCE_3),
                LOCATIONS,
              ),
            ).resolves.toEqual({ status: "clean" });
            expect(
              sameBytes(
                fake.control.readDurableCredential(),
                scenario.expected,
              ),
            ).toBe(true);
            expect(
              entryNames(fake).every(
                (name) => name === "credentials.json",
              ),
            ).toBe(true);
            expect(
              JSON.stringify(fake.trace.operations()).includes(OLD_KEY),
            ).toBe(false);
            expect(
              JSON.stringify(fake.trace.operations()).includes(NEW_KEY),
            ).toBe(false);
          }
        }
      }
    }
  });

  it("recovers to exactly old or new across every injected mutation fault", async () => {
    const old = credential(OLD_KEY);
    const next = credential(NEW_KEY);
    const oldBytes = credentialBytes(old);
    const nextBytes = credentialBytes(next);
    const clean = createInMemoryCredentialMutationStore({
      initialCredential: oldBytes,
    });
    await writeCredentialStore(
      writerDependencies(clean),
      LOCATIONS,
      next,
    );

    const boundaries = mutationBoundaries(clean.trace.operations());
    expect(boundaries.length > 10).toBe(true);

    const modes = [
      "throw-before",
      "throw-after",
      "crash-before",
      "crash-after",
    ] as const;
    for (const original of [oldBytes, undefined]) {
      for (const boundary of boundaries) {
        for (const mode of modes) {
          const policies =
            mode === "crash-before" || mode === "crash-after"
              ? (["discard-unsynced", "persist-unsynced"] as const)
              : (["discard-unsynced"] as const);
          for (const crashPolicy of policies) {
            const fault = Object.freeze({ ...boundary, mode });
            const fake =
              original === undefined
                ? createInMemoryCredentialMutationStore({
                    crashPolicy,
                    fault,
                  })
                : createInMemoryCredentialMutationStore({
                    initialCredential: original,
                    crashPolicy,
                    fault,
                  });
            await expect(
              writeCredentialStore(
                writerDependencies(fake),
                LOCATIONS,
                next,
              ),
            ).rejects.toBeDefined();

            await expect(
              recoverCredentialStore(
                recoveryDependencies(fake, NONCE_2),
                LOCATIONS,
              ),
            ).resolves.toMatchObject({
              status: expect.stringMatching(/^(?:clean|rolled-back)$/u),
            });
            fake.control.crash();
            await expect(
              recoverCredentialStore(
                recoveryDependencies(fake, NONCE_3),
                LOCATIONS,
              ),
            ).resolves.toEqual({ status: "clean" });

            const finalCredential = fake.control.readDurableCredential();
            expect(
              sameBytes(finalCredential, original) ||
                sameBytes(finalCredential, nextBytes),
            ).toBe(true);
            expect(
              entryNames(fake).every(
                (name) => name === "credentials.json",
              ),
            ).toBe(true);
            expect(
              JSON.stringify(fake.trace.operations()).includes(OLD_KEY),
            ).toBe(false);
            expect(
              JSON.stringify(fake.trace.operations()).includes(NEW_KEY),
            ).toBe(false);
          }
        }
      }
    }
  });
});
