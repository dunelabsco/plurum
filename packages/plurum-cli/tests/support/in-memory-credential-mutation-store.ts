import type {
  CredentialCanonicalEntry,
  CredentialEntrySnapshot,
  CredentialFileExclusiveWriteHandle,
  CredentialManagedEntry,
  CredentialManagedEntryObservation,
  CredentialMissingEntrySnapshot,
  CredentialPresentEntrySnapshot,
  CredentialSetupLeaseNonce,
  CredentialStoreMutationLease,
  CredentialStoreObservedMutationAdapter,
  CredentialTemporaryEntry,
} from "../../src/credentials/store-mutation-contracts.js";
import {
  CREDENTIAL_CANDIDATE_ENTRY_PREFIX,
  CREDENTIAL_RECOVERY_CANDIDATE_ENTRY_PREFIX,
  CREDENTIAL_TEMPORARY_ENTRY_SUFFIX,
  CREDENTIAL_TRANSACTION_ENTRY,
  CREDENTIAL_TRANSACTION_CANDIDATE_ENTRY_PREFIX,
} from "../../src/credentials/store-mutation-contracts.js";
import {
  CREDENTIAL_STORE_ENTRY,
  type BoundedCredentialRead,
  type CredentialFileAttestation,
  type CredentialFileReadHandle,
  type CredentialObjectIdentity,
  type CredentialStoreWholePassEvidence,
  type PrivateDirectoryAttestation,
} from "../../src/credentials/store-contracts.js";

export interface InMemoryCredentialMutationStoreOptions {
  readonly initialCredential?: Uint8Array;
  readonly loseLeaseAtRenew?: number;
  readonly malformedLeaseAtRenew?: number;
  readonly failRelease?: boolean;
  readonly failReleaseAt?: number;
  readonly busyObservedLeaseAtAcquire?: number;
  readonly crashPolicy?: "discard-unsynced" | "persist-unsynced";
  readonly onOperation?: (operation: string) => void;
  readonly fault?: Readonly<{
    mode: "throw-before" | "throw-after" | "crash-before" | "crash-after";
    operation: string;
    occurrence: number;
  }>;
  // Kept as a concise spelling for the restart matrix.
  readonly crashAfter?: Readonly<{
    operation: string;
    occurrence: number;
  }>;
}

export interface InMemoryCredentialMutationStoreEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface InMemoryCredentialMutationStoreControl {
  observeWholePass(): CredentialStoreWholePassEvidence;
  seedCredential(bytes: Uint8Array): void;
  seedTransaction(bytes: Uint8Array): void;
  seedTemporary(entry: CredentialTemporaryEntry, bytes: Uint8Array): void;
  readCredential(): Uint8Array | undefined;
  readDurableCredential(): Uint8Array | undefined;
  replaceCredentialUnrelated(bytes: Uint8Array): void;
  entries(): readonly InMemoryCredentialMutationStoreEntry[];
  crash(): void;
}

export interface InMemoryCredentialMutationStoreTrace {
  operations(): readonly string[];
}

export interface InMemoryCredentialMutationStore {
  readonly adapter: CredentialStoreObservedMutationAdapter;
  readonly control: InMemoryCredentialMutationStoreControl;
  readonly trace: InMemoryCredentialMutationStoreTrace;
}

interface StoredFile {
  readonly identity: CredentialObjectIdentity;
  entry: CredentialManagedEntry;
  bytes: Uint8Array;
  durableBytes: Uint8Array | undefined;
  revision: number;
}

interface SnapshotRecord {
  readonly leaseId: number;
  readonly key: string;
  readonly generation: number;
  readonly directoryRevision: number;
  readonly state: "missing" | "present";
  readonly identityObject: string | undefined;
}

interface LeaseState {
  readonly id: number;
  readonly nonce: CredentialSetupLeaseNonce;
  state: "held" | "released" | "abandoned" | "crashed";
}

interface WholePassEvidenceRecord {
  readonly directoryExists: boolean;
  readonly directoryRevision: number;
}

