import { describe, expect, it } from "vitest";

import { nodeHash } from "../src/adapters/node/hash.js";
import { CredentialError } from "../src/credentials/errors.js";
import {
  fingerprintCredentialKey,
  identifyCredentialKey,
  identifyCredentialKeyBytes,
} from "../src/credentials/fingerprint.js";
import {
  type CredentialV1,
  parseApiKey,
  validateCredentialDocument,
} from "../src/credentials/schema.js";
import type { HashAdapter } from "../src/system/contracts.js";

const API_KEY = "plrm_live_ABCDEFGHIJ";
const CANARY = "FINGERPRINT_FAILURE_CANARY";

function credential(overrides: Record<string, unknown> = {}) {
  return validateCredentialDocument({
    schema_version: 1,
    state: "active",
    api_origin: "https://api.plurum.ai",
    api_key: API_KEY,
    agent_id: "123e4567-e89b-42d3-a456-426614174000",
    agent_name: "Codex",
    username: "codex-42",
    registration_request_id: "ca908d9f-d901-4dac-b396-7f84377adfc8",
    created_at: "2026-07-16T12:00:00.000Z",
    updated_at: "2026-07-16T12:01:00.000Z",
    activated_at: "2026-07-16T12:01:00.000Z",
    ...overrides,
  });
}

