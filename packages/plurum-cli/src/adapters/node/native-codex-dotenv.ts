import { randomBytes as nodeRandomBytes, randomUUID as nodeRandomUUID } from "node:crypto";

import {
  CODEX_DOTENV_API_ORIGIN,
  type CodexDotenvCredentialExpectation,
  type CodexDotenvNativeAdapter,
  type CodexDotenvNativeEvidence,
  type CodexDotenvNativeMutationResult,
  type CodexDotenvObserveRequest,
  type CodexDotenvProjectionStatus,
  type CodexDotenvSynchronizeRequest,
} from "../../credentials/codex-dotenv-contracts.js";
import {
  CodexDotenvError,
  inspectCodexDotenv,
  MAX_CODEX_DOTENV_BYTES,
  rewriteCodexDotenv,
  type CodexDotenvNewline,
} from "../../credentials/codex-dotenv.js";
import {
  copyUint8Array,
  intrinsicUint8ArrayByteLength,
  wipeUint8Array,
} from "../../data/uint8-array.js";
import { parseApiKey, type ApiKey } from "../../credentials/schema.js";

export interface NativeCodexDotenvRawCalls {
  readonly observe: (options: Readonly<{
    excludedProjectDirectory: string;
    maxBytes: typeof MAX_CODEX_DOTENV_BYTES;
    noFollow: true;
    revisionNonce: string;
  }>) => unknown;
  readonly synchronize: (
    options:
      | Readonly<{
          disposition: "unchanged";
          excludedProjectDirectory: string;
          expectedRevision: string;
          maxBytes: typeof MAX_CODEX_DOTENV_BYTES;
          nextRevisionNonce: string;
          noFollow: true;
          nonce: string;
        }>
      | Readonly<{
          bytes: Uint8Array;
          disposition: "changed";
          excludedProjectDirectory: string;
          expectedRevision: string;
          maxBytes: typeof MAX_CODEX_DOTENV_BYTES;
          nextRevisionNonce: string;
          noFollow: true;
          nonce: string;
        }>,
  ) => unknown;
}

interface DataSnapshot {
  readonly names: readonly string[];
  readonly values: Readonly<Record<string, unknown>>;
}

type RawObservation =
  | Readonly<{
      status: "missing" | "oversized" | "unsafe";
      revision: string;
    }>
  | Readonly<{
      status: "present";
      revision: string;
      bytes: Uint8Array;
    }>;

const OBSERVE_REQUEST_KEYS = Object.freeze([
  "apiOrigin",
  "excludedProjectDirectory",
  "expectation",
  "kind",
  "scope",
] as const);
const SYNCHRONIZE_REQUEST_KEYS = Object.freeze([
  "apiOrigin",
  "excludedProjectDirectory",
  "expectation",
  "expectedRevision",
  "expectedStatus",
  "kind",
  "scope",
] as const);
const REVISION = /^[0-9a-f]{64}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const API_KEY_TOKEN = /plrm_live_[A-Za-z0-9_-]{10,200}/u;
const HEX = "0123456789abcdef";
const BASE_UINT8_ARRAY = Uint8Array;
const STRING_CHAR_CODE_AT = String.prototype.charCodeAt;
const RANDOM_BYTES = nodeRandomBytes;
const RANDOM_UUID = nodeRandomUUID;

const FAILED = Object.freeze({ status: "failed" } as const);
const PRECONDITION_FAILED = Object.freeze({
  status: "precondition-failed",
} as const);

function invalid(): never {
  throw new Error("The native Codex credential projection failed.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function snapshotDataObject(value: unknown): DataSnapshot {
  if (!isRecord(value)) {
    return invalid();
  }
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    keys = Reflect.ownKeys(value);
  } catch {
    return invalid();
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid();
  }

  const names: string[] = [];
  const values: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of keys) {
    if (typeof key !== "string") {
      return invalid();
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return invalid();
    }
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      return invalid();
    }
    names.push(key);
    values[key] = descriptor.value;
  }
  return Object.freeze({
    names: Object.freeze(names),
    values: Object.freeze(values),
  });
}

function bestEffortOwnDataValue(value: unknown, key: string): unknown {
  if (!isRecord(value)) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      return undefined;
    }
    return descriptor.value;
  } catch {
    return undefined;
  }
}

function exactSnapshot(
  snapshot: DataSnapshot,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (
    snapshot.names.length !== keys.length ||
    snapshot.names.some((name) => !keys.includes(name)) ||
    keys.some((key) => !snapshot.names.includes(key))
  ) {
    return invalid();
  }
  return snapshot.values;
}

