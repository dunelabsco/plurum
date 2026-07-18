import { describe, expect, it } from "vitest";

import { CredentialError } from "../src/credentials/errors.js";
import { DEFAULT_API_ORIGIN } from "../src/credentials/origin.js";
import {
  CREDENTIAL_TRANSACTION_KIND,
  CREDENTIAL_TRANSACTION_SCHEMA_VERSION,
  MAX_CREDENTIAL_TRANSACTION_BYTES,
  MAX_CREDENTIAL_TRANSACTION_CHARACTERS,
  parseCredentialTransactionDocument,
  parseCredentialTransactionDocumentBytes,
  serializeCredentialTransactionDocument,
  serializeCredentialTransactionDocumentBytes,
  type CredentialReplaceTransactionV1,
  validateCredentialTransactionDocument,
  validateCredentialTransactionId,
} from "../src/credentials/store-transaction.js";

const API_KEY = `plrm_live_${"S".repeat(43)}`;
const OLD_API_KEY = `plrm_live_${"O".repeat(43)}`;
const TRANSACTION_ID = "ca908d9f-d901-4dac-b396-7f84377adfc8";
const REQUEST_ID = "2be140a8-bd22-4c59-a3f6-d765ac7289d2";
const AGENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const CREATED_AT = "2026-07-19T12:00:00.000Z";
const ACTIVATED_AT = "2026-07-19T12:01:00.000Z";

function activeCredential(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    state: "active",
    api_origin: DEFAULT_API_ORIGIN,
    api_key: API_KEY,
    agent_id: AGENT_ID,
    agent_name: "Codex",
    username: "codex-42",
    registration_request_id: REQUEST_ID,
    created_at: CREATED_AT,
    updated_at: ACTIVATED_AT,
    activated_at: ACTIVATED_AT,
    ...overrides,
  };
}

function transactionInput(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: CREDENTIAL_TRANSACTION_SCHEMA_VERSION,
    kind: CREDENTIAL_TRANSACTION_KIND,
    transaction_id: TRANSACTION_ID,
    created_at: ACTIVATED_AT,
    before: null,
    after: activeCredential(),
    ...overrides,
  };
}

function expectTransactionError(
  attempt: () => unknown,
  code:
    | "invalid_credential_transaction"
    | "unsupported_credential_transaction_schema" =
    "invalid_credential_transaction",
): void {
  try {
    attempt();
  } catch (error) {
    if (!(error instanceof CredentialError)) {
      throw new Error("credential transaction raised an unsafe error type");
    }
    expect(error.code).toBe(code);
    expect(String(error).includes(API_KEY)).toBe(false);
    expect(String(error).includes(OLD_API_KEY)).toBe(false);
    expect(JSON.stringify(error).includes(API_KEY)).toBe(false);
    expect(JSON.stringify(error).includes(OLD_API_KEY)).toBe(false);
    return;
  }
  throw new Error("invalid credential transaction unexpectedly accepted");
}

