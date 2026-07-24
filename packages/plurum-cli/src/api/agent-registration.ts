import type {
  ApiOrigin,
  ApiOriginPolicy,
} from "../credentials/origin.js";
import { normalizeApiOrigin } from "../credentials/origin.js";
import {
  type AgentId,
  type AgentName,
  type RegistrationRequestId,
  type Username,
  containsApiKeyToken,
} from "../credentials/schema.js";
import { parseStrictJsonObject } from "../data/strict-json-object.js";
import {
  copyUint8Array,
  intrinsicUint8ArrayByteLength,
} from "../data/uint8-array.js";
import type {
  NetworkAdapter,
  NetworkResponse,
} from "../system/contracts.js";
import type {
  RegistrationApiKeyHash,
  RegistrationApiKeyPrefix,
} from "../registration/key-material.js";

export interface CliAgentRegistrationInput {
  readonly apiOrigin: ApiOrigin;
  readonly agentName: AgentName;
  readonly username: Username;
  readonly registrationRequestId: RegistrationRequestId;
  readonly apiKeyHash: RegistrationApiKeyHash;
  readonly apiKeyPrefix: RegistrationApiKeyPrefix;
}

export type CliAgentRegistrationConflict =
  | "idempotency_conflict"
  | "username_unavailable"
  | "credential_conflict";

export type CliAgentRegistrationResult =
  | Readonly<{
      status: "success";
      agentId: AgentId;
      disposition: "created" | "replayed";
    }>
  | Readonly<{
      status: "conflict";
      reason: CliAgentRegistrationConflict;
    }>
  | Readonly<{
      status: "retryable";
      reason: "rate_limit" | "registration_unavailable";
    }>;

export class AgentRegistrationRequestError extends Error {
  readonly code = "invalid_agent_registration_request";

  constructor() {
    super("The Plurum agent registration request is invalid.");
    this.name = "AgentRegistrationRequestError";
  }
}

const INPUT_FIELDS = Object.freeze([
  "apiOrigin",
  "agentName",
  "username",
  "registrationRequestId",
  "apiKeyHash",
  "apiKeyPrefix",
] as const);
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 16_384;
const AGENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REGISTRATION_REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const USERNAME = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u;
const API_KEY_HASH = /^[0-9a-f]{64}$/u;
const API_KEY_PREFIX = /^plrm_live_[A-Za-z0-9_-]{6}\.\.\.$/u;
const NAME_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const NAME_DISPLAY_CONTROL = /[\u061c\u200e\u200f\u2028-\u202e\u2066-\u206f]/u;
const JSON_CONTENT_TYPE =
  /^application\/json(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?\s*$/iu;
const fillBytes = Uint8Array.prototype.fill;

const RATE_LIMIT = Object.freeze({
  status: "retryable" as const,
  reason: "rate_limit" as const,
});
const UNAVAILABLE = Object.freeze({
  status: "retryable" as const,
  reason: "registration_unavailable" as const,
});

interface RegistrationSnapshot {
  readonly apiOrigin: ApiOrigin;
  readonly agentName: AgentName;
  readonly username: Username;
  readonly registrationRequestId: RegistrationRequestId;
  readonly apiKeyHash: RegistrationApiKeyHash;
  readonly apiKeyPrefix: RegistrationApiKeyPrefix;
}

function invalidRequest(): never {
  throw new AgentRegistrationRequestError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

function wipe(bytes: unknown): void {
  try {
    if (bytes instanceof Uint8Array) {
      fillBytes.call(bytes, 0);
    }
  } catch {
    // A detached or hostile buffer no longer exposes safely writable bytes.
  }
}

function isSafeAgentName(value: unknown): value is AgentName {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 510 ||
    NAME_CONTROL.test(value) ||
    NAME_DISPLAY_CONTROL.test(value) ||
    containsApiKeyToken(value)
  ) {
    return false;
  }

  let codePoints = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      (codePoints += 1) > 255
    ) {
      return false;
    }
  }
  return true;
}

function isUsername(value: unknown): value is Username {
  return (
    typeof value === "string" &&
    value.length >= 3 &&
    value.length <= 50 &&
    USERNAME.test(value) &&
    !containsApiKeyToken(value)
  );
}

function snapshotInput(
  input: CliAgentRegistrationInput,
  originPolicy: ApiOriginPolicy,
): RegistrationSnapshot {
  try {
    if (
      !isRecord(input) ||
      !hasExactKeys(input, INPUT_FIELDS) ||
      (originPolicy !== "https-only" &&
        originPolicy !== "explicit-loopback-development")
    ) {
      return invalidRequest();
    }

    const apiOrigin = input.apiOrigin;
    const agentName = input.agentName;
    const username = input.username;
    const registrationRequestId = input.registrationRequestId;
    const apiKeyHash = input.apiKeyHash;
    const apiKeyPrefix = input.apiKeyPrefix;
    const normalizedOrigin = normalizeApiOrigin(apiOrigin, originPolicy);
    if (
      normalizedOrigin !== apiOrigin ||
      !isSafeAgentName(agentName) ||
      !isUsername(username) ||
      typeof registrationRequestId !== "string" ||
      !REGISTRATION_REQUEST_ID.test(registrationRequestId) ||
      typeof apiKeyHash !== "string" ||
      !API_KEY_HASH.test(apiKeyHash) ||
      typeof apiKeyPrefix !== "string" ||
      !API_KEY_PREFIX.test(apiKeyPrefix)
    ) {
      return invalidRequest();
    }

    return Object.freeze({
      apiOrigin: normalizedOrigin,
      agentName,
      username,
      registrationRequestId,
      apiKeyHash,
      apiKeyPrefix,
    });
  } catch {
    return invalidRequest();
  }
}