function exactDataObject(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  return exactSnapshot(snapshotDataObject(value), keys);
}

function safeExcludedProjectDirectory(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 32_767 ||
    CONTROL.test(value) ||
    API_KEY_TOKEN.test(value)
  ) {
    return invalid();
  }
  return value;
}

function safeRevision(value: unknown): string {
  if (typeof value !== "string" || !REVISION.test(value)) {
    return invalid();
  }
  return value;
}

function normalizeExpectation(
  value: unknown,
): CodexDotenvCredentialExpectation {
  const snapshot = snapshotDataObject(value);
  if (snapshot.values.kind === "deferred-registration") {
    exactSnapshot(snapshot, ["kind"]);
    return Object.freeze({ kind: "deferred-registration" });
  }
  const object = exactSnapshot(snapshot, ["apiKey", "kind"]);
  if (object.kind !== "known") {
    return invalid();
  }
  return Object.freeze({
    kind: "known",
    apiKey: parseApiKey(object.apiKey),
  });
}

function normalizeObserveRequest(value: unknown): CodexDotenvObserveRequest {
  const object = exactDataObject(value, OBSERVE_REQUEST_KEYS);
  if (
    object.kind !== "codex-dotenv-observe" ||
    object.scope !== "user" ||
    object.apiOrigin !== CODEX_DOTENV_API_ORIGIN
  ) {
    return invalid();
  }
  return Object.freeze({
    kind: "codex-dotenv-observe",
    scope: "user",
    apiOrigin: CODEX_DOTENV_API_ORIGIN,
    expectation: normalizeExpectation(object.expectation),
    excludedProjectDirectory: safeExcludedProjectDirectory(
      object.excludedProjectDirectory,
    ),
  });
}

function normalizeSynchronizeRequest(
  value: unknown,
): CodexDotenvSynchronizeRequest {
  const object = exactDataObject(value, SYNCHRONIZE_REQUEST_KEYS);
  if (
    object.kind !== "codex-dotenv-synchronize" ||
    object.scope !== "user" ||
    object.apiOrigin !== CODEX_DOTENV_API_ORIGIN ||
    (object.expectedStatus !== "absent" &&
      object.expectedStatus !== "exact" &&
      object.expectedStatus !== "mismatched")
  ) {
    return invalid();
  }
  const expectation = normalizeExpectation(object.expectation);
  if (expectation.kind !== "known") {
    return invalid();
  }
  return Object.freeze({
    kind: "codex-dotenv-synchronize",
    scope: "user",
    apiOrigin: CODEX_DOTENV_API_ORIGIN,
    expectedRevision: safeRevision(object.expectedRevision),
    expectedStatus: object.expectedStatus,
    expectation,
    excludedProjectDirectory: safeExcludedProjectDirectory(
      object.excludedProjectDirectory,
    ),
  });
}

function freshRevisionNonce(): string {
  let bytes: Uint8Array | undefined;
  try {
    bytes = RANDOM_BYTES(32);
    if (intrinsicUint8ArrayByteLength(bytes) !== 32) {
      return invalid();
    }
    let value = "";
    for (let index = 0; index < 32; index += 1) {
      const byte = bytes[index];
      if (byte === undefined) {
        return invalid();
      }
      value += HEX[(byte >>> 4) & 0x0f] ?? "";
      value += HEX[byte & 0x0f] ?? "";
    }
    return safeRevision(value);
  } finally {
    if (bytes !== undefined) {
      wipeUint8Array(bytes);
    }
  }
}

function freshMutationNonce(): string {
  const value = RANDOM_UUID();
  return UUID_V4.test(value) ? value : invalid();
}

function normalizeRawObservation(value: unknown): RawObservation {
  const rawRead = bestEffortOwnDataValue(value, "read");
  const rawBytes = bestEffortOwnDataValue(rawRead, "bytes");
  let copied: Uint8Array | undefined;
  let succeeded = false;
  try {
    const snapshot = snapshotDataObject(value);
    const status = snapshot.values.status;
    if (
      status === "missing" ||
      status === "oversized" ||
      status === "unsafe"
    ) {
      const object = exactSnapshot(snapshot, ["revision", "status"]);
      return Object.freeze({
        status,
        revision: safeRevision(object.revision),
      });
    }
    if (status !== "present") {
      return invalid();
    }
    const object = exactSnapshot(snapshot, ["read", "revision", "status"]);
    const readSnapshot = snapshotDataObject(object.read);
    const read = exactSnapshot(readSnapshot, ["bytes", "endOfFile"]);
    if (read.endOfFile !== true) {
      return invalid();
    }
    const length = intrinsicUint8ArrayByteLength(read.bytes);
    if (length === undefined || length > MAX_CODEX_DOTENV_BYTES) {
      return invalid();
    }
    copied = copyUint8Array(read.bytes, length);
    if (copied === undefined) {
      return invalid();
    }
    const result = Object.freeze({
      status: "present",
      revision: safeRevision(object.revision),
      bytes: copied,
    });
    succeeded = true;
    return result;
  } finally {
    if (!succeeded && copied !== undefined) {
      wipeUint8Array(copied);
      copied = undefined;
    }
    try {
      wipeUint8Array(rawBytes);
    } catch {
      // The public error remains static for a hostile typed-array wrapper.
    }
  }
}