describe("credential transaction journal", () => {
  it("round-trips a canonical rollback journal as frozen defensive data", () => {
    const input = transactionInput();
    const transaction = validateCredentialTransactionDocument(input);

    expect(transaction === input).toBe(false);
    expect(Object.isFrozen(transaction)).toBe(true);
    expect(Object.isFrozen(transaction.after)).toBe(true);
    expect(transaction.before).toBeNull();

    const serialized = serializeCredentialTransactionDocument(transaction);
    const parsed = parseCredentialTransactionDocument(serialized);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.after)).toBe(true);
    expect(parsed.transaction_id).toBe(TRANSACTION_ID);
    expect(parsed.after.api_key === API_KEY).toBe(true);
  });

  it("preserves the credential that recovery must restore before commit", () => {
    const before = activeCredential({
      api_key: OLD_API_KEY,
      updated_at: CREATED_AT,
      activated_at: CREATED_AT,
    });
    const input = transactionInput({ before });
    const transaction = validateCredentialTransactionDocument(input);

    before.api_key = "plrm_live_mutated_after_validation";
    expect(transaction.before === null).toBe(false);
    expect(transaction.before?.api_key === OLD_API_KEY).toBe(true);
    expect(transaction.after.api_key === API_KEY).toBe(true);

    const parsed = parseCredentialTransactionDocument(
      serializeCredentialTransactionDocument(transaction),
    );
    expect(parsed.before?.api_key === OLD_API_KEY).toBe(true);
    expect(parsed.after.api_key === API_KEY).toBe(true);
  });

  it("accepts only lowercase RFC 4122 version 4 transaction IDs", () => {
    expect(validateCredentialTransactionId(TRANSACTION_ID)).toBe(
      TRANSACTION_ID,
    );

    for (const value of [
      TRANSACTION_ID.toUpperCase(),
      "ca908d9f-d901-1dac-b396-7f84377adfc8",
      "ca908d9f-d901-4dac-7396-7f84377adfc8",
      "00000000-0000-0000-0000-000000000000",
      "",
      null,
    ]) {
      expectTransactionError(() => validateCredentialTransactionId(value));
    }
  });

  it("distinguishes unsupported transaction schemas from malformed journals", () => {
    for (const schemaVersion of [0, 2, 999]) {
      expectTransactionError(
        () =>
          validateCredentialTransactionDocument(
            transactionInput({ schema_version: schemaVersion }),
          ),
        "unsupported_credential_transaction_schema",
      );
    }

    for (const schemaVersion of [null, "1", 1.5]) {
      expectTransactionError(() =>
        validateCredentialTransactionDocument(
          transactionInput({ schema_version: schemaVersion }),
        ),
      );
    }

    expectTransactionError(() =>
      validateCredentialTransactionDocument(
        transactionInput({
          after: activeCredential({ schema_version: 2 }),
        }),
      ),
    );

    const future = transactionInput({ schema_version: 2 });
    expectTransactionError(
      () =>
        parseCredentialTransactionDocument(
          `${JSON.stringify(future, null, 2)}\n`,
        ),
      "unsupported_credential_transaction_schema",
    );
  });

  it("requires exact fields, kind, canonical time, and complete credentials", () => {
    const missingAfter: Record<string, unknown> = transactionInput();
    delete missingAfter.after;

    for (const input of [
      null,
      [],
      {},
      missingAfter,
      transactionInput({ extra: true }),
      transactionInput({ kind: "credential-write" }),
      transactionInput({ transaction_id: "not-a-uuid" }),
      transactionInput({ created_at: "2026-07-19T12:00:00Z" }),
      transactionInput({ created_at: "2026-02-31T12:00:00.000Z" }),
      transactionInput({ before: {} }),
      transactionInput({ after: null }),
      transactionInput({ after: activeCredential({ state: "pending" }) }),
      transactionInput({
        after: activeCredential({ api_origin: "HTTPS://API.PLURUM.AI:443/" }),
      }),
    ]) {
      expectTransactionError(() =>
        validateCredentialTransactionDocument(input),
      );
    }
  });

  it("defaults to HTTPS and permits numeric loopback HTTP only by explicit policy", () => {
    const loopback = transactionInput({
      after: activeCredential({ api_origin: "http://127.0.0.1:8787" }),
    });
    expectTransactionError(() =>
      validateCredentialTransactionDocument(loopback),
    );

    const validated = validateCredentialTransactionDocument(
      loopback,
      "explicit-loopback-development",
    );
    const serialized = serializeCredentialTransactionDocument(
      validated,
      "explicit-loopback-development",
    );
    expect(
      parseCredentialTransactionDocument(
        serialized,
        "explicit-loopback-development",
      ).after.api_origin,
    ).toBe("http://127.0.0.1:8787");
  });

  it("rejects non-canonical text, duplicate keys, BOMs, and oversized input", () => {
    const serialized = serializeCredentialTransactionDocument(
      validateCredentialTransactionDocument(transactionInput()),
    );
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    const reordered = `${JSON.stringify(
      {
        kind: parsed.kind,
        schema_version: parsed.schema_version,
        transaction_id: parsed.transaction_id,
        created_at: parsed.created_at,
        before: parsed.before,
        after: parsed.after,
      },
      null,
      2,
    )}\n`;

    const nonCanonicalInputs = [
      "not json",
      `\ufeff${serialized}`,
      serialized.trimEnd(),
      `${serialized.trimEnd()}\r\n`,
      reordered,
      serialized.replace(
        '  "schema_version": 1,',
        '  "schema_version": 1,\n  "schema_version": 1,',
      ),
      "x".repeat(MAX_CREDENTIAL_TRANSACTION_CHARACTERS + 1),
    ];
    for (const input of nonCanonicalInputs) {
      expectTransactionError(() =>
        parseCredentialTransactionDocument(input),
      );
    }
  });

  it("round-trips canonical UTF-8 bytes without mutating caller memory", () => {
    const transaction = validateCredentialTransactionDocument(
      transactionInput({
        after: activeCredential({ agent_name: "Codex 👩‍💻" }),
      }),
    );
    const bytes = serializeCredentialTransactionDocumentBytes(transaction);
    const callerCopy = Uint8Array.prototype.slice.call(bytes);
    const parsed = parseCredentialTransactionDocumentBytes(bytes);

    expect(bytes.byteLength > 0).toBe(true);
    expect(bytes.every((value, index) => value === callerCopy[index])).toBe(
      true,
    );
    expect(parsed.after.agent_name).toBe("Codex 👩‍💻");
    expect(parsed.after.api_key === API_KEY).toBe(true);
  });

  it("rejects empty, malformed, BOM-prefixed, and oversized byte documents", () => {
    const serialized = serializeCredentialTransactionDocumentBytes(
      validateCredentialTransactionDocument(transactionInput()),
    );
    const bomPrefixed = new Uint8Array(serialized.byteLength + 3);
    bomPrefixed.set([0xef, 0xbb, 0xbf]);
    bomPrefixed.set(serialized, 3);

    for (const bytes of [
      new Uint8Array(),
      new Uint8Array([0xc3, 0x28]),
      bomPrefixed,
      new Uint8Array(MAX_CREDENTIAL_TRANSACTION_BYTES + 1),
    ]) {
      expectTransactionError(() =>
        parseCredentialTransactionDocumentBytes(bytes),
      );
    }
  });

  it("normalizes hostile access failures and never reflects journal secrets", () => {
    const hostile = transactionInput();
    Object.defineProperty(hostile, "after", {
      enumerable: true,
      get(): never {
        throw new Error(API_KEY);
      },
    });

    expectTransactionError(() =>
      validateCredentialTransactionDocument(hostile),
    );
    expectTransactionError(() =>
      serializeCredentialTransactionDocument(
        transactionInput({
          after: activeCredential({ api_key: `${API_KEY}$` }),
        }) as CredentialReplaceTransactionV1,
      ),
    );
  });
});
