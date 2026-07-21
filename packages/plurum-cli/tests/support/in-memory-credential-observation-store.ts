import type {
  BoundedCredentialRead,
  CredentialFileAttestation,
  CredentialFileReadHandle,
  PrivateDirectoryAttestation,
} from "../../src/credentials/store-contracts.js";
import type {
  CredentialManagedEntry,
  CredentialTemporaryEntry,
} from "../../src/credentials/store-mutation-contracts.js";
import type {
  CredentialStoreNativeObservationEvidence,
  CredentialStoreObservationAdapter,
  CredentialStoreObservationDirectoryHandle,
} from "../../src/credentials/store-observation-contracts.js";

export type CredentialObservationFakeOperation =
  | "open-directory"
  | `attest-directory:${number}`
  | `observe:${string}`
  | `attest-file:${string}:${number}`
  | `read-file:${string}`
  | `close-file:${string}`
  | "list-temporary"
  | "finish-observation"
  | "close-directory";

export interface InMemoryCredentialObservationStoreOptions {
  readonly directoryMissing?: boolean;
  readonly credentialBytes?: Uint8Array;
  readonly transactionBytes?: Uint8Array;
  readonly temporaries?: readonly CredentialTemporaryEntry[];
  readonly missingTemporaryKeys?: readonly string[];
  readonly directoryAttestations?: readonly PrivateDirectoryAttestation[];
  readonly failAt?: readonly CredentialObservationFakeOperation[];
  readonly endOfFile?: boolean;
  readonly listResult?: unknown;
  readonly openResult?: unknown;
  readonly finishEvidence?: unknown;
  readonly onOperation?: (operation: CredentialObservationFakeOperation) => void;
}

export interface InMemoryCredentialObservationStore {
  readonly adapter: CredentialStoreObservationAdapter;
  readonly operations: () => readonly CredentialObservationFakeOperation[];
  readonly directories: () => readonly string[];
  readonly openOptions: () => readonly Readonly<{ noFollow: true }>[];
  readonly entryOptions: () => readonly Readonly<{
    entry: CredentialManagedEntry;
    noFollow: true;
  }>[];
  readonly readOptions: () => readonly Readonly<{ maxBytes: number }>[];
}

const DIRECTORY_IDENTITY = Object.freeze({
  volume: "memory-volume",
  object: "credential-directory",
});

export function secureObservationDirectoryAttestation(
  overrides: Partial<PrivateDirectoryAttestation> = {},
): PrivateDirectoryAttestation {
  return Object.freeze({
    kind: "directory",
    identity: DIRECTORY_IDENTITY,
    revision: "directory-revision-1",
    binding: "canonical-current",
    owner: "current-user",
    access: "user-only",
    link: "direct",
    ...overrides,
  });
}

function entryKey(entry: CredentialManagedEntry): string {
  return entry.kind === "canonical"
    ? entry.role
    : `${entry.role}:${entry.transactionId}`;
}

function secureFileAttestation(
  key: string,
  size: number,
): CredentialFileAttestation {
  return Object.freeze({
    kind: "regular-file",
    identity: Object.freeze({
      volume: "memory-volume",
      object: `file-${key}`,
    }),
    parentIdentity: DIRECTORY_IDENTITY,
    revision: `revision-${key}`,
    binding: "canonical-current",
    owner: "current-user",
    access: "user-only",
    link: "direct",
    links: 1,
    size,
  });
}

function at<T>(values: readonly T[], index: number): T {
  const value = values[Math.min(index, values.length - 1)];
  if (value === undefined) {
    throw new Error("in-memory observation fixture is incomplete");
  }
  return value;
}

