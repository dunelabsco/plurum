import { describe, expect, it } from "vitest";

import {
  CODEX_DOTENV_PROJECTION_STATUSES,
  type CodexDotenvProjectionStatus,
} from "../src/credentials/codex-dotenv-contracts.js";
import {
  observeCodexDotenvStatus,
  type CodexDotenvStatusObservationAdapter,
  type CodexDotenvStatusObservationRequest,
} from "../src/credentials/codex-dotenv-status.js";
import { parseApiKey } from "../src/credentials/schema.js";

const API_KEY = parseApiKey(
  "plrm_live_STATUS_PROJECTION_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
);
const PROJECT = "/synthetic/private/project";
const OTHER_PROJECT = "C:\\Users\\private\\project";
const REVISION_CANARY = "private-projection-revision";
const ERROR_CANARY = "private-observation-error";

function request(
  overrides: Partial<CodexDotenvStatusObservationRequest> = {},
): CodexDotenvStatusObservationRequest {
  return {
    apiKey: API_KEY,
    excludedProjectDirectory: PROJECT,
    ...overrides,
  };
}

function adapterReturning(
  value: unknown,
  captured: CodexDotenvStatusObservationRequest[] = [],
): CodexDotenvStatusObservationAdapter {
  return Object.freeze({
    async observe(observedRequest: CodexDotenvStatusObservationRequest) {
      captured.push(observedRequest);
      return value as never;
    },
  });
}

function expectUnavailablePublicResult(value: unknown): void {
  expect(value).toEqual({ status: "unavailable" });
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  expect(Reflect.ownKeys(value as object)).toEqual(["status"]);
  expect(JSON.stringify(value)).toBe('{"status":"unavailable"}');
}

function keyFragments(value: string, length = 10): readonly string[] {
  const fragments: string[] = [];
  for (let index = 0; index + length <= value.length; index += 1) {
    fragments.push(value.slice(index, index + length));
  }
  return Object.freeze(fragments);
}

function expectDeepPublicData(
  value: unknown,
  seen = new WeakSet<object>(),
): void {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return;
  }
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  expect(Object.getOwnPropertySymbols(value)).toEqual([]);
  for (const name of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    expect(descriptor).toBeDefined();
    expect(descriptor?.get).toBeUndefined();
    expect(descriptor?.set).toBeUndefined();
    expect(Object.hasOwn(descriptor ?? {}, "value")).toBe(true);
    expect(typeof descriptor?.value).not.toBe("function");
    expectDeepPublicData(descriptor?.value, seen);
  }
}

