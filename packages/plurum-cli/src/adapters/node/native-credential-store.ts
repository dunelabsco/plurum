import type {
  CredentialCanonicalEntry,
  CredentialConditionalMoveResult,
  CredentialConditionalRemoveResult,
  CredentialEntrySnapshot,
  CredentialExclusiveCreateResult,
  CredentialFileExclusiveWriteHandle,
  CredentialManagedEntry,
  CredentialManagedEntryObservation,
  CredentialMissingEntrySnapshot,
  CredentialPresentEntrySnapshot,
  CredentialSetupLeaseAcquireResult,
  CredentialStoreMutationAdapter,
  CredentialStoreMutationLease,
  CredentialSetupLeaseNonce,
  CredentialTemporaryEntry,
  CredentialTemporaryEntryRole,
} from "../../credentials/store-mutation-contracts.js";
import type {
  BoundedCredentialRead,
  CredentialAccessAttestation,
  CredentialBindingAttestation,
  CredentialFileAttestation,
  CredentialFileOpenResult,
  CredentialFileReadHandle,
  CredentialLinkAttestation,
  CredentialObjectIdentity,
  CredentialOwnerAttestation,
  CredentialStoreReadAdapter,
  PrivateCredentialDirectoryHandle,
  PrivateCredentialDirectoryOpenResult,
  PrivateDirectoryAttestation,
} from "../../credentials/store-contracts.js";
import { CLI_VERSION } from "../../version.js";

export const NATIVE_CREDENTIAL_STORE_MAGIC =
  "plurum-native-credential-store" as const;
export const NATIVE_CREDENTIAL_STORE_ABI_VERSION = 1 as const;
export const NATIVE_CREDENTIAL_STORE_NODE_API_VERSION = 8 as const;

export const NATIVE_CREDENTIAL_TARGET_IDS = Object.freeze([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64-gnu",
  "linux-arm64-musl",
  "linux-x64-gnu",
  "linux-x64-musl",
  "win32-arm64-msvc",
  "win32-x64-msvc",
] as const);

export type NativeCredentialTarget =
  (typeof NATIVE_CREDENTIAL_TARGET_IDS)[number];

/*
 * This resolver is deliberately injected. The boundary does not import a
 * native binary, inspect module paths, or select an npm package. A later,
 * separately reviewed Node bridge may resolve one fixed package for one exact
 * target after every native platform suite passes.
 */
export type NativeCredentialModuleResolver = (
  target: NativeCredentialTarget,
) => unknown;

export type NativeCredentialStoreLoadResult =
  | Readonly<{
      status: "available";
      read: CredentialStoreReadAdapter;
      mutation: CredentialStoreMutationAdapter;
    }>
  | Readonly<{
      status: "unavailable";
      code: "native_credential_store_unavailable";
    }>;

export interface NativeCredentialStoreProvider {
  /*
   * Loading is explicit, synchronous, and memoized. Constructing or importing
   * this provider never resolves or instantiates native code.
   */
  load(): NativeCredentialStoreLoadResult;
}

const MODULE_KEYS = Object.freeze([
  "abiVersion",
  "createAdapters",
  "magic",
  "nodeApiVersion",
  "packageVersion",
  "target",
] as const);
const ADAPTER_PAIR_KEYS = Object.freeze(["mutation", "read"] as const);
const READ_OPTIONS_KEYS = Object.freeze(["noFollow"] as const);
const MUTATION_OPTIONS_KEYS = Object.freeze([
  "createDirectory",
  "noFollow",
  "nonce",
] as const);
const READ_ADAPTER_KEYS = Object.freeze(["openPrivateDirectory"] as const);
const MUTATION_ADAPTER_KEYS = Object.freeze(["acquireSetupLease"] as const);
const DIRECTORY_HANDLE_KEYS = Object.freeze([
  "attest",
  "close",
  "openCredentialReadOnly",
] as const);
const READ_HANDLE_KEYS = Object.freeze([
  "attest",
  "close",
  "readBounded",
] as const);
const WRITE_HANDLE_KEYS = Object.freeze([
  "attest",
  "close",
  "sync",
  "writeAll",
] as const);
const LEASE_KEYS = Object.freeze([
  "abandon",
  "attestDirectory",
  "createTemporaryExclusive",
  "listTemporaryEntries",
  "moveTemporaryConditionally",
  "observeEntry",
  "release",
  "removeConditionally",
  "renew",
  "syncDirectory",
] as const);
const DIRECTORY_ATTESTATION_KEYS = Object.freeze([
  "access",
  "binding",
  "identity",
  "kind",
  "link",
  "owner",
  "revision",
] as const);
const FILE_ATTESTATION_KEYS = Object.freeze([
  "access",
  "binding",
  "identity",
  "kind",
  "link",
  "links",
  "owner",
  "parentIdentity",
  "revision",
  "size",
] as const);
const IDENTITY_KEYS = Object.freeze(["object", "volume"] as const);
const CANONICAL_ENTRY_KEYS = Object.freeze([
  "kind",
  "name",
  "role",
] as const);
const TEMPORARY_ENTRY_KEYS = Object.freeze([
  "kind",
  "role",
  "transactionId",
] as const);
const MAX_OPAQUE_CHARACTERS = 512;
const MAX_NATIVE_READ_BYTES = 40_961;
const MAX_NATIVE_WRITE_BYTES = 40_960;
const MAX_NATIVE_TEMPORARY_ENTRIES = 1_024;
const RECOGNIZED_TARGETS = new Set<string>(NATIVE_CREDENTIAL_TARGET_IDS);
const UNAVAILABLE = Object.freeze({
  status: "unavailable" as const,
  code: "native_credential_store_unavailable" as const,
});
const INVALID_ADAPTER_REQUEST =
  "The native credential adapter request is invalid.";