function hasJsonContentType(
  headers: Readonly<Record<string, string>>,
): boolean {
  let contentType: string | undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "content-type") {
      continue;
    }
    if (contentType !== undefined || typeof value !== "string") {
      return false;
    }
    contentType = value;
  }
  return contentType !== undefined && JSON_CONTENT_TYPE.test(contentType);
}

function parseResponseObject(
  body: Uint8Array,
): Readonly<Record<string, unknown>> | undefined {
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(body);
    return parseStrictJsonObject(text);
  } catch {
    return undefined;
  }
}

function parseSuccess(
  body: Uint8Array,
): Extract<CliAgentRegistrationResult, { status: "success" }> | undefined {
  const parsed = parseResponseObject(body);
  if (
    parsed === undefined ||
    !hasExactKeys(parsed, ["agent_id", "disposition"]) ||
    typeof parsed.agent_id !== "string" ||
    !AGENT_ID.test(parsed.agent_id) ||
    (parsed.disposition !== "created" && parsed.disposition !== "replayed")
  ) {
    return undefined;
  }
  return Object.freeze({
    status: "success",
    agentId: parsed.agent_id as AgentId,
    disposition: parsed.disposition,
  });
}

function parseConflict(
  body: Uint8Array,
): Extract<CliAgentRegistrationResult, { status: "conflict" }> | undefined {
  const parsed = parseResponseObject(body);
  if (
    parsed === undefined ||
    !hasExactKeys(parsed, ["error"]) ||
    (parsed.error !== "idempotency_conflict" &&
      parsed.error !== "username_unavailable" &&
      parsed.error !== "credential_conflict")
  ) {
    return undefined;
  }
  return Object.freeze({
    status: "conflict",
    reason: parsed.error,
  });
}

function copyResponseBody(response: NetworkResponse): {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
} | undefined {
  let adapterBody: unknown;
  try {
    const status = response.status;
    const headers = response.headers;
    adapterBody = response.body;
    const length = intrinsicUint8ArrayByteLength(adapterBody);
    if (
      !Number.isInteger(status) ||
      status < 100 ||
      status > 599 ||
      !isRecord(headers) ||
      length === undefined ||
      length > MAX_RESPONSE_BYTES
    ) {
      return undefined;
    }
    const body = copyUint8Array(adapterBody, length);
    if (body === undefined) {
      return undefined;
    }
    return { status, headers, body };
  } catch {
    return undefined;
  } finally {
    wipe(adapterBody);
  }
}

export async function registerCliAgent(
  network: NetworkAdapter,
  input: CliAgentRegistrationInput,
  originPolicy: ApiOriginPolicy = "https-only",
): Promise<CliAgentRegistrationResult> {
  const snapshot = snapshotInput(input, originPolicy);
  const wireBody = Object.freeze({
    protocol_version: 1 as const,
    name: snapshot.agentName,
    username: snapshot.username,
    registration_request_id: snapshot.registrationRequestId,
    api_key_hash: snapshot.apiKeyHash,
    api_key_prefix: snapshot.apiKeyPrefix,
  });

  let requestBody: Uint8Array | undefined;
  let response: NetworkResponse;
  try {
    requestBody = new TextEncoder().encode(JSON.stringify(wireBody));
    response = await network.request(
      Object.freeze({
        url: `${snapshot.apiOrigin}/api/v1/agents/register/cli`,
        method: "POST" as const,
        headers: Object.freeze({
          Accept: "application/json",
          "Content-Type": "application/json",
        }),
        body: requestBody,
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        redirect: "error" as const,
      }),
    );
  } catch {
    return UNAVAILABLE;
  } finally {
    wipe(requestBody);
  }

  const copiedResponse = copyResponseBody(response);
  if (copiedResponse === undefined) {
    return UNAVAILABLE;
  }

  try {
    if (copiedResponse.status === 429) {
      return RATE_LIMIT;
    }
    if (
      copiedResponse.status !== 200 &&
      copiedResponse.status !== 409
    ) {
      return UNAVAILABLE;
    }
    if (!hasJsonContentType(copiedResponse.headers)) {
      return UNAVAILABLE;
    }
    if (copiedResponse.status === 200) {
      return parseSuccess(copiedResponse.body) ?? UNAVAILABLE;
    }
    return parseConflict(copiedResponse.body) ?? UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  } finally {
    wipe(copiedResponse.body);
  }
}
