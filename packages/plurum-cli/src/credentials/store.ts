import { CredentialError } from "./errors.js";
import type { ApiOriginPolicy } from "./origin.js";
import type { CredentialLocations } from "./paths.js";
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
  type CredentialStoreReadAdapter,
  type PrivateCredentialDirectoryHandle,
  type PrivateDirectoryAttestation,
} from "./store-contracts.js";

export type CredentialStoreMissingReason =
  | "directory_missing"
  | "credential_missing";

export type CredentialStoreReadResult =
  | Readonly<{
      status: "missing";
      reason: CredentialStoreMissingReason;
    }>
  | Readonly<{
      status: "loaded";
      credential: CredentialV1;
    }>;

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

interface Closeable {
  close(): Promise<void>;
}

type InspectedDirectoryOpenResult =
  | Readonly<{ status: "missing" }>
  | Readonly<{
      status: "opened";
      directory: PrivateCredentialDirectoryHandle;
    }>
  | Readonly<{ status: "invalid"; possibleHandle: unknown }>;

type InspectedFileOpenResult =
  | Readonly<{ status: "missing" }>
  | Readonly<{
      status: "opened";
      file: CredentialFileReadHandle;
    }>
  | Readonly<{ status: "invalid"; possibleHandle: unknown }>;

const DIRECTORY_OPEN_OPTIONS = Object.freeze({ noFollow: true as const });
const FILE_OPEN_OPTIONS = Object.freeze({
  entry: CREDENTIAL_STORE_ENTRY,
  noFollow: true as const,
});
const READ_OPTIONS = Object.freeze({
  maxBytes: MAX_CREDENTIAL_DOCUMENT_BYTES + 1,
});
const DIRECTORY_MISSING = Object.freeze({
  status: "missing" as const,
  reason: "directory_missing" as const,
});
const CREDENTIAL_MISSING = Object.freeze({
  status: "missing" as const,
  reason: "credential_missing" as const,
});
const MAX_IDENTITY_PART_CHARACTERS = 512;
const OPAQUE_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

function storeUnavailable(): never {
  throw new CredentialError("credential_store_unavailable");
}

function unsafeStore(): never {
  throw new CredentialError("unsafe_credential_store");
}

function documentTooLarge(): never {
  throw new CredentialError("credential_document_too_large");
}

function wipeBytes(bytes: Uint8Array): void {
  try {
    Uint8Array.prototype.fill.call(bytes, 0);
  } catch {
    // Best effort only; never replace the safe store result or error.
  }
}

async function callAdapter<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    return storeUnavailable();
  }
}

