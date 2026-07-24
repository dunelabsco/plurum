import { DEFAULT_API_ORIGIN } from "../../credentials/origin.js";
import { resolveCredentialLocations } from "../../credentials/paths.js";
import { readCredentialStore } from "../../credentials/store.js";
import type { CredentialStoreReadAdapter } from "../../credentials/store-contracts.js";
import type {
  PlatformAdapter,
  RuntimeEnvironment,
} from "../../system/contracts.js";

export const PLURUM_CLAUDE_MCP_SERVER_NAME =
  "plugin:plurum:plurum" as const;
export const PLURUM_MCP_ENDPOINT = "https://mcp.plurum.ai/mcp" as const;

const AUTHORIZATION_PREFIX = new TextEncoder().encode(
  '{"Authorization":"Bearer ',
);
const AUTHORIZATION_SUFFIX = new TextEncoder().encode('"}');

/*
 * Credential validation currently permits at most 210 ASCII API-key bytes.
 * Keep an independent hard ceiling here so a future schema expansion cannot
 * silently widen the helper's private stdout contract.
 */
export const MAX_CLAUDE_HEADERS_HELPER_OUTPUT_BYTES = 237 as const;

export type ClaudeHeadersHelperErrorCode =
  | "invalid_execution_context"
  | "invalid_server_context"
  | "credential_location_unavailable"
  | "credential_unavailable"
  | "credential_inactive"
  | "credential_origin_mismatch"
  | "private_auth_pipe_output_invalid"
  | "private_auth_pipe_consumed"
  | "private_auth_pipe_write_failed";

const SAFE_MESSAGES: Readonly<Record<ClaudeHeadersHelperErrorCode, string>> =
  Object.freeze({
    invalid_execution_context:
      "The Plurum credential helper requires a standard user session.",
    invalid_server_context:
      "Claude Code did not provide the expected Plurum MCP server context.",
    credential_location_unavailable:
      "The protected Plurum credential location is unavailable.",
    credential_unavailable:
      "The protected Plurum credential could not be loaded safely.",
    credential_inactive:
      "Plurum setup is not complete for this credential.",
    credential_origin_mismatch:
      "The protected Plurum credential is not bound to the production service.",
    private_auth_pipe_output_invalid:
      "The private Claude Code authentication payload could not be prepared safely.",
    private_auth_pipe_consumed:
      "The private Claude Code authentication payload is no longer available.",
    private_auth_pipe_write_failed:
      "The private Claude Code authentication payload could not be written safely.",
  });

export class ClaudeHeadersHelperError extends Error {
  readonly code: ClaudeHeadersHelperErrorCode;

  constructor(code: ClaudeHeadersHelperErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "ClaudeHeadersHelperError";
    this.code = code;
  }
}

export interface ClaudeHeadersHelperEnvironment {
  readonly CLAUDE_CODE_MCP_SERVER_NAME?: unknown;
  readonly CLAUDE_CODE_MCP_SERVER_URL?: unknown;
}

export type ClaudeHeadersHelperPlatform = Pick<
  PlatformAdapter,
  "os" | "elevation" | "environment" | "paths"
>;

/*
 * Identity comparison makes isolated path overrides an explicit capability,
 * not a string value that production configuration can accidentally select.
 */
export const CLAUDE_HEADERS_HELPER_PRODUCTION_LOCATION_MODE = Object.freeze({
  kind: "production-standard" as const,
});
export const CLAUDE_HEADERS_HELPER_ISOLATED_TEST_LOCATION_MODE = Object.freeze({
  kind: "isolated-test" as const,
});

export type ClaudeHeadersHelperLocationMode =
  | typeof CLAUDE_HEADERS_HELPER_PRODUCTION_LOCATION_MODE
  | typeof CLAUDE_HEADERS_HELPER_ISOLATED_TEST_LOCATION_MODE;

export interface ClaudeHeadersHelperDependencies {
  readonly credentialStore: CredentialStoreReadAdapter;
  readonly platform: ClaudeHeadersHelperPlatform;
  readonly claudeEnvironment: ClaudeHeadersHelperEnvironment;
  readonly credentialLocationMode?: ClaudeHeadersHelperLocationMode;
}

/*
 * This is a private authentication pipe, not a diagnostic or ProcessResult.
 * The future launcher must connect it only to Claude's headersHelper stdout.
 */
export interface ClaudeHeadersHelperPrivateAuthPipeSink {
  /*
   * Production must bind this to one bounded synchronous native all-write on
   * the inherited private stdout handle. Async/user callbacks are forbidden
   * because they can retain credential bytes after helper disposal.
   */
  write(bytes: Uint8Array): void;
}

