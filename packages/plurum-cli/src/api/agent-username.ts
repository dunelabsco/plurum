import {
  type ApiOrigin,
  type ApiOriginPolicy,
  normalizeApiOrigin,
} from "../credentials/origin.js";
import {
  type Username,
  containsApiKeyToken,
} from "../credentials/schema.js";
import { parseStrictJsonObject } from "../data/strict-json-object.js";
import {
  copyUint8Array,
  intrinsicUint8ArrayByteLength,
  wipeUint8Array,
} from "../data/uint8-array.js";
import type { ReadOnlyNetworkAdapter } from "../system/contracts.js";

export type AgentUsernameAvailabilityResult =
  | Readonly<{ readonly status: "available" }>
  | Readonly<{
      readonly status: "unavailable";
      readonly suggestions: readonly Username[];
    }>
  | Readonly<{
      readonly status: "indeterminate";
      readonly reason: "username_check_unavailable";
    }>;

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 8_192;
const MAX_SUGGESTIONS = 5;
const USERNAME = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u;
const JSON_CONTENT_TYPE =
  /^application\/json(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?\s*$/iu;

const AVAILABLE = Object.freeze({ status: "available" as const });
const INDETERMINATE = Object.freeze({
  status: "indeterminate" as const,
  reason: "username_check_unavailable" as const,
});

function isUsername(value: unknown): value is Username {
  return (
    typeof value === "string" &&
    value.length >= 3 &&
    value.length <= 50 &&
    USERNAME.test(value) &&
    !containsApiKeyToken(value)
  );
}

function hasJsonContentType(
  headers: Readonly<Record<string, string>>,
): boolean {
  let contentType: string | undefined;
  try {
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() !== "content-type") {
        continue;
      }
      if (contentType !== undefined || typeof value !== "string") {
        return false;
      }
      contentType = value;
    }
  } catch {
    return false;
  }
  return contentType !== undefined && JSON_CONTENT_TYPE.test(contentType);
}

function unavailableResult(
  values: unknown,
): AgentUsernameAvailabilityResult {
  if (!Array.isArray(values) || values.length > MAX_SUGGESTIONS) {
    return INDETERMINATE;
  }
  const suggestions: Username[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!isUsername(value) || seen.has(value)) {
      return INDETERMINATE;
    }
    seen.add(value);
    suggestions.push(value);
  }
  return Object.freeze({
    status: "unavailable" as const,
    suggestions: Object.freeze(suggestions),
  });
}

function parseResult(
  body: Uint8Array,
): AgentUsernameAvailabilityResult {
  let copied: Uint8Array | undefined;
  try {
    const length = intrinsicUint8ArrayByteLength(body);
    if (length === undefined || length > MAX_RESPONSE_BYTES) {
      return INDETERMINATE;
    }
    copied = copyUint8Array(body, length);
    if (copied === undefined) {
      return INDETERMINATE;
    }
    const parsed = parseStrictJsonObject(
      new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(copied),
    );
    const keys = Object.keys(parsed);
    if (
      keys.length !== 2 ||
      !keys.includes("available") ||
      !keys.includes("suggestions") ||
      typeof parsed.available !== "boolean"
    ) {
      return INDETERMINATE;
    }
    if (parsed.available) {
      return Array.isArray(parsed.suggestions) &&
        parsed.suggestions.length === 0
        ? AVAILABLE
        : INDETERMINATE;
    }
    return unavailableResult(parsed.suggestions);
  } catch {
    return INDETERMINATE;
  } finally {
    wipeUint8Array(copied);
  }
}

/*
 * This check is advisory only. Registration's transactional POST remains the
 * authority because availability can change immediately after this response.
 */
export async function checkAgentUsernameAvailability(
  network: ReadOnlyNetworkAdapter,
  apiOrigin: ApiOrigin,
  username: Username,
  originPolicy: ApiOriginPolicy = "https-only",
): Promise<AgentUsernameAvailabilityResult> {
  let origin: ApiOrigin;
  try {
    if (
      (originPolicy !== "https-only" &&
        originPolicy !== "explicit-loopback-development") ||
      !isUsername(username)
    ) {
      return INDETERMINATE;
    }
    origin = normalizeApiOrigin(apiOrigin, originPolicy);
    if (origin !== apiOrigin) {
      return INDETERMINATE;
    }
  } catch {
    return INDETERMINATE;
  }

  let response;
  try {
    response = await network.request(
      Object.freeze({
        url: `${origin}/api/v1/agents/check-username?username=${username}`,
        method: "GET" as const,
        headers: Object.freeze({ Accept: "application/json" }),
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        redirect: "error" as const,
      }),
    );
  } catch {
    return INDETERMINATE;
  }

  let responseBody: Uint8Array | undefined;
  try {
    if (
      response.status !== 200 ||
      !hasJsonContentType(response.headers)
    ) {
      return INDETERMINATE;
    }
    responseBody = response.body;
    return parseResult(responseBody);
  } catch {
    return INDETERMINATE;
  } finally {
    wipeUint8Array(responseBody);
  }
}