const NATIVE_OPERATION_FAILED = "The native credential operation failed.";
const LOWERCASE_UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPAQUE_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const FREEZE = Object.freeze;
const ARRAY_IS_ARRAY = Array.isArray;
const HAS_OWN = Object.prototype.hasOwnProperty;
const BASE_UINT8_ARRAY = Uint8Array;
const UINT8_FILL = Uint8Array.prototype.fill;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)?.get;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "buffer",
)?.get;
const SHARED_BUFFER_BYTE_LENGTH_GETTER =
  typeof SharedArrayBuffer === "undefined"
    ? undefined
    : Object.getOwnPropertyDescriptor(
        SharedArrayBuffer.prototype,
        "byteLength",
      )?.get;

type UnknownRecord = Record<string, unknown>;
type RawFunction = (...args: never[]) => unknown;

interface NativeCredentialModuleSnapshot {
  readonly receiver: UnknownRecord;
  readonly createAdapters: RawFunction;
}

interface NativeCredentialAdapterPairSnapshot {
  readonly readReceiver: UnknownRecord;
  readonly mutationReceiver: UnknownRecord;
  readonly openPrivateDirectory: RawFunction;
  readonly acquireSetupLease: RawFunction;
}

interface CapturedRawHandle {
  readonly receiver: UnknownRecord;
  readonly methods: Readonly<Record<string, RawFunction>>;
}

interface ChildLifecycleState {
  active: boolean;
  readonly children: Set<InvalidatableHandle>;
}

interface LeaseMembraneState extends ChildLifecycleState {
  readonly snapshots: WeakMap<object, RawSnapshot>;
}

interface RawSnapshot {
  readonly kind: "missing" | "present";
  readonly value: object;
}

interface InvalidatableHandle {
  invalidate(): void;
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !ARRAY_IS_ARRAY(value);
}

function hasExactOwnKeys(
  value: UnknownRecord,
  expected: readonly string[],
): boolean {
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string")) {
    return false;
  }
  actual.sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function suppressUnexpectedPromiseRejection(value: unknown): void {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return;
  }
  try {
    void Reflect.apply(Promise.prototype.then, value, [
      undefined,
      () => undefined,
    ]);
  } catch {
    // Non-Promise thenables are rejected without invoking their code.
  }
}

function captureRawField(value: UnknownRecord, name: string): unknown {
  const candidate = value[name];
  suppressUnexpectedPromiseRejection(candidate);
  return candidate;
}

function parseModuleDescriptor(
  value: unknown,
  target: NativeCredentialTarget,
): NativeCredentialModuleSnapshot | undefined {
  if (!isRecord(value) || !hasExactOwnKeys(value, MODULE_KEYS)) {
    return undefined;
  }

  const magic = captureRawField(value, "magic");
  const abiVersion = captureRawField(value, "abiVersion");
  const nodeApiVersion = captureRawField(value, "nodeApiVersion");
  const packageVersion = captureRawField(value, "packageVersion");
  const moduleTarget = captureRawField(value, "target");
  const createAdapters = captureRawField(value, "createAdapters");
  if (
    magic !== NATIVE_CREDENTIAL_STORE_MAGIC ||
    abiVersion !== NATIVE_CREDENTIAL_STORE_ABI_VERSION ||
    nodeApiVersion !== NATIVE_CREDENTIAL_STORE_NODE_API_VERSION ||
    packageVersion !== CLI_VERSION ||
    moduleTarget !== target ||
    typeof createAdapters !== "function"
  ) {
    return undefined;
  }

  return Object.freeze({
    receiver: value,
    createAdapters: createAdapters as RawFunction,
  });
}

function validReadRequest(
  directory: unknown,
  options: unknown,
): options is Readonly<{ noFollow: true }> {
  return (
    typeof directory === "string" &&
    directory.length > 0 &&
    isRecord(options) &&
    hasExactOwnKeys(options, READ_OPTIONS_KEYS) &&
    options.noFollow === true
  );
}

function parseMutationRequest(
  directory: unknown,
  options: unknown,
): CredentialSetupLeaseNonce | undefined {
  if (
    typeof directory !== "string" ||
    directory.length === 0 ||
    !isRecord(options) ||
    !hasExactOwnKeys(options, MUTATION_OPTIONS_KEYS)
  ) {
    return undefined;
  }

  const noFollow = options.noFollow;
  const createDirectory = options.createDirectory;
  const nonce = options.nonce;
  if (
    noFollow !== true ||
    createDirectory !== true ||
    typeof nonce !== "string" ||
    !LOWERCASE_UUID_V4.test(nonce)
  ) {
    return undefined;
  }
  return nonce as CredentialSetupLeaseNonce;
}

function parseAdapterPair(
  value: unknown,
): NativeCredentialAdapterPairSnapshot | undefined {
  if (!isRecord(value) || !hasExactOwnKeys(value, ADAPTER_PAIR_KEYS)) {
    return undefined;
  }

  const readReceiver = captureRawField(value, "read");
  const mutationReceiver = captureRawField(value, "mutation");
  if (
    !isRecord(readReceiver) ||
    !hasExactOwnKeys(readReceiver, READ_ADAPTER_KEYS) ||
    !isRecord(mutationReceiver) ||
    !hasExactOwnKeys(mutationReceiver, MUTATION_ADAPTER_KEYS)
  ) {
    return undefined;
  }
  const openPrivateDirectory = captureRawField(
    readReceiver,
    "openPrivateDirectory",
  );
  const acquireSetupLease = captureRawField(
    mutationReceiver,
    "acquireSetupLease",
  );
  if (
    typeof openPrivateDirectory !== "function" ||
    typeof acquireSetupLease !== "function"
  ) {
    return undefined;
  }

  return Object.freeze({
    readReceiver,
    mutationReceiver,
    openPrivateDirectory: openPrivateDirectory as RawFunction,
    acquireSetupLease: acquireSetupLease as RawFunction,
  });
}

function invalidAdapterRequest(): never {
  throw new TypeError(INVALID_ADAPTER_REQUEST);
}

