import { CredentialError } from "./errors.js";
import type { ApiOriginPolicy } from "./origin.js";
import type { CredentialLocations } from "./paths.js";
import {
  serializeCredentialDocument,
  type ActiveCredentialV1,
  type CanonicalTimestamp,
  type CredentialV1,
  type PendingCredentialV1,
  type RegistrationRequestId,
  type Username,
  validateCredentialDocument,
} from "./schema.js";
import {
  MAX_CREDENTIAL_DOCUMENT_BYTES,
  parseCredentialDocumentBytes,
} from "./store-codec.js";
import {
  CREDENTIAL_STORE_ENTRY,
  type BoundedCredentialRead,
  type CredentialFileAttestation,
  type CredentialFileReadHandle,
  type CredentialObjectIdentity,
} from "./store-contracts.js";
import {
  CREDENTIAL_TRANSACTION_ENTRY,
  type CredentialCanonicalEntry,
  type CredentialEntrySnapshot,
  type CredentialFileExclusiveWriteHandle,
  type CredentialManagedEntry,
  type CredentialMissingEntrySnapshot,
  type CredentialPresentEntrySnapshot,
  type CredentialSetupLeaseNonce,
  type CredentialStoreMutationAdapter,
  type CredentialStoreMutationLease,
  type CredentialTemporaryEntry,
  type CredentialTemporaryEntryRole,
} from "./store-mutation-contracts.js";
import {
  CREDENTIAL_TRANSACTION_KIND,
  CREDENTIAL_TRANSACTION_SCHEMA_VERSION,
  MAX_CREDENTIAL_TRANSACTION_BYTES,
  parseCredentialTransactionDocumentBytes,
  serializeCredentialTransactionDocumentBytes,
  type CredentialReplaceTransactionV1,
  validateCredentialTransactionId,
} from "./store-transaction.js";
import type {
  ClockAdapter,
  RandomAdapter,
} from "../system/contracts.js";

export interface CredentialStoreRecoveryDependencies {
  readonly storage: CredentialStoreMutationAdapter;
  readonly random: Pick<RandomAdapter, "uuid">;
}

export interface CredentialStoreWriterDependencies
  extends CredentialStoreRecoveryDependencies {
  readonly clock: ClockAdapter;
}

export type CredentialStoreRecoveryResult = Readonly<{
  status: "clean" | "rolled-back";
}>;

export type CredentialStoreWriteResult = Readonly<{
  status: "written" | "unchanged";
}>;

export interface VerifiedRegistrationAgent {
  readonly id: string;
  readonly name: string;
  readonly username: string | null;
}

export type CredentialRegistrationReadResult =
  | Readonly<{
      status: "pending-created";
      credential: PendingCredentialV1;
    }>
  | Readonly<{
      status: "pending-resumed";
      credential: PendingCredentialV1;
    }>
  | Readonly<{
      status: "existing-active";
      credential: ActiveCredentialV1;
    }>;

export type CredentialRegistrationActivationResult =
  | Readonly<{
      status: "activated";
      credential: ActiveCredentialV1;
    }>
  | Readonly<{
      status: "already-active";
      credential: ActiveCredentialV1;
    }>;

export type CredentialRegistrationUsernameReplacementResult =
  | Readonly<{
      status: "pending-replaced";
      credential: PendingCredentialV1;
    }>
  | Readonly<{
      status: "pending-unchanged";
      credential: PendingCredentialV1;
    }>
  | Readonly<{ status: "no-pending" }>;

export interface ExclusiveCredentialRegistrationSession {
  readOrCreatePending(
    factory: (createdAt: CanonicalTimestamp) => PendingCredentialV1,
  ): Promise<CredentialRegistrationReadResult>;
  activateExactPending(
    expected: PendingCredentialV1,
    verifiedAgent: VerifiedRegistrationAgent,
  ): Promise<CredentialRegistrationActivationResult>;
  replaceUsernameAfterConflict(
    username: Username,
    requestIdFactory: () => RegistrationRequestId,
  ): Promise<CredentialRegistrationUsernameReplacementResult>;
}

interface DirectorySnapshot {
  readonly identity: CredentialObjectIdentity;
}

interface FileSnapshot {
  readonly identity: CredentialObjectIdentity;
  readonly parentIdentity: CredentialObjectIdentity;
  readonly revision: string;
  readonly size: number;
}

type ManagedEntryRead =
  | Readonly<{
      status: "missing";
      snapshot: CredentialMissingEntrySnapshot;
    }>
  | Readonly<{
      status: "loaded";
      snapshot: CredentialPresentEntrySnapshot;
      bytes: Uint8Array;
    }>;

interface LeaseSession {
  readonly lease: CredentialStoreMutationLease;
  readonly directory: DirectorySnapshot;
}

interface PreparedLease {
  readonly storage: CredentialStoreMutationAdapter;
  readonly directory: string;
  readonly nonce: CredentialSetupLeaseNonce;
}

interface PreparedWrite {
  readonly transactionId: ReturnType<typeof validateCredentialTransactionId>;
  readonly createdAt: CanonicalTimestamp;
  readonly credential: CredentialV1;
  readonly credentialBytes: Uint8Array;
}

