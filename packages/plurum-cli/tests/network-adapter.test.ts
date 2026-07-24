import { describe, expect, it } from "vitest";

import {
  createNodeNetwork,
  type FetchBodyLike,
  type FetchCompatible,
  type FetchHeadersLike,
  type FetchRequestInitLike,
  type FetchResponseLike,
  NetworkTransportError,
  type NetworkTransportErrorCode,
} from "../src/adapters/node/network.js";
import type { NetworkRequest } from "../src/system/contracts.js";

const CANARY = "NETWORK_TRANSPORT_SECRET_CANARY";
const encoder = new TextEncoder();

const ERROR_MESSAGES: Readonly<Record<NetworkTransportErrorCode, string>> =
  Object.freeze({
    invalid_network_request: "The network request is invalid.",
    network_request_failed: "The network request failed.",
    network_request_timeout: "The network request timed out.",
    invalid_network_response: "The network response is invalid.",
    network_response_too_large:
      "The network response exceeded the configured limit.",
  });

function request(
  overrides: Partial<NetworkRequest> = {},
): NetworkRequest {
  return {
    url: "https://api.plurum.ai/api/v1/agents/me",
    method: "GET",
    headers: Object.freeze({
      accept: "application/json",
    }),
    timeoutMs: 1_000,
    maxResponseBytes: 16_384,
    redirect: "error",
    ...overrides,
  };
}

function headers(
  entries: readonly (readonly [string, string])[] = [],
): FetchHeadersLike {
  return Object.freeze({
    forEach(callback: (value: string, name: string) => void): void {
      for (const [name, value] of entries) {
        callback(value, name);
      }
    },
  });
}

function body(
  chunks: readonly Uint8Array[],
  hooks: {
    cancel?(): void;
    release?(): void;
  } = {},
): FetchBodyLike {
  return Object.freeze({
    getReader() {
      let index = 0;
      return {
        async read() {
          const chunk = chunks[index];
          index += 1;
          return chunk === undefined
            ? Object.freeze({ done: true as const })
            : Object.freeze({ done: false as const, value: chunk });
        },
        async cancel() {
          hooks.cancel?.();
        },
        releaseLock() {
          hooks.release?.();
        },
      };
    },
  });
}

function response(
  overrides: Partial<FetchResponseLike> = {},
): FetchResponseLike {
  return {
    status: 200,
    headers: headers(),
    body: null,
    ...overrides,
  };
}

async function expectFailure(
  operation: Promise<unknown>,
  code: NetworkTransportErrorCode,
): Promise<NetworkTransportError> {
  try {
    await operation;
    throw new Error("transport operation unexpectedly succeeded");
  } catch (error) {
    expect(error).toBeInstanceOf(NetworkTransportError);
    expect(error).toMatchObject({ code });
    expect(String(error)).toBe(
      `NetworkTransportError: ${ERROR_MESSAGES[code]}`,
    );
    expect(String(error)).not.toContain(CANARY);
    return error as NetworkTransportError;
  }
}

