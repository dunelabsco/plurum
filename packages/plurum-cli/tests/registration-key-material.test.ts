import { describe, expect, it } from "vitest";

import { nodeHash } from "../src/adapters/node/hash.js";
import {
  RegistrationKeyMaterialError,
  deriveRegistrationKeyCommitment,
  generateRegistrationKeyMaterial,
} from "../src/registration/key-material.js";
import {
  parseApiKey,
  type ApiKey,
} from "../src/credentials/schema.js";
import type {
  HashAdapter,
  RandomAdapter,
} from "../src/system/contracts.js";

const ZERO_KEY =
  "plrm_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ZERO_KEY_SHA256 =
  "844b408f85adab2867210d560a76a3e013ac2d4e3bfb850e033eeba69b6ac119";
const CANARY = "REGISTRATION_KEY_MATERIAL_SECRET_CANARY";

function fixedRandom(
  implementation: (length: number) => Uint8Array,
): RandomAdapter {
  return Object.freeze({
    bytes: implementation,
    uuid(): string {
      throw new Error("UUID generation is outside this operation.");
    },
  });
}

function detachedBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
  return bytes;
}

function expectSafeFailure(operation: () => unknown): void {
  try {
    operation();
    throw new Error("registration key operation unexpectedly succeeded");
  } catch (error) {
    expect(error).toBeInstanceOf(RegistrationKeyMaterialError);
    expect(error).toMatchObject({
      code: "registration_key_material_failed",
    });
    expect(String(error)).toBe(
      "RegistrationKeyMaterialError: Plurum registration key material could not be created safely.",
    );
    expect(String(error)).not.toContain(CANARY);
  }
}

describe("registration key generation", () => {
  it("generates the exact 32-byte base64url key and plain SHA-256 commitment", () => {
    const randomOutput = new Uint8Array(32);
    let requestedLength: number | undefined;
    let hashPreimage: Uint8Array | undefined;
    let hashPreimageSnapshot: Uint8Array | undefined;
    let adapterDigest: Uint8Array | undefined;
    const random = fixedRandom((length) => {
      requestedLength = length;
      return randomOutput;
    });
    const hash: HashAdapter = Object.freeze({
      sha256(data: Uint8Array): Uint8Array {
        hashPreimage = data;
        hashPreimageSnapshot = data.slice();
        adapterDigest = nodeHash.sha256(data);
        return adapterDigest;
      },
    });

    const material = generateRegistrationKeyMaterial(random, hash);

    expect(requestedLength).toBe(32);
    expect(material).toEqual({
      apiKey: ZERO_KEY,
      apiKeyHash: ZERO_KEY_SHA256,
      apiKeyPrefix: "plrm_live_AAAAAA...",
    });
    expect(material.apiKey).toHaveLength(53);
    expect(material.apiKey.slice("plrm_live_".length)).toHaveLength(43);
    expect(material.apiKey).not.toContain("=");
    expect(Object.isFrozen(material)).toBe(true);
    expect(new TextDecoder().decode(hashPreimageSnapshot)).toBe(ZERO_KEY);
    expect(randomOutput.every((byte) => byte === 0)).toBe(true);
    expect(hashPreimage?.every((byte) => byte === 0)).toBe(true);
    expect(adapterDigest?.every((byte) => byte === 0)).toBe(true);
  });

  it("encodes all bytes with the URL-safe alphabet and a canonical final character", () => {
    const randomBytes = new Uint8Array(
      Array.from({ length: 32 }, (_value, index) => index * 7 + 3),
    );
    const snapshot = randomBytes.slice();

    const material = generateRegistrationKeyMaterial(
      fixedRandom(() => randomBytes),
      nodeHash,
    );

    expect(material.apiKey).toBe(
      `plrm_live_${Buffer.from(snapshot).toString("base64url")}`,
    );
    expect(material.apiKey).toMatch(
      /^plrm_live_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u,
    );
    expect(randomBytes.every((byte) => byte === 0)).toBe(true);
  });

  it("accepts every canonical final character produced by 32 input bytes", () => {
    const finalCharacters: string[] = [];
    for (let lowNibble = 0; lowNibble < 16; lowNibble += 1) {
      const bytes = new Uint8Array(32);
      bytes[31] = lowNibble;
      const material = generateRegistrationKeyMaterial(
        fixedRandom(() => bytes),
        nodeHash,
      );
      finalCharacters.push(material.apiKey.at(-1) ?? "");
    }

    expect(finalCharacters.join("")).toBe("AEIMQUYcgkosw048");
  });

  it.each([
    ["too short", () => new Uint8Array(31)],
    ["too long", () => new Uint8Array(33)],
    ["detached", () => detachedBytes(32)],
    [
      "proxied",
      () => new Proxy(new Uint8Array(32), {}) as unknown as Uint8Array,
    ],
  ])("rejects %s random adapter output with one fixed error", (_name, make) => {
    expectSafeFailure(() =>
      generateRegistrationKeyMaterial(fixedRandom(make), nodeHash),
    );
  });

  it("maps a secret-bearing random adapter failure to one fixed error", () => {
    expectSafeFailure(() =>
      generateRegistrationKeyMaterial(
        fixedRandom(() => {
          throw new Error(CANARY);
        }),
        nodeHash,
      ),
    );
  });

  it("wipes random output even when hashing fails", () => {
    const randomOutput = new Uint8Array(32).fill(0xa5);
    const failingHash: HashAdapter = Object.freeze({
      sha256(): Uint8Array {
        throw new Error(CANARY);
      },
    });

    expectSafeFailure(() =>
      generateRegistrationKeyMaterial(
        fixedRandom(() => randomOutput),
        failingHash,
      ),
    );
    expect(randomOutput.every((byte) => byte === 0)).toBe(true);
  });
});