interface OpenedObservation {
  readonly snapshot: CredentialPresentEntrySnapshot;
  readonly attestation: CredentialFileAttestation;
  readonly file: CredentialFileReadHandle;
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
const ACQUIRE_OPTIONS_BASE = Object.freeze({
  noFollow: true as const,
  createDirectory: true as const,
});
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_OPAQUE_CHARACTERS = 512;
const OPAQUE_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const LEASE_LOST = Object.freeze({ kind: "credential-lease-lost" as const });

const CLEAN: CredentialStoreRecoveryResult = Object.freeze({
  status: "clean",
});
const ROLLED_BACK: CredentialStoreRecoveryResult = Object.freeze({
  status: "rolled-back",
});
const WRITTEN: CredentialStoreWriteResult = Object.freeze({
  status: "written",
});
const UNCHANGED: CredentialStoreWriteResult = Object.freeze({
  status: "unchanged",
});

function storeUnavailable(): never {
  throw new CredentialError("credential_store_unavailable");
}

function unsafeStore(): never {
  throw new CredentialError("unsafe_credential_store");
}

function storeBusy(): never {
  throw new CredentialError("credential_store_busy");
}

function storeConflict(): never {
  throw new CredentialError("credential_store_conflict");
}

function recoveryRequired(): never {
  throw new CredentialError("credential_recovery_required");
}

function leaseLost(): never {
  throw LEASE_LOST;
}

function documentTooLarge(): never {
  throw new CredentialError("credential_document_too_large");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCallable(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

interface Closeable {
  close(): Promise<void>;
}

interface Abandonable {
  abandon(): Promise<void>;
}

function isCloseable(value: unknown): value is Closeable {
  try {
    return isRecord(value) && isCallable(value.close);
  } catch {
    return false;
  }
}

function isAbandonable(value: unknown): value is Abandonable {
  try {
    return isRecord(value) && isCallable(value.abandon);
  } catch {
    return false;
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  try {
    const actual = Object.keys(value);
    return (
      actual.length === keys.length &&
      actual.every((key) => keys.includes(key))
    );
  } catch {
    return false;
  }
}

function possibleProperty(
  value: unknown,
  key: string,
): unknown {
  try {
    return isRecord(value) ? value[key] : undefined;
  } catch {
    return undefined;
  }
}

function wipeBytes(bytes: Uint8Array): void {
  try {
    Uint8Array.prototype.fill.call(bytes, 0);
  } catch {
    // Best effort only. JavaScript strings and caller-owned storage are not wiped.
  }
}

function copyBytes(value: unknown): Uint8Array | null {
  try {
    return value instanceof Uint8Array
      ? Uint8Array.prototype.slice.call(value)
      : null;
  } catch {
    return null;
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function copyOpaquePart(value: unknown): string | null {
  try {
    return typeof value === "string" &&
      value.length > 0 &&
      value.length <= MAX_OPAQUE_CHARACTERS &&
      !OPAQUE_CONTROL.test(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

function copyIdentity(value: unknown): CredentialObjectIdentity | null {
  try {
    if (!isRecord(value)) {
      return null;
    }
    const volume = copyOpaquePart(value.volume);
    const object = copyOpaquePart(value.object);
    if (volume === null || object === null) {
      return null;
    }
    return Object.freeze({ volume, object });
  } catch {
    return null;
  }
}

function identitiesEqual(
  left: CredentialObjectIdentity,
  right: CredentialObjectIdentity,
): boolean {
  return left.volume === right.volume && left.object === right.object;
}

function secureDirectorySnapshot(value: unknown): DirectorySnapshot | null {
  try {
    if (!isRecord(value)) {
      return null;
    }
    const identity = copyIdentity(value.identity);
    const revision = copyOpaquePart(value.revision);
    if (
      value.kind !== "directory" ||
      value.binding !== "canonical-current" ||
      value.owner !== "current-user" ||
      value.access !== "user-only" ||
      value.link !== "direct" ||
      identity === null ||
      revision === null
    ) {
      return null;
    }
    return Object.freeze({ identity });
  } catch {
    return null;
  }
}

function secureFileSnapshot(
  value: unknown,
  directoryIdentity: CredentialObjectIdentity,
  maxBytes: number,
): FileSnapshot | "too-large" | null {
  try {
    if (!isRecord(value)) {
      return null;
    }
    const identity = copyIdentity(value.identity);
    const parentIdentity = copyIdentity(value.parentIdentity);
    const revision = copyOpaquePart(value.revision);
    const size = value.size;
    if (
      value.kind !== "regular-file" ||
      value.binding !== "canonical-current" ||
      value.owner !== "current-user" ||
      value.access !== "user-only" ||
      value.link !== "direct" ||
      value.links !== 1 ||
      !Number.isSafeInteger(size) ||
      (size as number) < 0 ||
      identity === null ||
      parentIdentity === null ||
      revision === null ||
      identitiesEqual(identity, directoryIdentity) ||
      !identitiesEqual(parentIdentity, directoryIdentity)
    ) {
      return null;
    }
    if ((size as number) > maxBytes) {
      return "too-large";
    }
    return Object.freeze({
      identity,
      parentIdentity,
      revision,
      size: size as number,
    });
  } catch {
    return null;
  }
}

function fileSnapshotsEqual(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    identitiesEqual(left.identity, right.identity) &&
    identitiesEqual(left.parentIdentity, right.parentIdentity) &&
    left.revision === right.revision &&
    left.size === right.size
  );
}

function isReadHandle(value: unknown): value is CredentialFileReadHandle {
  try {
    return (
      isRecord(value) &&
      isCallable(value.attest) &&
      isCallable(value.readBounded) &&
      isCallable(value.close)
    );
  } catch {
    return false;
  }
}

function isWriteHandle(
  value: unknown,
): value is CredentialFileExclusiveWriteHandle {
  try {
    return (
      isRecord(value) &&
      isCallable(value.attest) &&
      isCallable(value.writeAll) &&
      isCallable(value.sync) &&
      isCallable(value.close)
    );
  } catch {
    return false;
  }
}

function isLease(value: unknown): value is CredentialStoreMutationLease {
  try {
    return (
      isRecord(value) &&
      isCallable(value.attestDirectory) &&
      isCallable(value.renew) &&
      isCallable(value.observeEntry) &&
      isCallable(value.listTemporaryEntries) &&
      isCallable(value.createTemporaryExclusive) &&
      isCallable(value.moveTemporaryConditionally) &&
      isCallable(value.removeConditionally) &&
      isCallable(value.syncDirectory) &&
      isCallable(value.release) &&
      isCallable(value.abandon)
    );
  } catch {
    return false;
  }
}

function isMutationAdapter(
  value: unknown,
): value is CredentialStoreMutationAdapter {
  try {
    return isRecord(value) && isCallable(value.acquireSetupLease);
  } catch {
    return false;
  }
}

function isOpaqueSnapshot(value: unknown): value is CredentialEntrySnapshot {
  try {
    return (
      value !== null &&
      typeof value === "object" &&
      Object.isFrozen(value)
    );
  } catch {
    return false;
  }
}

async function callAdapter<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error === LEASE_LOST) {
      throw error;
    }
    return storeUnavailable();
  }
}

async function closeReadHandle(file: CredentialFileReadHandle): Promise<void> {
  await callAdapter(() => file.close());
}

async function closeWriteHandle(
  file: CredentialFileExclusiveWriteHandle,
): Promise<void> {
  await callAdapter(() => file.close());
}

async function closeMalformedReadHandle(value: unknown): Promise<never> {
  if (isCloseable(value)) {
    await callAdapter(() => value.close());
  }
  return storeUnavailable();
}

async function closeMalformedWriteHandle(value: unknown): Promise<never> {
  if (isCloseable(value)) {
    await callAdapter(() => value.close());
  }
  return storeUnavailable();
}

async function abandonMalformedLease(value: unknown): Promise<never> {
  if (isAbandonable(value)) {
    await callAdapter(() => value.abandon());
  }
  return storeUnavailable();
}

function temporaryEntry(
  role: CredentialTemporaryEntryRole,
  transactionId: ReturnType<typeof validateCredentialTransactionId>,
): CredentialTemporaryEntry {
  return Object.freeze({
    kind: "temporary",
    role,
    transactionId,
  });
}

function validateTemporaryEntry(value: unknown): CredentialTemporaryEntry | null {
  try {
    if (!isRecord(value)) {
      return null;
    }
    const kind = value.kind;
    const role = value.role;
    const rawTransactionId = value.transactionId;
    if (
      !hasExactKeys(value, ["kind", "role", "transactionId"]) ||
      kind !== "temporary" ||
      (role !== "credential-candidate" &&
        role !== "transaction-candidate" &&
        role !== "recovery-candidate")
    ) {
      return null;
    }
    const transactionId =
      validateCredentialTransactionId(rawTransactionId);
    return temporaryEntry(role, transactionId);
  } catch {
    return null;
  }
}

function managedEntryMaxBytes(entry: CredentialManagedEntry): number {
  if (entry.kind === "canonical" && entry.role === "transaction") {
    return MAX_CREDENTIAL_TRANSACTION_BYTES;
  }
  if (
    entry.kind === "temporary" &&
    entry.role === "transaction-candidate"
  ) {
    return MAX_CREDENTIAL_TRANSACTION_BYTES;
  }
  return MAX_CREDENTIAL_DOCUMENT_BYTES;
}

async function attestDirectory(
  lease: CredentialStoreMutationLease,
): Promise<DirectorySnapshot> {
  const value = await callAdapter(() => lease.attestDirectory());
  return secureDirectorySnapshot(value) ?? unsafeStore();
}

async function assertLeaseHeld(session: LeaseSession): Promise<void> {
  const renewed = await callAdapter(() => session.lease.renew());
  try {
    if (
      !isRecord(renewed) ||
      !hasExactKeys(renewed, ["status"]) ||
      renewed.status !== "held"
    ) {
      if (
        isRecord(renewed) &&
        hasExactKeys(renewed, ["status"]) &&
        renewed.status === "lost"
      ) {
        return leaseLost();
      }
      return storeUnavailable();
    }
  } catch (error) {
    if (error === LEASE_LOST) {
      throw error;
    }
    return storeUnavailable();
  }
  const current = await attestDirectory(session.lease);
  if (!identitiesEqual(current.identity, session.directory.identity)) {
    return unsafeStore();
  }
}

function inspectedObservation(value: unknown):
  | Readonly<{
      status: "missing";
      snapshot: CredentialMissingEntrySnapshot;
    }>
  | Readonly<{
      status: "opened";
      observation: OpenedObservation;
    }>
  | Readonly<{ status: "invalid"; possibleFile: unknown }> {
  const possibleFile = possibleProperty(value, "file");
  try {
    if (!isRecord(value)) {
      return Object.freeze({ status: "invalid", possibleFile });
    }
    const status = value.status;
    const snapshot = value.snapshot;
    const attestation = value.attestation;
    if (
      status === "missing" &&
      hasExactKeys(value, ["status", "snapshot"]) &&
      isOpaqueSnapshot(snapshot)
    ) {
      return Object.freeze({
        status: "missing",
        snapshot: snapshot as CredentialMissingEntrySnapshot,
      });
    }
    if (
      status === "opened" &&
      hasExactKeys(value, ["status", "snapshot", "attestation", "file"]) &&
      isOpaqueSnapshot(snapshot) &&
      isReadHandle(possibleFile)
    ) {
      return Object.freeze({
        status: "opened",
        observation: Object.freeze({
          snapshot: snapshot as CredentialPresentEntrySnapshot,
          attestation: attestation as CredentialFileAttestation,
          file: possibleFile,
        }),
      });
    }
    return Object.freeze({ status: "invalid", possibleFile });
  } catch {
    return Object.freeze({ status: "invalid", possibleFile });
  }
}

function inspectedBoundedRead(value: unknown): BoundedCredentialRead | null {
  try {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ["bytes", "endOfFile"]) ||
      !(value.bytes instanceof Uint8Array) ||
      typeof value.endOfFile !== "boolean"
    ) {
      return null;
    }
    return Object.freeze({
      bytes: value.bytes,
      endOfFile: value.endOfFile,
    });
  } catch {
    return null;
  }
}

async function readOpenedEntry(
  session: LeaseSession,
  opened: OpenedObservation,
  maxBytes: number,
): Promise<Uint8Array> {
  let operationError: unknown;
  let bytes: Uint8Array | undefined;
  let result: Uint8Array | undefined;
  try {
    const initial = secureFileSnapshot(
      opened.attestation,
      session.directory.identity,
      maxBytes,
    );
    if (initial === "too-large") {
      return documentTooLarge();
    }
    if (initial === null) {
      return unsafeStore();
    }
    const beforeValue = await callAdapter(() => opened.file.attest());
    const before = secureFileSnapshot(
      beforeValue,
      session.directory.identity,
      maxBytes,
    );
    if (before === "too-large") {
      return documentTooLarge();
    }
    if (before === null || !fileSnapshotsEqual(initial, before)) {
      return unsafeStore();
    }
    const rawRead = await callAdapter(() =>
      opened.file.readBounded(
        Object.freeze({ maxBytes: maxBytes + 1 }),
      ),
    );
    const bounded = inspectedBoundedRead(rawRead);
    if (bounded === null) {
      return storeUnavailable();
    }
    bytes = copyBytes(bounded.bytes) ?? storeUnavailable();
    if (bytes.byteLength > maxBytes + 1) {
      return storeUnavailable();
    }
    const afterValue = await callAdapter(() => opened.file.attest());
    const after = secureFileSnapshot(
      afterValue,
      session.directory.identity,
      maxBytes,
    );
    if (
      after === "too-large" ||
      after === null ||
      !fileSnapshotsEqual(before, after) ||
      !bounded.endOfFile ||
      bytes.byteLength > maxBytes ||
      bytes.byteLength !== before.size
    ) {
      return unsafeStore();
    }
    result = bytes;
    bytes = undefined;
  } catch (error) {
    operationError = error;
  } finally {
    if (bytes !== undefined) {
      wipeBytes(bytes);
    }
    try {
      await closeReadHandle(opened.file);
    } catch (closeError) {
      operationError = closeError;
    }
  }
  if (operationError instanceof CredentialError) {
    if (result !== undefined) {
      wipeBytes(result);
    }
    throw operationError;
  }
  if (operationError !== undefined || result === undefined) {
    if (result !== undefined) {
      wipeBytes(result);
    }
    return storeUnavailable();
  }
  return result;
}

async function readManagedEntry(
  session: LeaseSession,
  entry: CredentialManagedEntry,
  maxBytes = managedEntryMaxBytes(entry),
): Promise<ManagedEntryRead> {
  await assertLeaseHeld(session);
  const raw = await callAdapter(() => session.lease.observeEntry(entry));
  const inspected = inspectedObservation(raw);
  if (inspected.status === "invalid") {
    return closeMalformedReadHandle(inspected.possibleFile);
  }
  if (inspected.status === "missing") {
    return Object.freeze({
      status: "missing",
      snapshot: inspected.snapshot,
    });
  }
  const bytes = await readOpenedEntry(
    session,
    inspected.observation,
    maxBytes,
  );
  try {
    await assertLeaseHeld(session);
    return Object.freeze({
      status: "loaded",
      snapshot: inspected.observation.snapshot,
      bytes,
    });
  } catch (error) {
    wipeBytes(bytes);
    throw error;
  }
}

async function inspectManagedEntryForRemoval(
  session: LeaseSession,
  entry: CredentialManagedEntry,
): Promise<
  | Readonly<{ status: "missing" }>
  | Readonly<{
      status: "present";
      snapshot: CredentialPresentEntrySnapshot;
    }>
> {
  await assertLeaseHeld(session);
  const raw = await callAdapter(() => session.lease.observeEntry(entry));
  const inspected = inspectedObservation(raw);
  if (inspected.status === "invalid") {
    return closeMalformedReadHandle(inspected.possibleFile);
  }
  if (inspected.status === "missing") {
    return Object.freeze({ status: "missing" });
  }

  let operationError: unknown;
  try {
    const initial = secureFileSnapshot(
      inspected.observation.attestation,
      session.directory.identity,
      managedEntryMaxBytes(entry),
    );
    if (initial === "too-large" || initial === null) {
      return unsafeStore();
    }
    const current = secureFileSnapshot(
      await callAdapter(() => inspected.observation.file.attest()),
      session.directory.identity,
      managedEntryMaxBytes(entry),
    );
    if (
      current === "too-large" ||
      current === null ||
      !fileSnapshotsEqual(initial, current)
    ) {
      return unsafeStore();
    }
  } catch (error) {
    operationError = error;
  } finally {
    try {
      await closeReadHandle(inspected.observation.file);
    } catch (closeError) {
      operationError = closeError;
    }
  }
  if (operationError !== undefined) {
    if (operationError instanceof CredentialError) {
      throw operationError;
    }
    return storeUnavailable();
  }
  return Object.freeze({
    status: "present",
    snapshot: inspected.observation.snapshot,
  });
}

async function writeCreatedTemporary(
  session: LeaseSession,
  file: CredentialFileExclusiveWriteHandle,
  bytes: Uint8Array,
  maxBytes: number,
): Promise<void> {
  let operationError: unknown;
  let ownedBytes: Uint8Array | undefined;
  try {
    const beforeValue = await callAdapter(() => file.attest());
    const before = secureFileSnapshot(
      beforeValue,
      session.directory.identity,
      maxBytes,
    );
    if (before === "too-large" || before === null || before.size !== 0) {
      return unsafeStore();
    }
    ownedBytes = copyBytes(bytes) ?? storeUnavailable();
    await callAdapter(() => file.writeAll(ownedBytes as Uint8Array));
    wipeBytes(ownedBytes);
    ownedBytes = undefined;
    await callAdapter(() => file.sync());
    const afterValue = await callAdapter(() => file.attest());
    const after = secureFileSnapshot(
      afterValue,
      session.directory.identity,
      maxBytes,
    );
    if (
      after === "too-large" ||
      after === null ||
      !identitiesEqual(before.identity, after.identity) ||
      !identitiesEqual(before.parentIdentity, after.parentIdentity) ||
      before.revision === after.revision ||
      after.size !== bytes.byteLength
    ) {
      return unsafeStore();
    }
  } catch (error) {
    operationError = error;
  } finally {
    if (ownedBytes !== undefined) {
      wipeBytes(ownedBytes);
    }
    try {
      await closeWriteHandle(file);
    } catch (closeError) {
      operationError = closeError;
    }
  }
  if (operationError !== undefined) {
    if (operationError instanceof CredentialError) {
      throw operationError;
    }
    return storeUnavailable();
  }
}

async function createVerifiedTemporary(
  session: LeaseSession,
  entry: CredentialTemporaryEntry,
  bytes: Uint8Array,
): Promise<CredentialPresentEntrySnapshot> {
  const maxBytes = managedEntryMaxBytes(entry);
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    return storeUnavailable();
  }
  const observed = await readManagedEntry(session, entry, maxBytes);
  if (observed.status === "loaded") {
    wipeBytes(observed.bytes);
    return storeConflict();
  }

  const rawCreate = await callAdapter(() =>
    session.lease.createTemporaryExclusive(
      Object.freeze({
        entry,
        expected: observed.snapshot,
      }),
    ),
  );
  const possibleFile = possibleProperty(rawCreate, "file");
  let file: CredentialFileExclusiveWriteHandle;
  try {
    if (
      !isRecord(rawCreate) ||
      (rawCreate.status === "conflict" &&
        !hasExactKeys(rawCreate, ["status"]))
    ) {
      return closeMalformedWriteHandle(possibleFile);
    }
    if (rawCreate.status === "conflict") {
      return storeConflict();
    }
    if (
      rawCreate.status !== "created" ||
      !hasExactKeys(rawCreate, ["status", "file"]) ||
      !isWriteHandle(possibleFile)
    ) {
      return closeMalformedWriteHandle(possibleFile);
    }
    file = possibleFile;
  } catch {
    return closeMalformedWriteHandle(possibleFile);
  }

  await writeCreatedTemporary(session, file, bytes, maxBytes);
  const verified = await readManagedEntry(session, entry, maxBytes);
  if (verified.status === "missing") {
    return recoveryRequired();
  }
  try {
    if (!bytesEqual(verified.bytes, bytes)) {
      return unsafeStore();
    }
    return verified.snapshot;
  } finally {
    wipeBytes(verified.bytes);
  }
}

async function syncDirectory(session: LeaseSession): Promise<void> {
  await callAdapter(() => session.lease.syncDirectory());
  await assertLeaseHeld(session);
}

async function moveTemporary(
  session: LeaseSession,
  source: CredentialTemporaryEntry,
  expectedSource: CredentialPresentEntrySnapshot,
  destination: CredentialCanonicalEntry,
  expectedDestination: CredentialEntrySnapshot,
): Promise<void> {
  const result = await callAdapter(() =>
    session.lease.moveTemporaryConditionally(
      Object.freeze({
        source,
        expectedSource,
        destination,
        expectedDestination,
      }),
    ),
  );
  try {
    if (
      !isRecord(result) ||
      !hasExactKeys(result, ["status"]) ||
      (result.status !== "moved" && result.status !== "conflict")
    ) {
      return storeUnavailable();
    }
    if (result.status === "conflict") {
      return storeConflict();
    }
  } catch {
    return storeUnavailable();
  }
}

async function removeEntry(
  session: LeaseSession,
  entry: CredentialManagedEntry,
  expected: CredentialPresentEntrySnapshot,
): Promise<void> {
  const result = await callAdapter(() =>
    session.lease.removeConditionally(
      Object.freeze({ entry, expected }),
    ),
  );
  try {
    if (
      !isRecord(result) ||
      !hasExactKeys(result, ["status"]) ||
      (result.status !== "removed" && result.status !== "conflict")
    ) {
      return storeUnavailable();
    }
    if (result.status === "conflict") {
      return storeConflict();
    }
  } catch {
    return storeUnavailable();
  }
}

async function cleanupTemporaryEntries(session: LeaseSession): Promise<void> {
  await assertLeaseHeld(session);
  const rawEntries = await callAdapter(() =>
    session.lease.listTemporaryEntries(),
  );
  let entries: readonly CredentialTemporaryEntry[];
  try {
    if (!Array.isArray(rawEntries) || !Object.isFrozen(rawEntries)) {
      return storeUnavailable();
    }
    const copied: CredentialTemporaryEntry[] = [];
    const seen = new Set<string>();
    for (const value of rawEntries) {
      const entry = validateTemporaryEntry(value);
      if (entry === null || !Object.isFrozen(value)) {
        return storeUnavailable();
      }
      const key = `${entry.role}:${entry.transactionId}`;
      if (seen.has(key)) {
        return storeUnavailable();
      }
      seen.add(key);
      copied.push(entry);
    }
    entries = Object.freeze(copied);
  } catch {
    return storeUnavailable();
  }

  let removed = false;
  for (const entry of entries) {
    const observation = await inspectManagedEntryForRemoval(session, entry);
    if (observation.status === "present") {
      await removeEntry(session, entry, observation.snapshot);
      removed = true;
    }
  }
  if (removed) {
    await syncDirectory(session);
  }
}

function transactionBytes(
  transaction: CredentialReplaceTransactionV1,
  originPolicy: ApiOriginPolicy,
): Uint8Array {
  try {
    return serializeCredentialTransactionDocumentBytes(
      transaction,
      originPolicy,
    );
  } catch (error) {
    if (error instanceof CredentialError) {
      throw error;
    }
    return storeUnavailable();
  }
}

async function installTransaction(
  session: LeaseSession,
  transaction: CredentialReplaceTransactionV1,
  originPolicy: ApiOriginPolicy,
): Promise<void> {
  const bytes = transactionBytes(transaction, originPolicy);
  const candidate = temporaryEntry(
    "transaction-candidate",
    transaction.transaction_id,
  );
  try {
    const source = await createVerifiedTemporary(session, candidate, bytes);
    const destination = await readManagedEntry(
      session,
      TRANSACTION_ENTRY,
      MAX_CREDENTIAL_TRANSACTION_BYTES,
    );
    if (destination.status === "loaded") {
      wipeBytes(destination.bytes);
      return recoveryRequired();
    }
    await moveTemporary(
      session,
      candidate,
      source,
      TRANSACTION_ENTRY,
      destination.snapshot,
    );
    await syncDirectory(session);
    const installed = await readManagedEntry(
      session,
      TRANSACTION_ENTRY,
      MAX_CREDENTIAL_TRANSACTION_BYTES,
    );
    if (installed.status === "missing") {
      return recoveryRequired();
    }
    try {
      if (!bytesEqual(installed.bytes, bytes)) {
        return unsafeStore();
      }
      parseCredentialTransactionDocumentBytes(
        installed.bytes,
        originPolicy,
      );
    } finally {
      wipeBytes(installed.bytes);
    }
  } finally {
    wipeBytes(bytes);
  }
}

function credentialBytes(
  credential: CredentialV1,
  originPolicy: ApiOriginPolicy,
): Uint8Array {
  try {
    return new TextEncoder().encode(
      serializeCredentialDocument(credential, originPolicy),
    );
  } catch (error) {
    if (error instanceof CredentialError) {
      throw error;
    }
    return storeUnavailable();
  }
}

async function readCredential(
  session: LeaseSession,
  originPolicy: ApiOriginPolicy,
): Promise<
  | Readonly<{
      status: "missing";
      snapshot: CredentialMissingEntrySnapshot;
    }>
  | Readonly<{
      status: "loaded";
      snapshot: CredentialPresentEntrySnapshot;
      credential: CredentialV1;
      bytes: Uint8Array;
    }>
> {
  const result = await readManagedEntry(
    session,
    CREDENTIAL_ENTRY,
    MAX_CREDENTIAL_DOCUMENT_BYTES,
  );
  if (result.status === "missing") {
    return result;
  }
  try {
    const credential = parseCredentialDocumentBytes(
      result.bytes,
      originPolicy,
    );
    return Object.freeze({
      status: "loaded",
      snapshot: result.snapshot,
      credential,
      bytes: result.bytes,
    });
  } catch (error) {
    wipeBytes(result.bytes);
    throw error;
  }
}

async function removeTransactionLast(
  session: LeaseSession,
  expectedBytes: Uint8Array,
): Promise<void> {
  const current = await readManagedEntry(
    session,
    TRANSACTION_ENTRY,
    MAX_CREDENTIAL_TRANSACTION_BYTES,
  );
  if (current.status === "missing") {
    return recoveryRequired();
  }
  try {
    if (!bytesEqual(current.bytes, expectedBytes)) {
      return storeConflict();
    }
    await removeEntry(session, TRANSACTION_ENTRY, current.snapshot);
  } finally {
    wipeBytes(current.bytes);
  }
  await syncDirectory(session);
}

async function verifyCredentialState(
  session: LeaseSession,
  expected: Uint8Array | null,
  originPolicy: ApiOriginPolicy,
): Promise<void> {
  const current = await readCredential(session, originPolicy);
  if (expected === null) {
    if (current.status === "loaded") {
      wipeBytes(current.bytes);
      return recoveryRequired();
    }
    return;
  }
  if (current.status === "missing") {
    return recoveryRequired();
  }
  try {
    if (!bytesEqual(current.bytes, expected)) {
      return storeConflict();
    }
  } finally {
    wipeBytes(current.bytes);
  }
}

async function rollbackInstalledCredential(
  session: LeaseSession,
  transaction: CredentialReplaceTransactionV1,
  transactionBytesValue: Uint8Array,
  target: Extract<Awaited<ReturnType<typeof readCredential>>, { status: "loaded" }>,
  originPolicy: ApiOriginPolicy,
): Promise<void> {
  const afterBytes = credentialBytes(transaction.after, originPolicy);
  try {
    if (!bytesEqual(target.bytes, afterBytes)) {
      return storeConflict();
    }
  } finally {
    wipeBytes(afterBytes);
    wipeBytes(target.bytes);
  }

  /*
   * A previous process may have durably synced a candidate before dying.
   * The journal embeds the complete rollback state, so those exact managed
   * remnants are unnecessary and must be removed before creating a fresh
   * recovery candidate. Re-observe the target afterwards because cleanup
   * invalidates directory-generation-scoped snapshots.
   */
  await cleanupTemporaryEntries(session);

  if (transaction.before === null) {
    const currentTarget = await readCredential(session, originPolicy);
    if (currentTarget.status === "missing") {
      return recoveryRequired();
    }
    try {
      const expectedAfter = credentialBytes(
        transaction.after,
        originPolicy,
      );
      try {
        if (!bytesEqual(currentTarget.bytes, expectedAfter)) {
          return storeConflict();
        }
      } finally {
        wipeBytes(expectedAfter);
      }
      await removeEntry(
        session,
        CREDENTIAL_ENTRY,
        currentTarget.snapshot,
      );
    } finally {
      wipeBytes(currentTarget.bytes);
    }
    await syncDirectory(session);
    await verifyCredentialState(session, null, originPolicy);
  } else {
    const beforeBytes = credentialBytes(transaction.before, originPolicy);
    const recovery = temporaryEntry(
      "recovery-candidate",
      transaction.transaction_id,
    );
    try {
      const source = await createVerifiedTemporary(
        session,
        recovery,
        beforeBytes,
      );
      const currentTarget = await readCredential(session, originPolicy);
      if (currentTarget.status === "missing") {
        return recoveryRequired();
      }
      try {
        const currentAfter = credentialBytes(transaction.after, originPolicy);
        try {
          if (!bytesEqual(currentTarget.bytes, currentAfter)) {
            return storeConflict();
          }
        } finally {
          wipeBytes(currentAfter);
        }
        await moveTemporary(
          session,
          recovery,
          source,
          CREDENTIAL_ENTRY,
          currentTarget.snapshot,
        );
      } finally {
        wipeBytes(currentTarget.bytes);
      }
      await syncDirectory(session);
      await verifyCredentialState(session, beforeBytes, originPolicy);
    } finally {
      wipeBytes(beforeBytes);
    }
  }

  await removeTransactionLast(session, transactionBytesValue);
}

async function recoverWithinLease(
  session: LeaseSession,
  originPolicy: ApiOriginPolicy,
): Promise<CredentialStoreRecoveryResult> {
  const journal = await readManagedEntry(
    session,
    TRANSACTION_ENTRY,
    MAX_CREDENTIAL_TRANSACTION_BYTES,
  );
  if (journal.status === "missing") {
    await cleanupTemporaryEntries(session);
    /*
     * A prior conditional journal removal may have applied even though its
     * directory-sync acknowledgement was lost. Persist the observed absence
     * before reporting a clean store so a later crash cannot resurrect the
     * rollback authority.
     */
    await syncDirectory(session);
    return CLEAN;
  }

  let transaction: CredentialReplaceTransactionV1;
  try {
    transaction = parseCredentialTransactionDocumentBytes(
      journal.bytes,
      originPolicy,
    );
  } catch (error) {
    wipeBytes(journal.bytes);
    throw error;
  }

  let target:
    | Awaited<ReturnType<typeof readCredential>>
    | undefined;
  let beforeBytes: Uint8Array | null | undefined;
  let afterBytes: Uint8Array | undefined;
  try {
    target = await readCredential(session, originPolicy);
    beforeBytes =
      transaction.before === null
        ? null
        : credentialBytes(transaction.before, originPolicy);
    afterBytes = credentialBytes(transaction.after, originPolicy);
    const targetIsBefore =
      beforeBytes === null
        ? target.status === "missing"
        : target.status === "loaded" &&
          bytesEqual(target.bytes, beforeBytes);
    if (targetIsBefore) {
      if (target.status === "loaded") {
        wipeBytes(target.bytes);
      }
      await cleanupTemporaryEntries(session);
      await removeTransactionLast(session, journal.bytes);
      return ROLLED_BACK;
    }

    if (
      target.status === "missing" ||
      !bytesEqual(target.bytes, afterBytes)
    ) {
      if (target.status === "loaded") {
        wipeBytes(target.bytes);
      }
      return storeConflict();
    }

    await rollbackInstalledCredential(
      session,
      transaction,
      journal.bytes,
      target,
      originPolicy,
    );
    return ROLLED_BACK;
  } finally {
    if (beforeBytes !== null && beforeBytes !== undefined) {
      wipeBytes(beforeBytes);
    }
    if (afterBytes !== undefined) {
      wipeBytes(afterBytes);
    }
    if (target?.status === "loaded") {
      wipeBytes(target.bytes);
    }
    wipeBytes(journal.bytes);
  }
}

function prepareDirectory(
  locations: Pick<CredentialLocations, "directory">,
): string {
  try {
    const directory = locations.directory;
    return typeof directory === "string" && directory.length > 0
      ? `${directory}`
      : storeUnavailable();
  } catch {
    return storeUnavailable();
  }
}

function prepareUuid(random: Pick<RandomAdapter, "uuid">): string {
  try {
    const value = random.uuid();
    return typeof value === "string" && UUID_V4.test(value)
      ? value
      : storeUnavailable();
  } catch {
    return storeUnavailable();
  }
}

function prepareLease(
  dependencies: CredentialStoreRecoveryDependencies,
  locations: Pick<CredentialLocations, "directory">,
): PreparedLease {
  try {
    const storage = dependencies.storage;
    const random = dependencies.random;
    if (!isMutationAdapter(storage)) {
      return storeUnavailable();
    }
    const directory = prepareDirectory(locations);
    const nonce = prepareUuid(random) as CredentialSetupLeaseNonce;
    return Object.freeze({ storage, directory, nonce });
  } catch {
    return storeUnavailable();
  }
}

function prepareTimestamp(clock: ClockAdapter): CanonicalTimestamp {
  try {
    const milliseconds = clock.now();
    if (!Number.isFinite(milliseconds)) {
      return storeUnavailable();
    }
    return new Date(milliseconds).toISOString() as CanonicalTimestamp;
  } catch {
    return storeUnavailable();
  }
}

function prepareTransitionTimestamp(
  clock: ClockAdapter,
  notBefore: CanonicalTimestamp,
): CanonicalTimestamp {
  const timestamp = prepareTimestamp(clock);
  return timestamp < notBefore ? notBefore : timestamp;
}

function prepareWriteAt(
  dependencies: CredentialStoreWriterDependencies,
  input: CredentialV1,
  originPolicy: ApiOriginPolicy,
  createdAt: CanonicalTimestamp,
  preparedTransactionId?: ReturnType<
    typeof validateCredentialTransactionId
  >,
): PreparedWrite {
  let credentialBytesValue: Uint8Array | undefined;
  let succeeded = false;
  try {
    const random = dependencies.random;
    const credential = validateCredentialDocument(input, originPolicy);
    credentialBytesValue = credentialBytes(credential, originPolicy);
    const prepared = Object.freeze({
      transactionId:
        preparedTransactionId ??
        validateCredentialTransactionId(prepareUuid(random)),
      createdAt,
      credential,
      credentialBytes: credentialBytesValue,
    });
    succeeded = true;
    return prepared;
  } catch (error) {
    if (error instanceof CredentialError) {
      throw error;
    }
    return storeUnavailable();
  } finally {
    if (!succeeded && credentialBytesValue !== undefined) {
      wipeBytes(credentialBytesValue);
    }
  }
}

function prepareWrite(
  dependencies: CredentialStoreWriterDependencies,
  input: CredentialV1,
  originPolicy: ApiOriginPolicy,
): PreparedWrite {
  const transactionId = validateCredentialTransactionId(
    prepareUuid(dependencies.random),
  );
  const createdAt = prepareTimestamp(dependencies.clock);
  return prepareWriteAt(
    dependencies,
    input,
    originPolicy,
    createdAt,
    transactionId,
  );
}

function inspectAcquireResult(value: unknown):
  | Readonly<{ status: "busy" }>
  | Readonly<{
      status: "acquired";
      lease: CredentialStoreMutationLease;
    }>
  | Readonly<{ status: "invalid"; possibleLease: unknown }> {
  const possibleLease = possibleProperty(value, "lease");
  try {
    if (!isRecord(value)) {
      return Object.freeze({ status: "invalid", possibleLease });
    }
    if (
      value.status === "busy" &&
      hasExactKeys(value, ["status"])
    ) {
      return Object.freeze({ status: "busy" });
    }
    if (
      value.status === "acquired" &&
      hasExactKeys(value, [
        "status",
        "priorLease",
        "directory",
        "lease",
      ]) &&
      (value.priorLease === "absent" ||
        value.priorLease === "proven-abandoned") &&
      (value.directory === "created" || value.directory === "existing") &&
      isLease(possibleLease)
    ) {
      return Object.freeze({ status: "acquired", lease: possibleLease });
    }
    return Object.freeze({ status: "invalid", possibleLease });
  } catch {
    return Object.freeze({ status: "invalid", possibleLease });
  }
}

async function runTransactionalWrite(
  session: LeaseSession,
  prepared: PreparedWrite,
  originPolicy: ApiOriginPolicy,
  current: Awaited<ReturnType<typeof readCredential>>,
): Promise<CredentialStoreWriteResult> {
  const transaction: CredentialReplaceTransactionV1 = Object.freeze({
    schema_version: CREDENTIAL_TRANSACTION_SCHEMA_VERSION,
    kind: CREDENTIAL_TRANSACTION_KIND,
    transaction_id: prepared.transactionId,
    created_at: prepared.createdAt,
    before: current.status === "missing" ? null : current.credential,
    after: prepared.credential,
  });

  try {
    await installTransaction(session, transaction, originPolicy);

    const candidate = temporaryEntry(
      "credential-candidate",
      prepared.transactionId,
    );
    const source = await createVerifiedTemporary(
      session,
      candidate,
      prepared.credentialBytes,
    );
    const destination = await readCredential(session, originPolicy);
    try {
      let expectedBefore: boolean;
      if (transaction.before === null) {
        expectedBefore = destination.status === "missing";
      } else if (destination.status === "loaded") {
        const expectedBytes = credentialBytes(
          transaction.before,
          originPolicy,
        );
        try {
          expectedBefore = bytesEqual(
            destination.bytes,
            expectedBytes,
          );
        } finally {
          wipeBytes(expectedBytes);
        }
      } else {
        expectedBefore = false;
      }
      if (!expectedBefore) {
        return storeConflict();
      }
    } finally {
      if (destination.status === "loaded") {
        wipeBytes(destination.bytes);
      }
    }

    await moveTemporary(
      session,
      candidate,
      source,
      CREDENTIAL_ENTRY,
      destination.snapshot,
    );
    await syncDirectory(session);
    await verifyCredentialState(
      session,
      prepared.credentialBytes,
      originPolicy,
    );
    await cleanupTemporaryEntries(session);
    const installedTransaction = transactionBytes(
      transaction,
      originPolicy,
    );
    try {
      await removeTransactionLast(session, installedTransaction);
    } finally {
      wipeBytes(installedTransaction);
    }
    return WRITTEN;
  } catch (error) {
    if (error === LEASE_LOST) {
      throw error;
    }
    /*
     * The journal remains the authority until its durable removal. Try to
     * restore the prior state immediately; if that cannot be proven, retain
     * recovery material and report that manual progress must stop.
     */
    try {
      await recoverWithinLease(session, originPolicy);
    } catch {
      return recoveryRequired();
    }
    if (error instanceof CredentialError) {
      throw error;
    }
    return storeUnavailable();
  }
}

async function withLease<T>(
  storage: CredentialStoreMutationAdapter,
  prepared: PreparedLease,
  operation: (session: LeaseSession) => Promise<T>,
): Promise<T> {
  const rawAcquire = await callAdapter(() =>
    storage.acquireSetupLease(
      prepared.directory,
      Object.freeze({
        ...ACQUIRE_OPTIONS_BASE,
        nonce: prepared.nonce,
      }),
    ),
  );
  const acquired = inspectAcquireResult(rawAcquire);
  if (acquired.status === "invalid") {
    return abandonMalformedLease(acquired.possibleLease);
  }
  if (acquired.status === "busy") {
    return storeBusy();
  }

  let operationError: unknown;
  let result: T | undefined;
  try {
    const directory = await attestDirectory(acquired.lease);
    const session = Object.freeze({
      lease: acquired.lease,
      directory,
    });
    await assertLeaseHeld(session);
    result = await operation(session);
  } catch (error) {
    operationError = error;
  }

  try {
    if (operationError === LEASE_LOST) {
      await callAdapter(() => acquired.lease.abandon());
    } else {
      await callAdapter(() => acquired.lease.release());
    }
  } catch (releaseError) {
    operationError = releaseError;
  }

  if (operationError !== undefined) {
    if (operationError === LEASE_LOST) {
      return recoveryRequired();
    }
    if (operationError instanceof CredentialError) {
      throw operationError;
    }
    return storeUnavailable();
  }
  return result as T;
}

function preparePendingCredential(
  factory: (createdAt: CanonicalTimestamp) => PendingCredentialV1,
  createdAt: CanonicalTimestamp,
  originPolicy: ApiOriginPolicy,
): PendingCredentialV1 {
  let input: CredentialV1;
  try {
    input = factory(createdAt);
  } catch (error) {
    if (error instanceof CredentialError) {
      throw error;
    }
    return storeUnavailable();
  }

  const credential = validateCredentialDocument(input, originPolicy);
  if (
    credential.state !== "pending" ||
    credential.created_at !== createdAt ||
    credential.updated_at !== createdAt
  ) {
    return storeUnavailable();
  }
  return credential;
}

interface VerifiedRegistrationAgentSnapshot {
  readonly id: string;
  readonly name: string;
  readonly username: string | null;
}

function snapshotVerifiedRegistrationAgent(
  value: VerifiedRegistrationAgent,
): VerifiedRegistrationAgentSnapshot {
  try {
    const id = value.id;
    const name = value.name;
    const username = value.username;
    if (
      typeof id !== "string" ||
      typeof name !== "string" ||
      (username !== null && typeof username !== "string")
    ) {
      return storeConflict();
    }
    return Object.freeze({ id, name, username });
  } catch {
    return storeConflict();
  }
}

function verifiedAgentMatchesPending(
  agent: VerifiedRegistrationAgentSnapshot,
  pending: PendingCredentialV1,
): boolean {
  return (
    agent.name === pending.agent_name &&
    agent.username === pending.username
  );
}

function alreadyActiveEquivalent(
  active: ActiveCredentialV1,
  pending: PendingCredentialV1,
  agent: VerifiedRegistrationAgentSnapshot,
): boolean {
  return (
    verifiedAgentMatchesPending(agent, pending) &&
    active.api_origin === pending.api_origin &&
    active.api_key === pending.api_key &&
    active.agent_id === agent.id &&
    active.agent_name === agent.name &&
    active.username === agent.username &&
    active.registration_request_id === pending.registration_request_id &&
    active.created_at === pending.created_at &&
    active.activated_at === active.updated_at
  );
}

function createActivatedCredential(
  pending: PendingCredentialV1,
  agent: VerifiedRegistrationAgentSnapshot,
  activatedAt: CanonicalTimestamp,
  originPolicy: ApiOriginPolicy,
): ActiveCredentialV1 {
  if (!verifiedAgentMatchesPending(agent, pending)) {
    return storeConflict();
  }
  try {
    const credential = validateCredentialDocument(
      {
        schema_version: pending.schema_version,
        state: "active",
        api_origin: pending.api_origin,
        api_key: pending.api_key,
        agent_id: agent.id,
        agent_name: pending.agent_name,
        username: pending.username,
        registration_request_id: pending.registration_request_id,
        created_at: pending.created_at,
        updated_at: activatedAt,
        activated_at: activatedAt,
      },
      originPolicy,
    );
    return credential.state === "active" ? credential : storeConflict();
  } catch {
    return storeConflict();
  }
}

async function readOrCreatePendingWithinLease(
  session: LeaseSession,
  dependencies: CredentialStoreWriterDependencies,
  factory: (createdAt: CanonicalTimestamp) => PendingCredentialV1,
  originPolicy: ApiOriginPolicy,
): Promise<CredentialRegistrationReadResult> {
  const current = await readCredential(session, originPolicy);
  if (current.status === "loaded") {
    try {
      return current.credential.state === "pending"
        ? Object.freeze({
            status: "pending-resumed" as const,
            credential: current.credential,
          })
        : Object.freeze({
            status: "existing-active" as const,
            credential: current.credential,
          });
    } finally {
      wipeBytes(current.bytes);
    }
  }

  const createdAt = prepareTimestamp(dependencies.clock);
  const pending = preparePendingCredential(factory, createdAt, originPolicy);
  const prepared = prepareWriteAt(
    dependencies,
    pending,
    originPolicy,
    createdAt,
  );
  try {
    const result = await runTransactionalWrite(
      session,
      prepared,
      originPolicy,
      current,
    );
    if (result.status !== "written") {
      return storeUnavailable();
    }
    return Object.freeze({
      status: "pending-created" as const,
      credential: pending,
    });
  } finally {
    wipeBytes(prepared.credentialBytes);
  }
}

async function activateExactPendingWithinLease(
  session: LeaseSession,
  dependencies: CredentialStoreWriterDependencies,
  expectedInput: PendingCredentialV1,
  verifiedAgentInput: VerifiedRegistrationAgent,
  originPolicy: ApiOriginPolicy,
): Promise<CredentialRegistrationActivationResult> {
  const expectedCredential = validateCredentialDocument(
    expectedInput,
    originPolicy,
  );
  if (expectedCredential.state !== "pending") {
    return storeConflict();
  }
  const agent = snapshotVerifiedRegistrationAgent(verifiedAgentInput);
  if (!verifiedAgentMatchesPending(agent, expectedCredential)) {
    return storeConflict();
  }
  const expectedBytes = credentialBytes(expectedCredential, originPolicy);
  let current:
    | Awaited<ReturnType<typeof readCredential>>
    | undefined;
  try {
    current = await readCredential(session, originPolicy);
    if (current.status === "missing") {
      return storeConflict();
    }
    if (current.credential.state === "active") {
      if (
        !alreadyActiveEquivalent(
          current.credential,
          expectedCredential,
          agent,
        )
      ) {
        return storeConflict();
      }
      return Object.freeze({
        status: "already-active" as const,
        credential: current.credential,
      });
    }
    if (!bytesEqual(current.bytes, expectedBytes)) {
      return storeConflict();
    }

    const activatedAt = prepareTransitionTimestamp(
      dependencies.clock,
      expectedCredential.updated_at,
    );
    const active = createActivatedCredential(
      expectedCredential,
      agent,
      activatedAt,
      originPolicy,
    );
    const prepared = prepareWriteAt(
      dependencies,
      active,
      originPolicy,
      activatedAt,
    );
    try {
      const result = await runTransactionalWrite(
        session,
        prepared,
        originPolicy,
        current,
      );
      if (result.status !== "written") {
        return storeUnavailable();
      }
      return Object.freeze({
        status: "activated" as const,
        credential: active,
      });
    } finally {
      wipeBytes(prepared.credentialBytes);
    }
  } finally {
    wipeBytes(expectedBytes);
    if (current?.status === "loaded") {
      wipeBytes(current.bytes);
    }
  }
}

async function replaceUsernameAfterConflictWithinLease(
  session: LeaseSession,
  dependencies: CredentialStoreWriterDependencies,
  usernameInput: Username,
  requestIdFactory: () => RegistrationRequestId,
  originPolicy: ApiOriginPolicy,
): Promise<CredentialRegistrationUsernameReplacementResult> {
  let username: Username;
  try {
    username = usernameInput;
    if (typeof username !== "string") {
      return storeConflict();
    }
  } catch {
    return storeConflict();
  }

  const current = await readCredential(session, originPolicy);
  if (
    current.status === "missing" ||
    current.credential.state === "active"
  ) {
    if (current.status === "loaded") {
      wipeBytes(current.bytes);
    }
    return Object.freeze({ status: "no-pending" as const });
  }

  try {
    if (username === current.credential.username) {
      return Object.freeze({
        status: "pending-unchanged" as const,
        credential: current.credential,
      });
    }

    let registrationRequestId: RegistrationRequestId;
    try {
      registrationRequestId = requestIdFactory();
    } catch {
      return storeUnavailable();
    }
    if (
      typeof registrationRequestId !== "string" ||
      registrationRequestId ===
        current.credential.registration_request_id
    ) {
      return storeConflict();
    }

    const updatedAt = prepareTransitionTimestamp(
      dependencies.clock,
      current.credential.updated_at,
    );
    let replacement: CredentialV1;
    try {
      replacement = validateCredentialDocument(
        {
          ...current.credential,
          username,
          registration_request_id: registrationRequestId,
          updated_at: updatedAt,
        },
        originPolicy,
      );
    } catch {
      return storeConflict();
    }
    if (replacement.state !== "pending") {
      return storeConflict();
    }

    const prepared = prepareWriteAt(
      dependencies,
      replacement,
      originPolicy,
      updatedAt,
    );
    try {
      const result = await runTransactionalWrite(
        session,
        prepared,
        originPolicy,
        current,
      );
      if (result.status !== "written") {
        return storeUnavailable();
      }
      return Object.freeze({
        status: "pending-replaced" as const,
        credential: replacement,
      });
    } finally {
      wipeBytes(prepared.credentialBytes);
    }
  } finally {
    wipeBytes(current.bytes);
  }
}

async function runRegistrationCallback<T>(
  leaseSession: LeaseSession,
  dependencies: CredentialStoreWriterDependencies,
  operation: (
    session: ExclusiveCredentialRegistrationSession,
  ) => Promise<T>,
  originPolicy: ApiOriginPolicy,
): Promise<T> {
  let active = true;
  let inFlight: Promise<unknown> | undefined;
  let terminalError: unknown;

  function invoke<R>(task: () => Promise<R>): Promise<R> {
    if (!active) {
      return Promise.reject(
        new CredentialError("credential_store_unavailable"),
      );
    }
    if (inFlight !== undefined) {
      terminalError ??= new CredentialError(
        "credential_store_unavailable",
      );
      return Promise.reject(terminalError);
    }
    const pending = (async () => {
      try {
        return await task();
      } catch (error) {
        const safeError =
          error === LEASE_LOST || error instanceof CredentialError
            ? error
            : new CredentialError("credential_store_unavailable");
        terminalError ??= safeError;
        throw safeError;
      }
    })();
    inFlight = pending;
    void pending.then(
      () => {
        if (inFlight === pending) {
          inFlight = undefined;
        }
      },
      () => {
        if (inFlight === pending) {
          inFlight = undefined;
        }
      },
    );
    return pending;
  }

  const registrationSession: ExclusiveCredentialRegistrationSession =
    Object.freeze({
      readOrCreatePending(
        factory: (createdAt: CanonicalTimestamp) => PendingCredentialV1,
      ) {
        return invoke(() =>
          readOrCreatePendingWithinLease(
            leaseSession,
            dependencies,
            factory,
            originPolicy,
          ),
        );
      },
      activateExactPending(
        expected: PendingCredentialV1,
        verifiedAgent: VerifiedRegistrationAgent,
      ) {
        return invoke(() =>
          activateExactPendingWithinLease(
            leaseSession,
            dependencies,
            expected,
            verifiedAgent,
            originPolicy,
          ),
        );
      },
      replaceUsernameAfterConflict(
        username: Username,
        requestIdFactory: () => RegistrationRequestId,
      ) {
        return invoke(() =>
          replaceUsernameAfterConflictWithinLease(
            leaseSession,
            dependencies,
            username,
            requestIdFactory,
            originPolicy,
          ),
        );
      },
    });

  let callbackError: unknown;
  let result: T | undefined;
  try {
    result = await operation(registrationSession);
  } catch (error) {
    callbackError = error;
  }
  active = false;

  const abandonedOperation = inFlight;
  if (abandonedOperation !== undefined) {
    try {
      await abandonedOperation;
    } catch (error) {
      callbackError ??= error;
    }
    callbackError = terminalError ?? callbackError;
    callbackError ??= new CredentialError("credential_store_unavailable");
  }

  callbackError = terminalError ?? callbackError;
  if (callbackError !== undefined) {
    throw callbackError;
  }
  return result as T;
}

export async function recoverCredentialStore(
  dependencies: CredentialStoreRecoveryDependencies,
  locations: Pick<CredentialLocations, "directory">,
  originPolicy: ApiOriginPolicy = "https-only",
): Promise<CredentialStoreRecoveryResult> {
  const prepared = prepareLease(dependencies, locations);
  return withLease(prepared.storage, prepared, (session) =>
    recoverWithinLease(session, originPolicy),
  );
}

export async function writeCredentialStore(
  dependencies: CredentialStoreWriterDependencies,
  locations: Pick<CredentialLocations, "directory">,
  input: CredentialV1,
  originPolicy: ApiOriginPolicy = "https-only",
): Promise<CredentialStoreWriteResult> {
  const preparedLease = prepareLease(dependencies, locations);
  const prepared = prepareWrite(dependencies, input, originPolicy);
  try {
    return await withLease(
      preparedLease.storage,
      preparedLease,
      async (session) => {
        await recoverWithinLease(session, originPolicy);
        const current = await readCredential(session, originPolicy);
        if (current.status === "loaded") {
          try {
            if (bytesEqual(current.bytes, prepared.credentialBytes)) {
              return UNCHANGED;
            }
          } finally {
            wipeBytes(current.bytes);
          }
        }

        return runTransactionalWrite(
          session,
          prepared,
          originPolicy,
          current,
        );
      },
    );
  } finally {
    wipeBytes(prepared.credentialBytes);
  }
}

export async function runExclusiveCredentialRegistration<T>(
  dependencies: CredentialStoreWriterDependencies,
  locations: Pick<CredentialLocations, "directory">,
  operation: (
    session: ExclusiveCredentialRegistrationSession,
  ) => Promise<T>,
  originPolicy: ApiOriginPolicy = "https-only",
): Promise<T> {
  const prepared = prepareLease(dependencies, locations);
  return withLease(prepared.storage, prepared, async (session) => {
    await recoverWithinLease(session, originPolicy);
    return runRegistrationCallback(
      session,
      dependencies,
      operation,
      originPolicy,
    );
  });
}