function nativeOperationFailed(): never {
  throw new Error(NATIVE_OPERATION_FAILED);
}

function isThenable(value: unknown): boolean {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return false;
  }
  return typeof (value as { readonly then?: unknown }).then === "function";
}

function callRaw(
  method: RawFunction,
  receiver: UnknownRecord,
  args: unknown[],
): unknown {
  let value: unknown;
  try {
    value = Reflect.apply(method, receiver, args);
  } catch {
    return nativeOperationFailed();
  }
  try {
    suppressUnexpectedPromiseRejection(value);
    if (isThenable(value)) {
      return nativeOperationFailed();
    }
  } catch {
    return nativeOperationFailed();
  }
  return value;
}

function callRawVoid(
  method: RawFunction,
  receiver: UnknownRecord,
  args: unknown[] = [],
): void {
  if (callRaw(method, receiver, args) !== undefined) {
    return nativeOperationFailed();
  }
}

function captureRawHandle(
  value: unknown,
  expectedMethods: readonly string[],
): CapturedRawHandle {
  try {
    if (
      !isRecord(value) ||
      !hasExactOwnKeys(value, expectedMethods)
    ) {
      return nativeOperationFailed();
    }
    const methods: Record<string, RawFunction> = {};
    for (const name of expectedMethods) {
      const method = captureRawField(value, name);
      if (typeof method !== "function") {
        return nativeOperationFailed();
      }
      methods[name] = method as RawFunction;
    }
    return FREEZE({
      receiver: value,
      methods: FREEZE(methods),
    });
  } catch {
    return nativeOperationFailed();
  }
}

function rawMethod(handle: CapturedRawHandle, name: string): RawFunction {
  const method = handle.methods[name];
  return method ?? nativeOperationFailed();
}

function ensureActive(active: boolean): void {
  if (!active) {
    return nativeOperationFailed();
  }
}

function wipeBytes(bytes: Uint8Array): void {
  try {
    Reflect.apply(UINT8_FILL, bytes, [0]);
  } catch {
    // Best effort only. No diagnostic may reflect secret-bearing objects.
  }
}

function isSharedBuffer(value: unknown): boolean {
  if (SHARED_BUFFER_BYTE_LENGTH_GETTER === undefined) {
    return false;
  }
  try {
    Reflect.apply(SHARED_BUFFER_BYTE_LENGTH_GETTER, value, []);
    return true;
  } catch {
    return false;
  }
}

function copyBaseBytes(
  value: unknown,
  maxBytes: number,
  allowEmpty: boolean,
): Uint8Array | undefined {
  let copy: Uint8Array | undefined;
  try {
    if (
      TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined ||
      TYPED_ARRAY_BUFFER_GETTER === undefined
    ) {
      return undefined;
    }
    const byteLength = Reflect.apply(
      TYPED_ARRAY_BYTE_LENGTH_GETTER,
      value,
      [],
    );
    const buffer = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, value, []);
    if (
      !Number.isSafeInteger(byteLength) ||
      (byteLength as number) < 0 ||
      (!allowEmpty && byteLength === 0) ||
      (byteLength as number) > maxBytes ||
      isSharedBuffer(buffer)
    ) {
      return undefined;
    }
    copy = new BASE_UINT8_ARRAY(value as Uint8Array);
    const copiedLength = Reflect.apply(
      TYPED_ARRAY_BYTE_LENGTH_GETTER,
      copy,
      [],
    );
    if (copiedLength !== byteLength) {
      wipeBytes(copy);
      return undefined;
    }
    return copy;
  } catch {
    if (copy !== undefined) {
      wipeBytes(copy);
    }
    return undefined;
  }
}

function copyOpaquePart(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_OPAQUE_CHARACTERS &&
    !OPAQUE_CONTROL.test(value)
    ? value
    : undefined;
}

function normalizeIdentity(value: unknown): CredentialObjectIdentity {
  try {
    suppressUnexpectedPromiseRejection(value);
    if (
      !isRecord(value) ||
      !hasExactOwnKeys(value, IDENTITY_KEYS)
    ) {
      return nativeOperationFailed();
    }
    const volume = copyOpaquePart(captureRawField(value, "volume"));
    const object = copyOpaquePart(captureRawField(value, "object"));
    if (volume === undefined || object === undefined) {
      return nativeOperationFailed();
    }
    return FREEZE({ volume, object });
  } catch {
    return nativeOperationFailed();
  }
}

function isBinding(value: unknown): value is CredentialBindingAttestation {
  return (
    value === "canonical-current" ||
    value === "detached" ||
    value === "unknown"
  );
}

function isOwner(value: unknown): value is CredentialOwnerAttestation {
  return (
    value === "current-user" ||
    value === "other-user" ||
    value === "unknown"
  );
}

function isAccess(value: unknown): value is CredentialAccessAttestation {
  return value === "user-only" || value === "broader" || value === "unknown";
}

function isLink(value: unknown): value is CredentialLinkAttestation {
  return (
    value === "direct" ||
    value === "symbolic-link" ||
    value === "reparse-point" ||
    value === "unknown"
  );
}

function normalizeDirectoryAttestation(
  value: unknown,
): PrivateDirectoryAttestation {
  try {
    if (
      !isRecord(value) ||
      !hasExactOwnKeys(value, DIRECTORY_ATTESTATION_KEYS)
    ) {
      return nativeOperationFailed();
    }
    const kind = captureRawField(value, "kind");
    const identity = normalizeIdentity(captureRawField(value, "identity"));
    const revision = copyOpaquePart(captureRawField(value, "revision"));
    const binding = captureRawField(value, "binding");
    const owner = captureRawField(value, "owner");
    const access = captureRawField(value, "access");
    const link = captureRawField(value, "link");
    if (
      kind !== "directory" ||
      revision === undefined ||
      !isBinding(binding) ||
      !isOwner(owner) ||
      !isAccess(access) ||
      !isLink(link)
    ) {
      return nativeOperationFailed();
    }
    return FREEZE({
      kind,
      identity,
      revision,
      binding,
      owner,
      access,
      link,
    });
  } catch {
    return nativeOperationFailed();
  }
}

