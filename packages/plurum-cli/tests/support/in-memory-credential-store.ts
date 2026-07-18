import type {
  BoundedCredentialRead,
  CredentialFileAttestation,
  CredentialFileReadHandle,
  CredentialStoreReadAdapter,
  PrivateCredentialDirectoryHandle,
  PrivateDirectoryAttestation,
} from "../../src/credentials/store-contracts.js";

export type CredentialStoreFakeOperation =
  | "open-directory"
  | `attest-directory:${number}`
  | "open-credential"
  | `attest-file:${number}`
  | "read-file"
  | "close-file"
  | "close-directory";

export interface InMemoryCredentialStoreOptions {
  readonly bytes?: Uint8Array;
  readonly directoryMissing?: boolean;
  readonly credentialMissing?: boolean;
  readonly directoryAttestations?: readonly PrivateDirectoryAttestation[];
  readonly fileAttestations?: readonly CredentialFileAttestation[];
  readonly endOfFile?: boolean;
  readonly failAt?: readonly CredentialStoreFakeOperation[];
  readonly failureMessage?: string;
  readonly onOperation?: (operation: CredentialStoreFakeOperation) => void;
}

export interface CredentialStoreFakeTrace {
  operations(): readonly CredentialStoreFakeOperation[];
  directories(): readonly string[];
  directoryOpenOptions(): readonly Readonly<{ noFollow: true }>[];
  credentialOpenOptions(): readonly Readonly<{
    entry: "credentials.json";
    noFollow: true;
  }>[];
  readOptions(): readonly Readonly<{ maxBytes: number }>[];
}

export interface InMemoryCredentialStore {
  readonly adapter: CredentialStoreReadAdapter;
  readonly trace: CredentialStoreFakeTrace;
}

const DIRECTORY_IDENTITY = Object.freeze({
  volume: "memory-volume",
  object: "credential-directory",
});
const FILE_IDENTITY = Object.freeze({
  volume: "memory-volume",
  object: "credential-file",
});

export function secureDirectoryAttestation(
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

export function secureFileAttestation(
  size: number,
  overrides: Partial<CredentialFileAttestation> = {},
): CredentialFileAttestation {
  return Object.freeze({
    kind: "regular-file",
    identity: FILE_IDENTITY,
    parentIdentity: DIRECTORY_IDENTITY,
    revision: "file-revision-1",
    binding: "canonical-current",
    owner: "current-user",
    access: "user-only",
    link: "direct",
    links: 1,
    size,
    ...overrides,
  });
}

function itemAt<T>(items: readonly T[], index: number): T {
  const item = items[Math.min(index, items.length - 1)];
  if (item === undefined) {
    throw new Error("in-memory credential-store fixture is incomplete");
  }
  return item;
}

export function createInMemoryCredentialStore(
  options: InMemoryCredentialStoreOptions = {},
): InMemoryCredentialStore {
  const bytes = options.bytes ?? new Uint8Array();
  const directoryAttestations =
    options.directoryAttestations ?? [secureDirectoryAttestation()];
  const fileAttestations =
    options.fileAttestations ?? [secureFileAttestation(bytes.byteLength)];
  const failures = new Set(options.failAt ?? []);
  const operations: CredentialStoreFakeOperation[] = [];
  const directories: string[] = [];
  const directoryOpenOptions: Readonly<{ noFollow: true }>[] = [];
  const credentialOpenOptions: Readonly<{
    entry: "credentials.json";
    noFollow: true;
  }>[] = [];
  const readOptions: Readonly<{ maxBytes: number }>[] = [];
  let directoryAttestationIndex = 0;
  let fileAttestationIndex = 0;

  function record(operation: CredentialStoreFakeOperation): void {
    operations.push(operation);
    options.onOperation?.(operation);
    if (failures.has(operation)) {
      throw new Error(options.failureMessage ?? "in-memory adapter failure");
    }
  }

  const file: CredentialFileReadHandle = Object.freeze({
    async attest() {
      const operation =
        `attest-file:${fileAttestationIndex + 1}` as const;
      record(operation);
      const attestation = itemAt(fileAttestations, fileAttestationIndex);
      fileAttestationIndex += 1;
      return attestation;
    },
    async readBounded(
      readOption: Readonly<{ maxBytes: number }>,
    ): Promise<BoundedCredentialRead> {
      record("read-file");
      readOptions.push(Object.freeze({ maxBytes: readOption.maxBytes }));
      const complete = bytes.byteLength <= readOption.maxBytes;
      return {
        bytes: complete ? bytes : bytes.slice(0, readOption.maxBytes),
        endOfFile: options.endOfFile ?? complete,
      };
    },
    async close() {
      record("close-file");
    },
  });

  const directory: PrivateCredentialDirectoryHandle = Object.freeze({
    async attest() {
      const operation =
        `attest-directory:${directoryAttestationIndex + 1}` as const;
      record(operation);
      const attestation = itemAt(
        directoryAttestations,
        directoryAttestationIndex,
      );
      directoryAttestationIndex += 1;
      return attestation;
    },
    async openCredentialReadOnly(
      openOptions: Readonly<{
        entry: "credentials.json";
        noFollow: true;
      }>,
    ) {
      record("open-credential");
      credentialOpenOptions.push(
        Object.freeze({
          entry: openOptions.entry,
          noFollow: openOptions.noFollow,
        }),
      );
      if (options.credentialMissing === true) {
        return Object.freeze({ status: "missing" as const });
      }
      return Object.freeze({ status: "opened" as const, file });
    },
    async close() {
      record("close-directory");
    },
  });

  const adapter: CredentialStoreReadAdapter = Object.freeze({
    async openPrivateDirectory(
      targetDirectory: string,
      openOptions: Readonly<{ noFollow: true }>,
    ) {
      record("open-directory");
      directories.push(targetDirectory);
      directoryOpenOptions.push(
        Object.freeze({ noFollow: openOptions.noFollow }),
      );
      if (options.directoryMissing === true) {
        return Object.freeze({ status: "missing" as const });
      }
      return Object.freeze({ status: "opened" as const, directory });
    },
  });

  const trace: CredentialStoreFakeTrace = Object.freeze({
    operations: () => Object.freeze([...operations]),
    directories: () => Object.freeze([...directories]),
    directoryOpenOptions: () => Object.freeze([...directoryOpenOptions]),
    credentialOpenOptions: () => Object.freeze([...credentialOpenOptions]),
    readOptions: () => Object.freeze([...readOptions]),
  });

  return Object.freeze({ adapter, trace });
}
