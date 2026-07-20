import {
  clearTimeout as cancelTimer,
  setTimeout as scheduleTimer,
} from "node:timers";

import type {
  NetworkAdapter,
  NetworkRequest,
  NetworkResponse,
} from "../../system/contracts.js";
import {
  copyUint8Array,
  intrinsicUint8ArrayByteLength,
} from "../../data/uint8-array.js";

export type NetworkTransportErrorCode =
  | "invalid_network_request"
  | "network_request_failed"
  | "network_request_timeout"
  | "invalid_network_response"
  | "network_response_too_large";

const SAFE_MESSAGES: Readonly<Record<NetworkTransportErrorCode, string>> =
  Object.freeze({
    invalid_network_request: "The network request is invalid.",
    network_request_failed: "The network request failed.",
    network_request_timeout: "The network request timed out.",
    invalid_network_response: "The network response is invalid.",
    network_response_too_large:
      "The network response exceeded the configured limit.",
  });

export class NetworkTransportError extends Error {
  readonly code: NetworkTransportErrorCode;

  constructor(code: NetworkTransportErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "NetworkTransportError";
    this.code = code;
  }
}

export interface FetchHeadersLike {
  forEach(
    callback: (value: string, name: string) => void,
  ): void;
}

export interface FetchBodyReaderLike {
  read(): Promise<{
    readonly done: boolean;
    readonly value?: Uint8Array;
  }>;
  cancel(): Promise<void>;
  releaseLock?(): void;
}

export interface FetchBodyLike {
  getReader(): FetchBodyReaderLike;
}

export interface FetchResponseLike {
  readonly status: number;
  readonly headers: FetchHeadersLike;
  readonly body: FetchBodyLike | null;
}

export interface FetchRequestInitLike {
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly redirect: "error";
  readonly signal: AbortSignal;
}

export type FetchCompatible = (
  url: string,
  init: FetchRequestInitLike,
) => Promise<FetchResponseLike>;

const REQUEST_FIELDS = Object.freeze([
  "url",
  "method",
  "headers",
  "body",
  "timeoutMs",
  "maxResponseBytes",
  "redirect",
] as const);
const REQUIRED_REQUEST_FIELDS = Object.freeze([
  "url",
  "method",
  "headers",
  "timeoutMs",
  "maxResponseBytes",
  "redirect",
] as const);
const ASCII_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const MAX_URL_CHARACTERS = 8_192;
const MAX_TIMEOUT_MS = 120_000;
const MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_HEADER_COUNT = 64;
const MAX_REQUEST_HEADER_BYTES = 16 * 1024;
const MAX_RESPONSE_HEADER_COUNT = 128;
const MAX_RESPONSE_HEADER_BYTES = 64 * 1024;
const MAX_HEADER_NAME_CHARACTERS = 256;
const MAX_REQUEST_HEADER_VALUE_CHARACTERS = 8 * 1024;
const MAX_RESPONSE_HEADER_VALUE_CHARACTERS = 16 * 1024;
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "transfer-encoding",
  "upgrade",
]);
const BASE_UINT8_ARRAY = Uint8Array;
const fillBytes = Uint8Array.prototype.fill;
const setBytes = Uint8Array.prototype.set;

