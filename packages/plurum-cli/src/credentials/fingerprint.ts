import type { HashAdapter } from "../system/contracts.js";
import { CredentialError } from "./errors.js";
import {
  type ApiOrigin,
  type ApiOriginPolicy,
  normalizeApiOrigin,
} from "./origin.js";
import {
  type ApiKey,
  type CredentialV1,
  parseApiKey,
  validateCredentialDocument,
} from "./schema.js";

declare const credentialKeyFingerprintBrand: unique symbol;
declare const credentialKeyIdentityBrand: unique symbol;

export type CredentialKeyFingerprint = string & {
  readonly [credentialKeyFingerprintBrand]: true;
};

export type CredentialKeyIdentity = string & {
  readonly [credentialKeyIdentityBrand]: true;
};

export interface IdentifiedCredentialKey {
  readonly identity: CredentialKeyIdentity;
  readonly fingerprint: CredentialKeyFingerprint;
}

const DOMAIN = new TextEncoder().encode(
  "plurum.ai/credential-key-fingerprint/sha256/v1",
);
const SHA256_DIGEST_BYTES = 32;
const DISPLAY_DIGEST_BYTES = 6;
const DISPLAY_PREFIX = "plurum-fp-v1:";
const fillBytes = Uint8Array.prototype.fill;
const setBytes = Uint8Array.prototype.set;

function writeUint32BigEndian(
  destination: Uint8Array,
  offset: number,
  value: number,
): void {
  destination[offset] = value >>> 24;
  destination[offset + 1] = value >>> 16;
  destination[offset + 2] = value >>> 8;
  destination[offset + 3] = value;
}

function failure(): never {
  throw new CredentialError("credential_fingerprint_failed");
}

function wipe(bytes: Uint8Array | undefined): void {
  if (bytes === undefined) {
    return;
  }
  try {
    fillBytes.call(bytes, 0);
  } catch {
    // A hostile adapter may detach the exposed preimage. Detached data is gone.
  }
}

function encodePreimage(apiOrigin: ApiOrigin, apiKey: ApiKey): Uint8Array {
  const encoder = new TextEncoder();
  const origin = encoder.encode(apiOrigin);
  const key = encoder.encode(apiKey);
  try {
    return encodePreimageBytes(origin, key);
  } finally {
    wipe(origin);
    wipe(key);
  }
}

function encodePreimageBytes(
  origin: Uint8Array,
  key: Uint8Array,
): Uint8Array {
  try {
    const length = DOMAIN.length + 1 + 4 + origin.length + 4 + key.length;
    if (
      origin.length > 0xffff_ffff ||
      key.length > 0xffff_ffff ||
      !Number.isSafeInteger(length)
    ) {
      return failure();
    }

    const preimage = new Uint8Array(length);
    let offset = 0;
    preimage.set(DOMAIN, offset);
    offset += DOMAIN.length;
    preimage[offset] = 0;
    offset += 1;
    writeUint32BigEndian(preimage, offset, origin.length);
    offset += 4;
    preimage.set(origin, offset);
    offset += origin.length;
    writeUint32BigEndian(preimage, offset, key.length);
    offset += 4;
    preimage.set(key, offset);
    return preimage;
  } catch {
    return failure();
  }
}

