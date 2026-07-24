import {
  copyUint8Array,
  intrinsicUint8ArrayByteLength,
  wipeUint8Array,
} from "../data/uint8-array.js";

declare const setupSecretLeaseBrand: unique symbol;

/*
 * A setup secret lease is a property-free, in-memory ownership token. The
 * mutable bytes live only in this module's WeakMap and may be copied for a
 * bounded read-only check, claimed once by approved execution, or discarded.
 */
export interface SetupSecretLease {
  readonly [setupSecretLeaseBrand]: never;
}

const LEASE_BYTES = new WeakMap<SetupSecretLease, Uint8Array>();
const TOKEN_TO_JSON = Object.freeze(function tokenToJson(): undefined {
  return undefined;
});

function issueLease(): SetupSecretLease {
  const token = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(token, "toJSON", {
    configurable: false,
    enumerable: false,
    value: TOKEN_TO_JSON,
    writable: false,
  });
  return Object.freeze(token) as unknown as SetupSecretLease;
}

/* Takes ownership by copying the supplied bytes and wiping the caller buffer. */
export function createSetupSecretLease(bytes: Uint8Array): SetupSecretLease {
  let owned: Uint8Array | undefined;
  try {
    const length = intrinsicUint8ArrayByteLength(bytes);
    if (length === undefined || length === 0) {
      throw new Error("The setup secret could not be retained safely.");
    }
    owned = copyUint8Array(bytes, length);
    if (owned === undefined) {
      throw new Error("The setup secret could not be retained safely.");
    }
    const lease = issueLease();
    LEASE_BYTES.set(lease, owned);
    owned = undefined;
    return lease;
  } finally {
    wipeUint8Array(owned);
    wipeUint8Array(bytes);
  }
}

/* Returns an owned copy; the caller must wipe it on every path. */
export function copySetupSecretLeaseBytes(
  lease: SetupSecretLease,
): Uint8Array | undefined {
  try {
    const retained = LEASE_BYTES.get(lease);
    if (retained === undefined) {
      return undefined;
    }
    const length = intrinsicUint8ArrayByteLength(retained);
    return length === undefined
      ? undefined
      : copyUint8Array(retained, length);
  } catch {
    return undefined;
  }
}

/* Burns the lease and transfers ownership of its mutable bytes to execution. */
export function claimSetupSecretLeaseBytes(
  lease: SetupSecretLease,
): Uint8Array | undefined {
  try {
    const retained = LEASE_BYTES.get(lease);
    LEASE_BYTES.delete(lease);
    return retained;
  } catch {
    return undefined;
  }
}

export function discardSetupSecretLease(lease: SetupSecretLease): boolean {
  try {
    const retained = LEASE_BYTES.get(lease);
    LEASE_BYTES.delete(lease);
    wipeUint8Array(retained);
    return retained !== undefined;
  } catch {
    return false;
  }
}

export function isOwnedSetupSecretLease(
  lease: unknown,
): lease is SetupSecretLease {
  return (
    typeof lease === "object" &&
    lease !== null &&
    LEASE_BYTES.has(lease as SetupSecretLease)
  );
}
