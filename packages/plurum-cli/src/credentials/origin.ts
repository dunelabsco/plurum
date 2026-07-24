import { CredentialError } from "./errors.js";

declare const apiOriginBrand: unique symbol;

export type ApiOrigin = string & {
  readonly [apiOriginBrand]: true;
};

export type ApiOriginPolicy =
  | "https-only"
  | "explicit-loopback-development";

export const DEFAULT_API_ORIGIN = "https://api.plurum.ai" as ApiOrigin;

const MAX_ORIGIN_CHARACTERS = 2_048;
const ABSOLUTE_ORIGIN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]+\/?$/u;
const ASCII_CONTROL = /[\u0000-\u001f\u007f]/u;

function invalidOrigin(): never {
  throw new CredentialError("invalid_api_origin");
}

function authorityOf(raw: string): string {
  const start = raw.indexOf("://") + 3;
  return raw.endsWith("/") ? raw.slice(start, -1) : raw.slice(start);
}

function rawHostname(authority: string): string {
  if (authority.startsWith("[")) {
    const match = /^(\[[^\]]+\])(?::([0-9]+))?$/u.exec(authority);
    if (match === null) {
      return invalidOrigin();
    }
    return match[1] ?? invalidOrigin();
  }

  const match = /^([^:]+)(?::([0-9]+))?$/u.exec(authority);
  if (match === null) {
    return invalidOrigin();
  }
  return match[1] ?? invalidOrigin();
}

function isCanonicalLoopbackHostname(hostname: string): boolean {
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

export function normalizeApiOrigin(
  raw: unknown,
  policy: ApiOriginPolicy = "https-only",
): ApiOrigin {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > MAX_ORIGIN_CHARACTERS ||
    raw !== raw.trim() ||
    ASCII_CONTROL.test(raw) ||
    raw.includes("\\") ||
    raw.includes("%") ||
    raw.includes("?") ||
    raw.includes("#") ||
    !ABSOLUTE_ORIGIN.test(raw)
  ) {
    return invalidOrigin();
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return invalidOrigin();
  }

  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.hostname === "" ||
    parsed.hostname.endsWith(".") ||
    parsed.port === "0" ||
    parsed.origin === "null"
  ) {
    return invalidOrigin();
  }

  const authority = authorityOf(raw);
  if (authority.includes("@")) {
    return invalidOrigin();
  }
  const inputHostname = rawHostname(authority);

  if (parsed.protocol === "https:") {
    return parsed.origin as ApiOrigin;
  }
  if (
    parsed.protocol === "http:" &&
    policy === "explicit-loopback-development" &&
    inputHostname === parsed.hostname &&
    isCanonicalLoopbackHostname(parsed.hostname)
  ) {
    return parsed.origin as ApiOrigin;
  }
  return invalidOrigin();
}
