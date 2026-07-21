import {
  copyUint8ArrayPrefix,
  intrinsicUint8ArrayByteLength,
  wipeUint8Array,
} from "../data/uint8-array.js";

export const SETUP_CREDENTIAL_INPUT_PROMPT =
  "Plurum API key: " as const;
export const SETUP_CREDENTIAL_KEY_MIN_BYTES = 20;
export const SETUP_CREDENTIAL_KEY_MAX_BYTES = 210;
export const SETUP_CREDENTIAL_INPUT_MAX_BYTES = 212;

export type SetupCredentialInputFraming =
  | "interactive-line"
  | "explicit-eof";
export type SetupCredentialInputCancellationReason =
  | "cancelled"
  | "interrupted"
  | "timed-out";

declare const setupCredentialInputBrand: unique symbol;

/*
 * The key stays in one owned mutable byte array behind this empty identity.
 * General setup orchestration can retain, bind, or discard the identity but
 * cannot inspect or serialize the credential bytes.
 */
export interface SetupCredentialInputIdentity {
  readonly [setupCredentialInputBrand]: never;
}

export type SetupCredentialInputResult =
  | Readonly<{
      readonly status: "accepted";
      readonly credential: SetupCredentialInputIdentity;
    }>
  | Readonly<{ readonly status: "declined" }>
  | Readonly<{ readonly status: "invalid" }>
  | Readonly<{ readonly status: "cancelled" }>
  | Readonly<{ readonly status: "interrupted" }>
  | Readonly<{ readonly status: "timed-out" }>
  | Readonly<{ readonly status: "unavailable" }>;

export type SetupCredentialInputCancelResult =
  | Readonly<{ readonly status: "cancelled" }>
  | Readonly<{ readonly status: "discarded" }>
  | Readonly<{ readonly status: "already-settled" }>
  | Readonly<{ readonly status: "unavailable" }>;

export interface SetupCredentialInputAttempt {
  /* One attempt only. The attempt is burned before its first await. */
  capture(): Promise<SetupCredentialInputResult>;

  /*
   * The eventual lifecycle adapter maps timeouts and supported signals to this
   * synchronous cancellation boundary. No process signal is wired here.
   */
  cancel(
    reason?: SetupCredentialInputCancellationReason,
  ): SetupCredentialInputCancelResult;
}

export type SetupCredentialInputDiscardResult =
  | Readonly<{ readonly status: "discarded" }>
  | Readonly<{ readonly status: "precondition-failed" }>
  | Readonly<{ readonly status: "unavailable" }>;

const ASCII_CARRIAGE_RETURN = 0x0d;
const ASCII_LINE_FEED = 0x0a;
const API_KEY_PREFIX = Object.freeze([
  0x70,
  0x6c,
  0x72,
  0x6d,
  0x5f,
  0x6c,
  0x69,
  0x76,
  0x65,
  0x5f,
] as const);
const TOKEN_TO_JSON = Object.freeze(function tokenToJson(): undefined {
  return undefined;
});
const MATERIAL = new WeakMap<SetupCredentialInputIdentity, Uint8Array>();

const DISCARDED = Object.freeze({ status: "discarded" as const });
const PRECONDITION_FAILED = Object.freeze({
  status: "precondition-failed" as const,
});
const UNAVAILABLE = Object.freeze({ status: "unavailable" as const });

function issueIdentity(bytes: Uint8Array): SetupCredentialInputIdentity {
  const identity = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(identity, "toJSON", {
    configurable: false,
    enumerable: false,
    value: TOKEN_TO_JSON,
    writable: false,
  });
  const frozen = Object.freeze(identity) as unknown as SetupCredentialInputIdentity;
  MATERIAL.set(frozen, bytes);
  return frozen;
}

function isSuffixByte(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    (byte >= 0x30 && byte <= 0x39) ||
    byte === 0x5f ||
    byte === 0x2d
  );
}

function framedKeyLength(
  bytes: Uint8Array,
  framing: SetupCredentialInputFraming,
): number | undefined {
  const transportLength = intrinsicUint8ArrayByteLength(bytes);
  if (
    transportLength === undefined ||
    transportLength > SETUP_CREDENTIAL_INPUT_MAX_BYTES ||
    (framing !== "interactive-line" && framing !== "explicit-eof")
  ) {
    return undefined;
  }

  let keyLength = transportLength;
  if (bytes[keyLength - 1] === ASCII_LINE_FEED) {
    keyLength -= 1;
    if (bytes[keyLength - 1] === ASCII_CARRIAGE_RETURN) {
      keyLength -= 1;
    }
  } else if (framing === "interactive-line") {
    return undefined;
  }
  if (
    keyLength < SETUP_CREDENTIAL_KEY_MIN_BYTES ||
    keyLength > SETUP_CREDENTIAL_KEY_MAX_BYTES
  ) {
    return undefined;
  }

  for (let index = 0; index < API_KEY_PREFIX.length; index += 1) {
    if (bytes[index] !== API_KEY_PREFIX[index]) {
      return undefined;
    }
  }
  for (let index = API_KEY_PREFIX.length; index < keyLength; index += 1) {
    if (!isSuffixByte(bytes[index] ?? -1)) {
      return undefined;
    }
  }
  return keyLength;
}

/*
 * Exact reviewed adapters transfer ownership of `framedBytes` here. This
 * function always attempts to wipe that transferred buffer, even when the
 * framing or API-key grammar is invalid.
 */
export function retainFramedSetupCredentialInput(
  framedBytes: Uint8Array,
  framing: SetupCredentialInputFraming,
): SetupCredentialInputIdentity | undefined {
  let transport: Uint8Array | undefined;
  let credential: Uint8Array | undefined;
  let retained = false;
  try {
    const length = intrinsicUint8ArrayByteLength(framedBytes);
    if (
      length === undefined ||
      length > SETUP_CREDENTIAL_INPUT_MAX_BYTES
    ) {
      return undefined;
    }
    transport = copyUint8ArrayPrefix(framedBytes, length);
    if (transport === undefined) {
      return undefined;
    }
    const keyLength = framedKeyLength(transport, framing);
    if (keyLength === undefined) {
      return undefined;
    }
    credential = copyUint8ArrayPrefix(transport, keyLength);
    if (credential === undefined) {
      return undefined;
    }
    const identity = issueIdentity(credential);
    retained = true;
    return identity;
  } catch {
    return undefined;
  } finally {
    wipeUint8Array(transport);
    wipeUint8Array(framedBytes);
    if (!retained) {
      wipeUint8Array(credential);
    }
  }
}

/*
 * Step 4.8.5 may import this only in its exact reviewed execution boundary.
 * Claiming burns the identity first and transfers ownership of the mutable
 * byte array; that executor must wipe it on every terminal path.
 */
export function claimSetupCredentialInputBytes(
  identity: SetupCredentialInputIdentity,
): Uint8Array | undefined {
  const bytes = MATERIAL.get(identity);
  MATERIAL.delete(identity);
  return bytes;
}

export function discardSetupCredentialInput(
  identity: SetupCredentialInputIdentity,
): SetupCredentialInputDiscardResult {
  const bytes = MATERIAL.get(identity);
  MATERIAL.delete(identity);
  if (bytes === undefined) {
    return PRECONDITION_FAILED;
  }
  return wipeUint8Array(bytes) ? DISCARDED : UNAVAILABLE;
}