describe("Node network adapter request snapshots", () => {
  it("normalizes the URL and passes a frozen redirect-safe GET snapshot", async () => {
    let observedUrl: string | undefined;
    let observedInit: FetchRequestInitLike | undefined;
    const responseHeaders: [string, string][] = [
      ["Content-Type", "application/json"],
      ["X-Plurum", "collective"],
    ];
    const firstChunk = new Uint8Array([1, 2]);
    const secondChunk = new Uint8Array([3, 4]);
    const compatibleFetch: FetchCompatible = async (url, init) => {
      observedUrl = url;
      observedInit = init;
      return response({
        headers: headers(responseHeaders),
        body: body([firstChunk, secondChunk]),
      });
    };

    const networkResponse = await createNodeNetwork(compatibleFetch).request(
      request({
        url: "HTTPS://API.PLURUM.AI:443/api/v1/agents/me?view=full",
      }),
    );

    expect(observedUrl).toBe(
      "https://api.plurum.ai/api/v1/agents/me?view=full",
    );
    expect(observedInit).toMatchObject({
      method: "GET",
      redirect: "error",
    });
    expect(observedInit?.body).toBeUndefined();
    expect(observedInit?.signal).toBeInstanceOf(AbortSignal);
    expect(observedInit?.signal.aborted).toBe(false);
    expect(Object.isFrozen(observedInit)).toBe(true);
    expect(Object.isFrozen(observedInit?.headers)).toBe(true);

    expect(networkResponse.status).toBe(200);
    expect(networkResponse.headers["content-type"]).toBe("application/json");
    expect(networkResponse.headers["x-plurum"]).toBe("collective");
    expect(Array.from(networkResponse.body)).toEqual([1, 2, 3, 4]);
    expect(Object.isFrozen(networkResponse)).toBe(true);
    expect(Object.isFrozen(networkResponse.headers)).toBe(true);

    firstChunk.fill(9);
    secondChunk.fill(9);
    responseHeaders[0] = ["Content-Type", "text/plain"];
    expect(Array.from(networkResponse.body)).toEqual([1, 2, 3, 4]);
    expect(networkResponse.headers["content-type"]).toBe("application/json");
  });

  it("copies the POST body before dispatch and wipes its owned copy afterward", async () => {
    const callerBody = encoder.encode(CANARY);
    const callerHeaders: Record<string, string> = {
      Authorization: `Bearer ${CANARY}`,
      "Content-Type": "application/json",
    };
    let observedInit: FetchRequestInitLike | undefined;
    let bodyAtDispatch: Uint8Array | undefined;
    let headersAtDispatch: Readonly<Record<string, string>> | undefined;
    let releaseFetch: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const compatibleFetch: FetchCompatible = async (_url, init) => {
      observedInit = init;
      bodyAtDispatch = init.body?.slice();
      headersAtDispatch = Object.freeze({ ...init.headers });
      await gate;
      return response();
    };

    const operation = createNodeNetwork(compatibleFetch).request(
      request({
        method: "POST",
        headers: callerHeaders,
        body: callerBody,
      }),
    );
    callerBody.fill(0xa5);
    callerHeaders.Authorization = "Bearer replaced";
    releaseFetch?.();
    await operation;

    expect(new TextDecoder().decode(bodyAtDispatch)).toBe(CANARY);
    expect(headersAtDispatch?.authorization).toBe(`Bearer ${CANARY}`);
    expect(headersAtDispatch?.["content-type"]).toBe("application/json");
    expect(observedInit?.headers.authorization).toBe("");
    expect(observedInit?.headers["content-type"]).toBe("");
    expect(observedInit?.body).not.toBe(callerBody);
    expect(observedInit?.body?.every((byte) => byte === 0)).toBe(true);
    expect(Object.isFrozen(observedInit)).toBe(true);
    expect(Object.isFrozen(observedInit?.headers)).toBe(true);
    expect(() => {
      (observedInit?.headers as Record<string, string>).authorization =
        "Bearer mutated";
    }).toThrow();
  });

  it("reads every untrusted request field exactly once before validation", async () => {
    const reads: Record<string, number> = Object.create(null);
    const once = <T>(name: string, value: T, later: T): T => {
      reads[name] = (reads[name] ?? 0) + 1;
      return reads[name] === 1 ? value : later;
    };
    let bodyAtDispatch: Uint8Array | undefined;
    const hostile = {
      get url() {
        return once(
          "url",
          "https://api.plurum.ai/path",
          `https://${CANARY}.invalid/`,
        );
      },
      get method() {
        return once("method", "POST", "GET");
      },
      get headers() {
        return once(
          "headers",
          { accept: "application/json" },
          { authorization: `Bearer ${CANARY}` },
        );
      },
      get body() {
        return once(
          "body",
          new Uint8Array([1, 2, 3]),
          new Uint8Array(5 * 1024 * 1024 + 1),
        );
      },
      get timeoutMs() {
        return once("timeoutMs", 1_000, 0);
      },
      get maxResponseBytes() {
        return once("maxResponseBytes", 1_000, Number.POSITIVE_INFINITY);
      },
      get redirect() {
        return once("redirect", "error", "follow");
      },
    } as unknown as NetworkRequest;
    const compatibleFetch: FetchCompatible = async (_url, init) => {
      bodyAtDispatch = init.body?.slice();
      return response();
    };

    await createNodeNetwork(compatibleFetch).request(hostile);

    expect(reads).toEqual({
      url: 1,
      method: 1,
      headers: 1,
      body: 1,
      timeoutMs: 1,
      maxResponseBytes: 1,
      redirect: 1,
    });
    expect(Array.from(bodyAtDispatch ?? [])).toEqual([1, 2, 3]);
  });

  it("uses intrinsic request-body length before dispatch", async () => {
    const body = new Uint8Array(5 * 1024 * 1024 + 1);
    Object.defineProperties(body, {
      byteLength: { get: () => 1 },
      length: { get: () => 1 },
    });
    let dispatched = false;

    await expectFailure(
      createNodeNetwork(async () => {
        dispatched = true;
        return response();
      }).request(request({ method: "POST", body })),
      "invalid_network_request",
    );

    expect(dispatched).toBe(false);
  });

  it("accepts HTTPS and only canonical numeric-loopback HTTP URLs", async () => {
    const observed: string[] = [];
    const compatibleFetch: FetchCompatible = async (url) => {
      observed.push(url);
      return response();
    };
    const network = createNodeNetwork(compatibleFetch);

    await network.request(request({ url: "https://example.test/path" }));
    await network.request(request({ url: "http://127.0.0.1:43197/path" }));
    await network.request(request({ url: "http://[::1]:43197/path" }));

    expect(observed).toEqual([
      "https://example.test/path",
      "http://127.0.0.1:43197/path",
      "http://[::1]:43197/path",
    ]);
  });

  it.each([
    "http://api.plurum.ai/path",
    "http://localhost:43197/path",
    "http://127.1:43197/path",
    "http://2130706433:43197/path",
    "https://2130706433/path",
    "https://0177.0.0.1/path",
    "https://user:password@example.test/path",
    "https://example.test/path#fragment",
    "https://example.test/path#",
    "https://example.test\\path",
    "https://example.test./path",
    " ftp://example.test/path",
    "ftp://example.test/path",
    `https://example.test/${String.fromCharCode(10)}${CANARY}`,
  ])("rejects an unsafe URL without dispatching it", async (url) => {
    let called = false;
    const compatibleFetch: FetchCompatible = async () => {
      called = true;
      return response();
    };

    await expectFailure(
      createNodeNetwork(compatibleFetch).request(request({ url })),
      "invalid_network_request",
    );
    expect(called).toBe(false);
  });

  it("rejects malformed runtime request shapes and bounds before dispatch", async () => {
    let called = false;
    const compatibleFetch: FetchCompatible = async () => {
      called = true;
      return response();
    };
    const network = createNodeNetwork(compatibleFetch);
    const excessiveHeaders = Object.fromEntries(
      Array.from({ length: 65 }, (_value, index) => [`x-${index}`, "a"]),
    );
    const duplicateHeaders = {
      "X-Plurum": "one",
      "x-plurum": "two",
    };
    const excessiveHeaderBytes = {
      "x-one": "a".repeat(6_000),
      "x-two": "b".repeat(6_000),
      "x-three": "c".repeat(6_000),
    };
    const symbolRequest = request() as NetworkRequest & {
      [key: symbol]: string;
    };
    symbolRequest[Symbol("secret")] = CANARY;

    const malformed: NetworkRequest[] = [
      { ...request(), method: "PUT" } as unknown as NetworkRequest,
      { ...request(), redirect: "follow" } as unknown as NetworkRequest,
      request({ body: encoder.encode(CANARY) }),
      request({ timeoutMs: 0 }),
      request({ timeoutMs: Number.NaN }),
      request({ timeoutMs: 120_001 }),
      request({ maxResponseBytes: 0 }),
      request({ maxResponseBytes: Number.POSITIVE_INFINITY }),
      request({ maxResponseBytes: 5 * 1024 * 1024 + 1 }),
      request({
        method: "POST",
        body: new Uint8Array(5 * 1024 * 1024 + 1),
      }),
      request({ headers: { "bad header": CANARY } }),
      request({ headers: { "x-control": `ok${String.fromCharCode(10)}${CANARY}` } }),
      request({ headers: { Host: "api.plurum.ai" } }),
      request({ headers: { "Content-Length": "1" } }),
      request({ headers: { "Transfer-Encoding": "chunked" } }),
      request({ headers: { Connection: "keep-alive" } }),
      request({ headers: { Upgrade: "websocket" } }),
      request({ headers: { "Proxy-Authorization": CANARY } }),
      request({ headers: { "Proxy-Connection": "keep-alive" } }),
      request({ headers: duplicateHeaders }),
      request({ headers: excessiveHeaders }),
      request({ headers: excessiveHeaderBytes }),
      { ...request(), unexpected: CANARY } as unknown as NetworkRequest,
      symbolRequest,
    ];

    for (const malformedRequest of malformed) {
      await expectFailure(
        network.request(malformedRequest),
        "invalid_network_request",
      );
    }
    expect(called).toBe(false);
  });

  it("replaces hostile request getters with the fixed request error", async () => {
    const hostile = {
      get url(): string {
        throw new Error(CANARY);
      },
      method: "GET",
      headers: {},
      timeoutMs: 1_000,
      maxResponseBytes: 1_000,
      redirect: "error",
    } as NetworkRequest;

    await expectFailure(
      createNodeNetwork(async () => response()).request(hostile),
      "invalid_network_request",
    );
  });
});

