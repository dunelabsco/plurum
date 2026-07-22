import { describe, expect, it } from "vitest";

import {
  probeApiReachability,
  type ApiReachabilityResult,
} from "../src/api/reachability.js";
import {
  normalizeApiOrigin,
  type ApiOrigin,
} from "../src/credentials/origin.js";
import type {
  NetworkResponse,
  ReadOnlyNetworkAdapter,
  ReadOnlyNetworkRequest,
} from "../src/system/contracts.js";

const ORIGIN = normalizeApiOrigin("https://api.plurum.ai");
const SECRET = "plrm_live_API_REACHABILITY_SECRET_DO_NOT_PRINT";

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
  return Object.freeze({ status, headers, body });
}

function fakeNetwork(
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

function serialized(result: ApiReachabilityResult): string {
  return JSON.stringify(result);
}

describe("API reachability", () => {
  it("makes one exact bounded unauthenticated health request", async () => {
    const fake = fakeNetwork(async () =>
      response(200, encode({ status: "healthy" })),
    );

    await expect(
      probeApiReachability(fake.network, ORIGIN),
    ).resolves.toEqual({ reachability: "reachable", health: "healthy" });
    expect(fake.requests).toEqual([
      {
        url: "https://api.plurum.ai/health",
        method: "GET",
        headers: { Accept: "application/json" },
        timeoutMs: 12_000,
        maxResponseBytes: 4_096,
        redirect: "error",
      },
    ]);
    expect("body" in (fake.requests[0] ?? {})).toBe(false);
    expect(
      Object.keys(fake.requests[0]?.headers ?? {}).some(
        (name) => name.toLowerCase() === "authorization",
      ),
    ).toBe(false);
  });

  it("accepts only the live endpoint's bounded canonical version extension", async () => {
    for (const body of [
      { status: "healthy", version: "0.2.0" },
      { status: "healthy", version: "12.34.567" },
    ]) {
      const fake = fakeNetwork(async () => response(200, encode(body)));
      await expect(
        probeApiReachability(fake.network, ORIGIN),
      ).resolves.toEqual({ reachability: "reachable", health: "healthy" });
    }
  });

  it.each([100, 204, 401, 500, 599])(
    "reports a structurally valid HTTP %s response as reachable but unhealthy",
    async (status) => {
      const fake = fakeNetwork(async () =>
        response(status, encode({ reflected: SECRET })),
      );

      const result = await probeApiReachability(fake.network, ORIGIN);

      expect(result).toEqual({
        reachability: "reachable",
        health: "unhealthy",
      });
      expect(serialized(result)).not.toContain(SECRET);
    },
  );

  it.each([
    ["wrong status", { status: "degraded" }],
    ["unknown field", { status: "healthy", detail: SECRET }],
    ["invalid version", { status: "healthy", version: `0.2.0-${SECRET}` }],
    ["missing status", { version: "0.2.0" }],
    ["array body", [{ status: "healthy" }]],
  ] as const)("treats a 200 %s payload as reachable but unhealthy", async (_label, body) => {
    const fake = fakeNetwork(async () => response(200, encode(body)));

    const result = await probeApiReachability(fake.network, ORIGIN);

    expect(result).toEqual({ reachability: "reachable", health: "unhealthy" });
    expect(serialized(result)).not.toContain(SECRET);
  });

  it.each([
    "text/plain",
    "application/problem+json",
    "application/json; charset=iso-8859-1",
  ])("requires an exact JSON content type for health: %s", async (contentType) => {
    const fake = fakeNetwork(async () =>
      response(
        200,
        encode({ status: "healthy" }),
        Object.freeze({ "content-type": contentType }),
      ),
    );

    await expect(
      probeApiReachability(fake.network, ORIGIN),
    ).resolves.toEqual({ reachability: "reachable", health: "unhealthy" });
  });

  it("rejects duplicate top-level health fields without reflecting the body", async () => {
    const fake = fakeNetwork(async () =>
      response(
        200,
        encode(`{"status":"healthy","status":"${SECRET}"}`),
      ),
    );

    const result = await probeApiReachability(fake.network, ORIGIN);

    expect(result).toEqual({ reachability: "reachable", health: "unhealthy" });
    expect(serialized(result)).not.toContain(SECRET);
  });

  it("maps transport failures to a fixed unavailable result", async () => {
    const fake = fakeNetwork(async () => {
      throw new Error(SECRET);
    });

    const result = await probeApiReachability(fake.network, ORIGIN);

    expect(result).toEqual({ reachability: "unavailable", health: "unknown" });
    expect(serialized(result)).not.toContain(SECRET);
  });

  it.each([
    null,
    { status: 99, headers: {}, body: new Uint8Array() },
    { status: 600, headers: {}, body: new Uint8Array() },
    { status: 200, headers: [], body: new Uint8Array() },
    { status: 200, headers: {}, body: SECRET },
    { status: 200, headers: {}, body: new Uint8Array(4_097) },
    { status: 200, headers: {}, body: new Uint8Array(), extra: true },
  ] as const)("fails closed for a malformed network capability response", async (value) => {
    const fake = fakeNetwork(async () => value as NetworkResponse);

    await expect(
      probeApiReachability(fake.network, ORIGIN),
    ).resolves.toEqual({ reachability: "unavailable", health: "unknown" });
  });

  it("rejects a response accessor without invoking it", async () => {
    let statusReads = 0;
    const malicious = Object.defineProperty(
      {
        headers: Object.freeze({ "content-type": "application/json" }),
        body: encode({ status: "healthy" }),
      },
      "status",
      {
        enumerable: true,
        get() {
          statusReads += 1;
          throw new Error(SECRET);
        },
      },
    );
    const fake = fakeNetwork(
      async () => malicious as unknown as NetworkResponse,
    );

    await expect(
      probeApiReachability(fake.network, ORIGIN),
    ).resolves.toEqual({ reachability: "unavailable", health: "unknown" });
    expect(statusReads).toBe(0);
  });

  it("rejects noncanonical or unauthorized origins before networking", async () => {
    const fake = fakeNetwork(async () =>
      response(200, encode({ status: "healthy" })),
    );
    const invalidOrigins = [
      "https://api.plurum.ai/",
      "http://127.0.0.1:43197",
      `https://${SECRET}.invalid`,
    ] as ApiOrigin[];

    for (const origin of invalidOrigins) {
      await expect(
        probeApiReachability(fake.network, origin),
      ).resolves.toEqual({ reachability: "unavailable", health: "unknown" });
    }
    expect(fake.requests).toEqual([]);
  });

  it("allows a canonical numeric loopback only under the explicit development policy", async () => {
    const origin = normalizeApiOrigin(
      "http://127.0.0.1:43197",
      "explicit-loopback-development",
    );
    const fake = fakeNetwork(async () =>
      response(200, encode({ status: "healthy" })),
    );

    await expect(
      probeApiReachability(
        fake.network,
        origin,
        "explicit-loopback-development",
      ),
    ).resolves.toEqual({ reachability: "reachable", health: "healthy" });
    expect(fake.requests[0]?.url).toBe("http://127.0.0.1:43197/health");
  });
});
