import { HostError } from "./errors.js";

const CANONICAL_VERSION_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const MAX_VERSION_LENGTH = 128;

export interface CanonicalVersion {
  readonly canonical: string;
  readonly major: string;
  readonly minor: string;
  readonly patch: string;
}

function invalidVersion(): never {
  throw new HostError("invalid_host_version");
}

function compareIdentifier(left: string, right: string): -1 | 0 | 1 {
  if (left.length !== right.length) {
    return left.length < right.length ? -1 : 1;
  }

  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

export function parseCanonicalVersion(value: unknown): CanonicalVersion {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_VERSION_LENGTH
  ) {
    return invalidVersion();
  }

  const match = CANONICAL_VERSION_PATTERN.exec(value);
  if (match === null) {
    return invalidVersion();
  }

  const major = match[1];
  const minor = match[2];
  const patch = match[3];
  if (major === undefined || minor === undefined || patch === undefined) {
    return invalidVersion();
  }

  return Object.freeze({
    canonical: value,
    major,
    minor,
    patch,
  });
}

export function compareCanonicalVersions(
  left: string,
  right: string,
): -1 | 0 | 1 {
  const parsedLeft = parseCanonicalVersion(left);
  const parsedRight = parseCanonicalVersion(right);

  return (
    compareIdentifier(parsedLeft.major, parsedRight.major) ||
    compareIdentifier(parsedLeft.minor, parsedRight.minor) ||
    compareIdentifier(parsedLeft.patch, parsedRight.patch)
  );
}

export function isCanonicalVersionInRange(
  version: string,
  minimumInclusive: string,
  maximumExclusive: string,
): boolean {
  if (
    compareCanonicalVersions(minimumInclusive, maximumExclusive) >= 0
  ) {
    return invalidVersion();
  }

  return (
    compareCanonicalVersions(version, minimumInclusive) >= 0 &&
    compareCanonicalVersions(version, maximumExclusive) < 0
  );
}
