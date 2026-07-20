import { parseStrictJsonObject } from "../data/strict-json-object.js";
import {
  copyUint8Array,
  intrinsicUint8ArrayByteLength,
} from "../data/uint8-array.js";
import {
  LEGACY_CREDENTIAL_SOURCES,
  MAX_LEGACY_CREDENTIAL_BYTES,
  type LegacyCredentialAdapterReadResult,
  type LegacyCredentialReadAdapter,
  type LegacyCredentialSource,
} from "./legacy-reader-contracts.js";

export type LegacyCredentialReadResult =
  | Readonly<{
      status: "missing";
      source: LegacyCredentialSource;
    }>
  | Readonly<{
      status: "unsafe";
      source: LegacyCredentialSource;
    }>
  | Readonly<{
      status: "malformed";
      source: LegacyCredentialSource;
    }>
  | Readonly<{
      status: "unavailable";
      source: LegacyCredentialSource;
    }>
  | Readonly<{
      status: "candidate";
      source: LegacyCredentialSource;
      apiKey: string;
      apiOrigin: string | null;
    }>;

const READ_OPTIONS = Object.freeze({
  noFollow: true as const,
  maxBytes: MAX_LEGACY_CREDENTIAL_BYTES,
});

function result(
  status: Exclude<LegacyCredentialReadResult["status"], "candidate">,
  source: LegacyCredentialSource,
): LegacyCredentialReadResult {
  return Object.freeze({ status, source });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  try {
    const actual = Object.keys(value);
    return (
      actual.length === expected.length &&
      actual.every((key) => expected.includes(key))
    );
  } catch {
    return false;
  }
}

function inspectAdapterResult(
  value: unknown,
): LegacyCredentialAdapterReadResult | null {
  try {
    if (!isRecord(value)) {
      return null;
    }
    const status = value.status;
    if (status === "missing" || status === "unsafe") {
      return hasExactKeys(value, ["status"])
        ? Object.freeze({ status })
        : null;
    }
    if (status !== "loaded" || !hasExactKeys(value, ["status", "bytes"])) {
      return null;
    }
    const bytes = value.bytes;
    if (!(bytes instanceof Uint8Array)) {
      return null;
    }
    return Object.freeze({ status, bytes });
  } catch {
    return null;
  }
}

function wipeBytes(bytes: Uint8Array | undefined): void {
  if (bytes === undefined) {
    return;
  }
  try {
    Uint8Array.prototype.fill.call(bytes, 0);
  } catch {
    // Best effort only; never replace the fixed safe result.
  }
}

function decode(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      // Preserve a leading BOM so strict JSON parsing rejects it.
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    return null;
  }
}

function ownValue(
  document: Readonly<Record<string, unknown>>,
  field: string,
): Readonly<{ present: false }> | Readonly<{ present: true; value: unknown }> {
  try {
    if (!Object.keys(document).includes(field)) {
      return Object.freeze({ present: false });
    }
    return Object.freeze({ present: true, value: document[field] });
  } catch {
    return Object.freeze({ present: false });
  }
}

function candidateFromDocument(
  source: LegacyCredentialSource,
  document: Readonly<Record<string, unknown>>,
): LegacyCredentialReadResult {
  const keyField = source === "removed-cli" ? "apiKey" : "api_key";
  const originField =
    source === "hermes"
      ? "api_url"
      : source === "removed-cli"
        ? "apiUrl"
        : null;
  const key = ownValue(document, keyField);
  if (!key.present || typeof key.value !== "string") {
    return result("malformed", source);
  }

  let apiOrigin: string | null = null;
  if (originField !== null) {
    const origin = ownValue(document, originField);
    if (origin.present) {
      if (typeof origin.value !== "string") {
        return result("malformed", source);
      }
      apiOrigin = origin.value;
    }
  }

  const candidate = {
    status: "candidate",
    source,
    apiOrigin,
  } as LegacyCredentialReadResult & { readonly apiKey: string };
  Object.defineProperty(candidate, "apiKey", {
    configurable: false,
    enumerable: false,
    value: key.value,
    writable: false,
  });
  return Object.freeze(candidate);
}

function isLegacySource(value: unknown): value is LegacyCredentialSource {
  return (
    typeof value === "string" &&
    LEGACY_CREDENTIAL_SOURCES.includes(value as LegacyCredentialSource)
  );
}

export async function readLegacyCredential(
  adapter: LegacyCredentialReadAdapter,
  source: LegacyCredentialSource,
  path: string,
): Promise<LegacyCredentialReadResult> {
  if (
    !isLegacySource(source) ||
    typeof path !== "string" ||
    path.length === 0
  ) {
    return result("unavailable", isLegacySource(source) ? source : "hermes");
  }

  let rawResult: unknown;
  try {
    if (
      adapter === null ||
      typeof adapter !== "object" ||
      typeof adapter.read !== "function"
    ) {
      return result("unavailable", source);
    }
    rawResult = await adapter.read(source, path, READ_OPTIONS);
  } catch {
    return result("unavailable", source);
  }

  const inspected = inspectAdapterResult(rawResult);
  if (inspected === null) {
    return result("unavailable", source);
  }
  if (inspected.status === "missing" || inspected.status === "unsafe") {
    return result(inspected.status, source);
  }

  let bytes: Uint8Array | undefined;
  try {
    const byteLength = intrinsicUint8ArrayByteLength(inspected.bytes);
    if (
      byteLength === undefined ||
      byteLength === 0 ||
      byteLength > MAX_LEGACY_CREDENTIAL_BYTES
    ) {
      return result("malformed", source);
    }
    bytes = copyUint8Array(inspected.bytes, byteLength);
    if (bytes === undefined) {
      return result("unavailable", source);
    }
    const text = decode(bytes);
    if (text === null) {
      return result("malformed", source);
    }

    let document: Readonly<Record<string, unknown>>;
    try {
      document = parseStrictJsonObject(text);
    } catch {
      return result("malformed", source);
    }
    return candidateFromDocument(source, document);
  } catch {
    return result("unavailable", source);
  } finally {
    wipeBytes(bytes);
  }
}
