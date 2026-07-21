import { describe, expect, it } from "vitest";

import { DEFAULT_API_ORIGIN } from "../src/credentials/origin.js";
import {
  serializeCredentialDocument,
  validateCredentialDocument,
  type CredentialV1,
} from "../src/credentials/schema.js";
import {
  CREDENTIAL_CANDIDATE_ENTRY_PREFIX,
  type CredentialTemporaryEntry,
} from "../src/credentials/store-mutation-contracts.js";
import {
  CREDENTIAL_TRANSACTION_KIND,
  CREDENTIAL_TRANSACTION_SCHEMA_VERSION,
  serializeCredentialTransactionDocument,
  validateCredentialTransactionId,
} from "../src/credentials/store-transaction.js";
import {
  claimCredentialStoreObservationEvidence,
  createCredentialStoreObservationAuthority,
  isOwnedCredentialStoreObservationAuthority,
} from "../src/credentials/store-observer.js";
import type {
  CredentialStoreObservationAdapter,
  CredentialStoreObservationEvidence,
  CredentialStoreObservationIdentity,
} from "../src/credentials/store-observation-contracts.js";
import {
  createInMemoryCredentialObservationStore,
  secureObservationDirectoryAttestation,
} from "./support/in-memory-credential-observation-store.js";

const DIRECTORY = "/isolated/plurum";
const API_KEY = `plrm_live_${"A".repeat(43)}`;
const TRANSACTION_ID = validateCredentialTransactionId(
  "ca908d9f-d901-4dac-b396-7f84377adfc8",
);

function activeCredential(apiKey = API_KEY): CredentialV1 {
  return validateCredentialDocument({
    schema_version: 1,
    state: "active",
    api_origin: DEFAULT_API_ORIGIN,
    api_key: apiKey,
    agent_id: "123e4567-e89b-42d3-a456-426614174000",
    agent_name: "Codex",
    username: "codex-42",
    registration_request_id: null,
    created_at: "2026-07-16T12:00:00.000Z",
    updated_at: "2026-07-16T12:01:00.000Z",
    activated_at: "2026-07-16T12:01:00.000Z",
  });
}

function pendingCredential(): CredentialV1 {
  return validateCredentialDocument({
    schema_version: 1,
    state: "pending",
    api_origin: DEFAULT_API_ORIGIN,
    api_key: API_KEY,
    agent_id: null,
    agent_name: "Codex",
    username: "codex-42",
    registration_request_id: TRANSACTION_ID,
    created_at: "2026-07-16T12:00:00.000Z",
    updated_at: "2026-07-16T12:00:00.000Z",
    activated_at: null,
  });
}

function credentialBytes(credential = activeCredential()): Uint8Array {
  return new TextEncoder().encode(serializeCredentialDocument(credential));
}

function transactionBytes(credential = activeCredential()): Uint8Array {
  return new TextEncoder().encode(
    serializeCredentialTransactionDocument({
      schema_version: CREDENTIAL_TRANSACTION_SCHEMA_VERSION,
      kind: CREDENTIAL_TRANSACTION_KIND,
      transaction_id: TRANSACTION_ID,
      created_at: credential.updated_at,
      before: null,
      after: credential,
    }),
  );
}

function temporary(
  role: CredentialTemporaryEntry["role"],
  transactionId = TRANSACTION_ID,
): CredentialTemporaryEntry {
  return Object.freeze({ kind: "temporary", role, transactionId });
}

