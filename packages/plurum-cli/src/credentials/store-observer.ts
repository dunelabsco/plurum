import type { ApiOriginPolicy } from "./origin.js";
import type { CredentialV1 } from "./schema.js";
import {
  MAX_CREDENTIAL_DOCUMENT_BYTES,
  parseCredentialDocumentBytes,
} from "./store-codec.js";
import {
  CREDENTIAL_STORE_ENTRY,
  type CredentialFileAttestation,
  type CredentialFileReadHandle,
  type CredentialObjectIdentity,
  type PrivateDirectoryAttestation,
} from "./store-contracts.js";
import {
  CREDENTIAL_TRANSACTION_ENTRY,
  type CredentialCanonicalEntry,
  type CredentialManagedEntry,
  type CredentialTemporaryEntry,
} from "./store-mutation-contracts.js";
import {
  MAX_CREDENTIAL_TRANSACTION_BYTES,
  parseCredentialTransactionDocumentBytes,
  type CredentialReplaceTransactionV1,
} from "./store-transaction.js";
import type {
  CredentialStoreCanonicalPublicState,
  CredentialStoreNativeObservationEvidence,
  CredentialStoreObservationAdapter,
  CredentialStoreObservationAuthority,
  CredentialStoreObservationDirectoryHandle,
  CredentialStoreObservationDirectoryOpenResult,
  CredentialStoreObservationEvidence,
  CredentialStoreObservationIdentity,
  CredentialStoreObservationOptions,
  CredentialStoreObservationRedeemRequest,
  CredentialStoreObservationRedeemResult,
  CredentialStoreObservationRequest,
  CredentialStoreObservationResult,
  CredentialStoreTransactionPublicState,
} from "./store-observation-contracts.js";
import { copyUint8Array } from "../data/uint8-array.js";

interface DirectorySnapshot {
  readonly identity: CredentialObjectIdentity;
  readonly revision: string;
}

interface FileSnapshot {
  readonly identity: CredentialObjectIdentity;
  readonly parentIdentity: CredentialObjectIdentity;
  readonly revision: string;
  readonly size: number;
}

interface OpenedEntry {
  readonly attestation: CredentialFileAttestation;
  readonly file: CredentialFileReadHandle;
}

interface RetainedObservation {
  readonly directory: string;
  readonly credential: CredentialV1 | null;
  readonly transaction: CredentialReplaceTransactionV1 | null;
  readonly nativeEvidence: CredentialStoreNativeObservationEvidence;
}

interface OpenedStoreObservation {
  readonly credential: CredentialV1 | null;
  readonly transaction: CredentialReplaceTransactionV1 | null;
  readonly nativeEvidence: CredentialStoreNativeObservationEvidence;
  readonly temporaryCount: number;
}

interface DataSnapshot {
  readonly names: readonly string[];
  readonly values: Readonly<Record<string, unknown>>;
}

interface Closeable {
  close(): Promise<void>;
}

const CREDENTIAL_ENTRY: CredentialCanonicalEntry = Object.freeze({
  kind: "canonical",
  role: "credential",
  name: CREDENTIAL_STORE_ENTRY,
});
const TRANSACTION_ENTRY: CredentialCanonicalEntry = Object.freeze({
  kind: "canonical",
  role: "transaction",
  name: CREDENTIAL_TRANSACTION_ENTRY,
});
const DIRECTORY_OPEN_OPTIONS = Object.freeze({ noFollow: true as const });
const MAX_DIRECTORY_CHARACTERS = 32_767;
const MAX_OPAQUE_CHARACTERS = 512;
const MAX_MANAGED_TEMPORARY_ENTRIES = 1_024;
const OPAQUE_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOKEN_TO_JSON = Object.freeze(function tokenToJson(): undefined {
  return undefined;
});
const UNAVAILABLE = Object.freeze({
  status: "unavailable" as const,
  transaction: "unavailable" as const,
  canonical: "unavailable" as const,
});
const PRECONDITION_FAILED = Object.freeze({
  status: "precondition-failed" as const,
});
const OWNED_OBSERVATION_AUTHORITIES = new WeakSet<
  CredentialStoreObservationAuthority
