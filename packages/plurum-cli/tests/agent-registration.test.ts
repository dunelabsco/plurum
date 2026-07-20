import { describe, expect, it } from "vitest";

import {
  AgentRegistrationRequestError,
  registerCliAgent,
  type CliAgentRegistrationInput,
  type CliAgentRegistrationResult,
} from "../src/api/agent-registration.js";
import { nodeHash } from "../src/adapters/node/hash.js";
import {
  normalizeApiOrigin,
  type ApiOrigin,
} from "../src/credentials/origin.js";
import {
  parseApiKey,
  type AgentName,
  type RegistrationRequestId,
  type Username,
} from "../src/credentials/schema.js";
import {
  deriveRegistrationKeyCommitment,
  type RegistrationApiKeyHash,
  type RegistrationApiKeyPrefix,
} from "../src/registration/key-material.js";
import type {
  NetworkAdapter,
  NetworkRequest,
  NetworkResponse,
} from "../src/system/contracts.js";

const ORIGIN = normalizeApiOrigin("https://api.plurum.ai");
const REQUEST_ID =
  "ca908d9f-d901-4dac-b396-7f84377adfc8" as RegistrationRequestId;
const AGENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const API_KEY = parseApiKey(
  "plrm_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
);
const COMMITMENT = deriveRegistrationKeyCommitment(API_KEY, nodeHash);
const CANARY = "AGENT_REGISTRATION_SECRET_CANARY";
const encoder = new TextEncoder();

function input(
  overrides: Partial<CliAgentRegistrationInput> = {},
): CliAgentRegistrationInput {
  return {
    apiOrigin: ORIGIN,
    agentName: "Codex" as AgentName,
    username: "codex-agent" as Username,
    registrationRequestId: REQUEST_ID,
    apiKeyHash: COMMITMENT.apiKeyHash,
    apiKeyPrefix: COMMITMENT.apiKeyPrefix,
    ...overrides,
  };
}

