import { describe, expect, it } from "vitest";

import {
  checkAgentUsernameAvailability,
  type AgentUsernameAvailabilityResult,
} from "../src/api/agent-username.js";
import { normalizeApiOrigin } from "../src/credentials/origin.js";
import type { Username } from "../src/credentials/schema.js";
import type {
  NetworkResponse,
  ReadOnlyNetworkAdapter,
  ReadOnlyNetworkRequest,
} from "../src/system/contracts.js";

const ORIGIN = normalizeApiOrigin("https://api.plurum.ai");
const USERNAME = "codex-agent" as Username;
const CANARY = "plrm_live_USERNAME_CHECK_SECRET_CANARY";

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(
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

function createNetwork(
  implementation: (
    request: ReadOnlyNetworkRequest,
  ) => Promise<NetworkResponse>,
): Readonly<{
  network: ReadOnlyNetworkAdapter;
  requests: ReadOnlyNetworkRequest[];
}> {
  const requests: ReadOnlyNetworkRequest[] = [];
  return Object.freeze({
    requests,
    network: Object.freeze({
      async request(request: ReadOnlyNetworkRequest) {
        requests.push(request);
        return implementation(request);
      },
    }),
  });
}

function serialized(result: AgentUsernameAvailabilityResult): string {
  return JSON.stringify(result);
}

describe("agent username availability", () => {
  it("makes one exact bounded public GET", async () => {
    const bytes = encode({ available: true, suggestions: [] });
    const fake = createNetwork(async () => response(200, bytes));

    const result = await checkAgentUsernameAvailability(
      fake.network,
      ORIGIN,
      USERNAME,
    );

    expect(result).toEqual({ status: "available" });
    expect(Object.isFrozen(result)).toBe(true);
    expect(fake.requests).toEqual([
      {
        url: "https://api.plurum.ai/api/v1/agents/check-username?username=codex-agent",
        method: "GET",
        headers: { Accept: "application/json" },
        timeoutMs: 12_000,
        maxResponseBytes: 8_192,
        redirect: "error",
      },
    ]);
    expect(Object.isFrozen(fake.requests[0])).toBe(true);
    expect(Object.isFrozen(fake.requests[0]?.headers)).toBe(true);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  it("returns only bounded, unique, validated suggestions", async () => {
    const fake = createNetwork(async () =>
      response(
        200,
        encode({
          available: false,
          suggestions: ["codex-agent-1", "codex-agent-2"],
        }),
      ),
    );

    const result = await checkAgentUsernameAvailability(
      fake.network,
      ORIGIN,
      USERNAME,
    );

    expect(result).toEqual({
      status: "unavailable",
      suggestions: ["codex-agent-1", "codex-agent-2"],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(
      result.status === "unavailable" &&
        Object.isFrozen(result.suggestions),
    ).toBe(true);
  });

  it.each([
    { available: true, suggestions: ["codex-agent-1"] },
    { available: false, suggestions: ["no"] },
    { available: false, suggestions: ["codex-agent-1", "codex-agent-1"] },
    {
      available: false,
      suggestions: ["one", "two", "three", "four", "five", "six"],
    },
    { available: false, suggestions: [CANARY] },
    { available: "yes", suggestions: [] },
    { available: true, suggestions: [], extra: true },
  ])("rejects malformed response shape %#", async (body) => {
    const fake = createNetwork(async () => response(200, encode(body)));

    const result = await checkAgentUsernameAvailability(
      fake.network,
      ORIGIN,
      USERNAME,
    );

    expect(result).toEqual({
      status: "indeterminate",
      reason: "username_check_unavailable",
    });
    expect(serialized(result)).not.toContain(CANARY);
  });

  it.each([201, 400, 404, 408, 429, 500, 503])(
    "treats HTTP %i as advisory-check unavailability",
    async (status) => {
      const fake = createNetwork(async () => ({
        status,
        get headers(): Readonly<Record<string, string>> {
          throw new Error(CANARY);
        },
        get body(): Uint8Array {
          throw new Error(CANARY);
        },
      }));

      const result = await checkAgentUsernameAvailability(
        fake.network,
        ORIGIN,
        USERNAME,
      );

      expect(result).toEqual({
        status: "indeterminate",
        reason: "username_check_unavailable",
      });
      expect(serialized(result)).not.toContain(CANARY);
    },
  );

  it("fails closed on invalid input before network", async () => {
    const fake = createNetwork(async () => {
      throw new Error("must not run");
    });

    await expect(
      checkAgentUsernameAvailability(
        fake.network,
        ORIGIN,
        "no" as Username,
      ),
    ).resolves.toEqual({
      status: "indeterminate",
      reason: "username_check_unavailable",
    });
    expect(fake.requests).toEqual([]);
  });

  it("contains thrown secret-bearing failures", async () => {
    const fake = createNetwork(async () => {
      throw new Error(CANARY);
    });

    const result = await checkAgentUsernameAvailability(
      fake.network,
      ORIGIN,
      USERNAME,
    );

    expect(result).toEqual({
      status: "indeterminate",
      reason: "username_check_unavailable",
    });
    expect(serialized(result)).not.toContain(CANARY);
  });
});