function normalizeFileAttestation(value: unknown): CredentialFileAttestation {
  try {
    if (
      !isRecord(value) ||
      !hasExactOwnKeys(value, FILE_ATTESTATION_KEYS)
    ) {
      return nativeOperationFailed();
    }
    const kind = captureRawField(value, "kind");
    const identity = normalizeIdentity(captureRawField(value, "identity"));
    const parentIdentity = normalizeIdentity(
      captureRawField(value, "parentIdentity"),
    );
    const revision = copyOpaquePart(captureRawField(value, "revision"));
    const binding = captureRawField(value, "binding");
    const owner = captureRawField(value, "owner");
    const access = captureRawField(value, "access");
    const link = captureRawField(value, "link");
    const links = captureRawField(value, "links");
    const size = captureRawField(value, "size");
    if (
      kind !== "regular-file" ||
      revision === undefined ||
      !isBinding(binding) ||
      !isOwner(owner) ||
      !isAccess(access) ||
      !isLink(link) ||
      !Number.isSafeInteger(links) ||
      (links as number) < 0 ||
      !Number.isSafeInteger(size) ||
      (size as number) < 0
    ) {
      return nativeOperationFailed();
    }
    return FREEZE({
      kind,
      identity,
      parentIdentity,
      revision,
      binding,
      owner,
      access,
      link,
      links: links as number,
      size: size as number,
    });
  } catch {
    return nativeOperationFailed();
  }
}

function isTemporaryRole(
  value: unknown,
): value is CredentialTemporaryEntryRole {
  return (
    value === "credential-candidate" ||
    value === "transaction-candidate" ||
    value === "recovery-candidate"
  );
}

function normalizeTemporaryEntry(value: unknown): CredentialTemporaryEntry {
  try {
    suppressUnexpectedPromiseRejection(value);
    if (
      !isRecord(value) ||
      !hasExactOwnKeys(value, TEMPORARY_ENTRY_KEYS)
    ) {
      return invalidAdapterRequest();
    }
    const kind = captureRawField(value, "kind");
    const role = captureRawField(value, "role");
    const transactionId = captureRawField(value, "transactionId");
    if (
      kind !== "temporary" ||
      !isTemporaryRole(role) ||
      typeof transactionId !== "string" ||
      !LOWERCASE_UUID_V4.test(transactionId)
    ) {
      return invalidAdapterRequest();
    }
    return FREEZE({
      kind,
      role,
      transactionId,
    }) as CredentialTemporaryEntry;
  } catch {
    return invalidAdapterRequest();
  }
}

function normalizeCanonicalEntry(value: unknown): CredentialCanonicalEntry {
  try {
    suppressUnexpectedPromiseRejection(value);
    if (
      !isRecord(value) ||
      !hasExactOwnKeys(value, CANONICAL_ENTRY_KEYS)
    ) {
      return invalidAdapterRequest();
    }
    const kind = captureRawField(value, "kind");
    const role = captureRawField(value, "role");
    const name = captureRawField(value, "name");
    if (kind !== "canonical") {
      return invalidAdapterRequest();
    }
    if (role === "credential" && name === "credentials.json") {
      return FREEZE({
        kind: "canonical" as const,
        role: "credential" as const,
        name: "credentials.json" as const,
      });
    }
    if (
      role === "transaction" &&
      name === "credentials-transaction.json"
    ) {
      return FREEZE({
        kind: "canonical" as const,
        role: "transaction" as const,
        name: "credentials-transaction.json" as const,
      });
    }
    return invalidAdapterRequest();
  } catch {
    return invalidAdapterRequest();
  }
}

function normalizeManagedEntry(value: unknown): CredentialManagedEntry {
  try {
    suppressUnexpectedPromiseRejection(value);
    if (!isRecord(value)) {
      return invalidAdapterRequest();
    }
    return captureRawField(value, "kind") === "temporary"
      ? normalizeTemporaryEntry(value)
      : normalizeCanonicalEntry(value);
  } catch {
    return invalidAdapterRequest();
  }
}

function bestEffortRawTerminal(value: unknown, name: "abandon" | "close"): void {
  try {
    suppressUnexpectedPromiseRejection(value);
    if (!isRecord(value)) {
      return;
    }
    const method = value[name];
    if (typeof method !== "function") {
      return;
    }
    const result = Reflect.apply(method as RawFunction, value, []);
    suppressUnexpectedPromiseRejection(result);
  } catch {
    // Cleanup is deliberately non-reflective and best effort.
  }
}

function normalizeBoundedRead(
  value: unknown,
  maxBytes: number,
  retained: Set<Uint8Array>,
): BoundedCredentialRead {
  let rawBytes: unknown;
  let copiedBytes: Uint8Array | undefined;
  try {
    if (
      !isRecord(value) ||
      !hasExactOwnKeys(value, ["bytes", "endOfFile"])
    ) {
      return nativeOperationFailed();
    }
    rawBytes = captureRawField(value, "bytes");
    const endOfFile = captureRawField(value, "endOfFile");
    if (typeof endOfFile !== "boolean") {
      return nativeOperationFailed();
    }
    copiedBytes = copyBaseBytes(rawBytes, maxBytes, true);
    if (copiedBytes === undefined) {
      return nativeOperationFailed();
    }
    const result = FREEZE({
      bytes: copiedBytes,
      endOfFile,
    });
    retained.add(copiedBytes);
    copiedBytes = undefined;
    return result;
  } catch {
    return nativeOperationFailed();
  } finally {
    if (copiedBytes !== undefined) {
      wipeBytes(copiedBytes);
    }
    try {
      wipeBytes(rawBytes as Uint8Array);
    } catch {
      // The public error remains static even for hostile typed-array objects.
    }
  }
}