>();

export function isOwnedCredentialStoreObservationAuthority(
  value: unknown,
): value is CredentialStoreObservationAuthority {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return false;
  }
  return OWNED_OBSERVATION_AUTHORITIES.has(
    value as CredentialStoreObservationAuthority,
  );
}

function invalid(): never {
  throw new Error("The credential-store observation could not be verified.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

function isCallable(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

function snapshotDataObject(value: unknown): DataSnapshot {
  if (!isRecord(value)) {
    return invalid();
  }
  let prototype: object | null;
  let names: string[];
  let symbols: symbol[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    names = Object.getOwnPropertyNames(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return invalid();
  }
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    symbols.length !== 0
  ) {
    return invalid();
  }
  const copied: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const name of names) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, name);
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
    copied[name] = descriptor.value;
  }
  return Object.freeze({
    names: Object.freeze([...names]),
    values: Object.freeze(copied),
  });
}

function exactSnapshot(
  snapshot: DataSnapshot,
  expected: readonly string[],
): Readonly<Record<string, unknown>> {
  if (
    snapshot.names.length !== expected.length ||
    snapshot.names.some((name) => !expected.includes(name)) ||
    expected.some((name) => !snapshot.names.includes(name))
  ) {
    return invalid();
  }
  return snapshot.values;
}

function exactDataObject(
  value: unknown,
  expected: readonly string[],
): Readonly<Record<string, unknown>> {
  return exactSnapshot(snapshotDataObject(value), expected);
}

function safeOpaquePart(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_OPAQUE_CHARACTERS ||
    OPAQUE_CONTROL.test(value)
  ) {
    return invalid();
  }
  return value;
}

function safeDirectory(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_DIRECTORY_CHARACTERS ||
    OPAQUE_CONTROL.test(value)
  ) {
    return invalid();
  }
  return value;
}

function normalizeIdentity(value: unknown): CredentialObjectIdentity {
  const object = exactDataObject(value, ["volume", "object"]);
  return Object.freeze({
    volume: safeOpaquePart(object.volume),
    object: safeOpaquePart(object.object),
  });
}

function sameIdentity(
  left: CredentialObjectIdentity,
  right: CredentialObjectIdentity,
): boolean {
  return left.volume === right.volume && left.object === right.object;
}

function normalizeDirectoryAttestation(
  value: unknown,
): DirectorySnapshot {
  const object = exactDataObject(value, [
    "kind",
    "identity",
    "revision",
    "binding",
    "owner",
    "access",
    "link",
  ]);
  if (
    object.kind !== "directory" ||
    object.binding !== "canonical-current" ||
    object.owner !== "current-user" ||
    object.access !== "user-only" ||
    object.link !== "direct"
  ) {
    return invalid();
  }
  return Object.freeze({
    identity: normalizeIdentity(object.identity),
    revision: safeOpaquePart(object.revision),
  });
}

function normalizeFileAttestation(
  value: unknown,
  directoryIdentity: CredentialObjectIdentity,
): FileSnapshot {
  const object = exactDataObject(value, [
    "kind",
    "identity",
    "parentIdentity",
    "revision",
    "binding",
    "owner",
    "access",
    "link",
    "links",
    "size",
  ]);
  if (
    object.kind !== "regular-file" ||
    object.binding !== "canonical-current" ||
    object.owner !== "current-user" ||
    object.access !== "user-only" ||
    object.link !== "direct" ||
    object.links !== 1 ||
    !Number.isSafeInteger(object.size) ||
    (object.size as number) < 0
  ) {
    return invalid();
  }
  const identity = normalizeIdentity(object.identity);
  const parentIdentity = normalizeIdentity(object.parentIdentity);
  if (
    sameIdentity(identity, directoryIdentity) ||
    !sameIdentity(parentIdentity, directoryIdentity)
  ) {
    return invalid();
  }
  return Object.freeze({
    identity,
    parentIdentity,
    revision: safeOpaquePart(object.revision),
    size: object.size as number,
  });
}

