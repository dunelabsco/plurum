import { describe, expect, it } from "vitest";

import { createPlatformPathAdapter } from "../src/adapters/node/platform.js";
import { CredentialError } from "../src/credentials/errors.js";
import {
  DEFAULT_API_ORIGIN,
  type ApiOriginPolicy,
  normalizeApiOrigin,
} from "../src/credentials/origin.js";
import { resolveCredentialLocations } from "../src/credentials/paths.js";
import {
  MAX_CREDENTIAL_DOCUMENT_CHARACTERS,
  parseCredentialDocument,
  serializeCredentialDocument,
  validateCredentialDocument,
} from "../src/credentials/schema.js";
import type {
  RuntimeEnvironment,
  SupportedOs,
} from "../src/system/contracts.js";

const API_KEY = `plrm_live_${"A".repeat(43)}`;
const AGENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const REQUEST_ID = "ca908d9f-d901-4dac-b396-7f84377adfc8";
const CREATED_AT = "2026-07-16T12:00:00.000Z";
const ACTIVATED_AT = "2026-07-16T12:01:00.000Z";

function pendingInput(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    state: "pending",
    api_origin: DEFAULT_API_ORIGIN,
    api_key: API_KEY,
    agent_id: null,
    agent_name: "Codex",
    username: "codex-42",
    registration_request_id: REQUEST_ID,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    activated_at: null,
    ...overrides,
  };
}

function activeInput(overrides: Record<string, unknown> = {}) {
  return {
    ...pendingInput(),
    state: "active",
    agent_id: AGENT_ID,
    updated_at: ACTIVATED_AT,
    activated_at: ACTIVATED_AT,
    ...overrides,
  };
}

function canonical(
  input: unknown,
  policy: ApiOriginPolicy = "https-only",
): string {
  return serializeCredentialDocument(
    validateCredentialDocument(input, policy),
    policy,
  );
}

function fakePlatform(
  os: SupportedOs,
  environment: RuntimeEnvironment,
) {
  return Object.freeze({
    os,
    environment: Object.freeze({ ...environment }),
    paths: createPlatformPathAdapter(os),
  });
}