describe("registration key commitment derivation", () => {
  it("derives the same golden commitment without requesting randomness", () => {
    const apiKey = parseApiKey(ZERO_KEY);

    const commitment = deriveRegistrationKeyCommitment(apiKey, nodeHash);

    expect(commitment).toEqual({
      apiKeyHash: ZERO_KEY_SHA256,
      apiKeyPrefix: "plrm_live_AAAAAA...",
    });
    expect(Object.isFrozen(commitment)).toBe(true);
    expect(JSON.stringify(commitment)).not.toContain(apiKey);
  });

  it.each([
    "plrm_live_ABCDEFGHIJ",
    `plrm_live_${"A".repeat(42)}B`,
    `plrm_live_${"A".repeat(44)}`,
    "plrm_live_ABCDEFGHI!",
  ])("rejects non-generated key form %s before hashing", (rawApiKey) => {
    let called = false;
    const hash: HashAdapter = Object.freeze({
      sha256(): Uint8Array {
        called = true;
        return new Uint8Array(32);
      },
    });

    expectSafeFailure(() =>
      deriveRegistrationKeyCommitment(rawApiKey as ApiKey, hash),
    );
    expect(called).toBe(false);
  });

  it.each([
    ["too short", () => new Uint8Array(31)],
    ["too long", () => new Uint8Array(33)],
    ["detached", () => detachedBytes(32)],
    [
      "proxied",
      () => new Proxy(new Uint8Array(32), {}) as unknown as Uint8Array,
    ],
  ])("rejects %s hash adapter output and wipes its preimage", (_name, make) => {
    let retainedPreimage: Uint8Array | undefined;
    const hash: HashAdapter = Object.freeze({
      sha256(data: Uint8Array): Uint8Array {
        retainedPreimage = data;
        return make();
      },
    });

    expectSafeFailure(() =>
      deriveRegistrationKeyCommitment(parseApiKey(ZERO_KEY), hash),
    );
    expect(
      retainedPreimage === undefined ||
        retainedPreimage.every((byte) => byte === 0),
    ).toBe(true);
  });

  it("maps a secret-bearing hash failure to one fixed non-reflecting error", () => {
    const hash: HashAdapter = Object.freeze({
      sha256(): Uint8Array {
        throw new Error(CANARY);
      },
    });

    expectSafeFailure(() =>
      deriveRegistrationKeyCommitment(parseApiKey(ZERO_KEY), hash),
    );
  });
});