interface RequestSnapshot {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly clearHeaders: () => void;
  readonly body?: Uint8Array;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

interface RequestHeaderSnapshot {
  readonly headers: Readonly<Record<string, string>>;
  readonly clear: () => void;
}

interface ActiveRequest {
  readonly controller: AbortController;
  reader: FetchBodyReaderLike | undefined;
  timedOut: boolean;
}

interface ResponseChunk {
  readonly bytes: Uint8Array;
  readonly length: number;
}

function fail(code: NetworkTransportErrorCode): never {
  throw new NetworkTransportError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function wipe(bytes: Uint8Array | undefined): void {
  if (bytes === undefined) {
    return;
  }
  try {
    fillBytes.call(bytes, 0);
  } catch {
    // A detached owned buffer no longer contains accessible data.
  }
}

function byteLength(
  bytes: unknown,
  errorCode: "invalid_network_request" | "invalid_network_response",
): number {
  return intrinsicUint8ArrayByteLength(bytes) ?? fail(errorCode);
}

function copyBytes(
  bytes: Uint8Array,
  length: number,
  errorCode: "invalid_network_request" | "invalid_network_response",
): Uint8Array {
  return copyUint8Array(bytes, length) ?? fail(errorCode);
}

function rawAuthority(raw: string): string {
  const authorityStart = raw.indexOf("://") + 3;
  const pathStart = raw.indexOf("/", authorityStart);
  const queryStart = raw.indexOf("?", authorityStart);
  let authorityEnd = raw.length;
  if (pathStart !== -1 && pathStart < authorityEnd) {
    authorityEnd = pathStart;
  }
  if (queryStart !== -1 && queryStart < authorityEnd) {
    authorityEnd = queryStart;
  }
  return raw.slice(authorityStart, authorityEnd);
}

function rawHostname(authority: string): string {
  if (
    authority.length === 0 ||
    authority.includes("@") ||
    authority.includes("%")
  ) {
    return fail("invalid_network_request");
  }
  if (authority.startsWith("[")) {
    const match = /^(\[[^\]]+\])(?::[0-9]+)?$/u.exec(authority);
    return match?.[1] ?? fail("invalid_network_request");
  }
  const match = /^([^:]+)(?::[0-9]+)?$/u.exec(authority);
  return match?.[1] ?? fail("invalid_network_request");
}

function isNumericLoopback(hostname: string): boolean {
  if (hostname === "[::1]") {
    return true;
  }
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every(
      (octet) =>
        /^(?:0|[1-9][0-9]{0,2})$/u.test(octet) && Number(octet) <= 255,
    )
  );
}

function normalizeUrl(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > MAX_URL_CHARACTERS ||
    input !== input.trim() ||
    ASCII_CONTROL.test(input) ||
    input.includes("\\") ||
    input.includes("#") ||
    !/^(?:https?|HTTPS?):\/\//u.test(input)
  ) {
    return fail("invalid_network_request");
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return fail("invalid_network_request");
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hostname === "" ||
    parsed.hostname.endsWith(".") ||
    parsed.port === "0" ||
    parsed.hash !== ""
  ) {
    return fail("invalid_network_request");
  }

  const inputHostname = rawHostname(rawAuthority(input));
  if (inputHostname.toLowerCase() !== parsed.hostname) {
    return fail("invalid_network_request");
  }
  if (parsed.protocol === "https:") {
    return parsed.href;
  }
  if (
    parsed.protocol === "http:" &&
    isNumericLoopback(parsed.hostname)
  ) {
    return parsed.href;
  }
  return fail("invalid_network_request");
}

function validHeaderValue(value: string, maximumCharacters: number): boolean {
  if (value.length > maximumCharacters) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code > 0xff ||
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      return false;
    }
  }
  return true;
}

function snapshotRequestHeaders(
  input: unknown,
): RequestHeaderSnapshot {
  if (
    !isRecord(input) ||
    Object.getOwnPropertySymbols(input).length !== 0
  ) {
    return fail("invalid_network_request");
  }
  const names = Object.keys(input);
  if (names.length > MAX_REQUEST_HEADER_COUNT) {
    return fail("invalid_network_request");
  }

  const values = Object.create(null) as Record<string, string>;
  const view = Object.create(null) as Record<string, string>;
  const normalizedNames: string[] = [];
  let totalBytes = 0;
  for (const name of names) {
    const value = input[name];
    const normalizedName = name.toLowerCase();
    if (
      name.length === 0 ||
      name.length > MAX_HEADER_NAME_CHARACTERS ||
      !HEADER_NAME.test(name) ||
      FORBIDDEN_REQUEST_HEADERS.has(normalizedName) ||
      normalizedName.startsWith("proxy-") ||
      normalizedName in values ||
      typeof value !== "string" ||
      !validHeaderValue(value, MAX_REQUEST_HEADER_VALUE_CHARACTERS)
    ) {
      return fail("invalid_network_request");
    }
    totalBytes += normalizedName.length + value.length + 4;
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes > MAX_REQUEST_HEADER_BYTES
    ) {
      return fail("invalid_network_request");
    }
    normalizedNames.push(normalizedName);
    values[normalizedName] = value;
  }

  for (const name of normalizedNames) {
    Object.defineProperty(view, name, {
      configurable: false,
      enumerable: true,
      get(): string {
        return values[name] ?? "";
      },
    });
  }
  return Object.freeze({
    headers: Object.freeze(view),
    clear(): void {
      for (const name of normalizedNames) {
        values[name] = "";
      }
    },
  });
}