export function createInMemoryCredentialObservationStore(
  options: InMemoryCredentialObservationStoreOptions = {},
): InMemoryCredentialObservationStore {
  const operations: CredentialObservationFakeOperation[] = [];
  const directories: string[] = [];
  const directoryOpenOptions: Readonly<{ noFollow: true }>[] = [];
  const observedEntryOptions: Readonly<{
    entry: CredentialManagedEntry;
    noFollow: true;
  }>[] = [];
  const readOptions: Readonly<{ maxBytes: number }>[] = [];
  const failures = new Set(options.failAt ?? []);
  const temporaries = Object.freeze([...(options.temporaries ?? [])]);
  const temporaryByKey = new Map(
    temporaries.map((entry) => [entryKey(entry), entry] as const),
  );
  const missingTemporaries = new Set(options.missingTemporaryKeys ?? []);
  const directoryAttestations = options.directoryAttestations ?? [
    secureObservationDirectoryAttestation(),
  ];
  let directoryAttestationIndex = 0;

  function record(operation: CredentialObservationFakeOperation): void {
    operations.push(operation);
    options.onOperation?.(operation);
    if (failures.has(operation)) {
      throw new Error("in-memory observation failure");
    }
  }

  function bytesFor(entry: CredentialManagedEntry): Uint8Array | undefined {
    if (entry.kind === "canonical" && entry.role === "credential") {
      return options.credentialBytes;
    }
    if (entry.kind === "canonical" && entry.role === "transaction") {
      return options.transactionBytes;
    }
    return temporaryByKey.has(entryKey(entry)) ? new Uint8Array() : undefined;
  }

  function openedEntry(entry: CredentialManagedEntry, bytes: Uint8Array) {
    const key = entryKey(entry);
    const attestation = secureFileAttestation(key, bytes.byteLength);
    let attestationCount = 0;
    const file: CredentialFileReadHandle = Object.freeze({
      async attest() {
        attestationCount += 1;
        record(`attest-file:${key}:${attestationCount}`);
        return attestation;
      },
      async readBounded(
        request: Readonly<{ maxBytes: number }>,
      ): Promise<BoundedCredentialRead> {
        record(`read-file:${key}`);
        readOptions.push(Object.freeze({ maxBytes: request.maxBytes }));
        const complete = bytes.byteLength <= request.maxBytes;
        return Object.freeze({
          bytes: complete ? bytes : bytes.slice(0, request.maxBytes),
          endOfFile: options.endOfFile ?? complete,
        });
      },
      async close() {
        record(`close-file:${key}`);
      },
    });
    return Object.freeze({
      status: "opened" as const,
      attestation,
      file,
    });
  }

  const directory: CredentialStoreObservationDirectoryHandle = Object.freeze({
    async attest() {
      directoryAttestationIndex += 1;
      record(`attest-directory:${directoryAttestationIndex}`);
      return at(directoryAttestations, directoryAttestationIndex - 1);
    },
    async observeEntry(request: Readonly<{
      entry: CredentialManagedEntry;
      noFollow: true;
    }>) {
      const copied = Object.freeze({
        entry: request.entry,
        noFollow: request.noFollow,
      });
      observedEntryOptions.push(copied);
      const key = entryKey(request.entry);
      record(`observe:${key}`);
      if (missingTemporaries.has(key)) {
        return Object.freeze({ status: "missing" as const });
      }
      const bytes = bytesFor(request.entry);
      return bytes === undefined
        ? Object.freeze({ status: "missing" as const })
        : openedEntry(request.entry, bytes);
    },
    async listTemporaryEntries() {
      record("list-temporary");
      return (options.listResult ?? temporaries) as readonly CredentialTemporaryEntry[];
    },
    async finishObservation() {
      record("finish-observation");
      const evidence = options.finishEvidence ?? Object.freeze({});
      return evidence as CredentialStoreNativeObservationEvidence;
    },
    async close() {
      record("close-directory");
    },
  });

  const adapter: CredentialStoreObservationAdapter = Object.freeze({
    async openPrivateDirectory(
      path: string,
      request: Readonly<{ noFollow: true }>,
    ) {
      record("open-directory");
      directories.push(path);
      directoryOpenOptions.push(Object.freeze({ noFollow: request.noFollow }));
      if (options.openResult !== undefined) {
        return options.openResult as never;
      }
      if (options.directoryMissing === true) {
        return Object.freeze({
          status: "missing" as const,
          evidence: Object.freeze({}) as CredentialStoreNativeObservationEvidence,
        });
      }
      return Object.freeze({ status: "opened" as const, directory });
    },
  });

  return Object.freeze({
    adapter,
    operations: () => Object.freeze([...operations]),
    directories: () => Object.freeze([...directories]),
    openOptions: () => Object.freeze([...directoryOpenOptions]),
    entryOptions: () => Object.freeze([...observedEntryOptions]),
    readOptions: () => Object.freeze([...readOptions]),
  });
}