const DIRECTORY_IDENTITY = Object.freeze({
  volume: "memory-mutation-volume",
  object: "credential-directory",
});
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
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function copyBytes(bytes: Uint8Array): Uint8Array {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error("in-memory mutation fixture requires bytes");
  }
  return Uint8Array.prototype.slice.call(bytes);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateEntry(input: CredentialManagedEntry): CredentialManagedEntry {
  if (!isRecord(input)) {
    throw new Error("invalid in-memory managed entry");
  }
  const entry = input as unknown as Record<string, unknown>;
  const kind = entry.kind;
  const role = entry.role;
  if (kind === "canonical") {
    const name = entry.name;
    if (
      !hasExactKeys(entry, ["kind", "role", "name"]) ||
      (role === "credential" && name !== CREDENTIAL_STORE_ENTRY) ||
      (role === "transaction" &&
        name !== "credentials-transaction.json") ||
      (role !== "credential" && role !== "transaction")
    ) {
      throw new Error("invalid in-memory canonical entry");
    }
    return Object.freeze({
      kind: "canonical",
      role,
      name,
    }) as CredentialCanonicalEntry;
  }
  const transactionId = entry.transactionId;
  if (
    kind !== "temporary" ||
    !hasExactKeys(entry, ["kind", "role", "transactionId"]) ||
    (role !== "credential-candidate" &&
      role !== "transaction-candidate" &&
      role !== "recovery-candidate") ||
    typeof transactionId !== "string" ||
    !UUID_V4.test(transactionId)
  ) {
    throw new Error("invalid in-memory temporary entry");
  }
  return Object.freeze({
    kind: "temporary",
    role,
    transactionId,
  }) as CredentialTemporaryEntry;
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

function cloneStoredFile(file: StoredFile): StoredFile {
  return {
    identity: file.identity,
    entry: file.entry,
    bytes: copyBytes(file.bytes),
    durableBytes:
      file.durableBytes === undefined
        ? undefined
        : copyBytes(file.durableBytes),
    revision: file.revision,
  };
}

function cloneEntries(
  entries: ReadonlyMap<string, StoredFile>,
): Map<string, StoredFile> {
  return new Map(
    [...entries].map(([key, file]) => [key, cloneStoredFile(file)]),
  );
}

export function createInMemoryCredentialMutationStore(
  options: InMemoryCredentialMutationStoreOptions = {},
): InMemoryCredentialMutationStore {
  let nextIdentity = 1;
  let nextLeaseId = 1;
  let directoryRevision = 1;
  let directoryExists = options.initialCredential !== undefined;
  let durableDirectoryExists = directoryExists;
  let liveEntries = new Map<string, StoredFile>();
  let durableEntries = new Map<string, StoredFile>();
  let activeLease: LeaseState | undefined;
  let abandonedLeaseEvidence = false;
  let renewCount = 0;
  let releaseFailuresRemaining = options.failRelease === true ? 1 : 0;
  let releaseCount = 0;
  let observedLeaseAcquireCount = 0;

  const generations = new Map<string, number>();
  const snapshotRecords = new WeakMap<object, SnapshotRecord>();
  const wholePassEvidenceRecords = new WeakMap<
    object,
    WholePassEvidenceRecord
  >();
  const operationLog: string[] = [];
  const startedOperationCounts = new Map<string, number>();

  function record(operation: string): void {
    operationLog.push(operation);
    options.onOperation?.(operation);
  }

  function crashState(): void {
    if (options.crashPolicy === "persist-unsynced") {
      const persisted = new Map<string, StoredFile>();
      for (const [key, file] of liveEntries) {
        const persistedFile = cloneStoredFile(file);
        const bytes = file.durableBytes ?? file.bytes;
        persistedFile.bytes = copyBytes(bytes);
        persistedFile.durableBytes = copyBytes(bytes);
        persisted.set(key, persistedFile);
      }
      durableEntries = persisted;
      durableDirectoryExists = directoryExists;
    }
    liveEntries = cloneEntries(durableEntries);
    directoryExists = durableDirectoryExists;
    if (activeLease?.state === "held") {
      activeLease.state = "crashed";
      activeLease = undefined;
      abandonedLeaseEvidence = true;
    }
    directoryRevision += 1;
  }

  function configuredFault() {
    return (
      options.fault ??
      (options.crashAfter === undefined
        ? undefined
        : Object.freeze({
            ...options.crashAfter,
            mode: "crash-after" as const,
          }))
    );
  }

  function beginMutation(operation: string): number {
    const occurrence = (startedOperationCounts.get(operation) ?? 0) + 1;
    startedOperationCounts.set(operation, occurrence);
    const fault = configuredFault();
    if (
      fault?.operation === operation &&
      fault.occurrence === occurrence &&
      (fault.mode === "throw-before" || fault.mode === "crash-before")
    ) {
      if (fault.mode === "crash-before") {
        record(`crash-before:${operation}`);
        crashState();
      }
      throw new Error("simulated in-memory credential-store fault");
    }
    return occurrence;
  }

  function completeMutation(
    operation: string,
    occurrence: number,
  ): void {
    const fault = configuredFault();
    if (
      fault?.operation === operation &&
      fault.occurrence === occurrence &&
      (fault.mode === "throw-after" || fault.mode === "crash-after")
    ) {
      if (fault.mode === "crash-after") {
        record(`crash-after:${operation}`);
        crashState();
      }
      throw new Error("simulated in-memory credential-store crash");
    }
  }

  function generationFor(key: string): number {
    return generations.get(key) ?? 0;
  }

  function advanceGeneration(key: string): void {
    generations.set(key, generationFor(key) + 1);
    directoryRevision += 1;
  }

  function newStoredFile(
    entry: CredentialManagedEntry,
    bytes: Uint8Array,
    durable: boolean,
  ): StoredFile {
    const ownedBytes = copyBytes(bytes);
    return {
      identity: Object.freeze({
        volume: "memory-mutation-volume",
        object: `credential-file-${nextIdentity++}`,
      }),
      entry: validateEntry(entry),
      bytes: ownedBytes,
      durableBytes: durable ? copyBytes(ownedBytes) : undefined,
      revision: 1,
    };
  }

  function replaceManaged(
    entry: CredentialManagedEntry,
    bytes: Uint8Array,
    operation: string,
  ): void {
    record(operation);
    directoryExists = true;
    durableDirectoryExists = true;
    const key = entryName(entry);
    const file = newStoredFile(entry, bytes, true);
    liveEntries.set(key, file);
    durableEntries.set(key, cloneStoredFile(file));
    advanceGeneration(key);
  }

  function replaceCredential(bytes: Uint8Array, operation: string): void {
    replaceManaged(CREDENTIAL_ENTRY, bytes, operation);
  }

  if (options.initialCredential !== undefined) {
    const file = newStoredFile(
      CREDENTIAL_ENTRY,
      options.initialCredential,
      true,
    );
    liveEntries.set(CREDENTIAL_STORE_ENTRY, file);
    durableEntries.set(CREDENTIAL_STORE_ENTRY, cloneStoredFile(file));
  }

  function assertHeld(leaseState: LeaseState): void {
    if (
      leaseState.state !== "held" ||
      activeLease !== leaseState
    ) {
      throw new Error("in-memory mutation lease is not held");
    }
  }

  function secureDirectoryAttestation(): PrivateDirectoryAttestation {
    return Object.freeze({
      kind: "directory",
      identity: DIRECTORY_IDENTITY,
      revision: `directory-revision-${directoryRevision}`,
      binding: "canonical-current",
      owner: "current-user",
      access: "user-only",
      link: "direct",
    });
  }

  function secureFileAttestation(
    key: string,
    file: StoredFile,
  ): CredentialFileAttestation {
    return Object.freeze({
      kind: "regular-file",
      identity: file.identity,
      parentIdentity: DIRECTORY_IDENTITY,
      revision: `file-revision-${file.revision}`,
      binding:
        liveEntries.get(key) === file
          ? "canonical-current"
          : "detached",
      owner: "current-user",
      access: "user-only",
      link: "direct",
      links: 1,
      size: file.bytes.byteLength,
    });
  }

  function mintMissingSnapshot(
    leaseState: LeaseState,
    key: string,
  ): CredentialMissingEntrySnapshot {
    const snapshot = Object.freeze({});
    snapshotRecords.set(snapshot, {
      leaseId: leaseState.id,
      key,
      generation: generationFor(key),
      directoryRevision,
      state: "missing",
      identityObject: undefined,
    });
    return snapshot as CredentialMissingEntrySnapshot;
  }

  function mintPresentSnapshot(
    leaseState: LeaseState,
    key: string,
    file: StoredFile,
  ): CredentialPresentEntrySnapshot {
    const snapshot = Object.freeze({});
    snapshotRecords.set(snapshot, {
      leaseId: leaseState.id,
      key,
      generation: generationFor(key),
      directoryRevision,
      state: "present",
      identityObject: file.identity.object,
    });
    return snapshot as CredentialPresentEntrySnapshot;
  }

  function snapshotMatches(
    leaseState: LeaseState,
    expected: CredentialEntrySnapshot,
    key: string,
    state: "missing" | "present",
  ): boolean {
    if (
      expected === null ||
      typeof expected !== "object"
    ) {
      return false;
    }
    const recordValue = snapshotRecords.get(expected);
    if (
      recordValue === undefined ||
      recordValue.leaseId !== leaseState.id ||
      recordValue.key !== key ||
      recordValue.generation !== generationFor(key) ||
      recordValue.directoryRevision !== directoryRevision ||
      recordValue.state !== state
    ) {
      return false;
    }
    const current = liveEntries.get(key);
    return state === "missing"
      ? current === undefined
      : current?.identity.object === recordValue.identityObject;
  }

  function createReadHandle(
    leaseState: LeaseState,
    key: string,
    file: StoredFile,
  ): CredentialFileReadHandle {
    let closed = false;

    function assertOpen(): void {
      assertHeld(leaseState);
      if (closed) {
        throw new Error("in-memory mutation read handle is closed");
      }
    }

    return Object.freeze({
      async attest() {
        assertOpen();
        record(`attest-read:${key}`);
        return secureFileAttestation(key, file);
      },
      async readBounded(
        readOptions: Readonly<{ maxBytes: number }>,
      ): Promise<BoundedCredentialRead> {
        assertOpen();
        record(`read:${key}`);
        if (
          !Number.isSafeInteger(readOptions.maxBytes) ||
          readOptions.maxBytes < 0
        ) {
          throw new Error("invalid in-memory bounded read");
        }
        const complete = file.bytes.byteLength <= readOptions.maxBytes;
        return Object.freeze({
          bytes: complete
            ? copyBytes(file.bytes)
            : file.bytes.slice(0, readOptions.maxBytes),
          endOfFile: complete,
        });
      },
      async close() {
        assertOpen();
        record(`close-read:${key}`);
        closed = true;
      },
    });
  }

  function createWriteHandle(
    leaseState: LeaseState,
    key: string,
    file: StoredFile,
  ): CredentialFileExclusiveWriteHandle {
    let closed = false;
    let written = false;

    function assertOpen(): void {
      assertHeld(leaseState);
      if (closed || liveEntries.get(key) !== file) {
        throw new Error("in-memory mutation write handle is not current");
      }
    }

    return Object.freeze({
      async attest() {
        assertOpen();
        record(`attest-write:${key}`);
        return secureFileAttestation(key, file);
      },
      async writeAll(bytes: Uint8Array) {
        assertOpen();
        const operation = `write:${key}`;
        record(operation);
        const occurrence = beginMutation(operation);
        if (written) {
          throw new Error("in-memory temporary file was already written");
        }
        const ownedBytes = copyBytes(bytes);
        file.bytes = ownedBytes;
        file.durableBytes = undefined;
        file.revision += 1;
        written = true;
        advanceGeneration(key);
        completeMutation(operation, occurrence);
      },
      async sync() {
        assertOpen();
        const operation = `sync-file:${key}`;
        record(operation);
        const occurrence = beginMutation(operation);
        file.durableBytes = copyBytes(file.bytes);
        const durableFile = durableEntries.get(key);
        if (durableFile?.identity.object === file.identity.object) {
          durableFile.bytes = copyBytes(file.bytes);
          durableFile.durableBytes = copyBytes(file.bytes);
          durableFile.revision = file.revision;
        }
        completeMutation(operation, occurrence);
      },
      async close() {
        assertOpen();
        record(`close-write:${key}`);
        closed = true;
      },
    });
  }

  function makeLease(leaseState: LeaseState): CredentialStoreMutationLease {
    return Object.freeze({
      async attestDirectory() {
        assertHeld(leaseState);
        record("attest-directory");
        return secureDirectoryAttestation();
      },
      async renew() {
        if (leaseState.state === "crashed") {
          record("renew-lost");
          return Object.freeze({ status: "lost" as const });
        }
        assertHeld(leaseState);
        record("renew");
        renewCount += 1;
        if (options.loseLeaseAtRenew === renewCount) {
          return Object.freeze({ status: "lost" as const });
        }
        if (options.malformedLeaseAtRenew === renewCount) {
          return Object.freeze({
            status: "held" as const,
            unexpected: true,
          });
        }
        return Object.freeze({ status: "held" as const });
      },
      async observeEntry(
        rawEntry: CredentialManagedEntry,
      ): Promise<CredentialManagedEntryObservation> {
        assertHeld(leaseState);
        const entry = validateEntry(rawEntry);
        const key = entryName(entry);
        record(`observe:${key}`);
        const file = liveEntries.get(key);
        if (file === undefined) {
          return Object.freeze({
            status: "missing" as const,
            snapshot: mintMissingSnapshot(leaseState, key),
          });
        }
        return Object.freeze({
          status: "opened" as const,
          snapshot: mintPresentSnapshot(leaseState, key, file),
          attestation: secureFileAttestation(key, file),
          file: createReadHandle(leaseState, key, file),
        });
      },
      async listTemporaryEntries() {
        assertHeld(leaseState);
        record("list-temporary");
        const entries = [...liveEntries.values()]
          .filter(
            (file): file is StoredFile & {
              readonly entry: CredentialTemporaryEntry;
            } => file.entry.kind === "temporary",
          )
          .map((file) => validateEntry(file.entry) as CredentialTemporaryEntry)
          .sort((left, right) =>
            entryName(left).localeCompare(entryName(right)),
          );
        return Object.freeze(entries);
      },
      async createTemporaryExclusive(
        createOptions: Readonly<{
          entry: CredentialTemporaryEntry;
          expected: CredentialMissingEntrySnapshot;
        }>,
      ) {
        assertHeld(leaseState);
        const entry = validateEntry(
          createOptions.entry,
        ) as CredentialTemporaryEntry;
        const key = entryName(entry);
        const operation = `create:${key}`;
        record(operation);
        const occurrence = beginMutation(operation);
        if (
          !snapshotMatches(
            leaseState,
            createOptions.expected,
            key,
            "missing",
          )
        ) {
          return Object.freeze({ status: "conflict" as const });
        }
        const file = newStoredFile(entry, new Uint8Array(), false);
        liveEntries.set(key, file);
        advanceGeneration(key);
        completeMutation(operation, occurrence);
        return Object.freeze({
          status: "created" as const,
          file: createWriteHandle(leaseState, key, file),
        });
      },
      async moveTemporaryConditionally(
        moveOptions: Readonly<{
          source: CredentialTemporaryEntry;
          expectedSource: CredentialPresentEntrySnapshot;
          destination: CredentialCanonicalEntry;
          expectedDestination: CredentialEntrySnapshot;
        }>,
      ) {
        assertHeld(leaseState);
        const source = validateEntry(
          moveOptions.source,
        ) as CredentialTemporaryEntry;
        const destination = validateEntry(
          moveOptions.destination,
        ) as CredentialCanonicalEntry;
        const sourceKey = entryName(source);
        const destinationKey = entryName(destination);
        const operation = `move:${sourceKey}->${destinationKey}`;
        record(operation);
        const occurrence = beginMutation(operation);
        const destinationState = liveEntries.has(destinationKey)
          ? "present"
          : "missing";
        if (
          sourceKey === destinationKey ||
          !snapshotMatches(
            leaseState,
            moveOptions.expectedSource,
            sourceKey,
            "present",
          ) ||
          !snapshotMatches(
            leaseState,
            moveOptions.expectedDestination,
            destinationKey,
            destinationState,
          )
        ) {
          return Object.freeze({ status: "conflict" as const });
        }
        const sourceFile = liveEntries.get(sourceKey);
        if (sourceFile === undefined) {
          return Object.freeze({ status: "conflict" as const });
        }
        liveEntries.delete(sourceKey);
        sourceFile.entry = destination;
        sourceFile.revision += 1;
        liveEntries.set(destinationKey, sourceFile);
        advanceGeneration(sourceKey);
        advanceGeneration(destinationKey);
        completeMutation(operation, occurrence);
        return Object.freeze({ status: "moved" as const });
      },
      async removeConditionally(
        removeOptions: Readonly<{
          entry: CredentialManagedEntry;
          expected: CredentialPresentEntrySnapshot;
        }>,
      ) {
        assertHeld(leaseState);
        const entry = validateEntry(removeOptions.entry);
        const key = entryName(entry);
        const operation = `remove:${key}`;
        record(operation);
        const occurrence = beginMutation(operation);
        if (
          !snapshotMatches(
            leaseState,
            removeOptions.expected,
            key,
            "present",
          )
        ) {
          return Object.freeze({ status: "conflict" as const });
        }
        liveEntries.delete(key);
        advanceGeneration(key);
        completeMutation(operation, occurrence);
        return Object.freeze({ status: "removed" as const });
      },
      async syncDirectory() {
        assertHeld(leaseState);
        const operation = "sync-directory";
        record(operation);
        const occurrence = beginMutation(operation);
        durableDirectoryExists = directoryExists;
        const nextDurable = new Map<string, StoredFile>();
        for (const [key, file] of liveEntries) {
          if (file.durableBytes === undefined) {
            continue;
          }
          const durableFile = cloneStoredFile(file);
          durableFile.bytes = copyBytes(file.durableBytes);
          durableFile.durableBytes = copyBytes(file.durableBytes);
          nextDurable.set(key, durableFile);
        }
        durableEntries = nextDurable;
        completeMutation(operation, occurrence);
      },
      async release() {
        assertHeld(leaseState);
        record("release");
        releaseCount += 1;
        leaseState.state = "released";
        activeLease = undefined;
        if (
          releaseFailuresRemaining > 0 ||
          options.failReleaseAt === releaseCount
        ) {
          if (releaseFailuresRemaining > 0) {
            releaseFailuresRemaining -= 1;
          }
          abandonedLeaseEvidence = true;
          throw new Error("simulated in-memory release failure");
        }
        abandonedLeaseEvidence = false;
      },
      async abandon() {
        assertHeld(leaseState);
        record("abandon");
        leaseState.state = "abandoned";
        activeLease = undefined;
        abandonedLeaseEvidence = true;
      },
    });
  }

  function acquireLease(nonce: CredentialSetupLeaseNonce) {
    const directory: "existing" | "created" = directoryExists
      ? "existing"
      : "created";
    directoryExists = true;
    durableDirectoryExists = true;
    const priorLease = abandonedLeaseEvidence
      ? "proven-abandoned" as const
      : "absent" as const;
    abandonedLeaseEvidence = false;
    const leaseState: LeaseState = {
      id: nextLeaseId++,
      nonce,
      state: "held",
    };
    activeLease = leaseState;
    return Object.freeze({
      status: "acquired" as const,
      priorLease,
      directory,
      lease: makeLease(leaseState),
    });
  }

  const adapter: CredentialStoreObservedMutationAdapter = Object.freeze({
    async acquireSetupLease(
      _directory: string,
      acquireOptions: Readonly<{
        noFollow: true;
        createDirectory: true;
        nonce: CredentialSetupLeaseNonce;
      }>,
    ) {
      record("acquire-lease");
      if (
        acquireOptions.noFollow !== true ||
        acquireOptions.createDirectory !== true ||
        typeof acquireOptions.nonce !== "string" ||
        !UUID_V4.test(acquireOptions.nonce)
      ) {
        throw new Error("invalid in-memory lease acquisition");
      }
      if (activeLease?.state === "held") {
        return Object.freeze({ status: "busy" as const });
      }
      return acquireLease(acquireOptions.nonce);
    },
    async acquireObservedSetupLease(
      _directory: string,
      acquireOptions: Readonly<{
        noFollow: true;
        createDirectory: true;
        evidence: CredentialStoreWholePassEvidence;
      }>,
    ) {
      record("acquire-observed-lease");
      observedLeaseAcquireCount += 1;
      if (
        acquireOptions.noFollow !== true ||
        acquireOptions.createDirectory !== true ||
        acquireOptions.evidence === null ||
        typeof acquireOptions.evidence !== "object"
      ) {
        throw new Error("invalid in-memory observed lease acquisition");
      }
      const retained = wholePassEvidenceRecords.get(
        acquireOptions.evidence,
      );
      wholePassEvidenceRecords.delete(acquireOptions.evidence);
      if (
        activeLease?.state === "held" ||
        options.busyObservedLeaseAtAcquire === observedLeaseAcquireCount
      ) {
        return Object.freeze({ status: "busy" as const });
      }
      if (
        retained === undefined ||
        retained.directoryExists !== directoryExists ||
        retained.directoryRevision !== directoryRevision
      ) {
        return Object.freeze({
          status: "precondition-failed" as const,
        });
      }
      return acquireLease(
        "ffffffff-ffff-4fff-8fff-ffffffffffff" as CredentialSetupLeaseNonce,
      );
    },
  });

  const control: InMemoryCredentialMutationStoreControl = Object.freeze({
    observeWholePass() {
      record("control:observe-whole-pass");
      const evidence = Object.freeze({});
      wholePassEvidenceRecords.set(
        evidence,
        Object.freeze({ directoryExists, directoryRevision }),
      );
      return evidence as CredentialStoreWholePassEvidence;
    },
    seedCredential(bytes: Uint8Array) {
      replaceCredential(bytes, "control:seed-credential");
    },
    seedTransaction(bytes: Uint8Array) {
      replaceManaged(
        TRANSACTION_ENTRY,
        bytes,
        "control:seed-transaction",
      );
    },
    seedTemporary(entry: CredentialTemporaryEntry, bytes: Uint8Array) {
      const validated = validateEntry(entry) as CredentialTemporaryEntry;
      replaceManaged(
        validated,
        bytes,
        "control:seed-temporary",
      );
    },
    readCredential() {
      const file = liveEntries.get(CREDENTIAL_STORE_ENTRY);
      return file === undefined ? undefined : copyBytes(file.bytes);
    },
    readDurableCredential() {
      const file = durableEntries.get(CREDENTIAL_STORE_ENTRY);
      return file === undefined ? undefined : copyBytes(file.bytes);
    },
    replaceCredentialUnrelated(bytes: Uint8Array) {
      replaceCredential(bytes, "control:replace-credential-unrelated");
    },
    entries() {
      return Object.freeze(
        [...liveEntries.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, file]) =>
            Object.freeze({
              name,
              bytes: copyBytes(file.bytes),
            }),
          ),
      );
    },
    crash() {
      record("control:crash");
      crashState();
    },
  });

  const trace: InMemoryCredentialMutationStoreTrace = Object.freeze({
    operations: () => Object.freeze([...operationLog]),
  });

  return Object.freeze({ adapter, control, trace });
}
