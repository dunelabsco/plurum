import {
  type ApiOrigin,
  type ApiOriginPolicy,
  normalizeApiOrigin,
} from "../credentials/origin.js";
import { parseStrictJsonObject } from "../data/strict-json-object.js";
import {
  copyUint8Array,
  intrinsicUint8ArrayByteLength,
} from "../data/uint8-array.js";
import type {
  ReadOnlyNetworkAdapter,
  ReadOnlyNetworkRequest,
} from "../system/contracts.js";

export type ApiReachabilityResult =
  | Readonly<{
      readonly reachability: "reachable";
      readonly health: "healthy" | "unhealthy";
    }>
  | Readonly<{
      readonly reachability: "unavailable";
      readonly health: "unknown";
    }>;

export const PLURUM_MCP_ENDPOINT = "https://mcp.plurum.ai/mcp" as const;

export type McpAuthenticationBoundaryResult =
  | Readonly<{
      readonly reachability: "reachable";
      readonly health: "healthy" | "unhealthy";
    }>
  | Readonly<{
      readonly reachability: "unavailable";
      readonly health: "unknown";
    }>;

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 4_096;
const MAX_HEADER_COUNT = 128;
const MAX_HEADER_NAME_CHARACTERS = 256;
const MAX_HEADER_VALUE_CHARACTERS = 8_192;
const HEALTH_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const JSON_CONTENT_TYPE =
  /^application\/json(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?\s*$/iu;

const HEALTHY = Object.freeze({
  reachability: "reachable" as const,
  health: "healthy" as const,
});
const UNHEALTHY = Object.freeze({
  reachability: "reachable" as const,
  health: "unhealthy" as const,
});
const UNAVAILABLE = Object.freeze({
  reachability: "unavailable" as const,
  health: "unknown" as const,
});
const MCP_AUTHENTICATION_HEALTHY = Object.freeze({
  reachability: "reachable" as const,
  health: "healthy" as const,
});
const MCP_AUTHENTICATION_UNHEALTHY = Object.freeze({
  reachability: "reachable" as const,
  health: "unhealthy" as const,
});
const MCP_AUTHENTICATION_UNAVAILABLE = Object.freeze({
  reachability: "unavailable" as const,
  health: "unknown" as const,
});
const MCP_AUTHENTICATION_CHALLENGE = 'Bearer realm="plurum"';

interface ResponseSnapshot {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

function ownDataValues(
  value: unknown,
  expectedNames: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null)
    ) {
      return undefined;
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedNames.length ||
      keys.some(
        (key) => typeof key !== "string" || !expectedNames.includes(key),
      ) ||
      expectedNames.some((name) => !keys.includes(name))
    ) {
      return undefined;
    }
    const copied: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const name of expectedNames) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        return undefined;
      }
      copied[name] = descriptor.value;
    }
    return Object.freeze(copied);
  } catch {
    return undefined;
  }
}

function snapshotHeaders(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null)
    ) {
      return undefined;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_HEADER_COUNT || keys.some((key) => typeof key !== "string")) {
      return undefined;
    }
    const copied: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    for (const key of keys) {
      const name = key as string;
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      const headerValue = descriptor?.value;
      if (
        name.length === 0 ||
        name.length > MAX_HEADER_NAME_CHARACTERS ||
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        typeof headerValue !== "string" ||
        headerValue.length > MAX_HEADER_VALUE_CHARACTERS
      ) {
        return undefined;
      }
      copied[name] = headerValue;
    }
    return Object.freeze(copied);
  } catch {
    return undefined;
  }
}

function snapshotResponse(value: unknown): ResponseSnapshot | undefined {
  const object = ownDataValues(value, ["status", "headers", "body"]);
  if (object === undefined) {
    return undefined;
  }
  const status = object.status;
  const headers = snapshotHeaders(object.headers);
  const bodyLength = intrinsicUint8ArrayByteLength(object.body);
  if (
    !Number.isInteger(status) ||
    (status as number) < 100 ||
    (status as number) > 599 ||
    headers === undefined ||
    bodyLength === undefined ||
    bodyLength > MAX_RESPONSE_BYTES
  ) {
    return undefined;
  }
  const body = copyUint8Array(object.body, bodyLength);
  return body === undefined
    ? undefined
    : Object.freeze({ status: status as number, headers, body });
}