function normalizeRawMutation(
  value: unknown,
): CodexDotenvNativeMutationResult {
  const snapshot = snapshotDataObject(value);
  if (snapshot.values.status === "precondition-failed") {
    exactSnapshot(snapshot, ["status"]);
    return PRECONDITION_FAILED;
  }
  if (snapshot.values.status === "failed") {
    exactSnapshot(snapshot, ["status"]);
    return FAILED;
  }
  const object = exactSnapshot(snapshot, [
    "disposition",
    "stateRevision",
    "status",
  ]);
  if (
    object.status !== "completed" ||
    (object.disposition !== "changed" &&
      object.disposition !== "unchanged")
  ) {
    return invalid();
  }
  return Object.freeze({
    status: "completed",
    disposition: object.disposition,
    stateRevision: safeRevision(object.stateRevision),
  });
}

function encodeApiKey(apiKey: ApiKey): Uint8Array {
  const bytes = new BASE_UINT8_ARRAY(apiKey.length);
  let succeeded = false;
  try {
    for (let index = 0; index < apiKey.length; index += 1) {
      const value = Reflect.apply(STRING_CHAR_CODE_AT, apiKey, [
        index,
      ]) as number;
      if (!Number.isSafeInteger(value) || value < 0x21 || value > 0x7e) {
        return invalid();
      }
      bytes[index] = value;
    }
    succeeded = true;
    return bytes;
  } finally {
    if (!succeeded) {
      wipeUint8Array(bytes);
    }
  }
}

function classifyPresent(
  bytes: Uint8Array,
  expectation: CodexDotenvCredentialExpectation,
  defaultNewline: CodexDotenvNewline,
): Readonly<{
  status: "absent" | "exact" | "mismatched";
  desired?: Uint8Array;
}> {
  if (expectation.kind === "deferred-registration") {
    return Object.freeze({
      status:
        inspectCodexDotenv(bytes).status === "absent"
          ? "absent"
          : "mismatched",
    });
  }

  let key: Uint8Array | undefined;
  try {
    const inspected = inspectCodexDotenv(bytes);
    key = encodeApiKey(expectation.apiKey);
    const rewritten = rewriteCodexDotenv(bytes, key, defaultNewline);
    if (rewritten.status === "unchanged") {
      return Object.freeze({ status: "exact" });
    }
    return Object.freeze({
      status:
        inspected.status === "absent" ? "absent" : "mismatched",
      desired: rewritten.bytes,
    });
  } finally {
    if (key !== undefined) {
      wipeUint8Array(key);
    }
  }
}

function observeRaw(
  raw: NativeCodexDotenvRawCalls,
  excludedProjectDirectory: string,
): RawObservation {
  return normalizeRawObservation(
    raw.observe(
      Object.freeze({
        excludedProjectDirectory,
        maxBytes: MAX_CODEX_DOTENV_BYTES,
        noFollow: true,
        revisionNonce: freshRevisionNonce(),
      }),
    ),
  );
}

function classifyObservation(
  observed: RawObservation,
  expectation: CodexDotenvCredentialExpectation,
  defaultNewline: CodexDotenvNewline,
): Readonly<{
  revision: string;
  status: CodexDotenvProjectionStatus;
  desired?: Uint8Array;
}> {
  if (observed.status === "missing") {
    return Object.freeze({
      revision: observed.revision,
      status: "absent",
    });
  }
  if (observed.status === "unsafe") {
    return Object.freeze({
      revision: observed.revision,
      status: "unsafe",
    });
  }
  if (observed.status === "oversized") {
    return Object.freeze({
      revision: observed.revision,
      status: "ambiguous",
    });
  }
  if (observed.status !== "present") {
    return invalid();
  }
  try {
    const classified = classifyPresent(
      observed.bytes,
      expectation,
      defaultNewline,
    );
    return Object.freeze({
      revision: observed.revision,
      status: classified.status,
      ...(classified.desired === undefined
        ? {}
        : { desired: classified.desired }),
    });
  } catch (error) {
    return Object.freeze({
      revision: observed.revision,
      status:
        error instanceof CodexDotenvError &&
        error.code !== "codex_dotenv_key_invalid"
          ? "ambiguous"
          : "credential-unavailable",
    });
  }
}