function parseReadBoundedOptions(options: unknown): number | undefined {
  try {
    if (
      !isRecord(options) ||
      !hasExactOwnKeys(options, ["maxBytes"])
    ) {
      return undefined;
    }
    const maxBytes = options.maxBytes;
    return Number.isSafeInteger(maxBytes) &&
      (maxBytes as number) >= 0 &&
      (maxBytes as number) <= MAX_NATIVE_READ_BYTES
      ? (maxBytes as number)
      : undefined;
  } catch {
    return undefined;
  }
}

function validCredentialOpenOptions(options: unknown): boolean {
  try {
    return (
      isRecord(options) &&
      hasExactOwnKeys(options, ["entry", "noFollow"]) &&
      options.entry === "credentials.json" &&
      options.noFollow === true
    );
  } catch {
    return false;
  }
}

function wrapReadHandle(
  value: unknown,
  parent?: ChildLifecycleState,
): CredentialFileReadHandle {
  if (parent !== undefined) {
    ensureActive(parent.active);
  }
  const raw = captureRawHandle(value, READ_HANDLE_KEYS);
  const retained = new Set<Uint8Array>();
  let active = true;
  const controller: InvalidatableHandle = {
    invalidate() {
      active = false;
      for (const bytes of retained) {
        wipeBytes(bytes);
      }
      retained.clear();
    },
  };
  parent?.children.add(controller);
  if (parent !== undefined && !parent.active) {
    controller.invalidate();
    parent.children.delete(controller);
    return nativeOperationFailed();
  }

  return FREEZE<CredentialFileReadHandle>({
    async attest() {
      ensureActive(active && (parent?.active ?? true));
      const result = normalizeFileAttestation(
        callRaw(rawMethod(raw, "attest"), raw.receiver, []),
      );
      if (!active || !(parent?.active ?? true)) {
        controller.invalidate();
        return nativeOperationFailed();
      }
      return result;
    },
    async readBounded(options) {
      const maxBytes = parseReadBoundedOptions(options);
      if (maxBytes === undefined) {
        return invalidAdapterRequest();
      }
      ensureActive(active && (parent?.active ?? true));
      const rawResult = callRaw(
        rawMethod(raw, "readBounded"),
        raw.receiver,
        [FREEZE({ maxBytes })],
      );
      const result = normalizeBoundedRead(rawResult, maxBytes, retained);
      if (!active || !(parent?.active ?? true)) {
        controller.invalidate();
        return nativeOperationFailed();
      }
      return result;
    },
    async close() {
      ensureActive(active && (parent?.active ?? true));
      controller.invalidate();
      parent?.children.delete(controller);
      callRawVoid(rawMethod(raw, "close"), raw.receiver);
    },
  });
}

function wrapPrivateDirectory(
  value: unknown,
): PrivateCredentialDirectoryHandle {
  const raw = captureRawHandle(value, DIRECTORY_HANDLE_KEYS);
  const state: ChildLifecycleState = {
    active: true,
    children: new Set<InvalidatableHandle>(),
  };

  function invalidate(): void {
    if (!state.active) {
      return;
    }
    state.active = false;
    for (const child of [...state.children]) {
      child.invalidate();
    }
    state.children.clear();
  }

  return FREEZE<PrivateCredentialDirectoryHandle>({
    async attest() {
      ensureActive(state.active);
      const result = normalizeDirectoryAttestation(
        callRaw(rawMethod(raw, "attest"), raw.receiver, []),
      );
      ensureActive(state.active);
      return result;
    },
    async openCredentialReadOnly(options) {
      if (!validCredentialOpenOptions(options)) {
        return invalidAdapterRequest();
      }
      ensureActive(state.active);
      const rawResult = callRaw(
        rawMethod(raw, "openCredentialReadOnly"),
        raw.receiver,
        [
          FREEZE({
            entry: "credentials.json" as const,
            noFollow: true as const,
          }),
        ],
      );
      const result = normalizeFileOpenResult(rawResult, state);
      ensureActive(state.active);
      return result;
    },
    async close() {
      ensureActive(state.active);
      invalidate();
      callRawVoid(rawMethod(raw, "close"), raw.receiver);
    },
  });
}

function normalizeFileOpenResult(
  value: unknown,
  parent: ChildLifecycleState,
): CredentialFileOpenResult {
  let possibleFile: unknown;
  try {
    if (!isRecord(value)) {
      return nativeOperationFailed();
    }
    const status = captureRawField(value, "status");
    if (
      status === "missing" &&
      hasExactOwnKeys(value, ["status"])
    ) {
      return FREEZE({ status: "missing" as const });
    }
    if (!hasExactOwnKeys(value, ["file", "status"])) {
      return nativeOperationFailed();
    }
    possibleFile = captureRawField(value, "file");
    if (status !== "opened") {
      return nativeOperationFailed();
    }
    return FREEZE({
      status: "opened" as const,
      file: wrapReadHandle(possibleFile, parent),
    });
  } catch {
    bestEffortRawTerminal(possibleFile, "close");
    return nativeOperationFailed();
  }
}

function normalizeDirectoryOpenResult(
  value: unknown,
): PrivateCredentialDirectoryOpenResult {
  let possibleDirectory: unknown;
  try {
    if (!isRecord(value)) {
      return nativeOperationFailed();
    }
    const status = captureRawField(value, "status");
    if (
      status === "missing" &&
      hasExactOwnKeys(value, ["status"])
    ) {
      return FREEZE({ status: "missing" as const });
    }
    if (!hasExactOwnKeys(value, ["directory", "status"])) {
      return nativeOperationFailed();
    }
    possibleDirectory = captureRawField(value, "directory");
    if (status !== "opened") {
      return nativeOperationFailed();
    }
    return FREEZE({
      status: "opened" as const,
      directory: wrapPrivateDirectory(possibleDirectory),
    });
  } catch {
    bestEffortRawTerminal(possibleDirectory, "close");
    return nativeOperationFailed();
  }
}

