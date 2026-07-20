import { describe, expect, it } from "vitest";

import { createPlatformPathAdapter } from "../src/adapters/node/platform.js";
import { DEFAULT_API_ORIGIN } from "../src/credentials/origin.js";
import {
  serializeCredentialDocument,
  validateCredentialDocument,
} from "../src/credentials/schema.js";
import {
  CLAUDE_HEADERS_HELPER_ISOLATED_TEST_LOCATION_MODE,
  CLAUDE_HEADERS_HELPER_PRODUCTION_LOCATION_MODE,
  ClaudeHeadersHelperError,
  MAX_CLAUDE_HEADERS_HELPER_OUTPUT_BYTES,
  PLURUM_CLAUDE_MCP_SERVER_NAME,
  PLURUM_MCP_ENDPOINT,
  prepareClaudeHeadersHelperPrivateAuthPipe,
  type ClaudeHeadersHelperDependencies,
  type ClaudeHeadersHelperEnvironment,
  type ClaudeHeadersHelperErrorCode,
  type ClaudeHeadersHelperLocationMode,
  type ClaudeHeadersHelperPrivateAuthPipe,
} from "../src/hosts/claude-code/headers-helper.js";
import type {
  ElevationState,
  RuntimeEnvironment,
  SupportedOs,
} from "../src/system/contracts.js";
import {
  createInMemoryCredentialStore,
  secureDirectoryAttestation,
} from "./support/in-memory-credential-store.js";

const API_KEY = `plrm_live_${"ClaudeHeadersHelperCanary7".repeat(2)}`;
const MAXIMUM_API_KEY = `plrm_live_${"A".repeat(200)}`;
const AGENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const REQUEST_ID = "ca908d9f-d901-4dac-b396-7f84377adfc8";
const CREATED_AT = "2026-07-16T12:00:00.000Z";
const ACTIVATED_AT = "2026-07-16T12:01:00.000Z";
const decoder = new TextDecoder("utf-8", { fatal: true });

function activeCredentialText(
  overrides: Record<string, unknown> = {},
): string {
  return serializeCredentialDocument(
    validateCredentialDocument({
      schema_version: 1,
      state: "active",
      api_origin: DEFAULT_API_ORIGIN,
      api_key: API_KEY,
      agent_id: AGENT_ID,
      agent_name: "Claude Code",
      username: "claude-code",
      registration_request_id: REQUEST_ID,
      created_at: CREATED_AT,
      updated_at: ACTIVATED_AT,
      activated_at: ACTIVATED_AT,
      ...overrides,
    }),
  );
}

function pendingCredentialText(): string {
  return serializeCredentialDocument(
    validateCredentialDocument({
      schema_version: 1,
      state: "pending",
      api_origin: DEFAULT_API_ORIGIN,
      api_key: API_KEY,
      agent_id: null,
      agent_name: "Claude Code",
      username: "claude-code",
      registration_request_id: REQUEST_ID,
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
      activated_at: null,
    }),
  );
}

function encoded(text = activeCredentialText()): Uint8Array {
  return new TextEncoder().encode(text);
}

function platform(
  overrides: {
    readonly os?: SupportedOs;
    readonly elevation?: ElevationState;
    readonly environment?: RuntimeEnvironment;
  } = {},
) {
  const os = overrides.os ?? "linux";
  return Object.freeze({
    os,
    elevation: overrides.elevation ?? "standard",
    environment:
      overrides.environment ??
      Object.freeze({
        PLURUM_HOME: "/isolated/headers-helper/run/plurum",
        PLURUM_TEST_ROOT: "/isolated/headers-helper/run",
        PLURUM_TEST_RUN_ID: "headers-helper-01",
      }),
    paths: createPlatformPathAdapter(os),
  });
}

function claudeEnvironment(
  overrides: Partial<ClaudeHeadersHelperEnvironment> = {},
): ClaudeHeadersHelperEnvironment {
  return Object.freeze({
    CLAUDE_CODE_MCP_SERVER_NAME: PLURUM_CLAUDE_MCP_SERVER_NAME,
    CLAUDE_CODE_MCP_SERVER_URL: PLURUM_MCP_ENDPOINT,
    ...overrides,
  });
}