async function useResource<T extends Closeable, R>(
  resource: T,
  operation: (value: T) => Promise<R>,
): Promise<R> {
  let operationFailed = false;
  let operationFailure: unknown;
  let result: R | undefined;

  try {
    result = await operation(resource);
  } catch (error) {
    operationFailed = true;
    operationFailure = error;
  }

  try {
    await callAdapter(() => resource.close());
  } catch (closeFailure) {
    operationFailed = true;
    operationFailure = closeFailure;
  }

  if (operationFailed) {
    if (operationFailure instanceof CredentialError) {
      throw operationFailure;
    }
    return storeUnavailable();
  }
  return result as R;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCallable(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

function isCloseable(value: unknown): value is Closeable {
  try {
    return isRecord(value) && isCallable(value.close);
  } catch {
    return false;
  }
}

function isDirectoryHandle(
  value: unknown,
): value is PrivateCredentialDirectoryHandle {
  try {
    return (
      isCloseable(value) &&
      isRecord(value) &&
      isCallable(value.attest) &&
      isCallable(value.openCredentialReadOnly)
    );
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

async function closeMalformedHandle(value: unknown): Promise<never> {
  if (isCloseable(value)) {
    await callAdapter(() => value.close());
  }
  return storeUnavailable();
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
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

function copyOpaquePart(value: unknown): string | null {
  try {
    return typeof value === "string" &&
      value.length > 0 &&
      value.length <= MAX_IDENTITY_PART_CHARACTERS &&
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

function directorySnapshot(value: PrivateDirectoryAttestation): DirectorySnapshot | null {
  try {
    const kind = value.kind;
    const binding = value.binding;
    const owner = value.owner;
    const access = value.access;
    const link = value.link;
    const rawIdentity = value.identity;
    const rawRevision = value.revision;
    if (
      !isRecord(value) ||
      kind !== "directory" ||
      binding !== "canonical-current" ||
      owner !== "current-user" ||
      access !== "user-only" ||
      link !== "direct"
    ) {
      return null;
    }
    const identity = copyIdentity(rawIdentity);
    const revision = copyOpaquePart(rawRevision);
    if (identity === null || revision === null) {
      return null;
    }
    return Object.freeze({ identity, revision });
  } catch {
    return null;
  }
}

function fileSnapshot(
  value: CredentialFileAttestation,
  directoryIdentity: CredentialObjectIdentity,
): FileSnapshot | "too-large" | null {
  try {
    const kind = value.kind;
    const binding = value.binding;
    const owner = value.owner;
    const access = value.access;
    const link = value.link;
    const links = value.links;
    const size = value.size;
    const rawIdentity = value.identity;
    const rawParentIdentity = value.parentIdentity;
    const rawRevision = value.revision;
    if (
      !isRecord(value) ||
      kind !== "regular-file" ||
      binding !== "canonical-current" ||
      owner !== "current-user" ||
      access !== "user-only" ||
      link !== "direct" ||
      links !== 1 ||
      !Number.isSafeInteger(size) ||
      size < 0
    ) {
      return null;
    }
    const identity = copyIdentity(rawIdentity);
    const parentIdentity = copyIdentity(rawParentIdentity);
    const revision = copyOpaquePart(rawRevision);
    if (
      identity === null ||
      parentIdentity === null ||
      revision === null ||
      identitiesEqual(identity, directoryIdentity) ||
      !identitiesEqual(parentIdentity, directoryIdentity)
    ) {
      return null;
    }
    if (size > MAX_CREDENTIAL_DOCUMENT_BYTES) {
      return "too-large";
    }
    return Object.freeze({
      identity,
      parentIdentity,
      revision,
      size,
    });
  } catch {
    return null;
  }
}

function directorySnapshotsEqual(
  left: DirectorySnapshot,
  right: DirectorySnapshot,
): boolean {
  return (
    identitiesEqual(left.identity, right.identity) &&
    left.revision === right.revision
  );
}

function fileSnapshotsEqual(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    identitiesEqual(left.identity, right.identity) &&
    identitiesEqual(left.parentIdentity, right.parentIdentity) &&
    left.revision === right.revision &&
    left.size === right.size
  );
}

function directoryOpenResult(
  value: unknown,
): InspectedDirectoryOpenResult {
  try {
    if (!isRecord(value)) {
      return Object.freeze({ status: "invalid", possibleHandle: undefined });
    }
    const status = value.status;
    const possibleHandle = value.directory;
    if (status === "missing" && hasExactKeys(value, ["status"])) {
      return Object.freeze({ status: "missing" });
    }
    if (
      status === "opened" &&
      hasExactKeys(value, ["status", "directory"]) &&
      isDirectoryHandle(possibleHandle)
    ) {
      return Object.freeze({
        status: "opened",
        directory: possibleHandle,
      });
    }
    return Object.freeze({ status: "invalid", possibleHandle });
  } catch {
    return Object.freeze({ status: "invalid", possibleHandle: undefined });
  }
}

function fileOpenResult(value: unknown): InspectedFileOpenResult {
  try {
    if (!isRecord(value)) {
      return Object.freeze({ status: "invalid", possibleHandle: undefined });
    }
    const status = value.status;
    const possibleHandle = value.file;
    if (status === "missing" && hasExactKeys(value, ["status"])) {
      return Object.freeze({ status: "missing" });
    }
    if (
      status === "opened" &&
      hasExactKeys(value, ["status", "file"]) &&
      isFileHandle(possibleHandle)
    ) {
      return Object.freeze({ status: "opened", file: possibleHandle });
    }
    return Object.freeze({ status: "invalid", possibleHandle });
  } catch {
    return Object.freeze({ status: "invalid", possibleHandle: undefined });
  }
}

async function attestDirectory(
  directory: PrivateCredentialDirectoryHandle,
): Promise<DirectorySnapshot> {
  const attestation = await callAdapter(() => directory.attest());
  const snapshot = directorySnapshot(attestation);
  return snapshot ?? unsafeStore();
}

async function attestFile(
  file: CredentialFileReadHandle,
  directoryIdentity: CredentialObjectIdentity,
): Promise<FileSnapshot> {
  const attestation = await callAdapter(() => file.attest());
  const snapshot = fileSnapshot(attestation, directoryIdentity);
  if (snapshot === "too-large") {
    return documentTooLarge();
  }
  return snapshot ?? unsafeStore();
}

async function readOpenedCredential(
  file: CredentialFileReadHandle,
  directoryIdentity: CredentialObjectIdentity,
  originPolicy: ApiOriginPolicy,
): Promise<CredentialStoreReadResult> {
  return useResource(file, async (openedFile) => {
    const before = await attestFile(openedFile, directoryIdentity);
    const bounded = await callAdapter(() =>
      openedFile.readBounded(READ_OPTIONS),
    );

    let bytes: Uint8Array;
    let endOfFile: boolean;
    try {
      const rawBytes = bounded.bytes;
      const rawEndOfFile = bounded.endOfFile;
      if (
        !isRecord(bounded) ||
        !(rawBytes instanceof Uint8Array) ||
        typeof rawEndOfFile !== "boolean"
      ) {
        return storeUnavailable();
      }
      bytes = Uint8Array.prototype.slice.call(rawBytes);
      if (bytes.byteLength > READ_OPTIONS.maxBytes) {
        wipeBytes(bytes);
        return storeUnavailable();
      }
      endOfFile = rawEndOfFile;
    } catch {
      return storeUnavailable();
    }

    try {
      const after = await attestFile(openedFile, directoryIdentity);
      if (
        !fileSnapshotsEqual(before, after) ||
        !endOfFile ||
        bytes.byteLength > MAX_CREDENTIAL_DOCUMENT_BYTES ||
        bytes.byteLength !== before.size
      ) {
        return unsafeStore();
      }
      const credential = parseCredentialDocumentBytes(bytes, originPolicy);
      return Object.freeze({
        status: "loaded",
        credential,
      });
    } finally {
      wipeBytes(bytes);
    }
  });
}

async function readFromDirectory(
  directory: PrivateCredentialDirectoryHandle,
  originPolicy: ApiOriginPolicy,
): Promise<CredentialStoreReadResult> {
  return useResource(directory, async (openedDirectory) => {
    const before = await attestDirectory(openedDirectory);
    const rawOpenResult = await callAdapter(() =>
      openedDirectory.openCredentialReadOnly(FILE_OPEN_OPTIONS),
    );
    const openResult = fileOpenResult(rawOpenResult);
    if (openResult.status === "invalid") {
      return closeMalformedHandle(openResult.possibleHandle);
    }

    let result: CredentialStoreReadResult;
    if (openResult.status === "missing") {
      result = CREDENTIAL_MISSING;
    } else {
      result = await readOpenedCredential(
        openResult.file,
        before.identity,
        originPolicy,
      );
    }

    const after = await attestDirectory(openedDirectory);
    if (!directorySnapshotsEqual(before, after)) {
      return unsafeStore();
    }
    return result;
  });
}

export async function readCredentialStore(
  adapter: CredentialStoreReadAdapter,
  locations: Pick<CredentialLocations, "directory">,
  originPolicy: ApiOriginPolicy = "https-only",
): Promise<CredentialStoreReadResult> {
  let directory: string;
  try {
    directory = locations.directory;
  } catch {
    return storeUnavailable();
  }
  if (typeof directory !== "string" || directory.length === 0) {
    return storeUnavailable();
  }

  const rawOpenResult = await callAdapter(() =>
    adapter.openPrivateDirectory(directory, DIRECTORY_OPEN_OPTIONS),
  );
  const openResult = directoryOpenResult(rawOpenResult);
  if (openResult.status === "invalid") {
    return closeMalformedHandle(openResult.possibleHandle);
  }
  if (openResult.status === "missing") {
    return DIRECTORY_MISSING;
  }
  return readFromDirectory(openResult.directory, originPolicy);
}