export interface ClaudeHeadersHelperPrivateAuthPipe {
  readonly kind: "claude-code-headers-helper-private-auth-pipe";
  readonly byteLength: number;
  writeOnce(sink: ClaudeHeadersHelperPrivateAuthPipeSink): void;
  dispose(): void;
}

function fail(code: ClaudeHeadersHelperErrorCode): never {
  throw new ClaudeHeadersHelperError(code);
}

function wipeBytes(bytes: Uint8Array): void {
  try {
    Uint8Array.prototype.fill.call(bytes, 0);
  } catch {
    // Best effort only; disposal must remain secret-free and non-throwing.
  }
}

function ownDataProperty(
  object: unknown,
  key: string,
  code: ClaudeHeadersHelperErrorCode,
  required: boolean,
): unknown {
  if (object === null || typeof object !== "object") {
    return fail(code);
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, key);
  } catch {
    return fail(code);
  }
  if (descriptor === undefined) {
    return required ? fail(code) : undefined;
  }
  if (
    !Object.hasOwn(descriptor, "value") ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined
  ) {
    return fail(code);
  }
  return descriptor.value;
}

function validateInvocationContext(
  dependencies: ClaudeHeadersHelperDependencies,
): void {
  const platform = ownDataProperty(
    dependencies,
    "platform",
    "invalid_execution_context",
    true,
  );
  const elevation = ownDataProperty(
    platform,
    "elevation",
    "invalid_execution_context",
    true,
  );
  if (elevation !== "standard") {
    return fail("invalid_execution_context");
  }

  const environment = ownDataProperty(
    dependencies,
    "claudeEnvironment",
    "invalid_server_context",
    true,
  );
  const serverName = ownDataProperty(
    environment,
    "CLAUDE_CODE_MCP_SERVER_NAME",
    "invalid_server_context",
    true,
  );
  const serverUrl = ownDataProperty(
    environment,
    "CLAUDE_CODE_MCP_SERVER_URL",
    "invalid_server_context",
    true,
  );
  if (
    serverName !== PLURUM_CLAUDE_MCP_SERVER_NAME ||
    serverUrl !== PLURUM_MCP_ENDPOINT
  ) {
    return fail("invalid_server_context");
  }
}

function ownEnvironmentString(
  environment: RuntimeEnvironment,
  key: "HOME" | "XDG_CONFIG_HOME" | "APPDATA",
  required: true,
): string;
function ownEnvironmentString(
  environment: RuntimeEnvironment,
  key: "HOME" | "XDG_CONFIG_HOME" | "APPDATA",
  required: false,
): string | undefined;
function ownEnvironmentString(
  environment: RuntimeEnvironment,
  key: "HOME" | "XDG_CONFIG_HOME" | "APPDATA",
  required: boolean,
): string | undefined {
  const value = ownDataProperty(
    environment,
    key,
    "credential_location_unavailable",
    required,
  );
  if (typeof value !== "string") {
    if (value === undefined && !required) {
      return undefined;
    }
    return fail("credential_location_unavailable");
  }
  return value;
}

function productionLocationPlatform(
  dependencies: ClaudeHeadersHelperDependencies,
): Pick<ClaudeHeadersHelperPlatform, "os" | "environment" | "paths"> {
  const platform = ownDataProperty(
    dependencies,
    "platform",
    "credential_location_unavailable",
    true,
  );
  const os = ownDataProperty(
    platform,
    "os",
    "credential_location_unavailable",
    true,
  ) as ClaudeHeadersHelperPlatform["os"];
  const environment = ownDataProperty(
    platform,
    "environment",
    "credential_location_unavailable",
    true,
  ) as RuntimeEnvironment;
  const paths = ownDataProperty(
    platform,
    "paths",
    "credential_location_unavailable",
    true,
  ) as ClaudeHeadersHelperPlatform["paths"];

  let standardEnvironment: RuntimeEnvironment;
  if (os === "darwin") {
    standardEnvironment = Object.freeze({
      HOME: ownEnvironmentString(environment, "HOME", true),
    });
  } else if (os === "linux") {
    const xdgConfigHome = ownEnvironmentString(
      environment,
      "XDG_CONFIG_HOME",
      false,
    );
    if (xdgConfigHome === undefined || xdgConfigHome === "") {
      standardEnvironment = Object.freeze({
        HOME: ownEnvironmentString(environment, "HOME", true),
      });
    } else {
      standardEnvironment = Object.freeze({
        XDG_CONFIG_HOME: xdgConfigHome,
      });
    }
  } else if (os === "win32") {
    standardEnvironment = Object.freeze({
      APPDATA: ownEnvironmentString(environment, "APPDATA", true),
    });
  } else {
    return fail("credential_location_unavailable");
  }

  return Object.freeze({
    os,
    environment: standardEnvironment,
    paths,
  });
}