describe("API origin normalization", () => {
  it.each([
    ["https://api.plurum.ai", "https://api.plurum.ai"],
    ["HTTPS://API.PLURUM.AI:443/", "https://api.plurum.ai"],
    ["https://bücher.example/", "https://xn--bcher-kva.example"],
    ["https://api.example:8443/", "https://api.example:8443"],
    ["https://127.0.0.1/", "https://127.0.0.1"],
    ["https://[::1]:8443/", "https://[::1]:8443"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeApiOrigin(input)).toBe(expected);
  });

  it.each([
    ["http://127.0.0.1:43197", "http://127.0.0.1:43197"],
    ["http://127.255.2.3/", "http://127.255.2.3"],
    ["http://[::1]:8787/", "http://[::1]:8787"],
  ])("permits explicit canonical numeric loopback development origin %s", (input, expected) => {
    expect(normalizeApiOrigin(input, "explicit-loopback-development")).toBe(
      expected,
    );
    expect(() => normalizeApiOrigin(input)).toThrow(CredentialError);
  });

  it.each([
    "",
    " https://api.plurum.ai",
    "https://api.plurum.ai ",
    "https://api.plurum.ai\n",
    "api.plurum.ai",
    "//api.plurum.ai",
    "http://api.plurum.ai",
    "ftp://api.plurum.ai",
    "file:///tmp/plurum",
    "https://user:password@api.plurum.ai",
    "https://api.plurum.ai/api/v1",
    "https://api.plurum.ai//",
    "https://api.plurum.ai/%2e%2e",
    "https://api.plurum.ai?",
    "https://api.plurum.ai#",
    "https:\\api.plurum.ai",
    "https://api.plurum.ai.",
    "https://api.plurum.ai:0",
    "https://api.plurum.ai:",
    "https://api.plurum.ai:99999",
    `https://${"a".repeat(2_049)}.example`,
  ])("rejects unsafe or ambiguous origin without reflecting it: %s", (input) => {
    try {
      normalizeApiOrigin(input);
      throw new Error("unsafe origin unexpectedly accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialError);
      if (input.length > 0) {
        expect(String(error)).not.toContain(input);
      }
    }
  });

  it.each([
    "http://localhost:8787",
    "http://127.1:8787",
    "http://2130706433:8787",
    "http://0x7f000001:8787",
    "http://127.000.000.001:8787",
    "http://127.0.0.1:0",
    "http://10.0.0.1:8787",
    "http://192.168.1.2:8787",
    "http://0.0.0.0:8787",
    "http://[0:0:0:0:0:0:0:1]:8787",
  ])("rejects deceptive or non-loopback HTTP origin %s", (input) => {
    expect(() =>
      normalizeApiOrigin(input, "explicit-loopback-development"),
    ).toThrow(CredentialError);
  });
});

describe("credential locations", () => {
  it("selects the standard macOS Application Support directory", () => {
    expect(
      resolveCredentialLocations(
        fakePlatform("darwin", { HOME: "/Users/example" }),
      ),
    ).toEqual({
      directory: "/Users/example/Library/Application Support/Plurum",
      credentials:
        "/Users/example/Library/Application Support/Plurum/credentials.json",
      setupLock: "/Users/example/Library/Application Support/Plurum/setup.lock",
      credentialTransaction:
        "/Users/example/Library/Application Support/Plurum/credentials-transaction.json",
    });
  });

  it("uses XDG_CONFIG_HOME on Linux and HOME only as its fallback", () => {
    expect(
      resolveCredentialLocations(
        fakePlatform("linux", {
          HOME: "/home/ignored",
          XDG_CONFIG_HOME: "/config base",
        }),
      ).directory,
    ).toBe("/config base/plurum");
    expect(
      resolveCredentialLocations(
        fakePlatform("linux", { HOME: "/home/example" }),
      ).directory,
    ).toBe("/home/example/.config/plurum");
    expect(
      resolveCredentialLocations(
        fakePlatform("linux", {
          HOME: "/home/example",
          XDG_CONFIG_HOME: "",
        }),
      ).directory,
    ).toBe("/home/example/.config/plurum");
  });

  it("selects Windows Roaming AppData with Windows path semantics", () => {
    const locations = resolveCredentialLocations(
      fakePlatform("win32", {
        APPDATA: "C:\\Users\\example\\AppData\\Roaming",
      }),
    );
    expect(locations).toEqual({
      directory: "C:\\Users\\example\\AppData\\Roaming\\Plurum",
      credentials:
        "C:\\Users\\example\\AppData\\Roaming\\Plurum\\credentials.json",
      setupLock: "C:\\Users\\example\\AppData\\Roaming\\Plurum\\setup.lock",
      credentialTransaction:
        "C:\\Users\\example\\AppData\\Roaming\\Plurum\\credentials-transaction.json",
    });
  });

  it("lexically accepts an ordinary non-root UNC roaming profile", () => {
    expect(
      resolveCredentialLocations(
        fakePlatform("win32", {
          APPDATA: "\\\\server\\profiles\\example\\AppData\\Roaming",
        }),
      ).directory,
    ).toBe("\\\\server\\profiles\\example\\AppData\\Roaming\\Plurum");
  });

  it.each([
    ["linux", "/isolated", "/isolated/plurum"],
    ["darwin", "/isolated", "/isolated/plurum"],
    ["win32", "C:\\isolated", "C:\\isolated\\plurum"],
  ] as const)(
    "uses only a complete contained test override on %s",
    (os, root, home) => {
      const locations = resolveCredentialLocations(
        fakePlatform(os, {
          HOME: "/must/not/be/used",
          APPDATA: "D:\\must\\not\\be\\used",
          PLURUM_HOME: home,
          PLURUM_TEST_ROOT: root,
          PLURUM_TEST_RUN_ID: "test-run-0001",
        }),
      );
      expect(locations.directory).toBe(home);
      expect(Object.isFrozen(locations)).toBe(true);
    },
  );

  it.each([
    ["unsupported", {}],
    ["darwin", {}],
    ["darwin", { HOME: "relative/home" }],
    ["darwin", { HOME: "/" }],
    ["darwin", { HOME: "/home/../escape" }],
    ["linux", {}],
    ["linux", { HOME: "/home/example", XDG_CONFIG_HOME: "relative" }],
    ["linux", { HOME: "//ambiguous/home" }],
    ["win32", {}],
    ["win32", { APPDATA: "C:relative" }],
    ["win32", { APPDATA: "\\rooted-without-drive" }],
    ["win32", { APPDATA: "C:\\" }],
    ["win32", { APPDATA: "\\\\?\\C:\\Users\\example" }],
    ["win32", { APPDATA: "\\\\.\\C:\\Users\\example" }],
    ["win32", { APPDATA: "C:\\Users\\example:stream" }],
    ["win32", { APPDATA: "C:\\Users\\CON\\AppData" }],
    ["win32", { APPDATA: "C:\\Users\\example.\\AppData" }],
    ["win32", { APPDATA: "C:\\Users\\example \\AppData" }],
    ["win32", { APPDATA: "C:\\Users\\COM¹\\AppData" }],
    ["win32", { APPDATA: "C:\\Users\\LPT³\\AppData" }],
    ["win32", { APPDATA: "C:\\Users\\CONIN$\\AppData" }],
    ["win32", { APPDATA: "C:\\Users\\CONOUT$.txt\\AppData" }],
    ["win32", { APPDATA: "C:\\Users\\bad<name\\AppData" }],
    ["win32", { APPDATA: "C:\\Users\\bad?name\\AppData" }],
    ["win32", { APPDATA: "\\\\server\\pipe\\credential" }],
    ["win32", { APPDATA: "\\\\server\\MAILSLOT\\credential" }],
    ["win32", { APPDATA: "\\\\server\\IPC$\\credential" }],
  ] as const)("rejects invalid %s credential base %#", (os, environment) => {
    expect(() =>
      resolveCredentialLocations(
        fakePlatform(os as SupportedOs, environment),
      ),
    ).toThrow(CredentialError);
  });

  it.each([
    {
      PLURUM_HOME: "/isolated/plurum",
    },
    {
      PLURUM_TEST_ROOT: "/isolated",
    },
    {
      PLURUM_HOME: "/isolated/plurum",
      PLURUM_TEST_ROOT: "/isolated",
    },
    {
      PLURUM_HOME: "/isolated/plurum",
      PLURUM_TEST_ROOT: "/isolated",
      PLURUM_TEST_RUN_ID: "short",
    },
    {
      PLURUM_HOME: "/isolated",
      PLURUM_TEST_ROOT: "/isolated",
      PLURUM_TEST_RUN_ID: "test-run-0001",
    },
    {
      PLURUM_HOME: "/isolated-sibling/plurum",
      PLURUM_TEST_ROOT: "/isolated",
      PLURUM_TEST_RUN_ID: "test-run-0001",
    },
    {
      PLURUM_HOME: "/isolated/../escape",
      PLURUM_TEST_ROOT: "/isolated",
      PLURUM_TEST_RUN_ID: "test-run-0001",
    },
    {
      PLURUM_HOME: "D:\\isolated\\plurum",
      PLURUM_TEST_ROOT: "C:\\isolated",
      PLURUM_TEST_RUN_ID: "test-run-0001",
    },
    {
      PLURUM_HOME: "\\\\server\\other\\plurum",
      PLURUM_TEST_ROOT: "\\\\server\\tests\\run",
      PLURUM_TEST_RUN_ID: "test-run-0001",
    },
  ])("rejects incomplete or escaping test locations", (environment) => {
    const os = environment.PLURUM_HOME?.includes("\\") ? "win32" : "linux";
    expect(() => resolveCredentialLocations(fakePlatform(os, environment))).toThrow(
      CredentialError,
    );
  });
});

describe("credential schema", () => {
  it("round-trips a canonical pending credential as a frozen defensive copy", () => {
    const input = pendingInput();
    const validated = validateCredentialDocument(input);
    expect(validated).not.toBe(input);
    expect(Object.isFrozen(validated)).toBe(true);

    const serialized = serializeCredentialDocument(validated);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(parseCredentialDocument(serialized)).toEqual(validated);
    expect(Object.isFrozen(parseCredentialDocument(serialized))).toBe(true);
  });

  it("accepts active credentials created by registration or imported from an older agent", () => {
    expect(validateCredentialDocument(activeInput())).toMatchObject({
      state: "active",
      agent_id: AGENT_ID,
      username: "codex-42",
      registration_request_id: REQUEST_ID,
    });
    expect(
      validateCredentialDocument(
        activeInput({ username: null, registration_request_id: null }),
      ),
    ).toMatchObject({
      state: "active",
      username: null,
      registration_request_id: null,
    });
  });

  it.each([0, 2, 999])("rejects schema version %s without treating it as missing", (schemaVersion) => {
    expect(() =>
      validateCredentialDocument(
        pendingInput({ schema_version: schemaVersion }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "unsupported_credential_schema" }),
    );
  });

  it.each([
    null,
    [],
    {},
    pendingInput({ schema_version: "1" }),
    pendingInput({ extra: true }),
    pendingInput({ api_key: `Bearer ${API_KEY}` }),
    pendingInput({ api_key: ` ${API_KEY}` }),
    pendingInput({ api_key: "plrm_live_short" }),
    pendingInput({ api_key: `plrm_live_${"A".repeat(201)}` }),
    pendingInput({ agent_name: "" }),
    pendingInput({ agent_name: "bad\nname" }),
    pendingInput({ agent_name: "Codex\u061c" }),
    pendingInput({ agent_name: "Codex\u200e" }),
    pendingInput({ agent_name: "Codex\u2028split" }),
    pendingInput({ agent_name: "Codex\u202ereversed" }),
    pendingInput({ agent_name: "Codex\u2066isolated" }),
    pendingInput({ agent_name: "😀".repeat(256) }),
    pendingInput({ username: "UPPERCASE" }),
    pendingInput({ username: "ab" }),
    pendingInput({ username: "a".repeat(51) }),
    pendingInput({ registration_request_id: AGENT_ID.replace("42d3", "12d3") }),
    pendingInput({ agent_id: AGENT_ID }),
    pendingInput({ activated_at: ACTIVATED_AT }),
    activeInput({ agent_id: null }),
    activeInput({ agent_id: "00000000-0000-0000-0000-000000000000" }),
    activeInput({ agent_id: AGENT_ID.toUpperCase() }),
    activeInput({ username: "UPPERCASE" }),
    activeInput({ activated_at: null }),
    activeInput({ created_at: "2026-07-16T12:02:00.000Z" }),
    activeInput({ updated_at: "2026-07-16T12:00:30.000Z" }),
    pendingInput({ created_at: "2026-07-16T12:00:00Z" }),
    pendingInput({ created_at: "2026-02-31T12:00:00.000Z" }),
    pendingInput({ updated_at: "2026-07-16T11:59:59.999Z" }),
  ])("rejects malformed or cross-state credential data", (input) => {
    expect(() => validateCredentialDocument(input)).toThrow(CredentialError);
  });

  it("supports standard Plurum key, name, and username boundaries", () => {
    expect(() =>
      validateCredentialDocument(
        pendingInput({ api_key: `plrm_live_${"a".repeat(10)}` }),
      ),
    ).not.toThrow();
    expect(() =>
      validateCredentialDocument(
        pendingInput({ api_key: `plrm_live_${"a".repeat(200)}` }),
      ),
    ).not.toThrow();
    expect(() =>
      validateCredentialDocument(
        pendingInput({ agent_name: "😀".repeat(255) }),
      ),
    ).not.toThrow();
    expect(() =>
      validateCredentialDocument(pendingInput({ agent_name: "Codex 👩‍💻" })),
    ).not.toThrow();
    expect(() =>
      validateCredentialDocument(pendingInput({ username: "a-a" })),
    ).not.toThrow();
    expect(() =>
      validateCredentialDocument(
        pendingInput({ username: `a${"b".repeat(48)}a` }),
      ),
    ).not.toThrow();
  });

  it("requires the stored origin to be canonical and explicitly authorizes loopback HTTP", () => {
    expect(() =>
      validateCredentialDocument(
        pendingInput({ api_origin: "HTTPS://API.PLURUM.AI:443/" }),
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_credential_origin" }));

    const loopback = pendingInput({ api_origin: "http://127.0.0.1:8787" });
    expect(() => validateCredentialDocument(loopback)).toThrow(CredentialError);
    expect(() =>
      validateCredentialDocument(loopback, "explicit-loopback-development"),
    ).not.toThrow();
    expect(() =>
      parseCredentialDocument(
        canonical(loopback, "explicit-loopback-development"),
        "explicit-loopback-development",
      ),
    ).not.toThrow();
  });

  it.each([
    "not json",
    "\ufeff{}",
    JSON.stringify(pendingInput()),
    `${canonical(pendingInput()).trimEnd()}\r\n`,
    canonical(pendingInput()).replace(
      '  "schema_version": 1,',
      '  "schema_version": 2,\n  "schema_version": 1,',
    ),
    canonical(pendingInput()).replace(
      '  "state": "pending",',
      '  "constructor": "unsafe",\n  "state": "pending",',
    ),
    "x".repeat(MAX_CREDENTIAL_DOCUMENT_CHARACTERS + 1),
  ])("rejects non-canonical, duplicate, hostile, or oversized credential text", (input) => {
    expect(() => parseCredentialDocument(input)).toThrow(CredentialError);
  });

  it("never includes a raw API key or payload in credential errors", () => {
    const secret = `plrm_live_${"SECRET".repeat(8)}`;
    const payload = JSON.stringify(pendingInput({ api_key: secret }));
    for (const attempt of [
      () =>
        validateCredentialDocument(
          pendingInput({ api_key: secret, agent_id: AGENT_ID }),
        ),
      () => parseCredentialDocument(payload),
    ]) {
      try {
        attempt();
        throw new Error("invalid credential unexpectedly accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(CredentialError);
        expect(String(error)).not.toContain(secret);
        expect(JSON.stringify(error)).not.toContain(secret);
      }
    }
  });
});
