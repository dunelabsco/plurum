import {
  CODEX_DOTENV_PROJECTION_STATUSES,
  type CodexDotenvProjectionStatus,
} from "./codex-dotenv-contracts.js";
import {
  containsApiKeyToken,
  parseApiKey,
  type ApiKey,
} from "./schema.js";
import {
  containsHostControlCharacter,
  containsHostSensitiveMaterial,
} from "../hosts/privacy.js";

export interface CodexDotenvStatusObservationRequest {
  readonly apiKey: ApiKey;
  readonly excludedProjectDirectory: string;
}

type CodexDotenvStatusProjectionObservation = Readonly<{
  readonly status: CodexDotenvProjectionStatus;
}>;

/*
 * This port is deliberately observation-only. It has no projection identity,
 * revision, path, apply, synchronization, or mutation method. A future native
 * implementation compares the user-scoped Codex projection with the exact key
 * in this request and returns only its semantic status.
 */
export interface CodexDotenvStatusObservationAdapter {
  observe(
    request: CodexDotenvStatusObservationRequest,
  ): Promise<CodexDotenvStatusProjectionObservation>;
}

export type CodexDotenvStatusObservationResult =
  | CodexDotenvStatusProjectionObservation
  | Readonly<{ readonly status: "unavailable" }>;

const UNAVAILABLE = Object.freeze({ status: "unavailable" as const });
const MAX_EXCLUDED_PROJECT_DIRECTORY_CHARACTERS = 32_767;

interface DataSnapshot {
  readonly values: Readonly<Record<string, unknown>>;
}

function snapshotExactDataObject(
  value: unknown,
  expectedNames: readonly string[],
): DataSnapshot | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }

  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    if (Array.isArray(value)) {
      return undefined;
    }
    prototype = Object.getPrototypeOf(value) as object | null;
    keys = Reflect.ownKeys(value);
  } catch {
    return undefined;
  }
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== expectedNames.length ||
    keys.some(
      (key) => typeof key !== "string" || !expectedNames.includes(key),
    ) ||
    expectedNames.some((name) => !keys.includes(name))
  ) {
    return undefined;
  }

  const copied = Object.create(null) as Record<string, unknown>;
  for (const name of expectedNames) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, name);
    } catch {
      return undefined;
    }
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
  return Object.freeze({ values: Object.freeze(copied) });
}

function normalizeRequest(
  value: unknown,
): CodexDotenvStatusObservationRequest | undefined {
  const snapshot = snapshotExactDataObject(value, [
    "apiKey",
    "excludedProjectDirectory",
  ]);
  if (snapshot === undefined) {
    return undefined;
  }

  let apiKey: ApiKey;
  try {
    apiKey = parseApiKey(snapshot.values.apiKey);
  } catch {
    return undefined;
  }
  const excludedProjectDirectory = snapshot.values.excludedProjectDirectory;
  if (
    typeof excludedProjectDirectory !== "string" ||
    excludedProjectDirectory.length === 0 ||
    excludedProjectDirectory.length >
      MAX_EXCLUDED_PROJECT_DIRECTORY_CHARACTERS ||
    containsHostControlCharacter(excludedProjectDirectory) ||
    containsHostSensitiveMaterial(excludedProjectDirectory) ||
    containsApiKeyToken(excludedProjectDirectory, apiKey)
  ) {
    return undefined;
  }
  return Object.freeze({ apiKey, excludedProjectDirectory });
}

function adapterObserve(
  value: unknown,
): CodexDotenvStatusObservationAdapter["observe"] | undefined {
  const snapshot = snapshotExactDataObject(value, ["observe"]);
  const observe = snapshot?.values.observe;
  return typeof observe === "function"
    ? (observe as CodexDotenvStatusObservationAdapter["observe"])
    : undefined;
}

function normalizeObservation(
  value: unknown,
): CodexDotenvStatusProjectionObservation | undefined {
  const snapshot = snapshotExactDataObject(value, ["status"]);
  const status = snapshot?.values.status;
  if (
    typeof status !== "string" ||
    !CODEX_DOTENV_PROJECTION_STATUSES.includes(
      status as CodexDotenvProjectionStatus,
    )
  ) {
    return undefined;
  }
  return Object.freeze({ status: status as CodexDotenvProjectionStatus });
}

export async function observeCodexDotenvStatus(
  adapter: CodexDotenvStatusObservationAdapter,
  request: CodexDotenvStatusObservationRequest,
): Promise<CodexDotenvStatusObservationResult> {
  const observe = adapterObserve(adapter);
  const normalizedRequest = normalizeRequest(request);
  if (observe === undefined || normalizedRequest === undefined) {
    return UNAVAILABLE;
  }

  let rawObservation: unknown;
  try {
    rawObservation = await observe(normalizedRequest);
  } catch {
    return UNAVAILABLE;
  }
  return normalizeObservation(rawObservation) ?? UNAVAILABLE;
}