function evidence(
  classified: Readonly<{
    revision: string;
    status: CodexDotenvProjectionStatus;
  }>,
): CodexDotenvNativeEvidence {
  return Object.freeze({
    revision: classified.revision,
    status: classified.status,
  });
}

export function createNativeCodexDotenvAdapter(
  raw: NativeCodexDotenvRawCalls,
  defaultNewline: CodexDotenvNewline,
): CodexDotenvNativeAdapter {
  if (
    defaultNewline !== "lf" &&
    defaultNewline !== "crlf"
  ) {
    return invalid();
  }

  async function observe(
    value: CodexDotenvObserveRequest,
  ): Promise<CodexDotenvNativeEvidence> {
    const request = normalizeObserveRequest(value);
    const observed = observeRaw(raw, request.excludedProjectDirectory);
    let desired: Uint8Array | undefined;
    try {
      const classified = classifyObservation(
        observed,
        request.expectation,
        defaultNewline,
      );
      desired = classified.desired;
      return evidence(classified);
    } finally {
      if (observed.status === "present") {
        wipeUint8Array(observed.bytes);
      }
      if (desired !== undefined) {
        wipeUint8Array(desired);
      }
    }
  }

  async function synchronize(
    value: CodexDotenvSynchronizeRequest,
  ): Promise<CodexDotenvNativeMutationResult> {
    let request: CodexDotenvSynchronizeRequest;
    try {
      request = normalizeSynchronizeRequest(value);
    } catch {
      return FAILED;
    }

    let observed: RawObservation;
    try {
      observed = observeRaw(raw, request.excludedProjectDirectory);
    } catch {
      return FAILED;
    }
    let desired: Uint8Array | undefined;
    try {
      const classified = classifyObservation(
        observed,
        request.expectation,
        defaultNewline,
      );
      desired = classified.desired;
      if (
        classified.revision !== request.expectedRevision ||
        classified.status !== request.expectedStatus
      ) {
        return PRECONDITION_FAILED;
      }
      if (
        request.expectedStatus === "exact" &&
        desired !== undefined
      ) {
        return FAILED;
      }
      if (
        request.expectedStatus !== "exact" &&
        desired === undefined
      ) {
        if (observed.status !== "missing") {
          return FAILED;
        }
        let key: Uint8Array | undefined;
        try {
          key = encodeApiKey(request.expectation.apiKey);
          const rewritten = rewriteCodexDotenv(
            new BASE_UINT8_ARRAY(0),
            key,
            defaultNewline,
          );
          if (rewritten.status !== "changed") {
            return FAILED;
          }
          desired = rewritten.bytes;
        } finally {
          if (key !== undefined) {
            wipeUint8Array(key);
          }
        }
      }

      const common = {
        excludedProjectDirectory: request.excludedProjectDirectory,
        expectedRevision: request.expectedRevision,
        maxBytes: MAX_CODEX_DOTENV_BYTES,
        nextRevisionNonce: freshRevisionNonce(),
        noFollow: true as const,
        nonce: freshMutationNonce(),
      };
      const rawResult =
        request.expectedStatus === "exact"
          ? raw.synchronize(
              Object.freeze({
                ...common,
                disposition: "unchanged" as const,
              }),
            )
          : raw.synchronize(
              Object.freeze({
                ...common,
                bytes: desired as Uint8Array,
                disposition: "changed" as const,
              }),
            );
      const result = normalizeRawMutation(rawResult);
      if (
        result.status === "completed" &&
        ((request.expectedStatus === "exact" &&
          (result.disposition !== "unchanged" ||
            result.stateRevision !== request.expectedRevision)) ||
          (request.expectedStatus !== "exact" &&
            (result.disposition !== "changed" ||
              result.stateRevision === request.expectedRevision)))
      ) {
        return FAILED;
      }
      return result;
    } catch {
      return FAILED;
    } finally {
      if (observed.status === "present") {
        wipeUint8Array(observed.bytes);
      }
      if (desired !== undefined) {
        wipeUint8Array(desired);
      }
    }
  }

  return Object.freeze({ observe, synchronize });
}