function validApiKeyBytes(value: Uint8Array): boolean {
  const prefix = "plrm_live_";
  try {
    if (
      !(value instanceof Uint8Array) ||
      value.length < 20 ||
      value.length > 210
    ) {
      return false;
    }
    for (let index = 0; index < value.length; index += 1) {
      const byte = value[index];
      if (byte === undefined) {
        return false;
      }
      if (index < prefix.length) {
        if (byte !== prefix.charCodeAt(index)) {
          return false;
        }
        continue;
      }
      if (
        (byte < 0x30 || byte > 0x39) &&
        (byte < 0x41 || byte > 0x5a) &&
        byte !== 0x5f &&
        (byte < 0x61 || byte > 0x7a) &&
        byte !== 0x2d
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function hexadecimalDigest(digest: Uint8Array, bytes: number): string {
  let hexadecimal = "";
  for (let index = 0; index < bytes; index += 1) {
    const byte = digest[index];
    if (byte === undefined) {
      return failure();
    }
    hexadecimal += byte.toString(16).padStart(2, "0");
  }
  return hexadecimal;
}

function displayDigest(digest: Uint8Array): CredentialKeyFingerprint {
  const hexadecimal = hexadecimalDigest(digest, DISPLAY_DIGEST_BYTES);
  return `${DISPLAY_PREFIX}${hexadecimal}` as CredentialKeyFingerprint;
}

function fullDigest(digest: Uint8Array): CredentialKeyIdentity {
  return hexadecimalDigest(
    digest,
    SHA256_DIGEST_BYTES,
  ) as CredentialKeyIdentity;
}

function hashCredentialKey(
  apiOrigin: ApiOrigin,
  apiKey: ApiKey,
  hash: HashAdapter,
): IdentifiedCredentialKey {
  let digest: Uint8Array | undefined;
  let preimage: Uint8Array | undefined;
  try {
    preimage = encodePreimage(apiOrigin, apiKey);
    const adapterDigest = hash.sha256(preimage);
    if (
      !(adapterDigest instanceof Uint8Array) ||
      adapterDigest.length !== SHA256_DIGEST_BYTES
    ) {
      return failure();
    }
    digest = new Uint8Array(SHA256_DIGEST_BYTES);
    setBytes.call(digest, adapterDigest);
    return Object.freeze({
      identity: fullDigest(digest),
      fingerprint: displayDigest(digest),
    });
  } catch {
    return failure();
  } finally {
    wipe(digest);
    wipe(preimage);
  }
}

function hashCredentialKeyBytes(
  apiOrigin: ApiOrigin,
  apiKey: Uint8Array,
  hash: HashAdapter,
): IdentifiedCredentialKey {
  let digest: Uint8Array | undefined;
  let origin: Uint8Array | undefined;
  let preimage: Uint8Array | undefined;
  try {
    if (!validApiKeyBytes(apiKey)) {
      return failure();
    }
    origin = new TextEncoder().encode(apiOrigin);
    preimage = encodePreimageBytes(origin, apiKey);
    const adapterDigest = hash.sha256(preimage);
    if (
      !(adapterDigest instanceof Uint8Array) ||
      adapterDigest.length !== SHA256_DIGEST_BYTES
    ) {
      return failure();
    }
    digest = new Uint8Array(SHA256_DIGEST_BYTES);
    setBytes.call(digest, adapterDigest);
    return Object.freeze({
      identity: fullDigest(digest),
      fingerprint: displayDigest(digest),
    });
  } catch {
    return failure();
  } finally {
    wipe(digest);
    wipe(origin);
    wipe(preimage);
  }
}

export function identifyCredentialKey(
  apiOrigin: unknown,
  apiKey: unknown,
  originPolicy: ApiOriginPolicy,
  hash: HashAdapter,
): IdentifiedCredentialKey {
  if (
    originPolicy !== "https-only" &&
    originPolicy !== "explicit-loopback-development"
  ) {
    throw new CredentialError("invalid_api_origin");
  }
  const normalizedOrigin = normalizeApiOrigin(apiOrigin, originPolicy);
  const parsedApiKey = parseApiKey(apiKey);
  return hashCredentialKey(normalizedOrigin, parsedApiKey, hash);
}

export function identifyCredentialKeyBytes(
  apiOrigin: unknown,
  apiKey: Uint8Array,
  originPolicy: ApiOriginPolicy,
  hash: HashAdapter,
): IdentifiedCredentialKey {
  if (
    originPolicy !== "https-only" &&
    originPolicy !== "explicit-loopback-development"
  ) {
    throw new CredentialError("invalid_api_origin");
  }
  const normalizedOrigin = normalizeApiOrigin(apiOrigin, originPolicy);
  return hashCredentialKeyBytes(normalizedOrigin, apiKey, hash);
}

export function fingerprintCredentialKey(
  credential: CredentialV1,
  hash: HashAdapter,
): CredentialKeyFingerprint {
  try {
    const validated = validateCredentialDocument(
      credential,
      "explicit-loopback-development",
    );
    return identifyCredentialKey(
      validated.api_origin,
      validated.api_key,
      "explicit-loopback-development",
      hash,
    ).fingerprint;
  } catch {
    return failure();
  }
}
