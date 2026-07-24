/*
 * Functional disk harness for sentinel-backed POSIX tests only. It is excluded
 * from dist and does not claim flock, *at syscalls, F_FULLFSYNC, ACL, or
 * cross-process abandonment proof. Promise-based O_EXCL creation is bracketed
 * by lease checks but is not a no-yield *at operation. Any pre-existing lock
 * is always busy.
 */
import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  type BigIntStats,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";

import {
  MAX_CREDENTIAL_DOCUMENT_BYTES,
} from "../../src/credentials/store-codec.js";
import {
  CREDENTIAL_STORE_ENTRY,
  type BoundedCredentialRead,
  type CredentialFileAttestation,
  type CredentialFileOpenResult,
  type CredentialFileReadHandle,
  type CredentialObjectIdentity,
  type CredentialStoreReadAdapter,
  type PrivateCredentialDirectoryHandle,
  type PrivateCredentialDirectoryOpenResult,
  type PrivateDirectoryAttestation,
} from "../../src/credentials/store-contracts.js";
import {
  CREDENTIAL_CANDIDATE_ENTRY_PREFIX,
  CREDENTIAL_RECOVERY_CANDIDATE_ENTRY_PREFIX,
  CREDENTIAL_TEMPORARY_ENTRY_SUFFIX,
  CREDENTIAL_TRANSACTION_CANDIDATE_ENTRY_PREFIX,
  CREDENTIAL_TRANSACTION_ENTRY,
  type CredentialCanonicalEntry,
  type CredentialEntrySnapshot,
  type CredentialFileExclusiveWriteHandle,
  type CredentialManagedEntry,
  type CredentialManagedEntryObservation,
  type CredentialMissingEntrySnapshot,
  type CredentialPresentEntrySnapshot,
  type CredentialSetupLeaseNonce,
  type CredentialStoreMutationAdapter,
  type CredentialStoreMutationLease,
  type CredentialTemporaryEntry,
} from "../../src/credentials/store-mutation-contracts.js";
import {
  MAX_CREDENTIAL_TRANSACTION_BYTES,
} from "../../src/credentials/store-transaction.js";
import type { CredentialLocations } from "../../src/credentials/paths.js";
import type { IsolatedTestRoot } from "./test-root.js";

export interface IsolatedPosixCredentialStore {
  readonly read: CredentialStoreReadAdapter;
  readonly mutation: CredentialStoreMutationAdapter;
}

interface SnapshotRecord {
  readonly leaseId: number;
  readonly directoryGeneration: number;
  readonly name: string;
  readonly state: "missing" | "present";
  readonly fingerprint?: string;
}

interface LeaseRecord {
  readonly id: number;
  readonly nonce: CredentialSetupLeaseNonce;
  readonly directory: FileHandle;
  readonly lock: FileHandle;
  readonly handles: Set<LeaseMintedHandle>;
  state: "held" | "lost" | "released" | "abandoned";
}

interface LeaseMintedHandle {
  invalidate(): Promise<void>;
}