describe("credential-store observation authority", () => {
  it("brands only exact factory-owned authorities without inspecting candidates", () => {
    const fake = createInMemoryCredentialObservationStore();
    const authority = createCredentialStoreObservationAuthority(fake.adapter);
    const clone = Object.freeze({
      inspect: authority.inspect,
      redeem: authority.redeem,
    });
    const forgery = Object.freeze({
      inspect: async () => Object.freeze({ status: "unavailable" }),
      redeem: () => Object.freeze({ status: "precondition-failed" }),
    });
    let trapCalls = 0;
    const proxy = new Proxy(authority, {
      get() {
        trapCalls += 1;
        throw new Error("candidate was inspected");
      },
      getOwnPropertyDescriptor() {
        trapCalls += 1;
        throw new Error("candidate was inspected");
      },
      getPrototypeOf() {
        trapCalls += 1;
        throw new Error("candidate was inspected");
      },
      ownKeys() {
        trapCalls += 1;
        throw new Error("candidate was inspected");
      },
    });

    expect(isOwnedCredentialStoreObservationAuthority(authority)).toBe(true);
    expect(isOwnedCredentialStoreObservationAuthority(clone)).toBe(false);
    expect(isOwnedCredentialStoreObservationAuthority(forgery)).toBe(false);
    expect(isOwnedCredentialStoreObservationAuthority(proxy)).toBe(false);
    expect(isOwnedCredentialStoreObservationAuthority(null)).toBe(false);
    expect(isOwnedCredentialStoreObservationAuthority("authority")).toBe(false);
    expect(trapCalls).toBe(0);
  });

  it("observes a coherent active credential without publishing its secret evidence", async () => {
    const fake = createInMemoryCredentialObservationStore({
      credentialBytes: credentialBytes(),
      finishEvidence: Object.freeze({
        revision: "native-revision",
        secret: API_KEY,
      }),
    });
    const authority = createCredentialStoreObservationAuthority(fake.adapter);

    const result = await authority.inspect({ directory: DIRECTORY });

    expect(result).toMatchObject({
      status: "available",
      transaction: "clean",
      canonical: "active",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).toBe(
      '{"status":"available","transaction":"clean","canonical":"active"}',
    );
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(JSON.stringify(result)).not.toContain("native-revision");
    expect(fake.directories()).toEqual([DIRECTORY]);
    expect(fake.openOptions()).toEqual([{ noFollow: true }]);
    expect(fake.operations()).toEqual([
      "open-directory",
      "attest-directory:1",
      "observe:credential",
      "attest-file:credential:1",
      "read-file:credential",
      "attest-file:credential:2",
      "close-file:credential",
      "observe:transaction",
      "list-temporary",
      "attest-directory:2",
      "finish-observation",
      "close-directory",
    ]);
    expect(fake.entryOptions()).toEqual([
      {
        entry: {
          kind: "canonical",
          role: "credential",
          name: "credentials.json",
        },
        noFollow: true,
      },
      {
        entry: {
          kind: "canonical",
          role: "transaction",
          name: "credentials-transaction.json",
        },
        noFollow: true,
      },
    ]);
  });

  it("keeps the canonical document private until exact one-use redemption", async () => {
    const credential = activeCredential();
    const fake = createInMemoryCredentialObservationStore({
      credentialBytes: credentialBytes(credential),
    });
    const authority = createCredentialStoreObservationAuthority(fake.adapter);
    const inspected = await authority.inspect({ directory: DIRECTORY });
    expect(inspected.status).toBe("available");
    if (inspected.status !== "available") {
      throw new Error("expected available observation");
    }
    expect(Object.keys(inspected.identity)).toEqual([]);
    expect(JSON.stringify(inspected.identity)).toBeUndefined();

    const redeemed = authority.redeem({
      identity: inspected.identity,
      directory: DIRECTORY,
    });

    expect(redeemed).toMatchObject({
      status: "redeemed",
      credential: { api_key: API_KEY, state: "active" },
      transaction: null,
    });
    expect(Object.isFrozen(redeemed)).toBe(true);
    if (redeemed.status !== "redeemed") {
      throw new Error("expected redemption");
    }
    expect(Object.keys(redeemed.evidence)).toEqual([]);
    expect(Object.keys(redeemed)).toEqual(["status", "evidence"]);
    expect(JSON.stringify(redeemed.evidence)).toBeUndefined();
    expect(JSON.stringify(redeemed)).toBeUndefined();
    expect(
      authority.redeem({
        identity: inspected.identity,
        directory: DIRECTORY,
      }),
    ).toEqual({ status: "precondition-failed" });
  });

  it("burns genuine identity on a wrong-directory attempt and rejects clones and cross-authority tokens", async () => {
    const fake = createInMemoryCredentialObservationStore();
    const authority = createCredentialStoreObservationAuthority(fake.adapter);
    const other = createCredentialStoreObservationAuthority(fake.adapter);
    const inspected = await authority.inspect({ directory: DIRECTORY });
    expect(inspected.status).toBe("available");
    if (inspected.status !== "available") {
      throw new Error("expected available observation");
    }
    const clone = Object.freeze({
      ...(inspected.identity as unknown as Record<string, unknown>),
    }) as unknown as CredentialStoreObservationIdentity;

    expect(
      other.redeem({ identity: inspected.identity, directory: DIRECTORY }),
    ).toEqual({ status: "precondition-failed" });
    expect(authority.redeem({ identity: clone, directory: DIRECTORY })).toEqual({
      status: "precondition-failed",
    });
    expect(
      authority.redeem({
        identity: inspected.identity,
        directory: "/isolated/other",
      }),
    ).toEqual({ status: "precondition-failed" });
    expect(
      authority.redeem({ identity: inspected.identity, directory: DIRECTORY }),
    ).toEqual({ status: "precondition-failed" });
  });

  it("burns private whole-pass evidence before checking its authority", async () => {
    const rawEvidence = Object.freeze({ source: "whole-pass" });
    const fake = createInMemoryCredentialObservationStore({
      finishEvidence: rawEvidence,
    });
    const authority = createCredentialStoreObservationAuthority(fake.adapter);
    const other = createCredentialStoreObservationAuthority(fake.adapter);

    async function redeemEvidence() {
      const inspected = await authority.inspect({ directory: DIRECTORY });
      if (inspected.status !== "available") {
        throw new Error("expected available observation");
      }
      const redeemed = authority.redeem({
        identity: inspected.identity,
        directory: DIRECTORY,
      });
      if (redeemed.status !== "redeemed") {
        throw new Error("expected redeemed observation");
      }
      return redeemed.evidence;
    }

    const wrongAuthority = await redeemEvidence();
    expect(
      claimCredentialStoreObservationEvidence(other, wrongAuthority),
    ).toBeUndefined();
    expect(
      claimCredentialStoreObservationEvidence(authority, wrongAuthority),
    ).toBeUndefined();

    const genuine = await redeemEvidence();
    expect(
      claimCredentialStoreObservationEvidence(authority, genuine),
    ).toBe(rawEvidence);
    expect(
      claimCredentialStoreObservationEvidence(authority, genuine),
    ).toBeUndefined();

    const forgery = Object.freeze({}) as CredentialStoreObservationEvidence;
    expect(
      claimCredentialStoreObservationEvidence(authority, forgery),
    ).toBeUndefined();
  });

  it("treats a valid transaction as recovery-required and retains it only in redemption", async () => {
    const transaction = transactionBytes();
    const fake = createInMemoryCredentialObservationStore({
      credentialBytes: credentialBytes(),
      transactionBytes: transaction,
    });
    const authority = createCredentialStoreObservationAuthority(fake.adapter);

    const result = await authority.inspect({ directory: DIRECTORY });

    expect(result).toMatchObject({
      status: "available",
      transaction: "recovery-required",
      canonical: "active",
    });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    if (result.status !== "available") {
      throw new Error("expected available observation");
    }
    const redeemed = authority.redeem({
      identity: result.identity,
      directory: DIRECTORY,
    });
    expect(redeemed).toMatchObject({
      status: "redeemed",
      transaction: {
        transaction_id: TRANSACTION_ID,
        after: { api_key: API_KEY },
      },
    });
  });

  it.each([
    "credential-candidate",
    "transaction-candidate",
    "recovery-candidate",
  ] as const)("treats a recognized %s remnant as recovery-required without reading it", async (role) => {
    const fake = createInMemoryCredentialObservationStore({
      temporaries: Object.freeze([temporary(role)]),
    });
    const authority = createCredentialStoreObservationAuthority(fake.adapter);

    await expect(authority.inspect({ directory: DIRECTORY })).resolves.toMatchObject({
      status: "available",
      transaction: "recovery-required",
      canonical: "missing",
    });
    expect(fake.operations()).toContain(`observe:${role}:${TRANSACTION_ID}`);
    expect(fake.operations()).not.toContain(`read-file:${role}:${TRANSACTION_ID}`);
  });

  it("sorts and observes the exact frozen managed-remnant set", async () => {
    const secondId = validateCredentialTransactionId(
      "123e4567-e89b-42d3-a456-426614174000",
    );
    const fake = createInMemoryCredentialObservationStore({
      temporaries: Object.freeze([
        temporary("transaction-candidate", TRANSACTION_ID),
        temporary("credential-candidate", secondId),
      ]),
    });
    const authority = createCredentialStoreObservationAuthority(fake.adapter);

    const result = await authority.inspect({ directory: DIRECTORY });

    expect(result).toMatchObject({
      status: "available",
      transaction: "recovery-required",
    });
    expect(
      fake.operations().filter((operation) => operation.startsWith("observe:")),
    ).toEqual([
      "observe:credential",
      "observe:transaction",
      `observe:credential-candidate:${secondId}`,
      `observe:transaction-candidate:${TRANSACTION_ID}`,
    ]);
  });

  it("reports a missing directory as clean with private missing-state evidence", async () => {
    const fake = createInMemoryCredentialObservationStore({
      directoryMissing: true,
    });
    const authority = createCredentialStoreObservationAuthority(fake.adapter);

    const result = await authority.inspect({ directory: DIRECTORY });

    expect(result).toMatchObject({
      status: "available",
      transaction: "clean",
      canonical: "missing",
    });
    expect(fake.operations()).toEqual(["open-directory"]);
    if (result.status !== "available") {
      throw new Error("expected available observation");
    }
    expect(
      authority.redeem({ identity: result.identity, directory: DIRECTORY }),
    ).toMatchObject({
      status: "redeemed",
      credential: null,
      transaction: null,
    });
  });

  it("retains pending canonical state privately without activating it", async () => {
    const fake = createInMemoryCredentialObservationStore({
      credentialBytes: credentialBytes(pendingCredential()),
    });
    const authority = createCredentialStoreObservationAuthority(fake.adapter);
    const result = await authority.inspect({ directory: DIRECTORY });
    expect(result).toMatchObject({ canonical: "pending", transaction: "clean" });
    if (result.status !== "available") {
      throw new Error("expected available observation");
    }
    expect(
      authority.redeem({ identity: result.identity, directory: DIRECTORY }),
    ).toMatchObject({
      status: "redeemed",
      credential: { state: "pending", api_key: API_KEY },
    });
  });

  it.each([
    ["invalid credential", { credentialBytes: new TextEncoder().encode("{}\n") }],
    ["invalid transaction", { transactionBytes: new TextEncoder().encode("{}\n") }],
    [
      "unsafe directory",
      {
        directoryAttestations: [
          secureObservationDirectoryAttestation({ access: "broader" }),
        ],
      },
    ],
    [
      "directory race",
      {
        directoryAttestations: [
          secureObservationDirectoryAttestation(),
          secureObservationDirectoryAttestation({ revision: "changed" }),
        ],
      },
    ],
    ["unfrozen temporary list", { listResult: [] }],
    [
      "duplicate temporary descriptors",
      {
        listResult: Object.freeze([
          temporary("credential-candidate"),
          temporary("credential-candidate"),
        ]),
      },
    ],
    [
      "listed temporary disappearance",
      {
        temporaries: Object.freeze([temporary("credential-candidate")]),
        missingTemporaryKeys: [
          `credential-candidate:${TRANSACTION_ID}`,
        ],
      },
    ],
    ["unreadable canonical", { failAt: ["read-file:credential"] }],
    ["failed completion", { failAt: ["finish-observation"] }],
    ["failed close", { failAt: ["close-directory"] }],
  ] as const)("fails closed with unavailable transaction state for %s", async (_name, options) => {
    const fake = createInMemoryCredentialObservationStore({
      credentialBytes: credentialBytes(),
      ...options,
    });
    const authority = createCredentialStoreObservationAuthority(fake.adapter);

    const result = await authority.inspect({ directory: DIRECTORY });

    expect(result).toEqual({
      status: "unavailable",
      transaction: "unavailable",
      canonical: "unavailable",
    });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(fake.operations().filter((item) => item === "close-directory")).toHaveLength(1);
  });

  it("copies credential bytes before the next await", async () => {
    const bytes = credentialBytes();
    const fake = createInMemoryCredentialObservationStore({
      credentialBytes: bytes,
      onOperation(operation) {
        if (operation === "attest-file:credential:2") {
          bytes.fill(0);
        }
      },
    });
    const authority = createCredentialStoreObservationAuthority(fake.adapter);

    const result = await authority.inspect({ directory: DIRECTORY });

    expect(result).toMatchObject({ status: "available", canonical: "active" });
    expect([...bytes].every((byte) => byte === 0)).toBe(true);
  });

  it("rejects hidden request fields and accessors without invoking them or opening the store", async () => {
    const fake = createInMemoryCredentialObservationStore();
    const authority = createCredentialStoreObservationAuthority(fake.adapter);
    const hidden = { directory: DIRECTORY };
    Object.defineProperty(hidden, "secret", {
      enumerable: false,
      value: API_KEY,
    });
    let getterCalls = 0;
    const accessor = {};
    Object.defineProperty(accessor, "directory", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return DIRECTORY;
      },
    });

    await expect(
      authority.inspect(hidden as { directory: string }),
    ).resolves.toEqual({
      status: "unavailable",
      transaction: "unavailable",
      canonical: "unavailable",
    });
    await expect(
      authority.inspect(accessor as { directory: string }),
    ).resolves.toMatchObject({ status: "unavailable" });
    expect(getterCalls).toBe(0);
    expect(fake.operations()).toEqual([]);
  });

  it("rejects oversized, sparse, extended, symbolic, and accessor temporary arrays", async () => {
    const oversized = Object.freeze(
      Array.from({ length: 1_025 }, () => temporary("credential-candidate")),
    );
    const sparse = new Array<CredentialTemporaryEntry>(1);
    Object.freeze(sparse);
    const extended = [temporary("credential-candidate")];
    Object.defineProperty(extended, "hidden", {
      enumerable: false,
      value: API_KEY,
    });
    Object.freeze(extended);
    const symbolic = [temporary("credential-candidate")];
    Object.defineProperty(symbolic, Symbol("hidden"), {
      enumerable: true,
      value: API_KEY,
    });
    Object.freeze(symbolic);
    let getterCalls = 0;
    const accessor = new Array<CredentialTemporaryEntry>(1);
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return temporary("credential-candidate");
      },
    });
    Object.freeze(accessor);

    for (const listResult of [oversized, sparse, extended, symbolic, accessor]) {
      const fake = createInMemoryCredentialObservationStore({ listResult });
      const authority = createCredentialStoreObservationAuthority(fake.adapter);
      await expect(authority.inspect({ directory: DIRECTORY })).resolves.toEqual({
        status: "unavailable",
        transaction: "unavailable",
        canonical: "unavailable",
      });
      expect(fake.operations().filter((item) => item === "close-directory")).toHaveLength(1);
    }
    expect(getterCalls).toBe(0);
  });

  it("closes a malformed opened directory result and rejects descriptor extensions", async () => {
    const closed: string[] = [];
    const malformedDirectory = Object.freeze({
      async close() {
        closed.push("closed");
      },
    });
    const openResult = {
      status: "opened",
      directory: malformedDirectory,
      extra: CREDENTIAL_CANDIDATE_ENTRY_PREFIX,
    };
    const adapter: CredentialStoreObservationAdapter = Object.freeze({
      async openPrivateDirectory() {
        return openResult as never;
      },
    });
    const authority = createCredentialStoreObservationAuthority(adapter);

    await expect(authority.inspect({ directory: DIRECTORY })).resolves.toEqual({
      status: "unavailable",
      transaction: "unavailable",
      canonical: "unavailable",
    });
    expect(closed).toEqual(["closed"]);
  });
});
