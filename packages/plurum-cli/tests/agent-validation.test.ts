import { describe, expect, it } from "vitest";

import {
  validateAgentCredential,
  type AgentCredentialValidationResult,
} from "../src/api/agent-validation.js";
import { parseStrictJsonObject } from "../src/data/strict-json-object.js";
import {
  normalizeApiOrigin,
  type ApiOrigin,
} from "../src/credentials/origin.js";
import type { ApiKey } from "../src/credentials/schema.js";
import type {
  NetworkResponse,
  ReadOnlyNetworkAdapter,
  ReadOnlyNetworkRequest,
} from "../src/system/contracts.js";

const ORIGIN = normalizeApiOrigin("https://api.plurum.ai");
const API_KEY = "plrm_live_agent_validation_key" as ApiKey;
const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const SECRET = "plrm_live_REFLECTED_SERVER_SECRET";

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

function validBody(overrides: Record<string, unknown> = {}): Uint8Array {
  return encode({
    id: AGENT_ID,
    name: "Codex",
    username: "codex-agent",
    api_key_prefix: SECRET,
    is_active: true,
    ...overrides,
  });
}

function response(
  status: number,
  body: Uint8Array = new Uint8Array(),
  headers: Readonly<Record<string, string>> = Object.freeze({
    "content-type": "application/json",
  }),
): NetworkResponse {
  return { status, headers, body };
}

function createNetwork(
  implementation: (
    request: ReadOnlyNetworkRequest,
  ) => Promise<NetworkResponse>,
): {
  readonly network: ReadOnlyNetworkAdapter;
  readonly requests: ReadOnlyNetworkRequest[];
} {
  const requests: ReadOnlyNetworkRequest[] = [];
  return {
    requests,
    network: Object.freeze({
      async request(request: ReadOnlyNetworkRequest) {
        requests.push(request);
        return implementation(request);
      },
    }),
  };
}

function serialized(result: AgentCredentialValidationResult): string {
  return JSON.stringify(result);
}