interface OpenedFileState {
  readonly stats: BigIntStats;
  readonly bytes: Uint8Array;
  readonly fingerprint: string;
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const POSIX_DIRECTORY_MODE = 0o700;
const POSIX_FILE_MODE = 0o600;
const MAX_ATTESTED_BYTES =
  Math.max(
    MAX_CREDENTIAL_DOCUMENT_BYTES,
    MAX_CREDENTIAL_TRANSACTION_BYTES,
  ) + 1;
const DIRECTORY_OPEN_FLAGS =
  constants.O_RDONLY |
  constants.O_DIRECTORY |
  constants.O_NOFOLLOW;
const READ_OPEN_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW;
const LOCK_OPEN_FLAGS =
  constants.O_RDWR |
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_NOFOLLOW;
const TEMPORARY_OPEN_FLAGS =
  constants.O_RDWR |
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_NOFOLLOW;

function fixtureFailure(): never {
  throw new Error("isolated POSIX credential-store fixture failed");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isExisting(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  try {
    return Uint8Array.prototype.slice.call(bytes);
  } catch {
    return fixtureFailure();
  }
}

function wipeBytes(bytes: Uint8Array): void {
  try {
    Uint8Array.prototype.fill.call(bytes, 0);
  } catch {
    // Best effort for test-owned copies only.
  }
}

function safeNumber(value: bigint): number {
  const converted = Number(value);
  return Number.isSafeInteger(converted) ? converted : fixtureFailure();
}

function sameNode(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFileState(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return (
    sameNode(left, right) &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function identity(stats: BigIntStats): CredentialObjectIdentity {
  return Object.freeze({
    volume: stats.dev.toString(10),
    object: stats.ino.toString(10),
  });
}

function digestState(stats: BigIntStats, bytes: Uint8Array): string {
  const metadata = [
    stats.dev,
    stats.ino,
    stats.mode,
    stats.uid,
    stats.gid,
    stats.nlink,
    stats.size,
    stats.mtimeNs,
    stats.ctimeNs,
  ]
    .map((value) => value.toString(10))
    .join(":");
  const digest = createHash("sha256");
  digest.update(metadata, "utf8");
  digest.update(bytes);
  return `posix-revision-${digest.digest("hex")}`;
}

async function readOpenedBounded(
  handle: FileHandle,
  maxBytes: number,
): Promise<Uint8Array> {
  const buffer = new Uint8Array(maxBytes);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      offset,
    );
    if (result.bytesRead === 0) {
      break;
    }
    offset += result.bytesRead;
  }
  const result = buffer.slice(0, offset);
  buffer.fill(0);
  return result;
}

function readOpenedBoundedSync(
  fileDescriptor: number,
  maxBytes: number,
): Uint8Array {
  const buffer = new Uint8Array(maxBytes);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const bytesRead = readSync(
      fileDescriptor,
      buffer,
      offset,
      buffer.byteLength - offset,
      offset,
    );
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  const result = buffer.slice(0, offset);
  buffer.fill(0);
  return result;
}

async function openedFileState(handle: FileHandle): Promise<OpenedFileState> {
  const before = await handle.stat({ bigint: true });
  if (!before.isFile()) {
    return fixtureFailure();
  }
  const bytes = await readOpenedBounded(handle, MAX_ATTESTED_BYTES);
  const after = await handle.stat({ bigint: true });
  if (!sameStableFileState(before, after)) {
    wipeBytes(bytes);
    return fixtureFailure();
  }
  return Object.freeze({
    stats: after,
    bytes,
    fingerprint: digestState(after, bytes),
  });
}

function pathFileStateSync(
  target: string,
  currentUid: bigint,
): OpenedFileState | undefined {
  let descriptor: number | undefined;
  let bytes: Uint8Array | undefined;
  try {
    let pathBefore: BigIntStats;
    try {
      pathBefore = lstatSync(target, { bigint: true });
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      return fixtureFailure();
    }
    if (!secureFile(pathBefore, currentUid)) {
      return fixtureFailure();
    }
    descriptor = openSync(target, READ_OPEN_FLAGS);
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !secureFile(before, currentUid) ||
      !sameNode(before, pathBefore)
    ) {
      return fixtureFailure();
    }
    bytes = readOpenedBoundedSync(descriptor, MAX_ATTESTED_BYTES);
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(target, { bigint: true });
    if (
      !sameStableFileState(before, after) ||
      !sameNode(after, pathAfter) ||
      !secureFile(pathAfter, currentUid)
    ) {
      return fixtureFailure();
    }
    return Object.freeze({
      stats: after,
      bytes,
      fingerprint: digestState(after, bytes),
    });
  } catch (error) {
    if (bytes !== undefined) {
      wipeBytes(bytes);
    }
    if (isMissing(error)) {
      return undefined;
    }
    return fixtureFailure();
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function validateCanonicalEntry(
  input: unknown,
): CredentialCanonicalEntry {
  if (!isRecord(input) || !hasExactKeys(input, ["kind", "role", "name"])) {
    return fixtureFailure();
  }
  if (
    input.kind === "canonical" &&
    input.role === "credential" &&
    input.name === CREDENTIAL_STORE_ENTRY
  ) {
    return Object.freeze({
      kind: "canonical",
      role: "credential",
      name: CREDENTIAL_STORE_ENTRY,
    });
  }
  if (
    input.kind === "canonical" &&
    input.role === "transaction" &&
    input.name === CREDENTIAL_TRANSACTION_ENTRY
  ) {
    return Object.freeze({
      kind: "canonical",
      role: "transaction",
      name: CREDENTIAL_TRANSACTION_ENTRY,
    });
  }
  return fixtureFailure();
}

function validateTemporaryEntry(
  input: unknown,
): CredentialTemporaryEntry {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["kind", "role", "transactionId"]) ||
    input.kind !== "temporary" ||
    (input.role !== "credential-candidate" &&
      input.role !== "transaction-candidate" &&
      input.role !== "recovery-candidate") ||
    typeof input.transactionId !== "string" ||
    !UUID_V4.test(input.transactionId)
  ) {
    return fixtureFailure();
  }
  return Object.freeze({
    kind: "temporary",
    role: input.role,
    transactionId: input.transactionId,
  }) as CredentialTemporaryEntry;
}

function validateManagedEntry(input: unknown): CredentialManagedEntry {
  if (!isRecord(input)) {
    return fixtureFailure();
  }
  return input.kind === "canonical"
    ? validateCanonicalEntry(input)
    : validateTemporaryEntry(input);
}

function entryName(entry: CredentialManagedEntry): string {
  if (entry.kind === "canonical") {
    return entry.name;
  }
  const prefix =
    entry.role === "credential-candidate"
      ? CREDENTIAL_CANDIDATE_ENTRY_PREFIX
      : entry.role === "transaction-candidate"
        ? CREDENTIAL_TRANSACTION_CANDIDATE_ENTRY_PREFIX
        : CREDENTIAL_RECOVERY_CANDIDATE_ENTRY_PREFIX;
  return `${prefix}${entry.transactionId}${CREDENTIAL_TEMPORARY_ENTRY_SUFFIX}`;
}

function temporaryEntryFromName(
  name: string,
): CredentialTemporaryEntry | undefined {
  for (const [role, prefix] of [
    ["credential-candidate", CREDENTIAL_CANDIDATE_ENTRY_PREFIX],
    ["transaction-candidate", CREDENTIAL_TRANSACTION_CANDIDATE_ENTRY_PREFIX],
    ["recovery-candidate", CREDENTIAL_RECOVERY_CANDIDATE_ENTRY_PREFIX],
  ] as const) {
    if (
      name.startsWith(prefix) &&
      name.endsWith(CREDENTIAL_TEMPORARY_ENTRY_SUFFIX)
    ) {
      const transactionId = name.slice(
        prefix.length,
        -CREDENTIAL_TEMPORARY_ENTRY_SUFFIX.length,
      );
      if (UUID_V4.test(transactionId)) {
        return Object.freeze({
          kind: "temporary",
          role,
          transactionId,
        }) as CredentialTemporaryEntry;
      }
    }
  }
  return undefined;
}

function secureDirectory(
  stats: BigIntStats,
  currentUid: bigint,
): boolean {
  return (
    stats.isDirectory() &&
    stats.uid === currentUid &&
    (stats.mode & 0o7777n) === BigInt(POSIX_DIRECTORY_MODE)
  );
}

function secureFile(stats: BigIntStats, currentUid: bigint): boolean {
  return (
    stats.isFile() &&
    stats.uid === currentUid &&
    stats.nlink === 1n &&
    (stats.mode & 0o7777n) === BigInt(POSIX_FILE_MODE)
  );
}

function directoryAttestation(
  opened: BigIntStats,
  pathStats: BigIntStats,
  currentUid: bigint,
): PrivateDirectoryAttestation {
  const direct = pathStats.isDirectory();
  return Object.freeze({
    kind: "directory",
    identity: identity(opened),
    revision: digestState(opened, new Uint8Array()),
    binding:
      direct && sameNode(opened, pathStats)
        ? "canonical-current"
        : "detached",
    owner: opened.uid === currentUid ? "current-user" : "other-user",
    access:
      (opened.mode & 0o7777n) === BigInt(POSIX_DIRECTORY_MODE)
        ? "user-only"
        : "broader",
    link: direct ? "direct" : "symbolic-link",
  });
}

function fileAttestation(
  state: OpenedFileState,
  pathStats: BigIntStats,
  parentIdentity: CredentialObjectIdentity,
  currentUid: bigint,
): CredentialFileAttestation {
  const direct = pathStats.isFile();
  return Object.freeze({
    kind: "regular-file",
    identity: identity(state.stats),
    parentIdentity,
    revision: state.fingerprint,
    binding:
      direct && sameNode(state.stats, pathStats)
        ? "canonical-current"
        : "detached",
    owner:
      state.stats.uid === currentUid ? "current-user" : "other-user",
    access:
      (state.stats.mode & 0o7777n) === BigInt(POSIX_FILE_MODE)
        ? "user-only"
        : "broader",
    link: direct ? "direct" : "symbolic-link",
    links: safeNumber(state.stats.nlink),
    size: safeNumber(state.stats.size),
  });
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  if (handle === undefined) {
    return;
  }
  try {
    await handle.close();
  } catch {
    // Preserve the original fixture failure.
  }
}

export function createIsolatedPosixCredentialStore(
  isolated: IsolatedTestRoot,
  locations: CredentialLocations,
): IsolatedPosixCredentialStore {
  const platform = isolated.boundary.config.platform;
  const uid = isolated.boundary.config.expectedUid;
  if (
    (platform !== "darwin" && platform !== "linux") ||
    uid === undefined ||
    uid === 0 ||
    isolated.environment.PLURUM_TEST_ROOT !== isolated.paths.root ||
    isolated.environment.PLURUM_TEST_RUN_ID !== isolated.runId ||
    isolated.environment.PLURUM_HOME !== isolated.paths.plurum ||
    locations.directory !== isolated.paths.plurum ||
    locations.credentials !==
      join(isolated.paths.plurum, CREDENTIAL_STORE_ENTRY) ||
    locations.setupLock !==
      join(isolated.paths.plurum, "setup.lock") ||
    locations.credentialTransaction !==
      join(isolated.paths.plurum, CREDENTIAL_TRANSACTION_ENTRY) ||
    isolated.boundary.config.root !== isolated.paths.root ||
    isolated.boundary.config.runId !== isolated.runId
  ) {
    return fixtureFailure();
  }

  const currentUid = BigInt(uid);
  const directoryPath = isolated.paths.plurum;
  const lockPath = locations.setupLock;
  const snapshotRecords = new WeakMap<object, SnapshotRecord>();
  let nextLeaseId = 1;
  let directoryGeneration = 0;
  let activeLease: LeaseRecord | undefined;
  let uncertainLeaseEvidence = false;

  async function guardedPath(
    target: string,
    operation: "read" | "write" | "delete",
  ): Promise<string> {
    return isolated.boundary.assertPath(target, operation);
  }

  async function openExistingDirectory(
    operation: "read" | "write",
  ): Promise<FileHandle | undefined> {
    const guardedDirectory = await guardedPath(directoryPath, operation);
    let pathStats: BigIntStats;
    try {
      pathStats = await lstat(guardedDirectory, { bigint: true });
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      return fixtureFailure();
    }
    if (!secureDirectory(pathStats, currentUid)) {
      return fixtureFailure();
    }
    const handle = await open(guardedDirectory, DIRECTORY_OPEN_FLAGS);
    try {
      const openedStats = await handle.stat({ bigint: true });
      const currentPathStats = await lstat(guardedDirectory, {
        bigint: true,
      });
      if (
        !secureDirectory(openedStats, currentUid) ||
        !sameNode(openedStats, currentPathStats)
      ) {
        return fixtureFailure();
      }
      return handle;
    } catch (error) {
      await closeQuietly(handle);
      throw error;
    }
  }

  async function ensurePrivateDirectory(): Promise<{
    readonly disposition: "created" | "existing";
    readonly handle: FileHandle;
  }> {
    const existing = await openExistingDirectory("write");
    if (existing !== undefined) {
      return Object.freeze({
        disposition: "existing" as const,
        handle: existing,
      });
    }

    const guardedDirectory = await guardedPath(directoryPath, "write");
    let createdDirectory = false;
    try {
      await mkdir(guardedDirectory, {
        mode: POSIX_DIRECTORY_MODE,
      });
      createdDirectory = true;
    } catch (error) {
      if (!isExisting(error)) {
        throw error;
      }
    }
    if (createdDirectory) {
      await chmod(guardedDirectory, POSIX_DIRECTORY_MODE);
    }
    const created = await openExistingDirectory("write");
    if (created === undefined) {
      return fixtureFailure();
    }
    await created.sync();
    return Object.freeze({
      disposition: createdDirectory
        ? ("created" as const)
        : ("existing" as const),
      handle: created,
    });
  }

  async function attestDirectoryHandle(
    handle: FileHandle,
  ): Promise<PrivateDirectoryAttestation> {
    const guardedDirectory = await guardedPath(directoryPath, "read");
    const opened = await handle.stat({ bigint: true });
    const pathStats = await lstat(guardedDirectory, { bigint: true });
    return directoryAttestation(opened, pathStats, currentUid);
  }

  async function assertPrivateDirectoryHandle(
    handle: FileHandle,
  ): Promise<BigIntStats> {
    const guardedDirectory = await guardedPath(directoryPath, "read");
    const opened = await handle.stat({ bigint: true });
    const pathStats = await lstat(guardedDirectory, { bigint: true });
    if (
      !secureDirectory(opened, currentUid) ||
      !sameNode(opened, pathStats)
    ) {
      return fixtureFailure();
    }
    return opened;
  }

  function assertPrivateDirectoryHandleSync(handle: FileHandle): BigIntStats {
    const opened = fstatSync(handle.fd, { bigint: true });
    const pathStats = lstatSync(directoryPath, { bigint: true });
    if (
      !secureDirectory(opened, currentUid) ||
      !sameNode(opened, pathStats)
    ) {
      return fixtureFailure();
    }
    return opened;
  }

  function trackLeaseHandle(
    record: LeaseRecord,
    invalidate: () => Promise<void>,
  ): LeaseMintedHandle {
    const tracked = Object.freeze({ invalidate });
    record.handles.add(tracked);
    return tracked;
  }

  async function invalidateLeaseHandles(
    record: LeaseRecord,
  ): Promise<unknown> {
    let failure: unknown;
    const handles = [...record.handles];
    record.handles.clear();
    for (const handle of handles) {
      try {
        await handle.invalidate();
      } catch (error) {
        failure = error;
      }
    }
    return failure;
  }

  async function openManagedReadHandle(
    name: string,
    parent: FileHandle,
    lease?: LeaseRecord,
  ): Promise<CredentialFileOpenResult> {
    const target = await guardedPath(join(directoryPath, name), "read");
    try {
      const pathStats = await lstat(target, { bigint: true });
      if (!pathStats.isFile()) {
        return fixtureFailure();
      }
    } catch (error) {
      if (isMissing(error)) {
        return Object.freeze({ status: "missing" as const });
      }
      return fixtureFailure();
    }

    const handle = await open(target, READ_OPEN_FLAGS);
    let parentStats: BigIntStats;
    try {
      parentStats = await assertPrivateDirectoryHandle(parent);
    } catch (error) {
      await closeQuietly(handle);
      throw error;
    }
    let closed = false;
    let tracked: LeaseMintedHandle | undefined;

    function assertOpen(): void {
      if (lease !== undefined) {
        assertLeaseHeld(lease);
      }
      if (closed) {
        return fixtureFailure();
      }
    }

    async function invalidate(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      if (tracked !== undefined && lease !== undefined) {
        lease.handles.delete(tracked);
      }
      await handle.close();
    }

    if (lease !== undefined) {
      tracked = trackLeaseHandle(lease, invalidate);
    }

    const file: CredentialFileReadHandle = Object.freeze({
      async attest() {
        assertOpen();
        const guardedTarget = await guardedPath(target, "read");
        const state = await openedFileState(handle);
        const pathStats = await lstat(guardedTarget, { bigint: true });
        try {
          return fileAttestation(
            state,
            pathStats,
            identity(parentStats),
            currentUid,
          );
        } finally {
          wipeBytes(state.bytes);
        }
      },
      async readBounded(
        options: Readonly<{ maxBytes: number }>,
      ): Promise<BoundedCredentialRead> {
        assertOpen();
        if (
          !Number.isSafeInteger(options.maxBytes) ||
          options.maxBytes < 0 ||
          options.maxBytes > MAX_ATTESTED_BYTES
        ) {
          return fixtureFailure();
        }
        await guardedPath(target, "read");
        const before = await handle.stat({ bigint: true });
        const bytes = await readOpenedBounded(handle, options.maxBytes);
        const after = await handle.stat({ bigint: true });
        if (!sameStableFileState(before, after)) {
          wipeBytes(bytes);
          return fixtureFailure();
        }
        return Object.freeze({
          bytes,
          endOfFile: BigInt(bytes.byteLength) === after.size,
        });
      },
      async close() {
        assertOpen();
        await invalidate();
      },
    });
    return Object.freeze({ status: "opened" as const, file });
  }

  function createReadDirectoryHandle(
    directory: FileHandle,
  ): PrivateCredentialDirectoryHandle {
    let closed = false;

    function assertOpen(): void {
      if (closed) {
        return fixtureFailure();
      }
    }

    return Object.freeze({
      async attest() {
        assertOpen();
        return attestDirectoryHandle(directory);
      },
      async openCredentialReadOnly(
        options: Readonly<{
          entry: typeof CREDENTIAL_STORE_ENTRY;
          noFollow: true;
        }>,
      ) {
        assertOpen();
        if (
          !isRecord(options) ||
          !hasExactKeys(options, ["entry", "noFollow"]) ||
          options.entry !== CREDENTIAL_STORE_ENTRY ||
          options.noFollow !== true
        ) {
          return fixtureFailure();
        }
        return openManagedReadHandle(CREDENTIAL_STORE_ENTRY, directory);
      },
      async close() {
        assertOpen();
        closed = true;
        await directory.close();
      },
    });
  }

  const read: CredentialStoreReadAdapter = Object.freeze({
    async openPrivateDirectory(
      requestedDirectory: string,
      options: Readonly<{ noFollow: true }>,
    ): Promise<PrivateCredentialDirectoryOpenResult> {
      if (
        requestedDirectory !== directoryPath ||
        !isRecord(options) ||
        !hasExactKeys(options, ["noFollow"]) ||
        options.noFollow !== true
      ) {
        return fixtureFailure();
      }
      const directory = await openExistingDirectory("read");
      return directory === undefined
        ? Object.freeze({ status: "missing" as const })
        : Object.freeze({
            status: "opened" as const,
            directory: createReadDirectoryHandle(directory),
          });
    },
  });

  function assertLeaseHeld(record: LeaseRecord): void {
    if (record.state !== "held" || activeLease !== record) {
      return fixtureFailure();
    }
  }

  async function lockMatches(record: LeaseRecord): Promise<boolean> {
    try {
      const guardedLock = await guardedPath(lockPath, "read");
      const handleStats = await record.lock.stat({ bigint: true });
      const pathStats = await lstat(guardedLock, { bigint: true });
      if (
        !secureFile(handleStats, currentUid) ||
        !sameNode(handleStats, pathStats)
      ) {
        return false;
      }
      const bytes = await readOpenedBounded(record.lock, 128);
      try {
        return new TextDecoder().decode(bytes) === `${record.nonce}\n`;
      } finally {
        wipeBytes(bytes);
      }
    } catch {
      return false;
    }
  }

  function lockMatchesSync(record: LeaseRecord): boolean {
    try {
      const handleStats = fstatSync(record.lock.fd, { bigint: true });
      const pathStats = lstatSync(lockPath, { bigint: true });
      if (
        !secureFile(handleStats, currentUid) ||
        !sameNode(handleStats, pathStats)
      ) {
        return false;
      }
      const bytes = readOpenedBoundedSync(record.lock.fd, 128);
      try {
        return new TextDecoder().decode(bytes) === `${record.nonce}\n`;
      } finally {
        wipeBytes(bytes);
      }
    } catch {
      return false;
    }
  }

  function assertLeaseHeldSync(record: LeaseRecord): void {
    assertLeaseHeld(record);
    assertPrivateDirectoryHandleSync(record.directory);
    if (!lockMatchesSync(record)) {
      return fixtureFailure();
    }
  }

  async function preserveConservativeLockRecord(
    record: LeaseRecord,
  ): Promise<void> {
    const guardedLock = await guardedPath(lockPath, "write");
    await assertPrivateDirectoryHandle(record.directory);
    try {
      await lstat(guardedLock, { bigint: true });
      return;
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }

    let replacement: FileHandle;
    try {
      replacement = await open(
        guardedLock,
        LOCK_OPEN_FLAGS,
        POSIX_FILE_MODE,
      );
    } catch (error) {
      if (isExisting(error)) {
        return;
      }
      throw error;
    }

    const bytes = new TextEncoder().encode(`${record.nonce}\n`);
    try {
      await replacement.chmod(POSIX_FILE_MODE);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await replacement.write(
          bytes,
          offset,
          bytes.byteLength - offset,
          offset,
        );
        if (result.bytesWritten === 0) {
          return fixtureFailure();
        }
        offset += result.bytesWritten;
      }
      await replacement.truncate(bytes.byteLength);
      await replacement.sync();
      const opened = await replacement.stat({ bigint: true });
      const current = await lstat(guardedLock, { bigint: true });
      if (
        !secureFile(opened, currentUid) ||
        !sameNode(opened, current)
      ) {
        return fixtureFailure();
      }
      await record.directory.sync();
    } finally {
      wipeBytes(bytes);
      await closeQuietly(replacement);
    }
  }

  function mintMissingSnapshot(
    record: LeaseRecord,
    name: string,
  ): CredentialMissingEntrySnapshot {
    const snapshot = Object.freeze({});
    snapshotRecords.set(snapshot, {
      leaseId: record.id,
      directoryGeneration,
      name,
      state: "missing",
    });
    return snapshot as CredentialMissingEntrySnapshot;
  }

  function mintPresentSnapshot(
    record: LeaseRecord,
    name: string,
    fingerprint: string,
  ): CredentialPresentEntrySnapshot {
    const snapshot = Object.freeze({});
    snapshotRecords.set(snapshot, {
      leaseId: record.id,
      directoryGeneration,
      name,
      state: "present",
      fingerprint,
    });
    return snapshot as CredentialPresentEntrySnapshot;
  }

  function snapshotRecord(
    record: LeaseRecord,
    snapshot: CredentialEntrySnapshot,
    name: string,
    state: "missing" | "present",
  ): SnapshotRecord | undefined {
    if (snapshot === null || typeof snapshot !== "object") {
      return undefined;
    }
    const value = snapshotRecords.get(snapshot);
    return value?.leaseId === record.id &&
      value.directoryGeneration === directoryGeneration &&
      value.name === name &&
      value.state === state
      ? value
      : undefined;
  }

  async function observeEntry(
    record: LeaseRecord,
    rawEntry: CredentialManagedEntry,
  ): Promise<CredentialManagedEntryObservation> {
    assertLeaseHeld(record);
    if (!(await lockMatches(record))) {
      return fixtureFailure();
    }
    const entry = validateManagedEntry(rawEntry);
    const name = entryName(entry);
    const opened = await openManagedReadHandle(
      name,
      record.directory,
      record,
    );
    if (opened.status === "missing") {
      return Object.freeze({
        status: "missing" as const,
        snapshot: mintMissingSnapshot(record, name),
      });
    }
    let initial: CredentialFileAttestation;
    try {
      initial = await opened.file.attest();
    } catch (error) {
      try {
        await opened.file.close();
      } catch {
        // The lease terminal path retains a second invalidation route.
      }
      throw error;
    }
    return Object.freeze({
      status: "opened" as const,
      snapshot: mintPresentSnapshot(record, name, initial.revision),
      attestation: initial,
      file: opened.file,
    });
  }

  function createWriteHandle(
    record: LeaseRecord,
    entry: CredentialTemporaryEntry,
    name: string,
    handle: FileHandle,
  ): CredentialFileExclusiveWriteHandle {
    let closed = false;
    let written = false;
    let tracked: LeaseMintedHandle | undefined;

    async function assertCurrent(): Promise<void> {
      assertLeaseHeld(record);
      if (closed || !(await lockMatches(record))) {
        return fixtureFailure();
      }
      const target = await guardedPath(join(directoryPath, name), "write");
      const opened = await handle.stat({ bigint: true });
      const pathStats = await lstat(target, { bigint: true });
      if (
        !secureFile(opened, currentUid) ||
        !sameNode(opened, pathStats)
      ) {
        return fixtureFailure();
      }
    }

    async function invalidate(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      if (tracked !== undefined) {
        record.handles.delete(tracked);
      }
      await handle.close();
    }

    tracked = trackLeaseHandle(record, invalidate);

    return Object.freeze({
      async attest() {
        await assertCurrent();
        const target = join(directoryPath, name);
        const state = await openedFileState(handle);
        const pathStats = await lstat(target, { bigint: true });
        const parentStats = await record.directory.stat({ bigint: true });
        try {
          return fileAttestation(
            state,
            pathStats,
            identity(parentStats),
            currentUid,
          );
        } finally {
          wipeBytes(state.bytes);
        }
      },
      async writeAll(input: Uint8Array) {
        const bytes = copyBytes(input);
        try {
          await assertCurrent();
          if (
            written ||
            bytes.byteLength === 0 ||
            bytes.byteLength >
              (entry.role === "transaction-candidate"
                ? MAX_CREDENTIAL_TRANSACTION_BYTES
                : MAX_CREDENTIAL_DOCUMENT_BYTES)
          ) {
            return fixtureFailure();
          }
          await handle.truncate(0);
          let offset = 0;
          while (offset < bytes.byteLength) {
            const result = await handle.write(
              bytes,
              offset,
              bytes.byteLength - offset,
              offset,
            );
            if (result.bytesWritten === 0) {
              return fixtureFailure();
            }
            offset += result.bytesWritten;
          }
          await handle.truncate(bytes.byteLength);
          written = true;
        } finally {
          wipeBytes(bytes);
        }
      },
      async sync() {
        await assertCurrent();
        await handle.sync();
        await assertCurrent();
      },
      async close() {
        if (closed) {
          return fixtureFailure();
        }
        assertLeaseHeld(record);
        await invalidate();
      },
    });
  }

  function makeLease(record: LeaseRecord): CredentialStoreMutationLease {
    return Object.freeze({
      async attestDirectory() {
        assertLeaseHeld(record);
        return attestDirectoryHandle(record.directory);
      },
      async renew() {
        if (record.state === "lost") {
          return Object.freeze({ status: "lost" as const });
        }
        try {
          assertLeaseHeld(record);
          if (
            !(await lockMatches(record)) ||
            !secureDirectory(
              await assertPrivateDirectoryHandle(record.directory),
              currentUid,
            )
          ) {
            record.state = "lost";
            return Object.freeze({ status: "lost" as const });
          }
          return Object.freeze({ status: "held" as const });
        } catch {
          record.state = "lost";
          return Object.freeze({ status: "lost" as const });
        }
      },
      async observeEntry(entry: CredentialManagedEntry) {
        return observeEntry(record, entry);
      },
      async listTemporaryEntries() {
        assertLeaseHeld(record);
        if (!(await lockMatches(record))) {
          return fixtureFailure();
        }
        const guardedDirectory = await guardedPath(directoryPath, "read");
        const entries = (await readdir(guardedDirectory))
          .map(temporaryEntryFromName)
          .filter(
            (entry): entry is CredentialTemporaryEntry =>
              entry !== undefined,
          )
          .sort((left, right) =>
            entryName(left).localeCompare(entryName(right)),
          );
        return Object.freeze(entries);
      },
      async createTemporaryExclusive(
        options: Readonly<{
          entry: CredentialTemporaryEntry;
          expected: CredentialMissingEntrySnapshot;
        }>,
      ) {
        assertLeaseHeld(record);
        const rawEntry = options.entry;
        const expectedSnapshot = options.expected;
        if (
          !isRecord(options) ||
          !hasExactKeys(options, ["entry", "expected"])
        ) {
          return fixtureFailure();
        }
        const entry = validateTemporaryEntry(rawEntry);
        const name = entryName(entry);
        if (
          snapshotRecord(
            record,
            expectedSnapshot,
            name,
            "missing",
          ) === undefined
        ) {
          return Object.freeze({ status: "conflict" as const });
        }
        const target = await guardedPath(
          join(directoryPath, name),
          "write",
        );
        /*
         * Bracket the promise-based O_EXCL request with lease checks. O_EXCL is
         * the atomic name guard; this test harness does not claim no-yield *at
         * semantics.
         */
        assertLeaseHeldSync(record);
        let handle: FileHandle;
        try {
          handle = await open(
            target,
            TEMPORARY_OPEN_FLAGS,
            POSIX_FILE_MODE,
          );
        } catch (error) {
          if (isExisting(error)) {
            return Object.freeze({ status: "conflict" as const });
          }
          throw error;
        }
        try {
          assertLeaseHeldSync(record);
          await handle.chmod(POSIX_FILE_MODE);
          const stats = await handle.stat({ bigint: true });
          const pathStats = await lstat(target, { bigint: true });
          if (
            !secureFile(stats, currentUid) ||
            stats.size !== 0n ||
            !sameNode(stats, pathStats)
          ) {
            return fixtureFailure();
          }
          directoryGeneration += 1;
          return Object.freeze({
            status: "created" as const,
            file: createWriteHandle(
              record,
              entry,
              name,
              handle,
            ),
          });
        } catch (error) {
          await closeQuietly(handle);
          throw error;
        }
      },
      async moveTemporaryConditionally(
        options: Readonly<{
          source: CredentialTemporaryEntry;
          expectedSource: CredentialPresentEntrySnapshot;
          destination: CredentialCanonicalEntry;
          expectedDestination: CredentialEntrySnapshot;
        }>,
      ) {
        assertLeaseHeld(record);
        const rawSource = options.source;
        const rawDestination = options.destination;
        const expectedSourceSnapshot = options.expectedSource;
        const expectedDestinationSnapshot = options.expectedDestination;
        if (
          !isRecord(options) ||
          !hasExactKeys(options, [
            "source",
            "expectedSource",
            "destination",
            "expectedDestination",
          ])
        ) {
          return fixtureFailure();
        }
        const source = validateTemporaryEntry(rawSource);
        const destination = validateCanonicalEntry(rawDestination);
        const sourceName = entryName(source);
        const destinationName = entryName(destination);
        const expectedSource = snapshotRecord(
          record,
          expectedSourceSnapshot,
          sourceName,
          "present",
        );
        const expectedDestination =
          expectedDestinationSnapshot === null ||
          typeof expectedDestinationSnapshot !== "object"
            ? undefined
            : snapshotRecords.get(expectedDestinationSnapshot);
        if (
          expectedSource === undefined ||
          expectedDestination === undefined ||
          expectedDestination.leaseId !== record.id ||
          expectedDestination.directoryGeneration !== directoryGeneration ||
          expectedDestination.name !== destinationName
        ) {
          return Object.freeze({ status: "conflict" as const });
        }

        const sourcePath = join(directoryPath, sourceName);
        const destinationPath = join(directoryPath, destinationName);
        const [guardedSource, guardedDestination] =
          await isolated.boundary.assertRename(
            sourcePath,
            destinationPath,
          );

        assertLeaseHeldSync(record);
        const currentSource = pathFileStateSync(
          guardedSource,
          currentUid,
        );
        const currentDestination = pathFileStateSync(
          guardedDestination,
          currentUid,
        );
        try {
          const destinationMatches =
            expectedDestination.state === "missing"
              ? currentDestination === undefined
              : currentDestination?.fingerprint ===
                expectedDestination.fingerprint;
          if (
            currentSource === undefined ||
            currentSource.fingerprint !== expectedSource.fingerprint ||
            !destinationMatches
          ) {
            return Object.freeze({ status: "conflict" as const });
          }
          renameSync(guardedSource, guardedDestination);
          const installed = lstatSync(guardedDestination, {
            bigint: true,
          });
          if (
            !sameNode(currentSource.stats, installed) ||
            !isMissingPathSync(guardedSource)
          ) {
            return fixtureFailure();
          }
          directoryGeneration += 1;
          return Object.freeze({ status: "moved" as const });
        } finally {
          if (currentSource !== undefined) {
            wipeBytes(currentSource.bytes);
          }
          if (currentDestination !== undefined) {
            wipeBytes(currentDestination.bytes);
          }
        }
      },
      async removeConditionally(
        options: Readonly<{
          entry: CredentialManagedEntry;
          expected: CredentialPresentEntrySnapshot;
        }>,
      ) {
        assertLeaseHeld(record);
        const rawEntry = options.entry;
        const expectedSnapshot = options.expected;
        if (
          !isRecord(options) ||
          !hasExactKeys(options, ["entry", "expected"])
        ) {
          return fixtureFailure();
        }
        const entry = validateManagedEntry(rawEntry);
        const name = entryName(entry);
        const expected = snapshotRecord(
          record,
          expectedSnapshot,
          name,
          "present",
        );
        if (expected === undefined) {
          return Object.freeze({ status: "conflict" as const });
        }
        const target = await guardedPath(
          join(directoryPath, name),
          "delete",
        );

        assertLeaseHeldSync(record);
        const current = pathFileStateSync(target, currentUid);
        try {
          if (
            current === undefined ||
            current.fingerprint !== expected.fingerprint
          ) {
            return Object.freeze({ status: "conflict" as const });
          }
          unlinkSync(target);
          if (!isMissingPathSync(target)) {
            return fixtureFailure();
          }
          directoryGeneration += 1;
          return Object.freeze({ status: "removed" as const });
        } finally {
          if (current !== undefined) {
            wipeBytes(current.bytes);
          }
        }
      },
      async syncDirectory() {
        assertLeaseHeld(record);
        await guardedPath(directoryPath, "write");
        if (!(await lockMatches(record))) {
          return fixtureFailure();
        }
        await record.directory.sync();
        await assertPrivateDirectoryHandle(record.directory);
      },
      async release() {
        let failure: unknown;
        let removalDurable = false;
        if (record.state !== "held" || activeLease !== record) {
          failure = new Error(
            "isolated POSIX credential-store fixture failed",
          );
        }

        const handleFailure = await invalidateLeaseHandles(record);
        if (handleFailure !== undefined) {
          failure = handleFailure;
        }

        if (failure === undefined) {
          try {
            await guardedPath(lockPath, "delete");
            await guardedPath(directoryPath, "write");
            assertLeaseHeldSync(record);
            unlinkSync(lockPath);
            if (!isMissingPathSync(lockPath)) {
              return fixtureFailure();
            }
            await record.directory.sync();
            removalDurable = true;
          } catch (error) {
            failure = error;
          }
        }

        if (failure !== undefined && !removalDurable) {
          try {
            await preserveConservativeLockRecord(record);
          } catch {
            // The in-memory uncertainty latch remains the final fail-closed gate.
          }
        }

        record.state = "released";
        if (activeLease === record) {
          activeLease = undefined;
        }
        try {
          await record.lock.close();
        } catch (error) {
          failure = error;
        }
        try {
          await record.directory.close();
        } catch (error) {
          failure = error;
        }
        if (failure !== undefined) {
          uncertainLeaseEvidence = true;
          return fixtureFailure();
        }
        uncertainLeaseEvidence = false;
      },
      async abandon() {
        let failure: unknown;
        if (
          record.state !== "held" &&
          record.state !== "lost"
        ) {
          failure = new Error(
            "isolated POSIX credential-store fixture failed",
          );
        }
        const handleFailure = await invalidateLeaseHandles(record);
        if (handleFailure !== undefined) {
          failure = handleFailure;
        }
        record.state = "abandoned";
        if (activeLease === record) {
          activeLease = undefined;
        }
        try {
          await record.lock.close();
        } catch (error) {
          failure = error;
        }
        try {
          await record.directory.close();
        } catch (error) {
          failure = error;
        }
        uncertainLeaseEvidence = true;
        if (failure !== undefined) {
          return fixtureFailure();
        }
      },
    });
  }

  const mutation: CredentialStoreMutationAdapter = Object.freeze({
    async acquireSetupLease(
      requestedDirectory: string,
      options: Readonly<{
        noFollow: true;
        createDirectory: true;
        nonce: CredentialSetupLeaseNonce;
      }>,
    ) {
      const nonce = options.nonce;
      if (
        requestedDirectory !== directoryPath ||
        !isRecord(options) ||
        !hasExactKeys(options, [
          "noFollow",
          "createDirectory",
          "nonce",
        ]) ||
        options.noFollow !== true ||
        options.createDirectory !== true ||
        typeof nonce !== "string" ||
        !UUID_V4.test(nonce)
      ) {
        return fixtureFailure();
      }
      if (activeLease !== undefined) {
        return Object.freeze({ status: "busy" as const });
      }
      if (uncertainLeaseEvidence) {
        return Object.freeze({ status: "busy" as const });
      }

      const ensured = await ensurePrivateDirectory();
      const guardedLock = await guardedPath(lockPath, "write");
      let lock: FileHandle;
      try {
        lock = await open(
          guardedLock,
          LOCK_OPEN_FLAGS,
          POSIX_FILE_MODE,
        );
      } catch (error) {
        await closeQuietly(ensured.handle);
        if (isExisting(error)) {
          return Object.freeze({ status: "busy" as const });
        }
        throw error;
      }

      const nonceBytes = new TextEncoder().encode(`${nonce}\n`);
      try {
        await lock.chmod(POSIX_FILE_MODE);
        let offset = 0;
        while (offset < nonceBytes.byteLength) {
          const result = await lock.write(
            nonceBytes,
            offset,
            nonceBytes.byteLength - offset,
            offset,
          );
          if (result.bytesWritten === 0) {
            return fixtureFailure();
          }
          offset += result.bytesWritten;
        }
        await lock.truncate(nonceBytes.byteLength);
        await lock.sync();
        const lockStats = await lock.stat({ bigint: true });
        const lockPathStats = await lstat(guardedLock, {
          bigint: true,
        });
        if (
          !secureFile(lockStats, currentUid) ||
          !sameNode(lockStats, lockPathStats)
        ) {
          return fixtureFailure();
        }
        await ensured.handle.sync();

        const record: LeaseRecord = {
          id: nextLeaseId,
          nonce,
          directory: ensured.handle,
          lock,
          handles: new Set(),
          state: "held",
        };
        nextLeaseId += 1;
        activeLease = record;
        return Object.freeze({
          status: "acquired" as const,
          priorLease: "absent" as const,
          directory: ensured.disposition,
          lease: makeLease(record),
        });
      } catch (error) {
        await closeQuietly(lock);
        await closeQuietly(ensured.handle);
        throw error;
      } finally {
        wipeBytes(nonceBytes);
      }
    },
  });

  return Object.freeze({ read, mutation });
}

function isMissingPathSync(target: string): boolean {
  try {
    lstatSync(target, { bigint: true });
    return false;
  } catch (error) {
    if (isMissing(error)) {
      return true;
    }
    return fixtureFailure();
  }
}
