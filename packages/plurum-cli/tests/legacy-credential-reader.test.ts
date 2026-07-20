import { describe, expect, it } from "vitest";

import {
  MAX_LEGACY_CREDENTIAL_BYTES,
  type LegacyCredentialAdapterReadResult,
  type LegacyCredentialReadAdapter,
  type LegacyCredentialReadOptions,
  type LegacyCredentialSource,
} from "../src/credentials/legacy-reader-contracts.js";
import {
  readLegacyCredential,
  type LegacyCredentialReadResult,
} from "../src/credentials/legacy-reader.js";

const PATH = "/isolated/home/.hermes/plurum.json";
const KEY = "plrm_live_legacy_reader_canary_123456789";
const ORIGIN = "HTTPS://API.EXAMPLE.TEST:443/";

interface ReadCall {
  readonly source: LegacyCredentialSource;
  readonly path: string;
  readonly options: LegacyCredentialReadOptions;
}

function encoded(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function adapterReturning(
  value: unknown,
  calls: ReadCall[] = [],
): LegacyCredentialReadAdapter {
  return Object.freeze<LegacyCredentialReadAdapter>({
    async read(source, path, options) {
      calls.push(Object.freeze({ source, path, options }));
      return value as LegacyCredentialAdapterReadResult;
    },
  });
}

function loadedJson(value: unknown): LegacyCredentialAdapterReadResult {
  return Object.freeze({
    status: "loaded",
    bytes: encoded(JSON.stringify(value)),
  });
}

function failureText(result: LegacyCredentialReadResult): string {
  return JSON.stringify(result);
}

describe("legacy credential reader", () => {
  it.each([
    ["hermes", { api_key: KEY, api_url: ORIGIN }, ORIGIN],
    ["openclaw", { api_key: KEY }, null],
    ["removed-cli", { apiKey: KEY, apiUrl: ORIGIN }, ORIGIN],
  ] as const)(
    "extracts the raw %s fields without normalizing secrets or origins",
    async (source, document, expectedOrigin) => {
      const result = await readLegacyCredential(
        adapterReturning(loadedJson(document)),
        source,
        PATH,
      );

      expect(result).toEqual({
        status: "candidate",
        source,
        apiOrigin: expectedOrigin,
      });
      expect(result.status === "candidate" && result.apiKey).toBe(KEY);
      expect(Object.keys(result)).not.toContain("apiKey");
      expect(failureText(result)).not.toContain(KEY);
      expect(Object.isFrozen(result)).toBe(true);
    },
  );

  it("preserves raw whitespace for higher-level validation", async () => {
    const result = await readLegacyCredential(
      adapterReturning(
        loadedJson({ api_key: ` ${KEY} `, api_url: ` ${ORIGIN} ` }),
      ),
      "hermes",
      PATH,
    );

    expect(result).toMatchObject({
      status: "candidate",
      apiOrigin: ` ${ORIGIN} `,
    });
    expect(result.status === "candidate" && result.apiKey).toBe(` ${KEY} `);
  });

  it("allows unrelated fields without returning or inspecting their values", async () => {
    const unrelatedCanary = "UNRELATED_LEGACY_FIELD_CANARY";
    const result = await readLegacyCredential(
      adapterReturning(
        loadedJson({
          api_key: KEY,
          nested: { secret: unrelatedCanary },
          enabled: true,
          count: 4,
        }),
      ),
      "hermes",
      PATH,
    );

    expect(result).toEqual({
      status: "candidate",
      source: "hermes",
      apiOrigin: null,
    });
    expect(result.status === "candidate" && result.apiKey).toBe(KEY);
    expect(failureText(result)).not.toContain(unrelatedCanary);
  });

  it("treats all OpenClaw fields except api_key as unrelated", async () => {
    const result = await readLegacyCredential(
      adapterReturning(
        loadedJson({
          api_key: KEY,
          api_url: 42,
          apiUrl: ORIGIN,
        }),
      ),
      "openclaw",
      PATH,
    );

    expect(result).toEqual({
      status: "candidate",
      source: "openclaw",
      apiOrigin: null,
    });
    expect(result.status === "candidate" && result.apiKey).toBe(KEY);
  });

  it.each([
    ["hermes", { apiKey: KEY }],
    ["hermes", { api_key: null }],
    ["hermes", { api_key: KEY, api_url: null }],
    ["openclaw", { apiKey: KEY }],
    ["openclaw", { api_key: 42 }],
    ["removed-cli", { api_key: KEY }],
    ["removed-cli", { apiKey: KEY, apiUrl: false }],
  ] as const)(
    "classifies malformed %s source fields without reflecting them",
    async (source, document) => {
      const result = await readLegacyCredential(
        adapterReturning(loadedJson(document)),
        source,
        PATH,
      );

      expect(result).toEqual({ status: "malformed", source });
      expect(Object.isFrozen(result)).toBe(true);
      expect(failureText(result)).not.toContain(KEY);
      expect(failureText(result)).not.toContain(PATH);
    },
  );

  it.each([
    ["missing", { status: "missing" }],
    ["unsafe", { status: "unsafe" }],
  ] as const)("preserves the fixed %s source state", async (status, adapterResult) => {
    const result = await readLegacyCredential(
      adapterReturning(adapterResult),
      "hermes",
      PATH,
    );

    expect(result).toEqual({ status, source: "hermes" });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("calls only the dedicated adapter with the exact path and fixed bounds", async () => {
    const calls: ReadCall[] = [];
    await readLegacyCredential(
      adapterReturning({ status: "missing" }, calls),
      "removed-cli",
      "/isolated/home/.plurum/config.json",
    );

    expect(calls).toEqual([
      {
        source: "removed-cli",
        path: "/isolated/home/.plurum/config.json",
        options: {
          noFollow: true,
          maxBytes: MAX_LEGACY_CREDENTIAL_BYTES,
        },
      },
    ]);
    expect(Object.isFrozen(calls[0]?.options)).toBe(true);
  });

  it.each([
    { label: "null", value: null },
    { label: "undefined", value: undefined },
    { label: "string", value: "missing" },
    { label: "array", value: [] },
    { label: "empty object", value: {} },
    { label: "unknown status", value: { status: "other" } },
    {
      label: "extra missing field",
      value: { status: "missing", bytes: new Uint8Array() },
    },
    {
      label: "extra unsafe field",
      value: { status: "unsafe", reason: KEY },
    },
    { label: "missing bytes", value: { status: "loaded" } },
    { label: "non-byte body", value: { status: "loaded", bytes: KEY } },
    {
      label: "extra loaded field",
      value: { status: "loaded", bytes: encoded("{}"), extra: true },
    },
  ])("maps a hostile $label adapter result to one safe unavailable state", async ({ value }) => {
    const result = await readLegacyCredential(
      adapterReturning(value),
      "hermes",
      PATH,
    );

    expect(result).toEqual({ status: "unavailable", source: "hermes" });
    expect(failureText(result)).not.toContain(KEY);
    expect(failureText(result)).not.toContain(PATH);
  });

  it("maps throwing adapter properties and operations without reflecting errors", async () => {
    const hostileResult = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error(`${KEY}:${PATH}`);
        },
      },
    );
    const throwingAdapter = Object.freeze({
      async read(): Promise<LegacyCredentialAdapterReadResult> {
        throw new Error(`${KEY}:${PATH}`);
      },
    });
    const throwingPropertyAdapter = Object.defineProperty({}, "read", {
      get() {
        throw new Error(`${KEY}:${PATH}`);
      },
    }) as LegacyCredentialReadAdapter;

    for (const adapter of [
      adapterReturning(hostileResult),
      throwingAdapter,
      throwingPropertyAdapter,
    ]) {
      const result = await readLegacyCredential(adapter, "hermes", PATH);
      expect(result).toEqual({ status: "unavailable", source: "hermes" });
      expect(failureText(result)).not.toContain(KEY);
      expect(failureText(result)).not.toContain(PATH);
    }
  });

  it.each([
    new Uint8Array(),
    new Uint8Array([0xc3, 0x28]),
    encoded("\uFEFF{\"api_key\":\"value\"}"),
    encoded("null"),
    encoded("[]"),
    encoded('"string"'),
    encoded('{"api_key":'),
    encoded('{"api_key":"first","api_key":"second"}'),
    encoded('{"api_key":"value","other":1,"other":2}'),
  ])("classifies invalid encoded or strict JSON bytes as malformed", async (bytes) => {
    const result = await readLegacyCredential(
      adapterReturning({ status: "loaded", bytes }),
      "hermes",
      PATH,
    );

    expect(result).toEqual({ status: "malformed", source: "hermes" });
  });

  it("rejects a byte beyond the bound without attempting to parse it", async () => {
    const bytes = new Uint8Array(MAX_LEGACY_CREDENTIAL_BYTES + 1).fill(0x41);
    const result = await readLegacyCredential(
      adapterReturning({ status: "loaded", bytes }),
      "hermes",
      PATH,
    );

    expect(result).toEqual({ status: "malformed", source: "hermes" });
  });

  it("uses intrinsic byte length before copying adversarial adapter bytes", async () => {
    const bytes = new Uint8Array(MAX_LEGACY_CREDENTIAL_BYTES + 1).fill(0x41);
    Object.defineProperties(bytes, {
      byteLength: { get: () => 1 },
      length: { get: () => 1 },
    });

    const result = await readLegacyCredential(
      adapterReturning({ status: "loaded", bytes }),
      "hermes",
      PATH,
    );

    expect(result).toEqual({ status: "malformed", source: "hermes" });
  });

  it("accepts a valid document at the exact byte bound", async () => {
    const prefix = `{"api_key":"${KEY}","padding":"`;
    const suffix = '"}';
    const padding = "a".repeat(
      MAX_LEGACY_CREDENTIAL_BYTES - prefix.length - suffix.length,
    );
    const bytes = encoded(`${prefix}${padding}${suffix}`);
    expect(bytes.byteLength).toBe(MAX_LEGACY_CREDENTIAL_BYTES);

    await expect(
      readLegacyCredential(
        adapterReturning({ status: "loaded", bytes }),
        "hermes",
        PATH,
      ),
    ).resolves.toMatchObject({
      status: "candidate",
      apiKey: KEY,
    });
  });

  it("copies through the intrinsic byte operation and leaves adapter-owned bytes unchanged", async () => {
    const bytes = encoded(JSON.stringify({ api_key: KEY }));
    Object.defineProperty(bytes, "slice", {
      configurable: true,
      value(): Uint8Array {
        throw new Error(KEY);
      },
    });
    const before = Uint8Array.prototype.slice.call(bytes) as Uint8Array;

    const result = await readLegacyCredential(
      adapterReturning({ status: "loaded", bytes }),
      "hermes",
      PATH,
    );

    expect(result.status).toBe("candidate");
    expect(bytes).toEqual(before);
  });

  it("does not reflect a raw key when strict parsing fails after decoding", async () => {
    const document = `{"api_key":"${KEY}","api_key":null}`;
    const result = await readLegacyCredential(
      adapterReturning({ status: "loaded", bytes: encoded(document) }),
      "hermes",
      PATH,
    );

    expect(result).toEqual({ status: "malformed", source: "hermes" });
    expect(failureText(result)).not.toContain(KEY);
  });
});
