import type { ReadOnlyNetworkAdapter } from "../system/contracts.js";
import {
  type ApiOrigin,
  type ApiOriginPolicy,
  normalizeApiOrigin,
} from "../credentials/origin.js";
import {
  type ApiKey,
  containsApiKeyToken,
  parseApiKey,
} from "../credentials/schema.js";
import { parseStrictJsonObject } from "../data/strict-json-object.js";
import {
  copyUint8Array,
  intrinsicUint8ArrayByteLength,
} from "../data/uint8-array.js";

export interface ValidatedAgentIdentity {
  readonly id: string;
  readonly name: string;
  readonly username: string | null;
}

export type AgentCredentialValidationResult =
  | Readonly<{
      status: "valid";
      agent: ValidatedAgentIdentity;
    }>
  | Readonly<{
      status: "invalid";
    }>
  | Readonly<{
      status: "indeterminate";
      reason: "credential_validation_unavailable";
    }>;

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 16_384;
const AGENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const USERNAME = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u;
const NAME_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const NAME_DISPLAY_CONTROL = /[\u061c\u200e\u200f\u2028-\u202e\u2066-\u206f]/u;
const JSON_CONTENT_TYPE =
  /^application\/json(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?\s*$/iu;

const INVALID = Object.freeze({ status: "invalid" as const });
const INDETERMINATE = Object.freeze({
  status: "indeterminate" as const,
  reason: "credential_validation_unavailable" as const,
});

function isSafeAgentName(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 510 ||
    NAME_CONTROL.test(value) ||
    NAME_DISPLAY_CONTROL.test(value)
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

function isUsername(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 3 &&
    value.length <= 50 &&
    USERNAME.test(value)
  );
}

function reflectsCredential(value: string, apiKey: ApiKey): boolean {
  return containsApiKeyToken(value, apiKey);
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

function parseAgentIdentity(
  body: Uint8Array,
  apiKey: ApiKey,
): ValidatedAgentIdentity | undefined {
  const bodyLength = intrinsicUint8ArrayByteLength(body);
  if (
    bodyLength === undefined ||
    bodyLength > MAX_RESPONSE_BYTES
  ) {
    return undefined;
  }

  let copiedBody: Uint8Array | undefined;
  try {
    copiedBody = copyUint8Array(body, bodyLength);
    if (copiedBody === undefined) {
      return undefined;
    }
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(copiedBody);
    const parsed = parseStrictJsonObject(text);
    const id = parsed.id;
    const name = parsed.name;
    const username = parsed.username;
    if (
      typeof id !== "string" ||
      !AGENT_ID.test(id) ||
      !isSafeAgentName(name) ||
      (username !== null && !isUsername(username)) ||
      reflectsCredential(name, apiKey) ||
      (username !== null && reflectsCredential(username, apiKey)) ||
      parsed.is_active !== true
    ) {
      return undefined;
    }
    return Object.freeze({ id, name, username });
  } catch {
    return undefined;
  } finally {
    copiedBody?.fill(0);
  }
}

export async function validateAgentCredential(
  network: ReadOnlyNetworkAdapter,
  apiOrigin: ApiOrigin,
  apiKey: ApiKey,
  originPolicy: ApiOriginPolicy = "https-only",
): Promise<AgentCredentialValidationResult> {
  let normalizedOrigin: ApiOrigin;
  try {
    if (
      originPolicy !== "https-only" &&
      originPolicy !== "explicit-loopback-development"
    ) {
      return INDETERMINATE;
    }
    normalizedOrigin = normalizeApiOrigin(apiOrigin, originPolicy);
    if (
      normalizedOrigin !== apiOrigin ||
      parseApiKey(apiKey) !== apiKey ||
      containsApiKeyToken(normalizedOrigin, apiKey)
    ) {
      return INDETERMINATE;
    }
  } catch {
    return INDETERMINATE;
  }

  let response;
  try {
    response = await network.request(
      Object.freeze({
        url: `${normalizedOrigin}/api/v1/agents/me`,
        method: "GET" as const,
        headers: Object.freeze({
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
        }),
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        redirect: "error" as const,
      }),
    );
  } catch {
    return INDETERMINATE;
  }

  try {
    const status = response.status;
    if (
      !Number.isInteger(status) ||
      status < 100 ||
      status > 599
    ) {
      return INDETERMINATE;
    }
    if (status === 401 || status === 403) {
      return INVALID;
    }
    if (status !== 200) {
      return INDETERMINATE;
    }
    if (!hasJsonContentType(response.headers)) {
      return INDETERMINATE;
    }
    const agent = parseAgentIdentity(response.body, apiKey);
    return agent === undefined
      ? INDETERMINATE
      : Object.freeze({ status: "valid" as const, agent });
  } catch {
    return INDETERMINATE;
  }
}