function snapshotRequest(input: unknown): RequestSnapshot {
  let copiedBody: Uint8Array | undefined;
  let headerSnapshot: RequestHeaderSnapshot | undefined;
  try {
    if (
      !isRecord(input) ||
      Object.getOwnPropertySymbols(input).length !== 0
    ) {
      return fail("invalid_network_request");
    }
    const fields = Object.keys(input);
    if (
      fields.some(
        (field) =>
          !REQUEST_FIELDS.includes(
            field as (typeof REQUEST_FIELDS)[number],
          ),
      ) ||
      REQUIRED_REQUEST_FIELDS.some((field) => !fields.includes(field))
    ) {
      return fail("invalid_network_request");
    }

    const rawUrl = input.url;
    const method = input.method;
    const rawHeaders = input.headers;
    const rawBody = input.body;
    const timeoutMs = input.timeoutMs;
    const maxResponseBytes = input.maxResponseBytes;
    const redirect = input.redirect;

    const url = normalizeUrl(rawUrl);
    if (method !== "GET" && method !== "POST") {
      return fail("invalid_network_request");
    }
    if (redirect !== "error") {
      return fail("invalid_network_request");
    }
    if (
      !Number.isSafeInteger(timeoutMs) ||
      (timeoutMs as number) <= 0 ||
      (timeoutMs as number) > MAX_TIMEOUT_MS ||
      !Number.isSafeInteger(maxResponseBytes) ||
      (maxResponseBytes as number) <= 0 ||
      (maxResponseBytes as number) > MAX_RESPONSE_BODY_BYTES
    ) {
      return fail("invalid_network_request");
    }
    headerSnapshot = snapshotRequestHeaders(rawHeaders);

    if (rawBody !== undefined) {
      if (
        method !== "POST" ||
        !(rawBody instanceof BASE_UINT8_ARRAY)
      ) {
        return fail("invalid_network_request");
      }
      const bodyLength = byteLength(rawBody, "invalid_network_request");
      if (bodyLength > MAX_REQUEST_BODY_BYTES) {
        return fail("invalid_network_request");
      }
      copiedBody = copyBytes(
        rawBody,
        bodyLength,
        "invalid_network_request",
      );
    }

    return Object.freeze({
      url,
      method,
      headers: headerSnapshot.headers,
      clearHeaders: headerSnapshot.clear,
      ...(copiedBody === undefined ? {} : { body: copiedBody }),
      timeoutMs: timeoutMs as number,
      maxResponseBytes: maxResponseBytes as number,
    });
  } catch {
    headerSnapshot?.clear();
    wipe(copiedBody);
    return fail("invalid_network_request");
  }
}

function safeAbort(active: ActiveRequest): void {
  try {
    active.controller.abort();
  } catch {
    // Abort is best effort after the operation has already failed.
  }
}

function safeCancel(reader: FetchBodyReaderLike | undefined): void {
  if (reader === undefined) {
    return;
  }
  try {
    void Promise.resolve(reader.cancel()).catch(() => undefined);
  } catch {
    // Cancellation is best effort after the operation has already failed.
  }
}