describe("read-only Codex dotenv status observation", () => {
  it.each(CODEX_DOTENV_PROJECTION_STATUSES)(
    "returns only the normalized %s projection status",
    async (status) => {
      const result = await observeCodexDotenvStatus(
        adapterReturning(Object.freeze({ status })),
        request(),
      );

      expect(result).toEqual({ status });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Reflect.ownKeys(result)).toEqual(["status"]);
      expect(Object.getOwnPropertyDescriptor(result, "status")).toMatchObject({
        enumerable: true,
        value: status,
      });
      expectDeepPublicData(result);
    },
  );

  it("passes one exact frozen defensive request to the observation-only port", async () => {
    const captured: CodexDotenvStatusObservationRequest[] = [];
    const input = request();
    const resultPromise = observeCodexDotenvStatus(
      adapterReturning(Object.freeze({ status: "exact" }), captured),
      input,
    );
    (input as { excludedProjectDirectory: string }).excludedProjectDirectory =
      OTHER_PROJECT;

    await expect(resultPromise).resolves.toEqual({ status: "exact" });
    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toBe(input);
    expect(captured[0]).toEqual({
      apiKey: API_KEY,
      excludedProjectDirectory: PROJECT,
    });
    expect(Object.isFrozen(captured[0])).toBe(true);
    expect(Reflect.ownKeys(captured[0] ?? {})).toEqual([
      "apiKey",
      "excludedProjectDirectory",
    ]);
    expect("apply" in (captured[0] ?? {})).toBe(false);
    expect("identity" in (captured[0] ?? {})).toBe(false);
    expect("revision" in (captured[0] ?? {})).toBe(false);
    expect("path" in (captured[0] ?? {})).toBe(false);
  });

  it.each([
    null,
    [],
    new Date(0),
    Object.create({
      apiKey: API_KEY,
      excludedProjectDirectory: PROJECT,
    }),
    { apiKey: API_KEY },
    { apiKey: API_KEY, excludedProjectDirectory: PROJECT, extra: true },
    { apiKey: "invalid", excludedProjectDirectory: PROJECT },
    { apiKey: API_KEY, excludedProjectDirectory: "" },
    { apiKey: API_KEY, excludedProjectDirectory: `bad\n${PROJECT}` },
    { apiKey: API_KEY, excludedProjectDirectory: API_KEY },
  ])("rejects malformed request %# without calling the adapter", async (input) => {
    let calls = 0;
    const adapter: CodexDotenvStatusObservationAdapter = Object.freeze({
      async observe() {
        calls += 1;
        return Object.freeze({ status: "exact" });
      },
    });

    const result = await observeCodexDotenvStatus(
      adapter,
      input as CodexDotenvStatusObservationRequest,
    );

    expectUnavailablePublicResult(result);
    expect(calls).toBe(0);
  });

  it("rejects request accessors without invoking them", async () => {
    let getterCalls = 0;
    const hostile = Object.defineProperty(
      { apiKey: API_KEY },
      "excludedProjectDirectory",
      {
        enumerable: true,
        get() {
          getterCalls += 1;
          return PROJECT;
        },
      },
    );

    const result = await observeCodexDotenvStatus(
      adapterReturning(Object.freeze({ status: "exact" })),
      hostile as CodexDotenvStatusObservationRequest,
    );

    expectUnavailablePublicResult(result);
    expect(getterCalls).toBe(0);
  });

  it("rejects symbols and oversize request paths before observation", async () => {
    const values: unknown[] = [
      Object.assign(request(), { [Symbol("private")]: API_KEY }),
      request({ excludedProjectDirectory: "x".repeat(32_768) }),
    ];
    let calls = 0;
    const adapter: CodexDotenvStatusObservationAdapter = Object.freeze({
      async observe() {
        calls += 1;
        return Object.freeze({ status: "exact" });
      },
    });

    for (const value of values) {
      expectUnavailablePublicResult(
        await observeCodexDotenvStatus(
          adapter,
          value as CodexDotenvStatusObservationRequest,
        ),
      );
    }
    expect(calls).toBe(0);
  });

  it.each([
    null,
    {},
    { observe: "not-a-function" },
    { observe: async () => ({ status: "exact" }), apply: async () => ({}) },
    Object.create({ observe: async () => ({ status: "exact" }) }),
  ])("rejects a malformed or mutation-capable adapter %#", async (value) => {
    const result = await observeCodexDotenvStatus(
      value as CodexDotenvStatusObservationAdapter,
      request(),
    );
    expectUnavailablePublicResult(result);
  });

  it("rejects adapter accessors without invoking them", async () => {
    let getterCalls = 0;
    const hostile = Object.defineProperty({}, "observe", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return async () => Object.freeze({ status: "exact" });
      },
    });

    expectUnavailablePublicResult(
      await observeCodexDotenvStatus(
        hostile as CodexDotenvStatusObservationAdapter,
        request(),
      ),
    );
    expect(getterCalls).toBe(0);
  });

  it("maps thrown observations to one fixed unavailable result", async () => {
    const adapter: CodexDotenvStatusObservationAdapter = Object.freeze({
      async observe() {
        throw new Error(`${ERROR_CANARY}:${API_KEY}:${PROJECT}`);
      },
    });

    const result = await observeCodexDotenvStatus(adapter, request());

    expectUnavailablePublicResult(result);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(ERROR_CANARY);
    expect(serialized).not.toContain(PROJECT);
    for (const fragment of keyFragments(API_KEY)) {
      expect(serialized).not.toContain(fragment);
    }
  });

  it.each([
    undefined,
    null,
    "exact",
    [],
    new Date(0),
    {},
    { status: "unavailable" },
    { status: "unknown" },
    { status: "exact", extra: ERROR_CANARY },
    Object.create({ status: "exact" }),
    Object.defineProperty({}, "status", {
      enumerable: false,
      value: "exact",
    }),
    Object.assign({ status: "exact" }, { [Symbol("secret")]: API_KEY }),
  ])("maps malformed observation %# to unavailable", async (value) => {
    const result = await observeCodexDotenvStatus(
      adapterReturning(value),
      request(),
    );
    expectUnavailablePublicResult(result);
  });

  it("rejects observation accessors without invoking or retaining them", async () => {
    let getterCalls = 0;
    const hostile = Object.defineProperty({}, "status", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "exact";
      },
    });

    const result = await observeCodexDotenvStatus(
      adapterReturning(hostile),
      request(),
    );

    expectUnavailablePublicResult(result);
    expect(getterCalls).toBe(0);
  });

  it("fails closed when observation reflection traps throw", async () => {
    const hostile = new Proxy(
      { status: "exact" },
      {
        ownKeys() {
          throw new Error(`${ERROR_CANARY}:${API_KEY}`);
        },
      },
    );

    const result = await observeCodexDotenvStatus(
      adapterReturning(hostile),
      request(),
    );

    expectUnavailablePublicResult(result);
  });

  it("exposes no key, path, identity, revision, mutation, or adapter material", async () => {
    const hostile = {
      status: "exact" as CodexDotenvProjectionStatus,
      apiKey: API_KEY,
      path: OTHER_PROJECT,
      identity: { revision: REVISION_CANARY },
      apply: () => API_KEY,
    };
    const result = await observeCodexDotenvStatus(
      adapterReturning(hostile),
      request(),
    );

    expectUnavailablePublicResult(result);
    expectDeepPublicData(result);
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      PROJECT,
      OTHER_PROJECT,
      REVISION_CANARY,
      ERROR_CANARY,
      "apiKey",
      "identity",
      "revision",
      "apply",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    for (const fragment of keyFragments(API_KEY)) {
      expect(serialized).not.toContain(fragment);
    }
  });
});
