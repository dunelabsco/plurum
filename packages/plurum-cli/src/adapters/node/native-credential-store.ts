import type {
  CredentialStoreMutationAdapter,
  CredentialSetupLeaseNonce,
} from "../../credentials/store-mutation-contracts.js";
import type { CredentialStoreReadAdapter } from "../../credentials/store-contracts.js";
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
const RECOGNIZED_TARGETS = new Set<string>(NATIVE_CREDENTIAL_TARGET_IDS);
const UNAVAILABLE = Object.freeze({
  status: "unavailable" as const,
  code: "native_credential_store_unavailable" as const,
});
const INVALID_ADAPTER_REQUEST =
  "The native credential adapter request is invalid.";
const LOWERCASE_UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type UnknownRecord = Record<string, unknown>;

interface NativeCredentialModuleSnapshot {
  readonly receiver: UnknownRecord;
  readonly createAdapters: () => unknown;
}

interface NativeCredentialAdapterPairSnapshot {
  readonly readReceiver: UnknownRecord;
  readonly mutationReceiver: UnknownRecord;
  readonly openPrivateDirectory: CredentialStoreReadAdapter["openPrivateDirectory"];
  readonly acquireSetupLease: CredentialStoreMutationAdapter["acquireSetupLease"];
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactEnumerableKeys(
  value: UnknownRecord,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function suppressUnexpectedPromiseRejection(value: unknown): void {
  if (value instanceof Promise) {
    void Reflect.apply(Promise.prototype.then, value, [
      undefined,
      () => undefined,
    ]);
  }
}

function parseModuleDescriptor(
  value: unknown,
  target: NativeCredentialTarget,
): NativeCredentialModuleSnapshot | undefined {
  if (!isRecord(value) || !hasExactEnumerableKeys(value, MODULE_KEYS)) {
    return undefined;
  }

  const magic = value.magic;
  const abiVersion = value.abiVersion;
  const nodeApiVersion = value.nodeApiVersion;
  const packageVersion = value.packageVersion;
  const moduleTarget = value.target;
  const createAdapters = value.createAdapters;
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
    createAdapters: createAdapters as () => unknown,
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
    hasExactEnumerableKeys(options, READ_OPTIONS_KEYS) &&
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
    !hasExactEnumerableKeys(options, MUTATION_OPTIONS_KEYS)
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
  if (!isRecord(value) || !hasExactEnumerableKeys(value, ADAPTER_PAIR_KEYS)) {
    return undefined;
  }

  const readReceiver = value.read;
  const mutationReceiver = value.mutation;
  if (!isRecord(readReceiver) || !isRecord(mutationReceiver)) {
    return undefined;
  }
  const openPrivateDirectory = readReceiver.openPrivateDirectory;
  const acquireSetupLease = mutationReceiver.acquireSetupLease;
  if (
    typeof openPrivateDirectory !== "function" ||
    typeof acquireSetupLease !== "function"
  ) {
    return undefined;
  }

  return Object.freeze({
    readReceiver,
    mutationReceiver,
    openPrivateDirectory:
      openPrivateDirectory as CredentialStoreReadAdapter["openPrivateDirectory"],
    acquireSetupLease:
      acquireSetupLease as CredentialStoreMutationAdapter["acquireSetupLease"],
  });
}

function wrapAdapterPair(
  pair: NativeCredentialAdapterPairSnapshot,
): Exclude<NativeCredentialStoreLoadResult, { status: "unavailable" }> {
  const read = Object.freeze<CredentialStoreReadAdapter>({
    async openPrivateDirectory(directory, options) {
      let valid = false;
      try {
        valid = validReadRequest(directory, options);
      } catch {
        valid = false;
      }
      if (!valid) {
        throw new TypeError(INVALID_ADAPTER_REQUEST);
      }
      return await Reflect.apply(pair.openPrivateDirectory, pair.readReceiver, [
        directory,
        Object.freeze({ noFollow: true as const }),
      ]);
    },
  });
  const mutation = Object.freeze<CredentialStoreMutationAdapter>({
    async acquireSetupLease(directory, options) {
      let nonce: CredentialSetupLeaseNonce | undefined;
      try {
        nonce = parseMutationRequest(directory, options);
      } catch {
        nonce = undefined;
      }
      if (nonce === undefined) {
        throw new TypeError(INVALID_ADAPTER_REQUEST);
      }
      return await Reflect.apply(pair.acquireSetupLease, pair.mutationReceiver, [
        directory,
        Object.freeze({
          noFollow: true as const,
          createDirectory: true as const,
          nonce,
        }),
      ]);
    },
  });

  return Object.freeze({
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
    if (wasReentered()) {
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
    if (wasReentered()) {
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