function safeRelease(reader: FetchBodyReaderLike | undefined): void {
  if (reader === undefined) {
    return;
  }
  try {
    const release = reader.releaseLock;
    if (typeof release === "function") {
      release.call(reader);
    }
  } catch {
    // Releasing a hostile fake reader must not replace the fixed error.
  }
}

async function readWithAbort(
  reader: FetchBodyReaderLike,
  active: ActiveRequest,
): Promise<unknown> {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(new NetworkTransportError("network_request_timeout"));
    };
    if (active.controller.signal.aborted) {
      onAbort();
    } else {
      active.controller.signal.addEventListener("abort", onAbort, {
        once: true,
      });
    }
  });
  const pendingRead = Promise.resolve().then(() => reader.read());
  try {
    return await Promise.race([pendingRead, aborted]);
  } finally {
    if (onAbort !== undefined) {
      active.controller.signal.removeEventListener("abort", onAbort);
    }
  }
}

function snapshotResponseHeaders(
  input: unknown,
): Readonly<Record<string, string>> {
  if (!isRecord(input) || typeof input.forEach !== "function") {
    return fail("invalid_network_response");
  }

  const copied = Object.create(null) as Record<string, string>;
  let count = 0;
  let totalBytes = 0;
  let valid = true;
  let accepting = true;
  try {
    input.forEach((value: unknown, name: unknown) => {
      if (!accepting || !valid) {
        return;
      }
      count += 1;
      if (
        count > MAX_RESPONSE_HEADER_COUNT ||
        typeof name !== "string" ||
        typeof value !== "string"
      ) {
        valid = false;
        return;
      }
      const normalizedName = name.toLowerCase();
      if (
        name.length === 0 ||
        name.length > MAX_HEADER_NAME_CHARACTERS ||
        !HEADER_NAME.test(name) ||
        normalizedName in copied ||
        !validHeaderValue(value, MAX_RESPONSE_HEADER_VALUE_CHARACTERS)
      ) {
        valid = false;
        return;
      }
      totalBytes += normalizedName.length + value.length + 4;
      if (
        !Number.isSafeInteger(totalBytes) ||
        totalBytes > MAX_RESPONSE_HEADER_BYTES
      ) {
        valid = false;
        return;
      }
      copied[normalizedName] = value;
    });
  } catch {
    valid = false;
  } finally {
    accepting = false;
  }
  if (!valid) {
    return fail("invalid_network_response");
  }
  return Object.freeze(copied);
}

async function snapshotResponseBody(
  input: unknown,
  maximumBytes: number,
  active: ActiveRequest,
): Promise<Uint8Array> {
  if (input === null) {
    return new BASE_UINT8_ARRAY();
  }
  if (!isRecord(input) || typeof input.getReader !== "function") {
    return fail("invalid_network_response");
  }

  let reader: FetchBodyReaderLike | undefined;
  const chunks: ResponseChunk[] = [];
  let totalBytes = 0;
  try {
    const untrustedReader: unknown = input.getReader();
    if (
      !isRecord(untrustedReader) ||
      typeof untrustedReader.read !== "function" ||
      typeof untrustedReader.cancel !== "function" ||
      (untrustedReader.releaseLock !== undefined &&
        typeof untrustedReader.releaseLock !== "function")
    ) {
      return fail("invalid_network_response");
    }
    reader = untrustedReader as unknown as FetchBodyReaderLike;
    active.reader = reader;

    while (true) {
      let item: unknown;
      try {
        item = await readWithAbort(reader, active);
      } catch {
        if (active.timedOut) {
          return fail("network_request_timeout");
        }
        return fail("network_request_failed");
      }
      if (!isRecord(item)) {
        return fail("invalid_network_response");
      }
      let done: unknown;
      let value: unknown;
      try {
        done = item.done;
        value = item.value;
      } catch {
        return fail("invalid_network_response");
      }
      if (typeof done !== "boolean" || (done && value !== undefined)) {
        return fail("invalid_network_response");
      }
      if (done) {
        break;
      }
      if (!(value instanceof BASE_UINT8_ARRAY)) {
        return fail("invalid_network_response");
      }
      const chunkLength = byteLength(value, "invalid_network_response");
      if (chunkLength > maximumBytes - totalBytes) {
        safeAbort(active);
        safeCancel(reader);
        return fail("network_response_too_large");
      }
      const copiedChunk = copyBytes(
        value,
        chunkLength,
        "invalid_network_response",
      );
      chunks.push(Object.freeze({ bytes: copiedChunk, length: chunkLength }));
      totalBytes += chunkLength;
    }

    const body = new BASE_UINT8_ARRAY(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      setBytes.call(body, chunk.bytes, offset);
      offset += chunk.length;
    }
    return body;
  } catch (error) {
    if (error instanceof NetworkTransportError) {
      throw error;
    }
    return fail("invalid_network_response");
  } finally {
    for (const chunk of chunks) {
      wipe(chunk.bytes);
    }
    if (active.reader === reader) {
      active.reader = undefined;
    }
    safeRelease(reader);
  }
}