function wrapWriteHandle(
  value: unknown,
  lease: LeaseMembraneState,
): CredentialFileExclusiveWriteHandle {
  ensureActive(lease.active);
  const raw = captureRawHandle(value, WRITE_HANDLE_KEYS);
  let active = true;
  const controller: InvalidatableHandle = {
    invalidate() {
      active = false;
    },
  };
  lease.children.add(controller);
  if (!lease.active) {
    controller.invalidate();
    lease.children.delete(controller);
    return nativeOperationFailed();
  }

  return FREEZE<CredentialFileExclusiveWriteHandle>({
    async attest() {
      ensureActive(active && lease.active);
      const result = normalizeFileAttestation(
        callRaw(rawMethod(raw, "attest"), raw.receiver, []),
      );
      ensureActive(active && lease.active);
      return result;
    },
    async writeAll(bytes) {
      ensureActive(active && lease.active);
      let copy: Uint8Array | undefined;
      try {
        copy = copyBaseBytes(bytes, MAX_NATIVE_WRITE_BYTES, false);
        if (copy === undefined) {
          return invalidAdapterRequest();
        }
      } catch {
        return invalidAdapterRequest();
      }
      try {
        ensureActive(active && lease.active);
        callRawVoid(rawMethod(raw, "writeAll"), raw.receiver, [copy]);
        ensureActive(active && lease.active);
      } finally {
        wipeBytes(copy);
      }
    },
    async sync() {
      ensureActive(active && lease.active);
      callRawVoid(rawMethod(raw, "sync"), raw.receiver);
      ensureActive(active && lease.active);
    },
    async close() {
      ensureActive(active && lease.active);
      controller.invalidate();
      lease.children.delete(controller);
      callRawVoid(rawMethod(raw, "close"), raw.receiver);
    },
  });
}

function mintSnapshot(
  rawValue: unknown,
  kind: RawSnapshot["kind"],
  lease: LeaseMembraneState,
): CredentialEntrySnapshot {
  try {
    ensureActive(lease.active);
    suppressUnexpectedPromiseRejection(rawValue);
    if (
      !isRecord(rawValue) ||
      !hasExactOwnKeys(rawValue, []) ||
      isThenable(rawValue)
    ) {
      return nativeOperationFailed();
    }
    const publicValue = FREEZE({});
    lease.snapshots.set(
      publicValue,
      FREEZE({
        kind,
        value: rawValue,
      }),
    );
    return publicValue as unknown as CredentialEntrySnapshot;
  } catch {
    return nativeOperationFailed();
  }
}

function resolveSnapshot(
  value: unknown,
  lease: LeaseMembraneState,
  expectedKind?: RawSnapshot["kind"],
): RawSnapshot {
  ensureActive(lease.active);
  try {
    if (value === null || typeof value !== "object") {
      return invalidAdapterRequest();
    }
    const snapshot = lease.snapshots.get(value);
    if (
      snapshot === undefined ||
      (expectedKind !== undefined && snapshot.kind !== expectedKind)
    ) {
      return invalidAdapterRequest();
    }
    return snapshot;
  } catch {
    return invalidAdapterRequest();
  }
}

function invalidateLease(lease: LeaseMembraneState): void {
  if (!lease.active) {
    return;
  }
  lease.active = false;
  for (const child of [...lease.children]) {
    child.invalidate();
  }
  lease.children.clear();
}

function normalizeObservation(
  value: unknown,
  lease: LeaseMembraneState,
): CredentialManagedEntryObservation {
  let possibleFile: unknown;
  try {
    if (!isRecord(value)) {
      return nativeOperationFailed();
    }
    const status = captureRawField(value, "status");
    if (
      status === "missing" &&
      hasExactOwnKeys(value, ["snapshot", "status"])
    ) {
      const rawSnapshot = captureRawField(value, "snapshot");
      return FREEZE({
        status,
        snapshot: mintSnapshot(
          rawSnapshot,
          "missing",
          lease,
        ) as CredentialMissingEntrySnapshot,
      });
    }
    if (
      !hasExactOwnKeys(value, [
        "attestation",
        "file",
        "snapshot",
        "status",
      ])
    ) {
      return nativeOperationFailed();
    }
    const rawSnapshot = captureRawField(value, "snapshot");
    possibleFile = captureRawField(value, "file");
    if (status !== "opened") {
      return nativeOperationFailed();
    }
    return FREEZE({
      status,
      snapshot: mintSnapshot(
        rawSnapshot,
        "present",
        lease,
      ) as CredentialPresentEntrySnapshot,
      attestation: normalizeFileAttestation(
        captureRawField(value, "attestation"),
      ),
      file: wrapReadHandle(possibleFile, lease),
    });
  } catch {
    bestEffortRawTerminal(possibleFile, "close");
    return nativeOperationFailed();
  }
}

function normalizeExclusiveCreateResult(
  value: unknown,
  lease: LeaseMembraneState,
): CredentialExclusiveCreateResult {
  let possibleFile: unknown;
  try {
    if (!isRecord(value)) {
      return nativeOperationFailed();
    }
    const status = captureRawField(value, "status");
    if (
      status === "conflict" &&
      hasExactOwnKeys(value, ["status"])
    ) {
      return FREEZE({ status: "conflict" as const });
    }
    if (!hasExactOwnKeys(value, ["file", "status"])) {
      return nativeOperationFailed();
    }
    possibleFile = captureRawField(value, "file");
    if (status !== "created") {
      return nativeOperationFailed();
    }
    return FREEZE({
      status: "created" as const,
      file: wrapWriteHandle(possibleFile, lease),
    });
  } catch {
    bestEffortRawTerminal(possibleFile, "close");
    return nativeOperationFailed();
  }
}