function encode(value: unknown): Uint8Array {
  return encoder.encode(
    typeof value === "string" ? value : JSON.stringify(value),
  );
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

function successBody(
  overrides: Record<string, unknown> = {},
): Uint8Array {
  return encode({
    agent_id: AGENT_ID,
    disposition: "created",
    ...overrides,
  });
}

function createNetwork(
  implementation: (request: NetworkRequest) => Promise<NetworkResponse>,
): {
  readonly network: NetworkAdapter;
  readonly requests: NetworkRequest[];
} {
  const requests: NetworkRequest[] = [];
  return {
    requests,
    network: Object.freeze({
      async request(request: NetworkRequest): Promise<NetworkResponse> {
        requests.push(request);
        return implementation(request);
      },
    }),
  };
}

function serialized(result: CliAgentRegistrationResult): string {
  return JSON.stringify(result);
}

describe("CLI agent registration request", () => {
  it("sends one exact bounded hash-only POST and returns a frozen identity", async () => {
    const responseBytes = successBody();
    let requestBodyReference: Uint8Array | undefined;
    let requestBodySnapshot: Uint8Array | undefined;
    const fake = createNetwork(async (request) => {
      requestBodyReference = request.body;
      requestBodySnapshot = request.body?.slice();
      return response(200, responseBytes);
    });

    const result = await registerCliAgent(fake.network, input());

    expect(result).toEqual({
      status: "success",
      agentId: AGENT_ID,
      disposition: "created",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      url: "https://api.plurum.ai/api/v1/agents/register/cli",
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      timeoutMs: 12_000,
      maxResponseBytes: 16_384,
      redirect: "error",
    });
    expect(Object.isFrozen(fake.requests[0])).toBe(true);
    expect(Object.isFrozen(fake.requests[0]?.headers)).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(requestBodySnapshot))).toEqual({
      protocol_version: 1,
      name: "Codex",
      username: "codex-agent",
      registration_request_id: REQUEST_ID,
      api_key_hash: COMMITMENT.apiKeyHash,
      api_key_prefix: COMMITMENT.apiKeyPrefix,
    });
    expect(new TextDecoder().decode(requestBodySnapshot)).not.toContain(
      API_KEY,
    );
    expect(
      requestBodyReference?.every((byte) => byte === 0),
    ).toBe(true);
    expect(responseBytes.every((byte) => byte === 0)).toBe(true);
  });

  it.each(["created", "replayed"] as const)(
    "accepts the exact %s success disposition",
    async (disposition) => {
      const fake = createNetwork(async () =>
        response(200, successBody({ disposition })),
      );

      await expect(registerCliAgent(fake.network, input())).resolves.toEqual({
        status: "success",
        agentId: AGENT_ID,
        disposition,
      });
    },
  );

  it.each([
    "idempotency_conflict",
    "username_unavailable",
    "credential_conflict",
  ] as const)("maps the exact 409 %s response", async (reason) => {
    const fake = createNetwork(async () =>
      response(409, encode({ error: reason })),
    );

    const result = await registerCliAgent(fake.network, input());

    expect(result).toEqual({ status: "conflict", reason });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("maps 429 to the fixed retryable rate limit result", async () => {
    const reflectedBody = encode({
      error: `provider reflected ${API_KEY}`,
    });
    const fake = createNetwork(async () => response(429, reflectedBody));

    const result = await registerCliAgent(fake.network, input());

    expect(result).toEqual({
      status: "retryable",
      reason: "rate_limit",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(serialized(result)).not.toContain(API_KEY);
    expect(reflectedBody.every((byte) => byte === 0)).toBe(true);
  });

  it("supports an explicitly opted-in normalized loopback development origin", async () => {
    const loopback = normalizeApiOrigin(
      "http://127.0.0.1:43197",
      "explicit-loopback-development",
    );
    const fake = createNetwork(async () => response(200, successBody()));

    const result = await registerCliAgent(
      fake.network,
      input({ apiOrigin: loopback }),
      "explicit-loopback-development",
    );

    expect(result.status).toBe("success");
    expect(fake.requests[0]?.url).toBe(
      "http://127.0.0.1:43197/api/v1/agents/register/cli",
    );
  });

  it("wipes the request body after a secret-bearing transport failure", async () => {
    let requestBodyReference: Uint8Array | undefined;
    const fake = createNetwork(async (request) => {
      requestBodyReference = request.body;
      throw new Error(`transport reflected ${API_KEY}`);
    });

    const result = await registerCliAgent(fake.network, input());

    expect(result).toEqual({
      status: "retryable",
      reason: "registration_unavailable",
    });
    expect(serialized(result)).not.toContain(API_KEY);
    expect(
      requestBodyReference?.every((byte) => byte === 0),
    ).toBe(true);
  });
});

describe("CLI agent registration response validation", () => {
  it.each([201, 204, 301, 302, 400, 401, 403, 404, 408, 422, 500, 503])(
    "maps HTTP %i to fixed retryable unavailability without reflecting its body",
    async (status) => {
      const reflectedBody = encode({
        error: `${CANARY}:${API_KEY}`,
      });
      const fake = createNetwork(async () =>
        response(status, reflectedBody),
      );

      const result = await registerCliAgent(fake.network, input());

      expect(result).toEqual({
        status: "retryable",
        reason: "registration_unavailable",
      });
      expect(serialized(result)).not.toContain(CANARY);
      expect(serialized(result)).not.toContain(API_KEY);
      expect(reflectedBody.every((byte) => byte === 0)).toBe(true);
    },
  );

  it.each([
    ["missing content type", {}, successBody()],
    ["wrong content type", { "content-type": "text/plain" }, successBody()],
    [
      "duplicate content type",
      {
        "content-type": "application/json",
        "Content-Type": "application/json",
      },
      successBody(),
    ],
    [
      "extra success field",
      { "content-type": "application/json" },
      successBody({ api_key: API_KEY }),
    ],
    [
      "missing success field",
      { "content-type": "application/json" },
      encode({ agent_id: AGENT_ID }),
    ],
    [
      "invalid agent ID",
      { "content-type": "application/json" },
      successBody({ agent_id: CANARY }),
    ],
    [
      "invalid disposition",
      { "content-type": "application/json" },
      successBody({ disposition: CANARY }),
    ],
    [
      "duplicate JSON key",
      { "content-type": "application/json" },
      encode(
        `{"agent_id":"${AGENT_ID}","agent_id":"${CANARY}","disposition":"created"}`,
      ),
    ],
    [
      "invalid UTF-8",
      { "content-type": "application/json" },
      new Uint8Array([0xc3, 0x28]),
    ],
  ])("rejects a %s success response safely", async (_name, headers, body) => {
    const responseBody = body.slice();
    const fake = createNetwork(async () =>
      response(200, responseBody, headers),
    );

    const result = await registerCliAgent(fake.network, input());

    expect(result).toEqual({
      status: "retryable",
      reason: "registration_unavailable",
    });
    expect(serialized(result)).not.toContain(CANARY);
    expect(serialized(result)).not.toContain(API_KEY);
    expect(responseBody.every((byte) => byte === 0)).toBe(true);
  });

  it.each([
    {},
    { error: "unknown_conflict" },
    { error: "username_unavailable", detail: CANARY },
  ])("rejects malformed 409 body %# safely", async (body) => {
    const fake = createNetwork(async () =>
      response(409, encode(body)),
    );

    await expect(registerCliAgent(fake.network, input())).resolves.toEqual({
      status: "retryable",
      reason: "registration_unavailable",
    });
  });

  it("rejects and wipes an oversized response body", async () => {
    const oversized = new Uint8Array(16_385).fill(0xa5);
    const fake = createNetwork(async () => response(200, oversized));

    const result = await registerCliAgent(fake.network, input());

    expect(result).toEqual({
      status: "retryable",
      reason: "registration_unavailable",
    });
    expect(oversized.every((byte) => byte === 0)).toBe(true);
  });

  it("rejects a detached response body without throwing", async () => {
    const fake = createNetwork(async () =>
      response(200, detachedBytes(64)),
    );

    await expect(registerCliAgent(fake.network, input())).resolves.toEqual({
      status: "retryable",
      reason: "registration_unavailable",
    });
  });

  it("snapshots hostile response properties exactly once", async () => {
    const reads: Record<string, number> = Object.create(null);
    const once = <T>(name: string, value: T, later: T): T => {
      reads[name] = (reads[name] ?? 0) + 1;
      return reads[name] === 1 ? value : later;
    };
    const safeBody = successBody();
    const maliciousBody = encode({ api_key: API_KEY });
    const fake = createNetwork(async () => ({
      get status(): number {
        return once("status", 200, 409);
      },
      get headers(): Readonly<Record<string, string>> {
        return once(
          "headers",
          { "content-type": "application/json" },
          { "content-type": "text/plain" },
        );
      },
      get body(): Uint8Array {
        return once("body", safeBody, maliciousBody);
      },
    }));

    const result = await registerCliAgent(fake.network, input());

    expect(result).toEqual({
      status: "success",
      agentId: AGENT_ID,
      disposition: "created",
    });
    expect(reads).toEqual({ status: 1, headers: 1, body: 1 });
    expect(safeBody.every((byte) => byte === 0)).toBe(true);
    expect(maliciousBody.some((byte) => byte !== 0)).toBe(true);
  });
});

describe("CLI agent registration input validation", () => {
  it.each([
    ["unnormalized origin", { apiOrigin: "HTTPS://API.PLURUM.AI/" as ApiOrigin }],
    ["insecure origin", { apiOrigin: "http://api.plurum.ai" as ApiOrigin }],
    ["empty name", { agentName: "" as AgentName }],
    ["controlled name", { agentName: "bad\nname" as AgentName }],
    ["key-shaped name", { agentName: API_KEY as unknown as AgentName }],
    [
      "hidden key-shaped name",
      { agentName: [...API_KEY].join("\u200b") as AgentName },
    ],
    ["invalid username", { username: "UPPERCASE" as Username }],
    ["key-shaped username", { username: API_KEY as unknown as Username }],
    [
      "non-v4 request ID",
      {
        registrationRequestId:
          "ca908d9f-d901-1dac-b396-7f84377adfc8" as RegistrationRequestId,
      },
    ],
    [
      "uppercase key hash",
      {
        apiKeyHash:
          COMMITMENT.apiKeyHash.toUpperCase() as RegistrationApiKeyHash,
      },
    ],
    [
      "invalid key prefix",
      { apiKeyPrefix: "plrm_live_TOO_LONG..." as RegistrationApiKeyPrefix },
    ],
  ])("rejects %s locally with no network request", async (_name, overrides) => {
    let called = false;
    const fake = createNetwork(async () => {
      called = true;
      return response(200, successBody());
    });

    try {
      await registerCliAgent(
        fake.network,
        input(overrides as Partial<CliAgentRegistrationInput>),
      );
      throw new Error("invalid registration request unexpectedly succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentRegistrationRequestError);
      expect(error).toMatchObject({
        code: "invalid_agent_registration_request",
      });
      expect(String(error)).toBe(
        "AgentRegistrationRequestError: The Plurum agent registration request is invalid.",
      );
      expect(String(error)).not.toContain(API_KEY);
      expect(String(error)).not.toContain(CANARY);
    }
    expect(called).toBe(false);
  });

  it("rejects extra input fields so a raw key cannot accidentally enter the wire request", async () => {
    let called = false;
    const fake = createNetwork(async () => {
      called = true;
      return response(200, successBody());
    });
    const withRawKey = {
      ...input(),
      apiKey: API_KEY,
    } as CliAgentRegistrationInput;

    await expect(
      registerCliAgent(fake.network, withRawKey),
    ).rejects.toBeInstanceOf(AgentRegistrationRequestError);
    expect(called).toBe(false);
  });

  it("reads each untrusted input field exactly once after enumerating it", async () => {
    const reads: Record<string, number> = Object.create(null);
    const once = <T>(name: string, value: T, later: T): T => {
      reads[name] = (reads[name] ?? 0) + 1;
      return reads[name] === 1 ? value : later;
    };
    const hostile = {
      get apiOrigin() {
        return once(
          "apiOrigin",
          ORIGIN,
          "https://malicious.invalid" as ApiOrigin,
        );
      },
      get agentName() {
        return once(
          "agentName",
          "Codex" as AgentName,
          API_KEY as unknown as AgentName,
        );
      },
      get username() {
        return once(
          "username",
          "codex-agent" as Username,
          API_KEY as unknown as Username,
        );
      },
      get registrationRequestId() {
        return once(
          "registrationRequestId",
          REQUEST_ID,
          "00000000-0000-4000-8000-000000000000" as RegistrationRequestId,
        );
      },
      get apiKeyHash() {
        return once(
          "apiKeyHash",
          COMMITMENT.apiKeyHash,
          "0".repeat(64) as RegistrationApiKeyHash,
        );
      },
      get apiKeyPrefix() {
        return once(
          "apiKeyPrefix",
          COMMITMENT.apiKeyPrefix,
          "plrm_live_ZZZZZZ..." as RegistrationApiKeyPrefix,
        );
      },
    } as CliAgentRegistrationInput;
    const fake = createNetwork(async () => response(200, successBody()));

    const result = await registerCliAgent(fake.network, hostile);

    expect(result.status).toBe("success");
    expect(reads).toEqual({
      apiOrigin: 1,
      agentName: 1,
      username: 1,
      registrationRequestId: 1,
      apiKeyHash: 1,
      apiKeyPrefix: 1,
    });
  });
});

function detachedBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
  return bytes;
}