function hasJsonContentType(
  headers: Readonly<Record<string, string>>,
): boolean {
  let contentType: string | undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "content-type") {
      continue;
    }
    if (contentType !== undefined) {
      return false;
    }
    contentType = value;
  }
  return contentType !== undefined && JSON_CONTENT_TYPE.test(contentType);
}

function hasExactMcpAuthenticationChallenge(
  headers: Readonly<Record<string, string>>,
): boolean {
  let challenge: string | undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "www-authenticate") {
      continue;
    }
    if (challenge !== undefined) {
      return false;
    }
    challenge = value;
  }
  return challenge === MCP_AUTHENTICATION_CHALLENGE;
}

function exactHealthyBody(body: Uint8Array): boolean {
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(body);
    const document = parseStrictJsonObject(text);
    const names = Object.getOwnPropertyNames(document);
    if (
      Object.getOwnPropertySymbols(document).length !== 0 ||
      (names.length !== 1 && names.length !== 2) ||
      !names.includes("status") ||
      (names.length === 2 && !names.includes("version"))
    ) {
      return false;
    }
    if (document.status !== "healthy") {
      return false;
    }
    if (names.length === 1) {
      return true;
    }
    const version = document.version;
    return (
      typeof version === "string" &&
      version.length <= 128 &&
      HEALTH_VERSION.test(version)
    );
  } catch {
    return false;
  }
}

function wipe(bytes: Uint8Array): void {
  try {
    Uint8Array.prototype.fill.call(bytes, 0);
  } catch {
    // A detached owned buffer no longer exposes its contents.
  }
}

export async function probeApiReachability(
  network: ReadOnlyNetworkAdapter,
  apiOrigin: ApiOrigin,
  originPolicy: ApiOriginPolicy = "https-only",
): Promise<ApiReachabilityResult> {
  let normalizedOrigin: ApiOrigin;
  try {
    normalizedOrigin = normalizeApiOrigin(apiOrigin, originPolicy);
    if (normalizedOrigin !== apiOrigin) {
      return UNAVAILABLE;
    }
  } catch {
    return UNAVAILABLE;
  }

  const request: ReadOnlyNetworkRequest = Object.freeze({
    url: `${normalizedOrigin}/health`,
    method: "GET" as const,
    headers: Object.freeze({ Accept: "application/json" }),
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    redirect: "error" as const,
  });

  let response: ResponseSnapshot | undefined;
  try {
    response = snapshotResponse(await network.request(request));
  } catch {
    return UNAVAILABLE;
  }
  if (response === undefined) {
    return UNAVAILABLE;
  }

  try {
    return response.status === 200 &&
      hasJsonContentType(response.headers) &&
      exactHealthyBody(response.body)
      ? HEALTHY
      : UNHEALTHY;
  } finally {
    wipe(response.body);
  }
}

/*
 * This deliberately checks only the hosted MCP HTTP authentication edge. It
 * sends no credential and does not initialize an MCP session, list tools, or
 * claim that a configured host has loaded the plugin.
 */
export async function probeMcpAuthenticationBoundary(
  network: ReadOnlyNetworkAdapter,
): Promise<McpAuthenticationBoundaryResult> {
  const request: ReadOnlyNetworkRequest = Object.freeze({
    url: PLURUM_MCP_ENDPOINT,
    method: "GET" as const,
    headers: Object.freeze({ Accept: "application/json" }),
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    redirect: "error" as const,
  });

  let response: ResponseSnapshot | undefined;
  try {
    response = snapshotResponse(await network.request(request));
  } catch {
    return MCP_AUTHENTICATION_UNAVAILABLE;
  }
  if (response === undefined) {
    return MCP_AUTHENTICATION_UNAVAILABLE;
  }

  try {
    return response.status === 401 &&
      hasExactMcpAuthenticationChallenge(response.headers)
      ? MCP_AUTHENTICATION_HEALTHY
      : MCP_AUTHENTICATION_UNHEALTHY;
  } finally {
    wipe(response.body);
  }
}