function credentialLocationPlatform(
  dependencies: ClaudeHeadersHelperDependencies,
): Pick<ClaudeHeadersHelperPlatform, "os" | "environment" | "paths"> {
  const mode = ownDataProperty(
    dependencies,
    "credentialLocationMode",
    "credential_location_unavailable",
    false,
  ) as ClaudeHeadersHelperLocationMode | undefined;

  if (mode === CLAUDE_HEADERS_HELPER_ISOLATED_TEST_LOCATION_MODE) {
    return ownDataProperty(
      dependencies,
      "platform",
      "credential_location_unavailable",
      true,
    ) as ClaudeHeadersHelperPlatform;
  }
  if (
    mode !== undefined &&
    mode !== CLAUDE_HEADERS_HELPER_PRODUCTION_LOCATION_MODE
  ) {
    return fail("credential_location_unavailable");
  }
  return productionLocationPlatform(dependencies);
}

function encodeAuthorization(apiKey: string): Uint8Array {
  const byteLength =
    AUTHORIZATION_PREFIX.byteLength +
    apiKey.length +
    AUTHORIZATION_SUFFIX.byteLength;
  if (
    byteLength > MAX_CLAUDE_HEADERS_HELPER_OUTPUT_BYTES ||
    apiKey.length === 0
  ) {
    return fail("private_auth_pipe_output_invalid");
  }

  const output = new Uint8Array(byteLength);
  output.set(AUTHORIZATION_PREFIX, 0);
  let offset = AUTHORIZATION_PREFIX.byteLength;
  for (let index = 0; index < apiKey.length; index += 1) {
    const byte = apiKey.charCodeAt(index);
    if (byte > 0x7f) {
      wipeBytes(output);
      return fail("private_auth_pipe_output_invalid");
    }
    output[offset] = byte;
    offset += 1;
  }
  output.set(AUTHORIZATION_SUFFIX, offset);
  return output;
}

function privateAuthPipe(
  ownedBytes: Uint8Array,
): ClaudeHeadersHelperPrivateAuthPipe {
  let available: Uint8Array | undefined = ownedBytes;
  const byteLength = ownedBytes.byteLength;

  return Object.freeze({
    kind: "claude-code-headers-helper-private-auth-pipe" as const,
    byteLength,
    writeOnce(
      sink: ClaudeHeadersHelperPrivateAuthPipeSink,
    ): void {
      const bytes = available;
      if (bytes === undefined) {
        return fail("private_auth_pipe_consumed");
      }
      available = undefined;
      try {
        const write = ownDataProperty(
          sink,
          "write",
          "private_auth_pipe_write_failed",
          true,
        );
        if (
          typeof write !== "function" ||
          (write as (value: Uint8Array) => unknown)(bytes) !== undefined
        ) {
          return fail("private_auth_pipe_write_failed");
        }
      } catch {
        return fail("private_auth_pipe_write_failed");
      } finally {
        wipeBytes(bytes);
      }
    },
    dispose(): void {
      const bytes = available;
      available = undefined;
      if (bytes !== undefined) {
        wipeBytes(bytes);
      }
    },
  });
}

export async function prepareClaudeHeadersHelperPrivateAuthPipe(
  dependencies: ClaudeHeadersHelperDependencies,
): Promise<ClaudeHeadersHelperPrivateAuthPipe> {
  validateInvocationContext(dependencies);

  let locations;
  try {
    locations = resolveCredentialLocations(
      credentialLocationPlatform(dependencies),
    );
  } catch {
    return fail("credential_location_unavailable");
  }

  let result;
  try {
    const credentialStore = ownDataProperty(
      dependencies,
      "credentialStore",
      "credential_unavailable",
      true,
    ) as CredentialStoreReadAdapter;
    result = await readCredentialStore(
      credentialStore,
      locations,
      "https-only",
    );
  } catch {
    return fail("credential_unavailable");
  }

  if (result.status !== "loaded") {
    return fail("credential_unavailable");
  }
  if (result.credential.state !== "active") {
    return fail("credential_inactive");
  }
  if (result.credential.api_origin !== DEFAULT_API_ORIGIN) {
    return fail("credential_origin_mismatch");
  }

  return privateAuthPipe(encodeAuthorization(result.credential.api_key));
}
