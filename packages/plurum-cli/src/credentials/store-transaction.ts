import { CredentialError } from "./errors.js";
import type { ApiOriginPolicy } from "./origin.js";
import {
  type CanonicalTimestamp,
  type CredentialV1,
  validateCredentialDocument,
} from "./schema.js";
import type { CredentialTransactionId } from "./store-mutation-contracts.js";

export const CREDENTIAL_TRANSACTION_SCHEMA_VERSION = 1 as const;
export const CREDENTIAL_TRANSACTION_KIND = "credential-replace" as const;
export const MAX_CREDENTIAL_TRANSACTION_CHARACTERS = 40_960;
export const MAX_CREDENTIAL_TRANSACTION_BYTES = 40_960;

/*
 * While this journal exists, recovery restores `before`. Removing the durable
 * journal is the commit point after `after` has been installed and verified.
 */
export interface CredentialReplaceTransactionV1 {
  readonly schema_version: typeof CREDENTIAL_TRANSACTION_SCHEMA_VERSION;
  readonly kind: typeof CREDENTIAL_TRANSACTION_KIND;
  readonly transaction_id: CredentialTransactionId;
  readonly created_at: CanonicalTimestamp;
  readonly before: CredentialV1 | null;
  readonly after: CredentialV1;
}

const FIELDS = [
  "schema_version",
  "kind",
  "transaction_id",
  "created_at",
  "before",
  "after",
] as const;

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_TIMESTAMP =
  /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/u;

function invalidTransaction(): never {
  throw new CredentialError("invalid_credential_transaction");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactFields(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === FIELDS.length &&
    keys.every((key) => FIELDS.includes(key as (typeof FIELDS)[number]))
  );
}

function isTransactionId(value: unknown): value is CredentialTransactionId {
  return typeof value === "string" && UUID_V4.test(value);
}

export function validateCredentialTransactionId(
  value: unknown,
): CredentialTransactionId {
  if (!isTransactionId(value)) {
    return invalidTransaction();
  }
  return value;
}

function isCanonicalTimestamp(value: unknown): value is CanonicalTimestamp {
  if (typeof value !== "string" || !CANONICAL_TIMESTAMP.test(value)) {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function canonicalText(transaction: CredentialReplaceTransactionV1): string {
  return `${JSON.stringify(transaction, null, 2)}\n`;
}

function wipeBytes(bytes: Uint8Array): void {
  try {
    Uint8Array.prototype.fill.call(bytes, 0);
  } catch {
    // Best effort only; never replace the safe parse result or error.
  }
}

function validateEmbeddedCredential(
  input: unknown,
  originPolicy: ApiOriginPolicy,
): CredentialV1 {
  try {
    return validateCredentialDocument(input, originPolicy);
  } catch {
    return invalidTransaction();
  }
}

export function validateCredentialTransactionDocument(
  input: unknown,
  originPolicy: ApiOriginPolicy = "https-only",
): CredentialReplaceTransactionV1 {
  let record: Record<string, unknown>;
  try {
    if (!isRecord(input)) {
      return invalidTransaction();
    }
    record = input;
  } catch {
    return invalidTransaction();
  }

  let schemaVersion: unknown;
  try {
    schemaVersion = record.schema_version;
  } catch {
    return invalidTransaction();
  }
  if (
    typeof schemaVersion === "number" &&
    Number.isInteger(schemaVersion) &&
    schemaVersion !== CREDENTIAL_TRANSACTION_SCHEMA_VERSION
  ) {
    throw new CredentialError("unsupported_credential_transaction_schema");
  }

  try {
    if (
      schemaVersion !== CREDENTIAL_TRANSACTION_SCHEMA_VERSION ||
      !hasExactFields(record)
    ) {
      return invalidTransaction();
    }

    const kind = record.kind;
    const transactionIdInput = record.transaction_id;
    const createdAt = record.created_at;
    const beforeInput = record.before;
    const afterInput = record.after;
    if (
      kind !== CREDENTIAL_TRANSACTION_KIND ||
      !isCanonicalTimestamp(createdAt)
    ) {
      return invalidTransaction();
    }

    const transactionId = validateCredentialTransactionId(transactionIdInput);
    const before =
      beforeInput === null
        ? null
        : validateEmbeddedCredential(beforeInput, originPolicy);
    const after = validateEmbeddedCredential(afterInput, originPolicy);

    return Object.freeze({
      schema_version: CREDENTIAL_TRANSACTION_SCHEMA_VERSION,
      kind: CREDENTIAL_TRANSACTION_KIND,
      transaction_id: transactionId,
      created_at: createdAt,
      before,
      after,
    });
  } catch (error) {
    if (
      error instanceof CredentialError &&
      error.code === "invalid_credential_transaction"
    ) {
      throw error;
    }
    return invalidTransaction();
  }
}

export function serializeCredentialTransactionDocument(
  transaction: CredentialReplaceTransactionV1,
  originPolicy: ApiOriginPolicy = "https-only",
): string {
  const text = canonicalText(
    validateCredentialTransactionDocument(transaction, originPolicy),
  );
  if (text.length > MAX_CREDENTIAL_TRANSACTION_CHARACTERS) {
    return invalidTransaction();
  }
  return text;
}

export function parseCredentialTransactionDocument(
  input: unknown,
  originPolicy: ApiOriginPolicy = "https-only",
): CredentialReplaceTransactionV1 {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > MAX_CREDENTIAL_TRANSACTION_CHARACTERS
  ) {
    return invalidTransaction();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch {
    return invalidTransaction();
  }

  const transaction = validateCredentialTransactionDocument(
    parsed,
    originPolicy,
  );
  if (input !== canonicalText(transaction)) {
    return invalidTransaction();
  }
  return transaction;
}

export function decodeCredentialTransactionDocumentBytes(
  input: Uint8Array,
): string {
  let bytes: Uint8Array;
  try {
    if (
      !(input instanceof Uint8Array) ||
      input.byteLength === 0 ||
      input.byteLength > MAX_CREDENTIAL_TRANSACTION_BYTES
    ) {
      return invalidTransaction();
    }
    bytes = Uint8Array.prototype.slice.call(input);
  } catch {
    return invalidTransaction();
  }

  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      // Preserve a leading BOM so canonical parsing rejects it.
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    return invalidTransaction();
  } finally {
    wipeBytes(bytes);
  }
}

export function serializeCredentialTransactionDocumentBytes(
  transaction: CredentialReplaceTransactionV1,
  originPolicy: ApiOriginPolicy = "https-only",
): Uint8Array {
  const bytes = new TextEncoder().encode(
    serializeCredentialTransactionDocument(transaction, originPolicy),
  );
  if (bytes.byteLength > MAX_CREDENTIAL_TRANSACTION_BYTES) {
    wipeBytes(bytes);
    return invalidTransaction();
  }
  return bytes;
}

export function parseCredentialTransactionDocumentBytes(
  input: Uint8Array,
  originPolicy: ApiOriginPolicy = "https-only",
): CredentialReplaceTransactionV1 {
  return parseCredentialTransactionDocument(
    decodeCredentialTransactionDocumentBytes(input),
    originPolicy,
  );
}