function dependencies(
  credentialStore: ClaudeHeadersHelperDependencies["credentialStore"],
  overrides: Partial<
    Pick<
      ClaudeHeadersHelperDependencies,
      "platform" | "claudeEnvironment" | "credentialLocationMode"
    >
  > = {},
): ClaudeHeadersHelperDependencies {
  return Object.freeze({
    credentialStore,
    platform: overrides.platform ?? platform(),
    claudeEnvironment:
      overrides.claudeEnvironment ?? claudeEnvironment(),
    credentialLocationMode:
      overrides.credentialLocationMode ??
      CLAUDE_HEADERS_HELPER_ISOLATED_TEST_LOCATION_MODE,
  });
}

function productionDependencies(
  credentialStore: ClaudeHeadersHelperDependencies["credentialStore"],
  productionPlatform: ClaudeHeadersHelperDependencies["platform"],
): ClaudeHeadersHelperDependencies {
  return Object.freeze({
    credentialStore,
    platform: productionPlatform,
    claudeEnvironment: claudeEnvironment(),
  });
}

async function expectSafeFailure(
  attempt: Promise<unknown>,
  code: ClaudeHeadersHelperErrorCode,
  forbidden: readonly string[] = [API_KEY],
): Promise<ClaudeHeadersHelperError> {
  try {
    await attempt;
  } catch (error) {
    expect(error).toBeInstanceOf(ClaudeHeadersHelperError);
    expect(error).toMatchObject({ code });
    const helperError = error as ClaudeHeadersHelperError;
    const diagnostic = [
      helperError.name,
      helperError.message,
      helperError.stack ?? "",
      JSON.stringify(helperError),
    ].join("\n");
    for (const value of forbidden) {
      expect(diagnostic).not.toContain(value);
    }
    return helperError;
  }
  throw new Error("expected the Claude headers helper to fail closed");
}

async function copyPrivateOutput(
  output: ClaudeHeadersHelperPrivateAuthPipe,
): Promise<{
  readonly copy: Uint8Array;
  readonly borrowedAfterWrite: Uint8Array;
}> {
  let copy: Uint8Array | undefined;
  let borrowed: Uint8Array | undefined;
  await output.writeOnce({
    write(bytes) {
      borrowed = bytes;
      copy = bytes.slice();
    },
  });
  if (copy === undefined || borrowed === undefined) {
    throw new Error("private test sink was not called");
  }
  return Object.freeze({ copy, borrowedAfterWrite: borrowed });
}