describe("strict JSON object parser", () => {
  it("returns a frozen top-level object", () => {
    const parsed = parseStrictJsonObject(
      '{"id":"one","nested":{"value":true}}',
    );

    expect(parsed).toEqual({ id: "one", nested: { value: true } });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each(["null", "[]", '"text"', "1", "true"])(
    "rejects non-object JSON %s with a fixed error",
    (text) => {
      expect(() => parseStrictJsonObject(text)).toThrow(
        "The JSON object is invalid.",
      );
    },
  );

  it.each([
    '{"id":"one","id":"two"}',
    '{"id":"one","\\u0069d":"two"}',
    '{"a":1,"\\u0061":2}',
  ])("rejects duplicate top-level keys without reflecting input", (text) => {
    let failure: unknown;
    try {
      parseStrictJsonObject(text);
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain("The JSON object is invalid.");
    expect(String(failure)).not.toContain(text);
  });

  it("does not reinterpret nested keys as top-level keys", () => {
    expect(
      parseStrictJsonObject('{"outer":{"id":1,"id":2},"id":3}'),
    ).toEqual({ outer: { id: 2 }, id: 3 });
  });

  it("rejects malformed JSON without reflecting it", () => {
    const malformed = `{"value":"${SECRET}"`;
    let failure: unknown;
    try {
      parseStrictJsonObject(malformed);
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toBe("SyntaxError: The JSON object is invalid.");
    expect(String(failure)).not.toContain(SECRET);
  });
});

describe("agent credential validation", () => {
  it("makes one exact bounded authenticated GET and returns safe identity", async () => {
    const fake = createNetwork(async () => response(200, validBody()));

    const result = await validateAgentCredential(
      fake.network,
      ORIGIN,
      API_KEY,
    );

    expect(result).toEqual({
      status: "valid",
      agent: {
        id: AGENT_ID,
        name: "Codex",
        username: "codex-agent",
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(
      result.status === "valid" && Object.isFrozen(result.agent),
    ).toBe(true);
    expect(serialized(result)).not.toContain(SECRET);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toEqual({
      url: "https://api.plurum.ai/api/v1/agents/me",
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      timeoutMs: 12_000,
      maxResponseBytes: 16_384,
      redirect: "error",
    });
    expect(Object.isFrozen(fake.requests[0])).toBe(true);
    expect(Object.isFrozen(fake.requests[0]?.headers)).toBe(true);
  });

  it.each([401, 403])(
    "treats %i as invalid without reading its reflected body",
    async (status) => {
      const reflected = {
        status,
        get headers(): Readonly<Record<string, string>> {
          throw new Error(SECRET);
        },
        get body(): Uint8Array {
          throw new Error(SECRET);
        },
      };
      const fake = createNetwork(async () => reflected);

      const result = await validateAgentCredential(
        fake.network,
        ORIGIN,
        API_KEY,
      );

      expect(result).toEqual({ status: "invalid" });
      expect(Object.isFrozen(result)).toBe(true);
      expect(serialized(result)).not.toContain(SECRET);
      expect(fake.requests).toHaveLength(1);
    },
  );

  it.each([201, 204, 301, 302, 400, 404, 408, 429, 500, 503])(
    "treats HTTP %i as indeterminate without reading its body",
    async (status) => {
      const reflected = {
        status,
        get headers(): Readonly<Record<string, string>> {
          throw new Error(SECRET);
        },
        get body(): Uint8Array {
          throw new Error(SECRET);
        },
      };
      const fake = createNetwork(async () => reflected);

      const result = await validateAgentCredential(
        fake.network,
        ORIGIN,
        API_KEY,
      );

      expect(result).toEqual({
        status: "indeterminate",
        reason: "credential_validation_unavailable",
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(serialized(result)).not.toContain(SECRET);
      expect(fake.requests).toHaveLength(1);
    },
  );

  it("snapshots a hostile status exactly once before classifying credentials", async () => {
    let reads = 0;
    const fake = createNetwork(async () => ({
      get status(): number {
        reads += 1;
        return reads === 1 ? 500 : 403;
      },
      get headers(): Readonly<Record<string, string>> {
        throw new Error(SECRET);
      },
      get body(): Uint8Array {
        throw new Error(SECRET);
      },
    }));

    const result = await validateAgentCredential(
      fake.network,
      ORIGIN,
      API_KEY,
    );

    expect(reads).toBe(1);
    expect(result).toEqual({
      status: "indeterminate",
      reason: "credential_validation_unavailable",
    });
    expect(serialized(result)).not.toContain(SECRET);
  });

  it("maps a secret-bearing transport error to the fixed indeterminate result", async () => {
    const fake = createNetwork(async () => {
      throw new Error(`DNS provider reflected ${SECRET}`);
    });

    const result = await validateAgentCredential(
      fake.network,
      ORIGIN,
      API_KEY,
    );

    expect(result).toEqual({
      status: "indeterminate",
      reason: "credential_validation_unavailable",
    });
    expect(serialized(result)).not.toContain(SECRET);
    expect(fake.requests).toHaveLength(1);
  });

  it.each([
    "application/json",
    "Application/JSON; charset=utf-8",
    'application/json; charset="utf-8"',
  ])("accepts JSON content type %s", async (contentType) => {
    const fake = createNetwork(async () =>
      response(
        200,
        validBody(),
        Object.freeze({ "Content-Type": contentType }),
      ),
    );

    await expect(
      validateAgentCredential(fake.network, ORIGIN, API_KEY),
    ).resolves.toMatchObject({ status: "valid" });
  });

  it.each([
    Object.freeze({}),
    Object.freeze({ "content-type": "text/plain" }),
    Object.freeze({ "content-type": "application/jsonp" }),
    Object.freeze({
      "content-type": "application/json",
      "Content-Type": "application/json",
    }),
  ])("rejects a missing or ambiguous JSON content type", async (headers) => {
    const fake = createNetwork(async () => response(200, validBody(), headers));

    await expect(
      validateAgentCredential(fake.network, ORIGIN, API_KEY),
    ).resolves.toEqual({
      status: "indeterminate",
      reason: "credential_validation_unavailable",
    });
  });

  it("rejects oversized and non-UTF-8 response bodies", async () => {
    for (const body of [
      new Uint8Array(16_385),
      new Uint8Array([0xc3, 0x28]),
    ]) {
      const fake = createNetwork(async () => response(200, body));
      await expect(
        validateAgentCredential(fake.network, ORIGIN, API_KEY),
      ).resolves.toEqual({
        status: "indeterminate",
        reason: "credential_validation_unavailable",
      });
    }
  });

  it("uses intrinsic byte length before copying an adversarial response", async () => {
    const body = new Uint8Array(16_385);
    Object.defineProperties(body, {
      byteLength: { get: () => 1 },
      length: { get: () => 1 },
    });
    const fake = createNetwork(async () => response(200, body));

    await expect(
      validateAgentCredential(fake.network, ORIGIN, API_KEY),
    ).resolves.toEqual({
      status: "indeterminate",
      reason: "credential_validation_unavailable",
    });
  });

  it.each([
    ["name", { name: API_KEY }],
    ["username", { username: API_KEY }],
    [
      "key-shaped name token",
      { name: `reflected plrm_live_other_secret_1234567890` },
    ],
    [
      "zero-width-obscured name",
      { name: [...API_KEY].join("\u200b") },
    ],
  ] as const)(
    "rejects a credential reflected through the agent %s",
    async (_label, overrides) => {
      const fake = createNetwork(async () =>
        response(200, validBody({ ...overrides })),
      );

      const result = await validateAgentCredential(
        fake.network,
        ORIGIN,
        API_KEY,
      );

      expect(result).toEqual({
        status: "indeterminate",
        reason: "credential_validation_unavailable",
      });
      expect(serialized(result)).not.toContain(API_KEY);
    },
  );

  it.each([
    ["invalid id", { id: "not-a-uuid" }],
    ["missing name", { name: undefined }],
    ["empty name", { name: "" }],
    ["controlled name", { name: `Codex\n${SECRET}` }],
    ["bidi name", { name: `Codex\u202e${SECRET}` }],
    ["invalid username", { username: "Not Valid" }],
    ["short username", { username: "ab" }],
    ["inactive agent", { is_active: false }],
  ] as const)("rejects a malformed 200 identity: %s", async (_label, overrides) => {
    const fake = createNetwork(async () => response(200, validBody({ ...overrides })));

    const result = await validateAgentCredential(
      fake.network,
      ORIGIN,
      API_KEY,
    );

    expect(result).toEqual({
      status: "indeterminate",
      reason: "credential_validation_unavailable",
    });
    expect(serialized(result)).not.toContain(SECRET);
  });

  it("accepts a null username", async () => {
    const fake = createNetwork(async () =>
      response(200, validBody({ username: null })),
    );

    await expect(
      validateAgentCredential(fake.network, ORIGIN, API_KEY),
    ).resolves.toEqual({
      status: "valid",
      agent: { id: AGENT_ID, name: "Codex", username: null },
    });
  });

  it("rejects duplicate top-level identity fields", async () => {
    const fake = createNetwork(async () =>
      response(
        200,
        encode(
          `{"id":"${AGENT_ID}","id":"${AGENT_ID}","name":"Codex","username":"codex-agent","is_active":true}`,
        ),
      ),
    );

    await expect(
      validateAgentCredential(fake.network, ORIGIN, API_KEY),
    ).resolves.toEqual({
      status: "indeterminate",
      reason: "credential_validation_unavailable",
    });
  });

  it("fails closed before networking for forged key and origin values", async () => {
    const fake = createNetwork(async () => response(200, validBody()));
    const attempts: ReadonlyArray<readonly [ApiOrigin, ApiKey]> = [
      [ORIGIN, `plrm_live_valid\r\n${SECRET}` as ApiKey],
      ["https://api.plurum.ai/" as ApiOrigin, API_KEY],
      [`https://${SECRET}.invalid` as ApiOrigin, API_KEY],
    ];

    for (const [origin, key] of attempts) {
      await expect(
        validateAgentCredential(fake.network, origin, key),
      ).resolves.toEqual({
        status: "indeterminate",
        reason: "credential_validation_unavailable",
      });
    }
    expect(fake.requests).toEqual([]);
  });

  it("requires explicit policy authorization for numeric-loopback HTTP", async () => {
    const loopback = normalizeApiOrigin(
      "http://127.0.0.1:43197",
      "explicit-loopback-development",
    );
    const fake = createNetwork(async () => response(200, validBody()));

    await expect(
      validateAgentCredential(fake.network, loopback, API_KEY),
    ).resolves.toEqual({
      status: "indeterminate",
      reason: "credential_validation_unavailable",
    });
    expect(fake.requests).toHaveLength(0);

    await expect(
      validateAgentCredential(
        fake.network,
        loopback,
        API_KEY,
        "explicit-loopback-development",
      ),
    ).resolves.toMatchObject({ status: "valid" });
    expect(fake.requests[0]?.url).toBe(
      "http://127.0.0.1:43197/api/v1/agents/me",
    );
  });
});