function normalizeMoveResult(value: unknown): CredentialConditionalMoveResult {
  try {
    if (
      !isRecord(value) ||
      !hasExactOwnKeys(value, ["status"])
    ) {
      return nativeOperationFailed();
    }
    const status = captureRawField(value, "status");
    if (status !== "moved" && status !== "conflict") {
      return nativeOperationFailed();
    }
    return FREEZE({ status });
  } catch {
    return nativeOperationFailed();
  }
}

function normalizeRemoveResult(
  value: unknown,
): CredentialConditionalRemoveResult {
  try {
    if (
      !isRecord(value) ||
      !hasExactOwnKeys(value, ["status"])
    ) {
      return nativeOperationFailed();
    }
    const status = captureRawField(value, "status");
    if (status !== "removed" && status !== "conflict") {
      return nativeOperationFailed();
    }
    return FREEZE({ status });
  } catch {
    return nativeOperationFailed();
  }
}

function wrapMutationLease(value: unknown): CredentialStoreMutationLease {
  const raw = captureRawHandle(value, LEASE_KEYS);
  const state: LeaseMembraneState = {
    active: true,
    snapshots: new WeakMap<object, RawSnapshot>(),
    children: new Set<InvalidatableHandle>(),
  };

  return FREEZE<CredentialStoreMutationLease>({
    async attestDirectory() {
      ensureActive(state.active);
      const result = normalizeDirectoryAttestation(
        callRaw(rawMethod(raw, "attestDirectory"), raw.receiver, []),
      );
      ensureActive(state.active);
      return result;
    },
    async renew() {
      ensureActive(state.active);
      const result = callRaw(rawMethod(raw, "renew"), raw.receiver, []);
      try {
        if (
          !isRecord(result) ||
          !hasExactOwnKeys(result, ["status"])
        ) {
          return nativeOperationFailed();
        }
        const status = captureRawField(result, "status");
        if (status !== "held" && status !== "lost") {
          return nativeOperationFailed();
        }
        const normalized = FREEZE({ status });
        ensureActive(state.active);
        return normalized;
      } catch {
        return nativeOperationFailed();
      }
    },
    async observeEntry(entry) {
      let normalizedEntry: CredentialManagedEntry;
      try {
        normalizedEntry = normalizeManagedEntry(entry);
      } catch {
        return invalidAdapterRequest();
      }
      ensureActive(state.active);
      const normalizedResult = normalizeObservation(
        callRaw(rawMethod(raw, "observeEntry"), raw.receiver, [
          normalizedEntry,
        ]),
        state,
      );
      ensureActive(state.active);
      return normalizedResult;
    },
    async listTemporaryEntries() {
      ensureActive(state.active);
      const result = callRaw(
        rawMethod(raw, "listTemporaryEntries"),
        raw.receiver,
        [],
      );
      try {
        if (!ARRAY_IS_ARRAY(result)) {
          return nativeOperationFailed();
        }
        const length = result.length;
        if (
          !Number.isSafeInteger(length) ||
          length < 0 ||
          length > MAX_NATIVE_TEMPORARY_ENTRIES
        ) {
          return nativeOperationFailed();
        }
        const entries: CredentialTemporaryEntry[] = [];
        for (let index = 0; index < length; index += 1) {
          if (!Reflect.apply(HAS_OWN, result, [index])) {
            return nativeOperationFailed();
          }
          entries[index] = normalizeTemporaryEntry(result[index]);
        }
        ensureActive(state.active);
        return FREEZE(entries);
      } catch {
        return nativeOperationFailed();
      }
    },
    async createTemporaryExclusive(options) {
      let entry: CredentialTemporaryEntry;
      let expected: RawSnapshot;
      try {
        if (
          !isRecord(options) ||
          !hasExactOwnKeys(options, ["entry", "expected"])
        ) {
          return invalidAdapterRequest();
        }
        entry = normalizeTemporaryEntry(options.entry);
        expected = resolveSnapshot(options.expected, state, "missing");
      } catch {
        return invalidAdapterRequest();
      }
      ensureActive(state.active);
      const result = callRaw(
        rawMethod(raw, "createTemporaryExclusive"),
        raw.receiver,
        [
          FREEZE({
            entry,
            expected: expected.value,
          }),
        ],
      );
      const normalized = normalizeExclusiveCreateResult(result, state);
      ensureActive(state.active);
      return normalized;
    },
    async moveTemporaryConditionally(options) {
      let source: CredentialTemporaryEntry;
      let destination: CredentialCanonicalEntry;
      let expectedSource: RawSnapshot;
      let expectedDestination: RawSnapshot;
      try {
        if (
          !isRecord(options) ||
          !hasExactOwnKeys(options, [
            "destination",
            "expectedDestination",
            "expectedSource",
            "source",
          ])
        ) {
          return invalidAdapterRequest();
        }
        source = normalizeTemporaryEntry(options.source);
        destination = normalizeCanonicalEntry(options.destination);
        expectedSource = resolveSnapshot(
          options.expectedSource,
          state,
          "present",
        );
        expectedDestination = resolveSnapshot(
          options.expectedDestination,
          state,
        );
      } catch {
        return invalidAdapterRequest();
      }
      ensureActive(state.active);
      const normalized = normalizeMoveResult(
        callRaw(
          rawMethod(raw, "moveTemporaryConditionally"),
          raw.receiver,
          [
            FREEZE({
              source,
              expectedSource: expectedSource.value,
              destination,
              expectedDestination: expectedDestination.value,
            }),
          ],
        ),
      );
      ensureActive(state.active);
      return normalized;
    },
    async removeConditionally(options) {
      let entry: CredentialManagedEntry;
      let expected: RawSnapshot;
      try {
        if (
          !isRecord(options) ||
          !hasExactOwnKeys(options, ["entry", "expected"])
        ) {
          return invalidAdapterRequest();
        }
        entry = normalizeManagedEntry(options.entry);
        expected = resolveSnapshot(options.expected, state, "present");
      } catch {
        return invalidAdapterRequest();
      }
      ensureActive(state.active);
      const normalized = normalizeRemoveResult(
        callRaw(rawMethod(raw, "removeConditionally"), raw.receiver, [
          FREEZE({
            entry,
            expected: expected.value,
          }),
        ]),
      );
      ensureActive(state.active);
      return normalized;
    },
    async syncDirectory() {
      ensureActive(state.active);
      callRawVoid(rawMethod(raw, "syncDirectory"), raw.receiver);
      ensureActive(state.active);
    },
    async release() {
      ensureActive(state.active);
      invalidateLease(state);
      callRawVoid(rawMethod(raw, "release"), raw.receiver);
    },
    async abandon() {
      ensureActive(state.active);
      invalidateLease(state);
      callRawVoid(rawMethod(raw, "abandon"), raw.receiver);
    },
  });
}