function hexadecimal(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

describe("API key parsing", () => {
  it("accepts the exact supported API key alphabet and length boundaries", () => {
    const shortest = `plrm_live_${"A".repeat(10)}`;
    const longest = `plrm_live_${"a0_-".repeat(50)}`;

    expect(parseApiKey(shortest)).toBe(shortest);
    expect(parseApiKey(longest)).toBe(longest);
  });

  it.each([
    undefined,
    null,
    42,
    "",
    "plrm_live_ABCDEFGHI",
    `plrm_live_${"A".repeat(201)}`,
    "plrm_test_ABCDEFGHIJ",
    "plrm_live_ABCDEFGHI!",
    " plrm_live_ABCDEFGHIJ",
    "plrm_live_ABCDEFGHIJ ",
    "Bearer plrm_live_ABCDEFGHIJ",
  ])("rejects malformed input with one fixed non-secret error", (input) => {
    try {
      parseApiKey(input);
      throw new Error("malformed API key unexpectedly accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialError);
      expect(error).toMatchObject({ code: "invalid_api_key" });
      expect(String(error)).toBe(
        "CredentialError: The Plurum API key is invalid.",
      );
      if (typeof input === "string" && input.length > 0) {
        expect(String(error)).not.toContain(input);
      }
    }
  });
});

describe("credential key identity", () => {
  it.each([
    `plrm_live_${"A".repeat(10)}`,
    `plrm_live_${"a0_-".repeat(50)}`,
  ])("derives the same identity directly from valid mutable bytes", (key) => {
    const bytes = new TextEncoder().encode(key);
    const before = bytes.slice();

    expect(
      identifyCredentialKeyBytes(
        "HTTPS://API.PLURUM.AI:443/",
        bytes,
        "https-only",
        nodeHash,
      ),
    ).toEqual(
      identifyCredentialKey(
        "https://api.plurum.ai",
        key,
        "https-only",
        nodeHash,
      ),
    );
    expect(bytes).toEqual(before);
    before.fill(0);
    bytes.fill(0);
  });

  it("rejects invalid credential bytes before hashing without altering the caller buffer", () => {
    const bytes = new TextEncoder().encode("plrm_live_ABCDEFGHI!");
    const before = bytes.slice();
    let called = false;
    const hash: HashAdapter = Object.freeze({
      sha256(): Uint8Array {
        called = true;
        return new Uint8Array(32);
      },
    });

    expect(() =>
      identifyCredentialKeyBytes(
        "https://api.plurum.ai",
        bytes,
        "https-only",
        hash,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "credential_fingerprint_failed" }),
    );
    expect(called).toBe(false);
    expect(bytes).toEqual(before);
    before.fill(0);
    bytes.fill(0);
  });

  it("never exposes or mutates the caller key buffer through a hostile hash adapter", () => {
    const bytes = new TextEncoder().encode(API_KEY);
    const before = bytes.slice();
    let retainedPreimage: Uint8Array | undefined;
    let receivedCallerBuffer = false;
    const hash: HashAdapter = Object.freeze({
      sha256(data: Uint8Array): Uint8Array {
        receivedCallerBuffer = data === bytes;
        retainedPreimage = data;
        const digest = nodeHash.sha256(data);
        data.fill(0xa5);
        return digest;
      },
    });

    expect(
      identifyCredentialKeyBytes(
        "https://api.plurum.ai",
        bytes,
        "https-only",
        hash,
      ),
    ).toEqual(
      identifyCredentialKey(
        "https://api.plurum.ai",
        API_KEY,
        "https-only",
        nodeHash,
      ),
    );
    expect(receivedCallerBuffer).toBe(false);
    expect(bytes).toEqual(before);
    expect(retainedPreimage?.every((byte) => byte === 0)).toBe(true);
    before.fill(0);
    bytes.fill(0);
  });

  it("returns the full audited digest and compatible display fingerprint", () => {
    let preimage: Uint8Array | undefined;
    let adapterDigest: Uint8Array | undefined;
    const capturingHash: HashAdapter = Object.freeze({
      sha256(data: Uint8Array): Uint8Array {
        preimage = data;
        adapterDigest = nodeHash.sha256(data);
        return adapterDigest;
      },
    });

    const identified = identifyCredentialKey(
      "https://api.plurum.ai",
      API_KEY,
      "https-only",
      capturingHash,
    );

    expect(identified).toEqual({
      identity:
        "16fe461aa99a080414a0a8e5e951eea0ef1b87294d74061128bc9df1fd44835e",
      fingerprint: "plurum-fp-v1:16fe461aa99a",
    });
    expect(Object.isFrozen(identified)).toBe(true);
    expect(identified.identity).toMatch(/^[0-9a-f]{64}$/u);
    expect(identified.identity).not.toContain(API_KEY);
    expect(identified.fingerprint).not.toContain(API_KEY);
    expect(preimage?.every((byte) => byte === 0)).toBe(true);
    expect(adapterDigest).toBeDefined();
    expect(hexadecimal(adapterDigest!)).toBe(identified.identity);
  });

  it("normalizes the origin under the supplied policy before hashing", () => {
    const canonical = identifyCredentialKey(
      "https://api.plurum.ai",
      API_KEY,
      "https-only",
      nodeHash,
    );
    const equivalent = identifyCredentialKey(
      "HTTPS://API.PLURUM.AI:443/",
      API_KEY,
      "https-only",
      nodeHash,
    );

    expect(equivalent).toEqual(canonical);
    expect(
      identifyCredentialKey(
        "http://127.0.0.1:43197",
        API_KEY,
        "explicit-loopback-development",
        nodeHash,
      ).identity,
    ).toMatch(/^[0-9a-f]{64}$/u);
    expect(() =>
      identifyCredentialKey(
        "http://127.0.0.1:43197",
        API_KEY,
        "https-only",
        nodeHash,
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_api_origin" }));
  });

  it("is deterministic and distinct across canonical origins and keys", () => {
    const baseline = identifyCredentialKey(
      "https://api.plurum.ai",
      API_KEY,
      "https-only",
      nodeHash,
    );
    const repeated = identifyCredentialKey(
      "https://api.plurum.ai",
      API_KEY,
      "https-only",
      nodeHash,
    );
    const changedOrigin = identifyCredentialKey(
      "https://api.example.test",
      API_KEY,
      "https-only",
      nodeHash,
    );
    const changedKey = identifyCredentialKey(
      "https://api.plurum.ai",
      "plrm_live_ABCDEFGHIJK",
      "https-only",
      nodeHash,
    );

    expect(repeated).toEqual(baseline);
    expect(changedOrigin.identity).not.toBe(baseline.identity);
    expect(changedKey.identity).not.toBe(baseline.identity);
    expect(changedOrigin.fingerprint).not.toBe(baseline.fingerprint);
    expect(changedKey.fingerprint).not.toBe(baseline.fingerprint);
  });

  it("rejects malformed keys and policies before calling the hash adapter", () => {
    let called = false;
    const observingHash: HashAdapter = Object.freeze({
      sha256(): Uint8Array {
        called = true;
        return new Uint8Array(32);
      },
    });

    expect(() =>
      identifyCredentialKey(
        "https://api.plurum.ai",
        `plrm_live_${CANARY}!`,
        "https-only",
        observingHash,
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_api_key" }));
    expect(() =>
      identifyCredentialKey(
        "https://api.plurum.ai",
        API_KEY,
        "unsupported" as "https-only",
        observingHash,
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_api_origin" }));
    expect(called).toBe(false);
  });

  it("wipes the owned preimage even when the adapter mutates it", () => {
    let retainedPreimage: Uint8Array | undefined;
    const mutatingHash: HashAdapter = Object.freeze({
      sha256(data: Uint8Array): Uint8Array {
        retainedPreimage = data;
        const digest = nodeHash.sha256(data);
        data.fill(0xa5);
        return digest;
      },
    });

    const identified = identifyCredentialKey(
      "https://api.plurum.ai",
      API_KEY,
      "https-only",
      mutatingHash,
    );

    expect(identified.identity).toBe(
      "16fe461aa99a080414a0a8e5e951eea0ef1b87294d74061128bc9df1fd44835e",
    );
    expect(retainedPreimage?.every((byte) => byte === 0)).toBe(true);
  });

  it.each([0, 31, 33])(
    "rejects a %s-byte identity digest with one fixed non-secret error",
    (length) => {
      const invalidHash: HashAdapter = Object.freeze({
        sha256(): Uint8Array {
          return new Uint8Array(length);
        },
      });

      expect(() =>
        identifyCredentialKey(
          "https://api.plurum.ai",
          API_KEY,
          "https-only",
          invalidHash,
        ),
      ).toThrowError(
        expect.objectContaining({ code: "credential_fingerprint_failed" }),
      );
    },
  );

  it("replaces malformed or failing adapter output without reflecting secrets", () => {
    const malformedHash: HashAdapter = Object.freeze({
      sha256(): Uint8Array {
        return "not-bytes" as unknown as Uint8Array;
      },
    });
    const failingHash: HashAdapter = Object.freeze({
      sha256(): Uint8Array {
        throw new Error(`${API_KEY}:${CANARY}`);
      },
    });

    for (const hash of [malformedHash, failingHash]) {
      try {
        identifyCredentialKey(
          "https://api.plurum.ai",
          API_KEY,
          "https-only",
          hash,
        );
        throw new Error("invalid adapter unexpectedly accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(CredentialError);
        expect(error).toMatchObject({
          code: "credential_fingerprint_failed",
        });
        expect(String(error)).not.toContain(API_KEY);
        expect(String(error)).not.toContain(CANARY);
      }
    }
  });
});

describe("credential key fingerprint", () => {
  it("matches the audited origin-bound framing and display vector", () => {
    let preimage: Uint8Array | undefined;
    let fullDigest: Uint8Array | undefined;
    const capturingHash: HashAdapter = Object.freeze({
      sha256(data: Uint8Array): Uint8Array {
        preimage = data;
        fullDigest = nodeHash.sha256(data);
        return fullDigest;
      },
    });

    expect(fingerprintCredentialKey(credential(), capturingHash)).toBe(
      "plurum-fp-v1:16fe461aa99a",
    );
    expect(preimage).toBeDefined();
    expect(preimage?.every((byte) => byte === 0)).toBe(true);
    expect(fullDigest).toBeDefined();
    expect(hexadecimal(fullDigest!)).toBe(
      "16fe461aa99a080414a0a8e5e951eea0ef1b87294d74061128bc9df1fd44835e",
    );
  });

  it("is stable and changes when either the canonical origin or key changes", () => {
    const baseline = fingerprintCredentialKey(credential(), nodeHash);
    expect(fingerprintCredentialKey(credential(), nodeHash)).toBe(baseline);
    const changedOrigin = fingerprintCredentialKey(
      credential({ api_origin: "https://api.example.test" }),
      nodeHash,
    );
    const changedKey = fingerprintCredentialKey(
      credential({ api_key: "plrm_live_ABCDEFGHIJK" }),
      nodeHash,
    );

    expect(changedOrigin).not.toBe(baseline);
    expect(changedKey).not.toBe(baseline);
    for (const fingerprint of [baseline, changedOrigin, changedKey]) {
      expect(fingerprint).toMatch(/^plurum-fp-v1:[0-9a-f]{12}$/u);
      expect(fingerprint).not.toContain("plrm_live_");
    }
  });

  it("preserves an explicitly validated canonical loopback development origin", () => {
    const loopback = validateCredentialDocument(
      {
        ...credential(),
        api_origin: "http://127.0.0.1:43197",
      },
      "explicit-loopback-development",
    );

    expect(fingerprintCredentialKey(loopback, nodeHash)).toMatch(
      /^plurum-fp-v1:[0-9a-f]{12}$/u,
    );
  });

  it("wipes the internal preimage even when an adapter mutates it", () => {
    let retainedPreimage: Uint8Array | undefined;
    const mutatingHash: HashAdapter = Object.freeze({
      sha256(data: Uint8Array): Uint8Array {
        retainedPreimage = data;
        const digest = nodeHash.sha256(data);
        data.fill(0xa5);
        return digest;
      },
    });

    expect(fingerprintCredentialKey(credential(), mutatingHash)).toBe(
      "plurum-fp-v1:16fe461aa99a",
    );
    expect(retainedPreimage?.every((byte) => byte === 0)).toBe(true);
  });

  it("runtime-rejects invalid credential casts before hashing", () => {
    const secretKey = `plrm_live_${CANARY}`;
    const invalidCredential = {
      ...credential({ api_key: secretKey }),
      api_origin: "HTTPS://API.PLURUM.AI",
    } as unknown as CredentialV1;
    let called = false;
    const observingHash: HashAdapter = Object.freeze({
      sha256(): Uint8Array {
        called = true;
        return new Uint8Array(32);
      },
    });

    try {
      fingerprintCredentialKey(invalidCredential, observingHash);
      throw new Error("runtime-invalid credential unexpectedly accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialError);
      expect(error).toMatchObject({ code: "credential_fingerprint_failed" });
      expect(String(error)).not.toContain(secretKey);
      expect(String(error)).not.toContain(CANARY);
      expect(called).toBe(false);
    }
  });

  it.each([0, 31, 33])(
    "rejects a %s-byte adapter digest with one fixed non-secret error",
    (length) => {
      const invalidHash: HashAdapter = Object.freeze({
        sha256(): Uint8Array {
          return new Uint8Array(length);
        },
      });

      try {
        fingerprintCredentialKey(credential(), invalidHash);
        throw new Error("invalid digest unexpectedly accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(CredentialError);
        expect(error).toMatchObject({ code: "credential_fingerprint_failed" });
        expect(String(error)).toBe(
          "CredentialError: The Plurum credential fingerprint could not be created.",
        );
        expect(String(error)).not.toContain(API_KEY);
      }
    },
  );

  it("replaces adapter failures without reflecting secrets or diagnostics", () => {
    const failingHash: HashAdapter = Object.freeze({
      sha256(): Uint8Array {
        throw new Error(`${API_KEY}:${CANARY}`);
      },
    });

    try {
      fingerprintCredentialKey(credential(), failingHash);
      throw new Error("failing adapter unexpectedly succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialError);
      expect(error).toMatchObject({ code: "credential_fingerprint_failed" });
      expect(String(error)).not.toContain(API_KEY);
      expect(String(error)).not.toContain(CANARY);
    }
  });

  it("rejects non-byte adapter results without exposing the credential", () => {
    const invalidHash: HashAdapter = Object.freeze({
      sha256(): Uint8Array {
        return "not-bytes" as unknown as Uint8Array;
      },
    });

    expect(() => fingerprintCredentialKey(credential(), invalidHash)).toThrowError(
      expect.objectContaining({
        code: "credential_fingerprint_failed",
      }),
    );
  });
});