describe("Node network adapter timeout and streaming limits", () => {
  it("uses one aborting timeout for a fetch that has not produced headers", async () => {
    let observedSignal: AbortSignal | undefined;
    let retainedBody: Uint8Array | undefined;
    let aborted = false;
    const compatibleFetch: FetchCompatible = async (_url, init) => {
      observedSignal = init.signal;
      retainedBody = init.body;
      return new Promise<FetchResponseLike>((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error(`${CANARY}:abort`));
          },
          { once: true },
        );
      });
    };

    await expectFailure(
      createNodeNetwork(compatibleFetch).request(
        request({
          method: "POST",
          body: encoder.encode(CANARY),
          timeoutMs: 20,
        }),
      ),
      "network_request_timeout",
    );
    expect(aborted).toBe(true);
    expect(observedSignal?.aborted).toBe(true);
    expect(retainedBody?.every((byte) => byte === 0)).toBe(true);
  });

  it("keeps the same timeout active while the response body is streaming", async () => {
    let observedSignal: AbortSignal | undefined;
    let cancelled = 0;
    let released = 0;
    const stalledBody: FetchBodyLike = {
      getReader() {
        return {
          read() {
            return new Promise(() => {});
          },
          async cancel() {
            cancelled += 1;
          },
          releaseLock() {
            released += 1;
          },
        };
      },
    };
    const compatibleFetch: FetchCompatible = async (_url, init) => {
      observedSignal = init.signal;
      return response({ body: stalledBody });
    };

    await expectFailure(
      createNodeNetwork(compatibleFetch).request(
        request({ timeoutMs: 20 }),
      ),
      "network_request_timeout",
    );
    expect(cancelled).toBeGreaterThanOrEqual(1);
    expect(released).toBe(1);
    expect(observedSignal?.aborted).toBe(true);
  });

  it("aborts and cancels an incrementally oversized response", async () => {
    let observedSignal: AbortSignal | undefined;
    let cancelled = 0;
    let released = 0;
    const compatibleFetch: FetchCompatible = async (_url, init) => {
      observedSignal = init.signal;
      return response({
        body: body(
          [new Uint8Array([1, 2, 3]), encoder.encode(CANARY)],
          {
            cancel() {
              cancelled += 1;
            },
            release() {
              released += 1;
            },
          },
        ),
      });
    };

    await expectFailure(
      createNodeNetwork(compatibleFetch).request(
        request({ maxResponseBytes: 4 }),
      ),
      "network_response_too_large",
    );
    expect(cancelled).toBeGreaterThanOrEqual(1);
    expect(released).toBe(1);
    expect(observedSignal?.aborted).toBe(true);
  });

  it("accepts a response exactly at the caller's byte limit", async () => {
    const networkResponse = await createNodeNetwork(async () =>
      response({
        body: body([
          new Uint8Array([1, 2]),
          new Uint8Array([3, 4]),
        ]),
      }),
    ).request(request({ maxResponseBytes: 4 }));

    expect(Array.from(networkResponse.body)).toEqual([1, 2, 3, 4]);
  });
});