function normalizeAcquireResult(
  value: unknown,
): CredentialSetupLeaseAcquireResult {
  let possibleLease: unknown;
  try {
    if (!isRecord(value)) {
      return nativeOperationFailed();
    }
    const status = captureRawField(value, "status");
    if (
      status === "busy" &&
      hasExactOwnKeys(value, ["status"])
    ) {
      return FREEZE({ status: "busy" as const });
    }
    if (
      !hasExactOwnKeys(value, [
        "directory",
        "lease",
        "priorLease",
        "status",
      ])
    ) {
      return nativeOperationFailed();
    }
    possibleLease = captureRawField(value, "lease");
    const priorLease = captureRawField(value, "priorLease");
    const directory = captureRawField(value, "directory");
    if (
      status !== "acquired" ||
      (priorLease !== "absent" && priorLease !== "proven-abandoned") ||
      (directory !== "created" && directory !== "existing")
    ) {
      return nativeOperationFailed();
    }
    return FREEZE({
      status: "acquired" as const,
      priorLease,
      directory,
      lease: wrapMutationLease(possibleLease),
    });
  } catch {
    bestEffortRawTerminal(possibleLease, "abandon");
    return nativeOperationFailed();
  }
}

function wrapAdapterPair(
  pair: NativeCredentialAdapterPairSnapshot,
): Exclude<NativeCredentialStoreLoadResult, { status: "unavailable" }> {
  const read = FREEZE<CredentialStoreReadAdapter>({
    async openPrivateDirectory(directory, options) {
      let valid = false;
      try {
        valid = validReadRequest(directory, options);
      } catch {
        valid = false;
      }
      if (!valid) {
        return invalidAdapterRequest();
      }
      return normalizeDirectoryOpenResult(
        callRaw(pair.openPrivateDirectory, pair.readReceiver, [
          directory,
          FREEZE({ noFollow: true as const }),
        ]),
      );
    },
  });
  const mutation = FREEZE<CredentialStoreMutationAdapter>({
    async acquireSetupLease(directory, options) {
      let nonce: CredentialSetupLeaseNonce | undefined;
      try {
        nonce = parseMutationRequest(directory, options);
      } catch {
        nonce = undefined;
      }
      if (nonce === undefined) {
        return invalidAdapterRequest();
      }
      return normalizeAcquireResult(
        callRaw(pair.acquireSetupLease, pair.mutationReceiver, [
          directory,
          FREEZE({
            noFollow: true as const,
            createDirectory: true as const,
            nonce,
          }),
        ]),
      );
    },
  });

  return FREEZE({
    status: "available" as const,
    read,
    mutation,
  });
}

function loadOnce(
  target: NativeCredentialTarget,
  resolve: (target: NativeCredentialTarget) => unknown,
  wasReentered: () => boolean,
): NativeCredentialStoreLoadResult {
  try {
    const moduleValue = resolve(target);
    suppressUnexpectedPromiseRejection(moduleValue);
    if (wasReentered() || isThenable(moduleValue)) {
      return UNAVAILABLE;
    }

    const descriptor = parseModuleDescriptor(moduleValue, target);
    if (descriptor === undefined || wasReentered()) {
      return UNAVAILABLE;
    }

    const adapters = Reflect.apply(
      descriptor.createAdapters,
      descriptor.receiver,
      [],
    );
    suppressUnexpectedPromiseRejection(adapters);
    if (wasReentered() || isThenable(adapters)) {
      return UNAVAILABLE;
    }
    const pair = parseAdapterPair(adapters);
    return pair === undefined ? UNAVAILABLE : wrapAdapterPair(pair);
  } catch {
    return UNAVAILABLE;
  }
}

export function createNativeCredentialStoreProvider(
  target: NativeCredentialTarget,
  resolve: NativeCredentialModuleResolver,
): NativeCredentialStoreProvider {
  let configured:
    | Readonly<{
        target: NativeCredentialTarget;
        resolve: (target: NativeCredentialTarget) => unknown;
      }>
    | undefined;
  try {
    if (RECOGNIZED_TARGETS.has(target) && typeof resolve === "function") {
      configured = Object.freeze({ target, resolve });
    }
  } catch {
    configured = undefined;
  }
  let cached: NativeCredentialStoreLoadResult | undefined;
  let loading = false;
  let reentered = false;

  return Object.freeze({
    load(): NativeCredentialStoreLoadResult {
      if (cached !== undefined) {
        return cached;
      }
      if (loading) {
        reentered = true;
        return UNAVAILABLE;
      }

      loading = true;
      reentered = false;
      try {
        const result =
          configured === undefined
            ? UNAVAILABLE
            : loadOnce(
                configured.target,
                configured.resolve,
                () => reentered,
              );
        cached = reentered ? UNAVAILABLE : result;
      } catch {
        cached = UNAVAILABLE;
      } finally {
        loading = false;
      }
      return cached;
    },
  });
}
