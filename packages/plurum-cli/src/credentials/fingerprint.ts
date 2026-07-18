import type { HashAdapter } from "../system/contracts.js";
import { CredentialError } from "./errors.js";
import {
  type CredentialV1,
  validateCredentialDocument,
} from "./schema.js";

declare const credentialKeyFingerprintBrand: unique symbol;

export type CredentialKeyFingerprint = string & {
  readonly [credentialKeyFingerprintBrand]: true;
};

const DOMAIN = new TextEncoder().encode(
  "plurum.ai/credential-key-fingerprint/sha256/v1",
);
const SHA256_DIGEST_BYTES = 32;
const DISPLAY_DIGEST_BYTES = 6;
const DISPLAY_PREFIX = "plurum-fp-v1:";

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

function encodePreimage(credential: CredentialV1): Uint8Array {
  const encoder = new TextEncoder();
  const origin = encoder.encode(credential.api_origin);
  const key = encoder.encode(credential.api_key);
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
  } finally {
    origin.fill(0);
    key.fill(0);
  }
}

function displayDigest(digest: Uint8Array): CredentialKeyFingerprint {
  let hexadecimal = "";
  for (let index = 0; index < DISPLAY_DIGEST_BYTES; index += 1) {
    const byte = digest[index];
    if (byte === undefined) {
      return failure();
    }
    hexadecimal += byte.toString(16).padStart(2, "0");
  }
  return `${DISPLAY_PREFIX}${hexadecimal}` as CredentialKeyFingerprint;
}

export function fingerprintCredentialKey(
  credential: CredentialV1,
  hash: HashAdapter,
): CredentialKeyFingerprint {
  let digest: Uint8Array | undefined;
  let preimage: Uint8Array | undefined;
  try {
    const validated = validateCredentialDocument(
      credential,
      "explicit-loopback-development",
    );
    preimage = encodePreimage(validated);
    const adapterDigest = hash.sha256(preimage);
    if (
      !(adapterDigest instanceof Uint8Array) ||
      adapterDigest.length !== SHA256_DIGEST_BYTES
    ) {
      return failure();
    }
    digest = Uint8Array.prototype.slice.call(adapterDigest) as Uint8Array;
    return displayDigest(digest);
  } catch {
    return failure();
  } finally {
    digest?.fill(0);
    preimage?.fill(0);
  }
}
