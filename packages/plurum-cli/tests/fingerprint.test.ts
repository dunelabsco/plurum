import { describe, expect, it } from "vitest";

import { nodeHash } from "../src/adapters/node/hash.js";
import { CredentialError } from "../src/credentials/errors.js";
import { fingerprintCredentialKey } from "../src/credentials/fingerprint.js";
import {
  type CredentialV1,
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