describe("Claude Code headersHelper private credential contract", () => {
  it("emits only the exact production Authorization header through a one-use private pipe", async () => {
    const fake = createInMemoryCredentialStore({ bytes: encoded() });
    const output = await prepareClaudeHeadersHelperPrivateAuthPipe(
      dependencies(fake.adapter),
    );

    expect(output.kind).toBe(
      "claude-code-headers-helper-private-auth-pipe",
    );
    expect(Object.isFrozen(output)).toBe(true);
    expect(output.byteLength).toBeLessThanOrEqual(
      MAX_CLAUDE_HEADERS_HELPER_OUTPUT_BYTES,
    );

    const { copy, borrowedAfterWrite } = await copyPrivateOutput(output);
    expect(decoder.decode(copy)).toBe(
      `{"Authorization":"Bearer ${API_KEY}"}`,
    );
    expect(copy.at(-1)).toBe("}".charCodeAt(0));
    expect(borrowedAfterWrite.every((byte) => byte === 0)).toBe(true);
    expect(fake.trace.directories()).toEqual([
      "/isolated/headers-helper/run/plurum",
    ]);
    expect(fake.trace.operations()).toEqual([
      "open-directory",
      "attest-directory:1",
      "open-credential",
      "attest-file:1",
      "read-file",
      "attest-file:2",
      "close-file",
      "attest-directory:2",
      "close-directory",
    ]);

    await expectSafeFailure(
      Promise.resolve().then(() =>
        output.writeOnce({
          write() {
            throw new Error("must not run");
          },
        }),
      ),
      "private_auth_pipe_consumed",
    );
  });

  it("enforces the independent byte ceiling at the maximum current key size", async () => {
    const fake = createInMemoryCredentialStore({
      bytes: encoded(activeCredentialText({ api_key: MAXIMUM_API_KEY })),
    });
    const output = await prepareClaudeHeadersHelperPrivateAuthPipe(
      dependencies(fake.adapter),
    );

    expect(output.byteLength).toBe(
      MAX_CLAUDE_HEADERS_HELPER_OUTPUT_BYTES,
    );
    const { copy } = await copyPrivateOutput(output);
    expect(copy.byteLength).toBe(
      MAX_CLAUDE_HEADERS_HELPER_OUTPUT_BYTES,
    );
    expect(decoder.decode(copy)).toBe(
      `{"Authorization":"Bearer ${MAXIMUM_API_KEY}"}`,
    );
  });

  it("defaults to standard OS paths and never redirects through a full Plurum test triad", async () => {
    const fake = createInMemoryCredentialStore({ bytes: encoded() });
    const output = await prepareClaudeHeadersHelperPrivateAuthPipe(
      productionDependencies(
        fake.adapter,
        platform({
          environment: Object.freeze({
            HOME: "/synthetic/users/claude",
            PLURUM_HOME: `/isolated/${API_KEY}/redirect`,
            PLURUM_TEST_ROOT: `/isolated/${API_KEY}`,
            PLURUM_TEST_RUN_ID: "hostile-redirect-01",
          }),
        }),
      ),
    );

    expect(fake.trace.directories()).toEqual([
      "/synthetic/users/claude/.config/plurum",
    ]);
    expect(fake.trace.directories().join("\n")).not.toContain(API_KEY);
    output.dispose();
  });

  it.each([
    [
      "darwin",
      Object.freeze({
        HOME: "/Users/synthetic",
        PLURUM_HOME: "/isolated/redirect",
        PLURUM_TEST_ROOT: "/isolated",
        PLURUM_TEST_RUN_ID: "hostile-redirect-02",
      }),
      "/Users/synthetic/Library/Application Support/Plurum",
    ],
    [
      "win32",
      Object.freeze({
        APPDATA: "C:\\Users\\synthetic\\AppData\\Roaming",
        PLURUM_HOME: "D:\\isolated\\redirect",
        PLURUM_TEST_ROOT: "D:\\isolated",
        PLURUM_TEST_RUN_ID: "hostile-redirect-03",
      }),
      "C:\\Users\\synthetic\\AppData\\Roaming\\Plurum",
    ],
  ] as const)(
    "derives the %s production location without honoring Plurum overrides",
    async (os, environment, expectedDirectory) => {
      const fake = createInMemoryCredentialStore({ bytes: encoded() });
      const output = await prepareClaudeHeadersHelperPrivateAuthPipe(
        productionDependencies(
          fake.adapter,
          platform({ os, environment }),
        ),
      );

      expect(fake.trace.directories()).toEqual([expectedDirectory]);
      output.dispose();
    },
  );

  it("does not access hostile Plurum override getters in production mode", async () => {
    const environment = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(environment, "HOME", {
      enumerable: true,
      value: "/synthetic/users/claude",
    });
    for (const key of [
      "PLURUM_HOME",
      "PLURUM_TEST_ROOT",
      "PLURUM_TEST_RUN_ID",
    ]) {
      Object.defineProperty(environment, key, {
        enumerable: true,
        get() {
          throw new Error(`override getter reflected ${API_KEY}`);
        },
      });
    }
    const fake = createInMemoryCredentialStore({ bytes: encoded() });
    const output = await prepareClaudeHeadersHelperPrivateAuthPipe(
      productionDependencies(
        fake.adapter,
        platform({
          environment,
        }),
      ),
    );

    expect(fake.trace.directories()).toEqual([
      "/synthetic/users/claude/.config/plurum",
    ]);
    output.dispose();
  });

  it("requires the exact isolated-test capability instead of accepting a lookalike", async () => {
    const fake = createInMemoryCredentialStore({ bytes: encoded() });
    const lookalike = Object.freeze({
      kind: "isolated-test" as const,
    }) as ClaudeHeadersHelperLocationMode;

    await expectSafeFailure(
      prepareClaudeHeadersHelperPrivateAuthPipe(
        Object.freeze({
          credentialStore: fake.adapter,
          platform: platform(),
          claudeEnvironment: claudeEnvironment(),
          credentialLocationMode: lookalike,
        }),
      ),
      "credential_location_unavailable",
    );
    expect(fake.trace.operations()).toEqual([]);
  });

  it("does not inherit an isolated-test capability into the default production path", async () => {
    const fake = createInMemoryCredentialStore({ bytes: encoded() });
    const inheritedMode = Object.create({
      credentialLocationMode:
        CLAUDE_HEADERS_HELPER_ISOLATED_TEST_LOCATION_MODE,
    }) as Record<string, unknown>;
    Object.assign(inheritedMode, {
      credentialStore: fake.adapter,
      platform: platform({
        environment: Object.freeze({
          HOME: "/synthetic/users/claude",
          PLURUM_HOME: "/isolated/headers-helper/run/plurum",
          PLURUM_TEST_ROOT: "/isolated/headers-helper/run",
          PLURUM_TEST_RUN_ID: "headers-helper-03",
        }),
      }),
      claudeEnvironment: claudeEnvironment(),
    });

    const output = await prepareClaudeHeadersHelperPrivateAuthPipe(
      inheritedMode as unknown as ClaudeHeadersHelperDependencies,
    );
    expect(fake.trace.directories()).toEqual([
      "/synthetic/users/claude/.config/plurum",
    ]);
    output.dispose();
  });

  it.each([
    ["HOME", undefined],
    ["XDG_CONFIG_HOME", "/synthetic/users/claude"],
  ] as const)(
    "fails safely when production %s is a throwing own property",
    async (throwingKey, home) => {
      const environment = Object.create(null) as Record<string, unknown>;
      let getterCalls = 0;
      if (home !== undefined) {
        Object.defineProperty(environment, "HOME", {
          enumerable: true,
          value: home,
        });
      }
      Object.defineProperty(environment, throwingKey, {
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new Error(`standard path getter reflected ${API_KEY}`);
        },
      });
      const fake = createInMemoryCredentialStore({ bytes: encoded() });

      await expectSafeFailure(
        prepareClaudeHeadersHelperPrivateAuthPipe(
          productionDependencies(
            fake.adapter,
            platform({ environment }),
          ),
        ),
        "credential_location_unavailable",
      );
      expect(fake.trace.operations()).toEqual([]);
      expect(getterCalls).toBe(0);
    },
  );

  it("rejects inherited production path variables instead of following them or test overrides", async () => {
    const environment = Object.create({
      HOME: `/synthetic/inherited/${API_KEY}`,
    }) as Record<string, unknown>;
    Object.assign(environment, {
      PLURUM_HOME: "/isolated/headers-helper/run/plurum",
      PLURUM_TEST_ROOT: "/isolated/headers-helper/run",
      PLURUM_TEST_RUN_ID: "headers-helper-04",
    });
    const fake = createInMemoryCredentialStore({ bytes: encoded() });

    await expectSafeFailure(
      prepareClaudeHeadersHelperPrivateAuthPipe(
        productionDependencies(
          fake.adapter,
          platform({ environment }),
        ),
      ),
      "credential_location_unavailable",
    );
    expect(fake.trace.operations()).toEqual([]);
  });

  it("accepts the explicit production capability without widening its environment snapshot", async () => {
    const fake = createInMemoryCredentialStore({ bytes: encoded() });
    const output = await prepareClaudeHeadersHelperPrivateAuthPipe(
      dependencies(fake.adapter, {
        credentialLocationMode:
          CLAUDE_HEADERS_HELPER_PRODUCTION_LOCATION_MODE,
        platform: platform({
          environment: Object.freeze({
            XDG_CONFIG_HOME: "/synthetic/xdg",
            PLURUM_HOME: "/isolated/headers-helper/run/plurum",
            PLURUM_TEST_ROOT: "/isolated/headers-helper/run",
            PLURUM_TEST_RUN_ID: "headers-helper-05",
          }),
        }),
      }),
    );

    expect(fake.trace.directories()).toEqual([
      "/synthetic/xdg/plurum",
    ]);
    output.dispose();
  });

  it("wipes the private buffer and replaces a sink failure with a fixed safe error", async () => {
    const fake = createInMemoryCredentialStore({ bytes: encoded() });
    const output = await prepareClaudeHeadersHelperPrivateAuthPipe(
      dependencies(fake.adapter),
    );
    let borrowed: Uint8Array | undefined;

    const failure = expectSafeFailure(
      Promise.resolve().then(() =>
        output.writeOnce({
          write(bytes: Uint8Array) {
            borrowed = bytes;
            throw new Error(`sink reflected ${API_KEY}`);
          },
        }),
      ),
      "private_auth_pipe_write_failed",
    );
    await failure;
    expect(borrowed).toBeDefined();
    expect(borrowed?.every((byte) => byte === 0)).toBe(true);
  });

  it("rejects an async sink so credential bytes cannot outlive helper disposal", async () => {
    const fake = createInMemoryCredentialStore({ bytes: encoded() });
    const output = await prepareClaudeHeadersHelperPrivateAuthPipe(
      dependencies(fake.adapter),
    );
    let borrowed: Uint8Array | undefined;

    await expectSafeFailure(
      Promise.resolve().then(() =>
        output.writeOnce({
          write(bytes: Uint8Array) {
            borrowed = bytes;
            return Promise.resolve();
          },
        } as unknown as {
          write(bytes: Uint8Array): void;
        }),
      ),
      "private_auth_pipe_write_failed",
    );
    expect(borrowed).toBeDefined();
    expect(borrowed?.every((byte) => byte === 0)).toBe(true);
  });

  it("supports explicit disposal without exposing or reusing credential bytes", async () => {
    const fake = createInMemoryCredentialStore({ bytes: encoded() });
    const output = await prepareClaudeHeadersHelperPrivateAuthPipe(
      dependencies(fake.adapter),
    );
    output.dispose();
    output.dispose();

    let writes = 0;
    await expectSafeFailure(
      Promise.resolve().then(() =>
        output.writeOnce({
          write() {
            writes += 1;
          },
        }),
      ),
      "private_auth_pipe_consumed",
    );
    expect(writes).toBe(0);
  });

  it.each(["elevated", "unknown"] as const)(
    "refuses %s execution before accessing the credential store",
    async (elevation) => {
      const fake = createInMemoryCredentialStore({ bytes: encoded() });
      await expectSafeFailure(
        prepareClaudeHeadersHelperPrivateAuthPipe(
          dependencies(fake.adapter, {
            platform: platform({ elevation }),
          }),
        ),
        "invalid_execution_context",
      );
      expect(fake.trace.operations()).toEqual([]);
    },
  );

  it.each([
    Object.freeze({}),
    Object.freeze({
      CLAUDE_CODE_MCP_SERVER_NAME: PLURUM_CLAUDE_MCP_SERVER_NAME,
    }),
    Object.freeze({
      CLAUDE_CODE_MCP_SERVER_URL: PLURUM_MCP_ENDPOINT,
    }),
    claudeEnvironment({
      CLAUDE_CODE_MCP_SERVER_NAME: `${PLURUM_CLAUDE_MCP_SERVER_NAME}\n`,
    }),
    claudeEnvironment({
      CLAUDE_CODE_MCP_SERVER_URL: `${PLURUM_MCP_ENDPOINT}?redirect=${API_KEY}`,
    }),
    claudeEnvironment({
      CLAUDE_CODE_MCP_SERVER_NAME: null,
      CLAUDE_CODE_MCP_SERVER_URL: 7,
    }),
  ])(
    "rejects a non-exact Claude server context without reading credentials",
    async (environment) => {
      const fake = createInMemoryCredentialStore({ bytes: encoded() });
      await expectSafeFailure(
        prepareClaudeHeadersHelperPrivateAuthPipe(
          dependencies(fake.adapter, {
            claudeEnvironment: environment,
          }),
        ),
        "invalid_server_context",
      );
      expect(fake.trace.operations()).toEqual([]);
    },
  );

  it("rejects inherited or throwing Claude environment values without reflecting them", async () => {
    const inherited = Object.create({
      CLAUDE_CODE_MCP_SERVER_NAME: PLURUM_CLAUDE_MCP_SERVER_NAME,
      CLAUDE_CODE_MCP_SERVER_URL: PLURUM_MCP_ENDPOINT,
    }) as ClaudeHeadersHelperEnvironment;
    const inheritedFake = createInMemoryCredentialStore({ bytes: encoded() });
    await expectSafeFailure(
      prepareClaudeHeadersHelperPrivateAuthPipe(
        dependencies(inheritedFake.adapter, {
          claudeEnvironment: inherited,
        }),
      ),
      "invalid_server_context",
    );
    expect(inheritedFake.trace.operations()).toEqual([]);

    const throwing = Object.create(null) as Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(throwing, "CLAUDE_CODE_MCP_SERVER_NAME", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error(`environment reflected ${API_KEY}`);
      },
    });
    Object.defineProperty(throwing, "CLAUDE_CODE_MCP_SERVER_URL", {
      enumerable: true,
      value: PLURUM_MCP_ENDPOINT,
    });
    const throwingFake = createInMemoryCredentialStore({ bytes: encoded() });
    await expectSafeFailure(
      prepareClaudeHeadersHelperPrivateAuthPipe(
        dependencies(throwingFake.adapter, {
          claudeEnvironment: throwing,
        }),
      ),
      "invalid_server_context",
    );
    expect(throwingFake.trace.operations()).toEqual([]);
    expect(getterCalls).toBe(0);
  });

  it("fails closed on an invalid synthetic credential location", async () => {
    const fake = createInMemoryCredentialStore({ bytes: encoded() });
    await expectSafeFailure(
      prepareClaudeHeadersHelperPrivateAuthPipe(
        dependencies(fake.adapter, {
          platform: platform({
            environment: Object.freeze({
              PLURUM_HOME: `/isolated/${API_KEY}/../plurum`,
              PLURUM_TEST_ROOT: "/isolated",
              PLURUM_TEST_RUN_ID: "headers-helper-02",
            }),
          }),
        }),
      ),
      "credential_location_unavailable",
    );
    expect(fake.trace.operations()).toEqual([]);
  });

  it.each([
    createInMemoryCredentialStore({ directoryMissing: true }),
    createInMemoryCredentialStore({ credentialMissing: true }),
    createInMemoryCredentialStore({
      bytes: encoded(),
      directoryAttestations: [
        secureDirectoryAttestation({ access: "broader" }),
      ],
    }),
    createInMemoryCredentialStore({
      bytes: encoded(),
      failAt: ["read-file"],
      failureMessage: `adapter reflected ${API_KEY}`,
    }),
  ])(
    "maps missing, unsafe, and failed credential reads to one fixed safe error",
    async (fake) => {
      const error = await expectSafeFailure(
        prepareClaudeHeadersHelperPrivateAuthPipe(
          dependencies(fake.adapter),
        ),
        "credential_unavailable",
      );
      expect(error.message).toBe(
        "The protected Plurum credential could not be loaded safely.",
      );
    },
  );

  it("refuses a pending credential after a complete secure read", async () => {
    const fake = createInMemoryCredentialStore({
      bytes: encoded(pendingCredentialText()),
    });
    await expectSafeFailure(
      prepareClaudeHeadersHelperPrivateAuthPipe(
        dependencies(fake.adapter),
      ),
      "credential_inactive",
    );
    expect(fake.trace.operations()).toContain("close-directory");
  });

  it("refuses a valid credential bound to any non-production HTTPS origin", async () => {
    const fake = createInMemoryCredentialStore({
      bytes: encoded(
        activeCredentialText({
          api_origin: "https://api.example.invalid",
        }),
      ),
    });
    await expectSafeFailure(
      prepareClaudeHeadersHelperPrivateAuthPipe(
        dependencies(fake.adapter),
      ),
      "credential_origin_mismatch",
    );
    expect(fake.trace.operations()).toContain("close-directory");
  });
});