describe("Node network adapter hostile response handling", () => {
  it("replaces fetch failures without reflecting their diagnostics", async () => {
    let retainedBody: Uint8Array | undefined;
    const compatibleFetch: FetchCompatible = async (_url, init) => {
      retainedBody = init.body;
      throw new Error(`${CANARY}:fetch`);
    };

    await expectFailure(
      createNodeNetwork(compatibleFetch).request(
        request({
          method: "POST",
          body: encoder.encode(CANARY),
        }),
      ),
      "network_request_failed",
    );
    expect(retainedBody?.every((byte) => byte === 0)).toBe(true);
  });

  it("snapshots response status exactly once", async () => {
    let reads = 0;
    const changingStatus = {
      get status(): number {
        reads += 1;
        return reads === 1 ? 200 : 599;
      },
      headers: headers(),
      body: null,
    } as FetchResponseLike;

    const networkResponse = await createNodeNetwork(async () =>
      changingStatus,
    ).request(request());

    expect(networkResponse.status).toBe(200);
    expect(reads).toBe(1);
  });

  it("reads each hostile stream record field once before enforcing the cap", async () => {
    let doneReads = 0;
    let valueReads = 0;
    let readCalls = 0;
    const hostileBody: FetchBodyLike = {
      getReader() {
        return {
          async read() {
            readCalls += 1;
            if (readCalls > 1) {
              return { done: true };
            }
            return {
              get done() {
                doneReads += 1;
                return false;
              },
              get value() {
                valueReads += 1;
                return valueReads === 1
                  ? new Uint8Array([1, 2, 3])
                  : encoder.encode(CANARY.repeat(1_000));
              },
            };
          },
          async cancel() {},
        };
      },
    };

    const networkResponse = await createNodeNetwork(async () =>
      response({ body: hostileBody }),
    ).request(request({ maxResponseBytes: 4 }));

    expect(Array.from(networkResponse.body)).toEqual([1, 2, 3]);
    expect(doneReads).toBe(1);
    expect(valueReads).toBe(1);
  });

  it("uses intrinsic stream-chunk length before enforcing the response cap", async () => {
    const chunk = new Uint8Array([1, 2, 3, 4, 5]);
    Object.defineProperties(chunk, {
      byteLength: { get: () => 1 },
      length: { get: () => 1 },
    });

    await expectFailure(
      createNodeNetwork(async () =>
        response({ body: body([chunk]) }),
      ).request(request({ maxResponseBytes: 4 })),
      "network_response_too_large",
    );
  });

  it("replaces response getter and header-iterator failures", async () => {
    const getterFailure = {
      get status(): number {
        throw new Error(`${CANARY}:status`);
      },
      headers: headers(),
      body: null,
    } as FetchResponseLike;
    const headerFailure = response({
      headers: {
        forEach() {
          throw new Error(`${CANARY}:headers`);
        },
      },
    });

    for (const hostileResponse of [getterFailure, headerFailure]) {
      await expectFailure(
        createNodeNetwork(async () => hostileResponse).request(request()),
        "invalid_network_response",
      );
    }
  });

  it("fails closed if an injected fetch returns a redirect response", async () => {
    let observedInit: FetchRequestInitLike | undefined;
    const compatibleFetch: FetchCompatible = async (_url, init) => {
      observedInit = init;
      return response({
        status: 302,
        headers: headers([["location", `https://${CANARY}.invalid/`]]),
      });
    };

    await expectFailure(
      createNodeNetwork(compatibleFetch).request(request()),
      "invalid_network_response",
    );
    expect(observedInit?.redirect).toBe("error");
    expect(observedInit?.signal.aborted).toBe(true);
  });

  it("replaces body stream failures without reflecting their diagnostics", async () => {
    const failingBody: FetchBodyLike = {
      getReader() {
        return {
          async read() {
            throw new Error(`${CANARY}:stream`);
          },
          async cancel() {
            throw new Error(`${CANARY}:cancel`);
          },
          releaseLock() {
            throw new Error(`${CANARY}:release`);
          },
        };
      },
    };

    await expectFailure(
      createNodeNetwork(async () => response({ body: failingBody })).request(
        request(),
      ),
      "network_request_failed",
    );
  });

  it("rejects malformed response status, headers, and stream records", async () => {
    const tooManyHeaders = headers(
      Array.from({ length: 129 }, (_value, index) => [`x-${index}`, "a"]),
    );
    const tooManyHeaderBytes = headers(
      Array.from({ length: 5 }, (_value, index) => [
        `x-${index}`,
        "a".repeat(14_000),
      ]),
    );
    const malformedResponses: FetchResponseLike[] = [
      response({ status: 99 }),
      response({ status: 100 }),
      response({ status: 600 }),
      response({ status: Number.NaN }),
      response({ headers: headers([["bad header", CANARY]]) }),
      response({
        headers: headers([
          ["X-Plurum", "one"],
          ["x-plurum", "two"],
        ]),
      }),
      response({
        headers: headers([
          ["x-control", `ok${String.fromCharCode(10)}${CANARY}`],
        ]),
      }),
      response({ headers: tooManyHeaders }),
      response({ headers: tooManyHeaderBytes }),
      response({ body: {} as FetchBodyLike }),
      response({
        body: {
          getReader() {
            return {
              async read() {
                return { done: false } as {
                  done: boolean;
                  value: Uint8Array;
                };
              },
              async cancel() {},
            };
          },
        },
      }),
      response({
        body: {
          getReader() {
            return {
              async read() {
                return {
                  done: true,
                  value: encoder.encode(CANARY),
                };
              },
              async cancel() {},
            };
          },
        },
      }),
    ];

    for (const malformedResponse of malformedResponses) {
      await expectFailure(
        createNodeNetwork(async () => malformedResponse).request(request()),
        "invalid_network_response",
      );
    }
  });

  it("ignores callbacks made after the response-header snapshot closes", async () => {
    let lateCallback:
      | ((value: string, name: string) => void)
      | undefined;
    const delayedHeaders: FetchHeadersLike = {
      forEach(callback) {
        callback("one", "X-Plurum");
        lateCallback = callback;
      },
    };

    const networkResponse = await createNodeNetwork(async () =>
      response({ headers: delayedHeaders }),
    ).request(request());
    lateCallback?.(CANARY, "X-Late");

    expect(networkResponse.headers["x-plurum"]).toBe("one");
    expect(networkResponse.headers["x-late"]).toBeUndefined();
    expect(Object.isFrozen(networkResponse.headers)).toBe(true);
  });

  it("rejects a non-function injected fetch with one fixed error", () => {
    expect(() =>
      createNodeNetwork(null as unknown as FetchCompatible),
    ).toThrowError(
      expect.objectContaining({
        code: "network_request_failed",
      }),
    );
  });
});
