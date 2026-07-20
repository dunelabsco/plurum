import type {
  HashAdapter,
  RandomAdapter,
} from "../system/contracts.js";
import {
  copyUint8Array,
  intrinsicUint8ArrayByteLength,
} from "../data/uint8-array.js";
import {
  type ApiKey,
  parseApiKey,
} from "../credentials/schema.js";

declare const registrationApiKeyHashBrand: unique symbol;
declare const registrationApiKeyPrefixBrand: unique symbol;

export type RegistrationApiKeyHash = string & {
  readonly [registrationApiKeyHashBrand]: true;
};

export type RegistrationApiKeyPrefix = string & {
  readonly [registrationApiKeyPrefixBrand]: true;
};

export interface RegistrationKeyCommitment {
  readonly apiKeyHash: RegistrationApiKeyHash;
  readonly apiKeyPrefix: RegistrationApiKeyPrefix;
}

export interface RegistrationKeyMaterial extends RegistrationKeyCommitment {
  readonly apiKey: ApiKey;
}

export class RegistrationKeyMaterialError extends Error {
  readonly code = "registration_key_material_failed";

  constructor() {
    super("Plurum registration key material could not be created safely.");
    this.name = "RegistrationKeyMaterialError";
  }
}

const API_KEY_PREFIX = "plrm_live_";
const RANDOM_BYTES = 32;
const SHA256_BYTES = 32;
const GENERATED_API_KEY =
  /^plrm_live_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const BASE64URL =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const fillBytes = Uint8Array.prototype.fill;

function failure(): never {
  throw new RegistrationKeyMaterialError();
}

function wipe(bytes: unknown): void {
  try {
    if (bytes instanceof Uint8Array) {
      fillBytes.call(bytes, 0);
    }
  } catch {
    // A detached or hostile buffer no longer exposes safely writable bytes.
  }
}

function byte(bytes: Uint8Array, index: number): number {
  return bytes[index] ?? failure();
}

function alphabet(index: number): string {
  return BASE64URL[index] ?? failure();
}

function encodeBase64Url(bytes: Uint8Array): string {
  if (intrinsicUint8ArrayByteLength(bytes) !== RANDOM_BYTES) {
    return failure();
  }

  let encoded = "";
  let offset = 0;
  while (offset + 2 < RANDOM_BYTES) {
    const first = byte(bytes, offset);
    const second = byte(bytes, offset + 1);
    const third = byte(bytes, offset + 2);
    encoded += alphabet(first >>> 2);
    encoded += alphabet(((first & 0x03) << 4) | (second >>> 4));
    encoded += alphabet(((second & 0x0f) << 2) | (third >>> 6));
    encoded += alphabet(third & 0x3f);
    offset += 3;
  }

  const first = byte(bytes, offset);
  const second = byte(bytes, offset + 1);
  encoded += alphabet(first >>> 2);
  encoded += alphabet(((first & 0x03) << 4) | (second >>> 4));
  encoded += alphabet((second & 0x0f) << 2);
  return encoded;
}

function hexadecimalDigest(digest: Uint8Array): RegistrationApiKeyHash {
  let hexadecimal = "";
  for (let index = 0; index < SHA256_BYTES; index += 1) {
    hexadecimal += byte(digest, index).toString(16).padStart(2, "0");
  }
  return hexadecimal as RegistrationApiKeyHash;
}

export function deriveRegistrationKeyCommitment(
  apiKey: ApiKey,
  hash: HashAdapter,
): RegistrationKeyCommitment {
  let preimage: Uint8Array | undefined;
  let adapterDigest: unknown;
  let digest: Uint8Array | undefined;
  try {
    const parsedApiKey = parseApiKey(apiKey);
    if (!GENERATED_API_KEY.test(parsedApiKey)) {
      return failure();
    }

    preimage = new TextEncoder().encode(parsedApiKey);
    adapterDigest = hash.sha256(preimage);
    if (intrinsicUint8ArrayByteLength(adapterDigest) !== SHA256_BYTES) {
      return failure();
    }
    digest = copyUint8Array(adapterDigest, SHA256_BYTES);
    if (digest === undefined) {
      return failure();
    }

    return Object.freeze({
      apiKeyHash: hexadecimalDigest(digest),
      apiKeyPrefix: `${parsedApiKey.slice(0, 16)}...` as RegistrationApiKeyPrefix,
    });
  } catch {
    return failure();
  } finally {
    wipe(digest);
    wipe(adapterDigest);
    wipe(preimage);
  }
}

export function generateRegistrationKeyMaterial(
  random: RandomAdapter,
  hash: HashAdapter,
): RegistrationKeyMaterial {
  let adapterBytes: unknown;
  let randomBytes: Uint8Array | undefined;
  try {
    adapterBytes = random.bytes(RANDOM_BYTES);
    if (intrinsicUint8ArrayByteLength(adapterBytes) !== RANDOM_BYTES) {
      return failure();
    }
    randomBytes = copyUint8Array(adapterBytes, RANDOM_BYTES);
    if (randomBytes === undefined) {
      return failure();
    }

    // JavaScript strings cannot be wiped; every owned byte representation is.
    const apiKey = parseApiKey(
      `${API_KEY_PREFIX}${encodeBase64Url(randomBytes)}`,
    );
    const commitment = deriveRegistrationKeyCommitment(apiKey, hash);
    return Object.freeze({
      apiKey,
      apiKeyHash: commitment.apiKeyHash,
      apiKeyPrefix: commitment.apiKeyPrefix,
    });
  } catch {
    return failure();
  } finally {
    wipe(randomBytes);
    wipe(adapterBytes);
  }
}