function sameDirectory(left: DirectorySnapshot, right: DirectorySnapshot): boolean {
  return sameIdentity(left.identity, right.identity) && left.revision === right.revision;
}

function sameFile(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    sameIdentity(left.identity, right.identity) &&
    sameIdentity(left.parentIdentity, right.parentIdentity) &&
    left.revision === right.revision &&
    left.size === right.size
  );
}

function isCloseable(value: unknown): value is Closeable {
  try {
    return isRecord(value) && isCallable(value.close);
  } catch {
    return false;
  }
}

function isFileHandle(value: unknown): value is CredentialFileReadHandle {
  try {
    return (
      isCloseable(value) &&
      isRecord(value) &&
      isCallable(value.attest) &&
      isCallable(value.readBounded)
    );
  } catch {
    return false;
  }
}

function isDirectoryHandle(
  value: unknown,
): value is CredentialStoreObservationDirectoryHandle {
  try {
    return (
      isCloseable(value) &&
      isRecord(value) &&
      isCallable(value.attest) &&
      isCallable(value.observeEntry) &&
      isCallable(value.listTemporaryEntries) &&
      isCallable(value.finishObservation)
    );
  } catch {
    return false;
  }
}

function possibleDataProperty(value: unknown, property: string): unknown {
  try {
    if (!isRecord(value)) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    return descriptor !== undefined && Object.hasOwn(descriptor, "value")
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

async function closeMalformed(value: unknown): Promise<never> {
  if (isCloseable(value)) {
    try {
      await value.close();
    } catch {
      // The whole observation is unavailable regardless of cleanup outcome.
    }
  }
  return invalid();
}

async function useResource<T extends Closeable, R>(
  resource: T,
  operation: (opened: T) => Promise<R>,
): Promise<R> {
  let result: R | undefined;
  let failed = false;
  try {
    result = await operation(resource);
  } catch {
    failed = true;
  }
  try {
    await resource.close();
  } catch {
    failed = true;
  }
  if (failed) {
    return invalid();
  }
  return result as R;
}

async function normalizeDirectoryOpenResult(
  value: unknown,
): Promise<CredentialStoreObservationDirectoryOpenResult> {
  const possibleDirectory = possibleDataProperty(value, "directory");
  try {
    const snapshot = snapshotDataObject(value);
    const status = snapshot.values.status;
    if (status === "missing") {
      const object = exactSnapshot(snapshot, ["status", "evidence"]);
      if (!isRecord(object.evidence)) {
        return invalid();
      }
      return Object.freeze({
        status: "missing",
        evidence: object.evidence as unknown as CredentialStoreNativeObservationEvidence,
      });
    }
    if (status === "opened") {
      const object = exactSnapshot(snapshot, ["status", "directory"]);
      if (!isDirectoryHandle(object.directory)) {
        return await closeMalformed(possibleDirectory);
      }
      return Object.freeze({ status: "opened", directory: object.directory });
    }
  } catch {
    if (possibleDirectory !== undefined) {
      return await closeMalformed(possibleDirectory);
    }
    return invalid();
  }
  return possibleDirectory === undefined
    ? invalid()
    : await closeMalformed(possibleDirectory);
}

async function normalizeEntryResult(value: unknown): Promise<
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "opened"; entry: OpenedEntry }>
> {
  const possibleFile = possibleDataProperty(value, "file");
  try {
    const snapshot = snapshotDataObject(value);
    const status = snapshot.values.status;
    if (status === "missing") {
      exactSnapshot(snapshot, ["status"]);
      return Object.freeze({ status: "missing" });
    }
    if (status === "opened") {
      const object = exactSnapshot(snapshot, ["status", "attestation", "file"]);
      if (!isFileHandle(object.file)) {
        return await closeMalformed(possibleFile);
      }
      return Object.freeze({
        status: "opened",
        entry: Object.freeze({
          attestation: object.attestation as CredentialFileAttestation,
          file: object.file,
        }),
      });
    }
  } catch {
    if (possibleFile !== undefined) {
      return await closeMalformed(possibleFile);
    }
    return invalid();
  }
  return possibleFile === undefined ? invalid() : await closeMalformed(possibleFile);
}

function normalizeTemporaryEntry(value: unknown): CredentialTemporaryEntry {
  const object = exactDataObject(value, ["kind", "role", "transactionId"]);
  const role = object.role;
  if (
    object.kind !== "temporary" ||
    (role !== "credential-candidate" &&
      role !== "transaction-candidate" &&
      role !== "recovery-candidate") ||
    typeof object.transactionId !== "string" ||
    !UUID_V4.test(object.transactionId)
  ) {
    return invalid();
  }
  return Object.freeze({
    kind: "temporary",
    role,
    transactionId: object.transactionId as CredentialTemporaryEntry["transactionId"],
  });
}

function temporaryEntryKey(entry: CredentialTemporaryEntry): string {
  return `${entry.role}:${entry.transactionId}`;
}

function normalizeTemporaryEntries(value: unknown): readonly CredentialTemporaryEntry[] {
  if (!Array.isArray(value) || !Object.isFrozen(value)) {
    return invalid();
  }
  let prototype: object | null;
  let names: string[];
  let symbols: symbol[];
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    names = Object.getOwnPropertyNames(value);
    symbols = Object.getOwnPropertySymbols(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    return invalid();
  }
  const length = lengthDescriptor?.value;
  if (
    prototype !== Array.prototype ||
    symbols.length !== 0 ||
    lengthDescriptor === undefined ||
    lengthDescriptor.enumerable !== false ||
    lengthDescriptor.configurable !== false ||
    lengthDescriptor.writable !== false ||
    lengthDescriptor.get !== undefined ||
    lengthDescriptor.set !== undefined ||
    !Number.isSafeInteger(length) ||
    (length as number) < 0 ||
    (length as number) > MAX_MANAGED_TEMPORARY_ENTRIES ||
    names.length !== (length as number) + 1 ||
    !names.includes("length")
  ) {
    return invalid();
  }
  const entries: CredentialTemporaryEntry[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    const name = String(index);
    if (!names.includes(name)) {
      return invalid();
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, name);
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
    entries.push(normalizeTemporaryEntry(descriptor.value));
  }
  const keys = entries.map(temporaryEntryKey);
  if (new Set(keys).size !== keys.length) {
    return invalid();
  }
  entries.sort((left, right) => {
    const leftKey = temporaryEntryKey(left);
    const rightKey = temporaryEntryKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return Object.freeze(entries);
}

function entryOpenOptions(entry: CredentialManagedEntry): Readonly<{
  entry: CredentialManagedEntry;
  noFollow: true;
}> {
  return Object.freeze({ entry, noFollow: true });
}

async function attestDirectory(
  directory: CredentialStoreObservationDirectoryHandle,
): Promise<DirectorySnapshot> {
  return normalizeDirectoryAttestation(await directory.attest());
}

async function attestFile(
  file: CredentialFileReadHandle,
  directoryIdentity: CredentialObjectIdentity,
): Promise<FileSnapshot> {
  return normalizeFileAttestation(await file.attest(), directoryIdentity);
}

function wipe(bytes: Uint8Array): void {
  try {
    Uint8Array.prototype.fill.call(bytes, 0);
  } catch {
    // Best effort only. A detached owned buffer no longer exposes its bytes.
  }
}

async function readOpenedEntry<T>(
  opened: OpenedEntry,
  directoryIdentity: CredentialObjectIdentity,
  maxBytes: number,
  parse: (bytes: Uint8Array) => T,
): Promise<T> {
  return useResource(opened.file, async (file) => {
    const declared = normalizeFileAttestation(
      opened.attestation,
      directoryIdentity,
    );
    const before = await attestFile(file, directoryIdentity);
    if (!sameFile(declared, before) || before.size > maxBytes) {
      return invalid();
    }
    const raw = await file.readBounded(
      Object.freeze({ maxBytes: maxBytes + 1 }),
    );
    const bounded = exactDataObject(raw, ["bytes", "endOfFile"]);
    if (typeof bounded.endOfFile !== "boolean") {
      return invalid();
    }
    const bytes = copyUint8Array(bounded.bytes, before.size);
    if (bytes === undefined) {
      return invalid();
    }
    try {
      const after = await attestFile(file, directoryIdentity);
      if (
        !sameFile(before, after) ||
        bounded.endOfFile !== true ||
        bytes.byteLength !== before.size
      ) {
        return invalid();
      }
      return parse(bytes);
    } finally {
      wipe(bytes);
    }
  });
}

async function observeCanonicalCredential(
  directory: CredentialStoreObservationDirectoryHandle,
  directoryIdentity: CredentialObjectIdentity,
  originPolicy: ApiOriginPolicy,
): Promise<CredentialV1 | null> {
  const result = await normalizeEntryResult(
    await directory.observeEntry(entryOpenOptions(CREDENTIAL_ENTRY)),
  );
  if (result.status === "missing") {
    return null;
  }
  return readOpenedEntry(
    result.entry,
    directoryIdentity,
    MAX_CREDENTIAL_DOCUMENT_BYTES,
    (bytes) => parseCredentialDocumentBytes(bytes, originPolicy),
  );
}

async function observeTransaction(
  directory: CredentialStoreObservationDirectoryHandle,
  directoryIdentity: CredentialObjectIdentity,
  originPolicy: ApiOriginPolicy,
): Promise<CredentialReplaceTransactionV1 | null> {
  const result = await normalizeEntryResult(
    await directory.observeEntry(entryOpenOptions(TRANSACTION_ENTRY)),
  );
  if (result.status === "missing") {
    return null;
  }
  return readOpenedEntry(
    result.entry,
    directoryIdentity,
    MAX_CREDENTIAL_TRANSACTION_BYTES,
    (bytes) => parseCredentialTransactionDocumentBytes(bytes, originPolicy),
  );
}

async function observeTemporaryEntry(
  directory: CredentialStoreObservationDirectoryHandle,
  directoryIdentity: CredentialObjectIdentity,
  entry: CredentialTemporaryEntry,
): Promise<void> {
  const result = await normalizeEntryResult(
    await directory.observeEntry(entryOpenOptions(entry)),
  );
  if (result.status !== "opened") {
    return invalid();
  }
  await useResource(result.entry.file, async (file) => {
    const declared = normalizeFileAttestation(
      result.entry.attestation,
      directoryIdentity,
    );
    const before = await attestFile(file, directoryIdentity);
    const after = await attestFile(file, directoryIdentity);
    if (!sameFile(declared, before) || !sameFile(before, after)) {
      return invalid();
    }
  });
}

async function observeOpenedStore(
  directory: CredentialStoreObservationDirectoryHandle,
  originPolicy: ApiOriginPolicy,
): Promise<OpenedStoreObservation> {
  return useResource(directory, async (opened) => {
    const before = await attestDirectory(opened);
    const credential = await observeCanonicalCredential(
      opened,
      before.identity,
      originPolicy,
    );
    const transaction = await observeTransaction(
      opened,
      before.identity,
      originPolicy,
    );
    const temporaries = normalizeTemporaryEntries(
      await opened.listTemporaryEntries(),
    );
    for (const temporary of temporaries) {
      await observeTemporaryEntry(opened, before.identity, temporary);
    }
    const after = await attestDirectory(opened);
    if (!sameDirectory(before, after)) {
      return invalid();
    }
    const nativeEvidence = await opened.finishObservation();
    if (!isRecord(nativeEvidence)) {
      return invalid();
    }
    return Object.freeze({
      credential,
      transaction,
      nativeEvidence,
      temporaryCount: temporaries.length,
    });
  });
}

function normalizeObservationRequest(
  value: unknown,
): CredentialStoreObservationRequest {
  const object = exactDataObject(value, ["directory"]);
  return Object.freeze({ directory: safeDirectory(object.directory) });
}

function normalizeRedeemRequest(
  value: unknown,
): CredentialStoreObservationRedeemRequest {
  const object = exactDataObject(value, ["identity", "directory"]);
  if (!isRecord(object.identity)) {
    return invalid();
  }
  return Object.freeze({
    identity: object.identity as unknown as CredentialStoreObservationIdentity,
    directory: safeDirectory(object.directory),
  });
}

function createToken<T>(): T {
  const token = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(token, "toJSON", {
    configurable: false,
    enumerable: false,
    value: TOKEN_TO_JSON,
    writable: false,
  });
  return Object.freeze(token) as T;
}

function publicCanonical(credential: CredentialV1 | null): CredentialStoreCanonicalPublicState {
  return credential === null ? "missing" : credential.state;
}

function publicTransaction(
  transaction: CredentialReplaceTransactionV1 | null,
  temporaryCount: number,
): Exclude<CredentialStoreTransactionPublicState, "unavailable"> {
  return transaction === null && temporaryCount === 0
    ? "clean"
    : "recovery-required";
}

export function createCredentialStoreObservationAuthority(
  adapter: CredentialStoreObservationAdapter,
  options: CredentialStoreObservationOptions = Object.freeze({}),
): CredentialStoreObservationAuthority {
  const originPolicy = options.originPolicy ?? "https-only";
  const observations = new WeakMap<
    CredentialStoreObservationIdentity,
    RetainedObservation
  >();
  const nativeEvidence = new WeakMap<
    CredentialStoreObservationEvidence,
    CredentialStoreNativeObservationEvidence
  >();

  function issue(
    directory: string,
    credential: CredentialV1 | null,
    transaction: CredentialReplaceTransactionV1 | null,
    evidence: CredentialStoreNativeObservationEvidence,
    temporaryCount: number,
  ): CredentialStoreObservationResult {
    const identity = createToken<CredentialStoreObservationIdentity>();
    observations.set(
      identity,
      Object.freeze({
        directory,
        credential,
        transaction,
        nativeEvidence: evidence,
      }),
    );
    return Object.freeze({
      status: "available",
      identity,
      transaction: publicTransaction(transaction, temporaryCount),
      canonical: publicCanonical(credential),
    });
  }

  async function inspect(
    rawRequest: CredentialStoreObservationRequest,
  ): Promise<CredentialStoreObservationResult> {
    try {
      const request = normalizeObservationRequest(rawRequest);
      const opened = await normalizeDirectoryOpenResult(
        await adapter.openPrivateDirectory(
          request.directory,
          DIRECTORY_OPEN_OPTIONS,
        ),
      );
      if (opened.status === "missing") {
        return issue(request.directory, null, null, opened.evidence, 0);
      }

      const observed = await observeOpenedStore(opened.directory, originPolicy);
      return issue(
        request.directory,
        observed.credential,
        observed.transaction,
        observed.nativeEvidence,
        observed.temporaryCount,
      );
    } catch {
      return UNAVAILABLE;
    }
  }

  function redeem(
    rawRequest: CredentialStoreObservationRedeemRequest,
  ): CredentialStoreObservationRedeemResult {
    let request: CredentialStoreObservationRedeemRequest;
    try {
      request = normalizeRedeemRequest(rawRequest);
    } catch {
      return PRECONDITION_FAILED;
    }
    const retained = observations.get(request.identity);
    if (retained === undefined) {
      return PRECONDITION_FAILED;
    }
    observations.delete(request.identity);
    if (retained.directory !== request.directory) {
      return PRECONDITION_FAILED;
    }
    const evidence = createToken<CredentialStoreObservationEvidence>();
    nativeEvidence.set(evidence, retained.nativeEvidence);
    const result = {
      status: "redeemed" as const,
      evidence,
    } as CredentialStoreObservationRedeemResult & Record<string, unknown>;
    Object.defineProperty(result, "credential", {
      configurable: false,
      enumerable: false,
      value: retained.credential,
      writable: false,
    });
    Object.defineProperty(result, "transaction", {
      configurable: false,
      enumerable: false,
      value: retained.transaction,
      writable: false,
    });
    Object.defineProperty(result, "toJSON", {
      configurable: false,
      enumerable: false,
      value: TOKEN_TO_JSON,
      writable: false,
    });
    return Object.freeze(result) as CredentialStoreObservationRedeemResult;
  }

  const authority = Object.freeze({ inspect, redeem });
  OWNED_OBSERVATION_AUTHORITIES.add(authority);
  return authority;
}