async function snapshotResponse(
  input: unknown,
  maximumBytes: number,
  active: ActiveRequest,
): Promise<NetworkResponse> {
  if (!isRecord(input)) {
    return fail("invalid_network_response");
  }
  let status: unknown;
  let headers: unknown;
  let body: unknown;
  try {
    status = input.status;
    headers = input.headers;
    body = input.body;
  } catch {
    return fail("invalid_network_response");
  }
  if (
    !Number.isInteger(status) ||
    (status as number) < 200 ||
    (status as number) > 599 ||
    ((status as number) >= 300 && (status as number) <= 399)
  ) {
    return fail("invalid_network_response");
  }
  const copiedHeaders = snapshotResponseHeaders(headers);
  const copiedBody = await snapshotResponseBody(body, maximumBytes, active);
  return Object.freeze({
    status: status as number,
    headers: copiedHeaders,
    body: copiedBody,
  });
}

async function executeRequest(
  request: RequestSnapshot,
  compatibleFetch: FetchCompatible,
): Promise<NetworkResponse> {
  const active: ActiveRequest = {
    controller: new AbortController(),
    reader: undefined,
    timedOut: false,
  };
  let timer: ReturnType<typeof scheduleTimer> | undefined;
  let succeeded = false;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = scheduleTimer(() => {
      active.timedOut = true;
      safeAbort(active);
      safeCancel(active.reader);
      reject(new NetworkTransportError("network_request_timeout"));
    }, request.timeoutMs);
  });
  const init: FetchRequestInitLike = Object.freeze({
    method: request.method,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body }),
    redirect: "error",
    signal: active.controller.signal,
  });

  const operation = (async (): Promise<NetworkResponse> => {
    let response: unknown;
    try {
      response = await compatibleFetch(request.url, init);
    } catch {
      if (active.timedOut) {
        return fail("network_request_timeout");
      }
      return fail("network_request_failed");
    }
    if (active.timedOut) {
      return fail("network_request_timeout");
    }
    return snapshotResponse(response, request.maxResponseBytes, active);
  })();

  try {
    const response = await Promise.race([operation, timeout]);
    succeeded = true;
    return response;
  } catch (error) {
    if (error instanceof NetworkTransportError) {
      throw error;
    }
    return fail("network_request_failed");
  } finally {
    if (timer !== undefined) {
      cancelTimer(timer);
    }
    if (!succeeded) {
      safeAbort(active);
      safeCancel(active.reader);
    }
  }
}

export function createNodeNetwork(
  compatibleFetch: FetchCompatible,
): NetworkAdapter {
  if (typeof compatibleFetch !== "function") {
    return fail("network_request_failed");
  }
  return Object.freeze<NetworkAdapter>({
    async request(request: NetworkRequest): Promise<NetworkResponse> {
      const snapshot = snapshotRequest(request);
      try {
        return await executeRequest(snapshot, compatibleFetch);
      } finally {
        snapshot.clearHeaders();
        wipe(snapshot.body);
      }
    },
  });
}

export const nodeNetwork: NetworkAdapter = createNodeNetwork(fetch);
