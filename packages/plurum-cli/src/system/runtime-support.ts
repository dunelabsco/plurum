export const RECOGNIZED_RUNTIME_TARGETS = Object.freeze([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64-gnu",
  "linux-arm64-musl",
  "linux-x64-gnu",
  "linux-x64-musl",
  "win32-arm64-msvc",
  "win32-x64-msvc",
] as const);

export type RuntimePlatformTarget =
  (typeof RECOGNIZED_RUNTIME_TARGETS)[number];

export const RELEASED_RUNTIME_TARGETS = Object.freeze([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64-gnu",
  "linux-x64-gnu",
  "win32-x64-msvc",
] as const satisfies readonly RuntimePlatformTarget[]);

export type ReleasedRuntimePlatformTarget =
  (typeof RELEASED_RUNTIME_TARGETS)[number];

export const SUPPORTED_NODE_RUNTIME_RANGES = Object.freeze([
  "^22.12.0",
  "^24.0.0",
] as const);

export type RuntimeSupportObservation =
  | Readonly<{
      readonly status: "available";
      readonly runtime: "node";
      readonly version: string;
      readonly target: string;
    }>
  | Readonly<{ readonly status: "unavailable" }>;

/*
 * This semantic port observes only the already-running CLI runtime. It has no
 * process, filesystem, network, host, credential, or mutation operation.
 * Production composition remains responsible for deriving one exact target
 * from its released artifact and native-platform evidence.
 */
export interface RuntimeSupportObservationAdapter {
  observe(): Promise<RuntimeSupportObservation>;
}

export type RuntimePlatformSupportResult =
  | Readonly<{
      readonly status: "supported";
      readonly runtime: "node";
      readonly version: string;
      readonly target: ReleasedRuntimePlatformTarget;
    }>
  | Readonly<{
      readonly status: "unsupported";
      readonly reason: "node-version" | "platform-target";
      readonly runtime: "node";
      readonly version: string;
      readonly target: RuntimePlatformTarget | null;
    }>
  | Readonly<{
      readonly status: "unavailable";
      readonly reason: "observation-unavailable";
      readonly runtime: null;
      readonly version: null;
      readonly target: null;
    }>;

const NODE_VERSION =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const OPAQUE_TARGET = /^[a-z0-9]+(?:-[a-z0-9]+){1,3}$/u;
const MAX_VERSION_CHARACTERS = 128;
const MAX_TARGET_CHARACTERS = 128;
const RELEASED_TARGET_SET = new Set<RuntimePlatformTarget>(
  RELEASED_RUNTIME_TARGETS,
);
const RECOGNIZED_TARGET_SET = new Set<RuntimePlatformTarget>(
  RECOGNIZED_RUNTIME_TARGETS,
);
const UNAVAILABLE = Object.freeze({
  status: "unavailable" as const,
  reason: "observation-unavailable" as const,
  runtime: null,
  version: null,
  target: null,
});

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

function observationMethod(
  value: unknown,
): RuntimeSupportObservationAdapter["observe"] | undefined {
  const object = ownDataValues(value, ["observe"]);
  const observe = object?.observe;
  return typeof observe === "function"
    ? (observe as RuntimeSupportObservationAdapter["observe"])
    : undefined;
}

function snapshotObservation(
  value: unknown,
): RuntimeSupportObservation | undefined {
  const unavailable = ownDataValues(value, ["status"]);
  if (unavailable?.status === "unavailable") {
    return Object.freeze({ status: "unavailable" as const });
  }

  const available = ownDataValues(value, [
    "status",
    "runtime",
    "version",
    "target",
  ]);
  if (
    available?.status !== "available" ||
    available.runtime !== "node" ||
    typeof available.version !== "string" ||
    available.version.length === 0 ||
    available.version.length > MAX_VERSION_CHARACTERS ||
    !NODE_VERSION.test(available.version) ||
    typeof available.target !== "string" ||
    available.target.length === 0 ||
    available.target.length > MAX_TARGET_CHARACTERS ||
    !OPAQUE_TARGET.test(available.target)
  ) {
    return undefined;
  }
  return Object.freeze({
    status: "available" as const,
    runtime: "node" as const,
    version: available.version,
    target: available.target,
  });
}

function identifierAtLeast(value: string, minimum: string): boolean {
  return (
    value.length > minimum.length ||
    (value.length === minimum.length && value >= minimum)
  );
}

function supportedNodeVersion(version: string): boolean {
  const match = NODE_VERSION.exec(version);
  if (match === null) {
    return false;
  }
  const major = match[1];
  const minor = match[2];
  return (
    major === "24" ||
    (major === "22" && minor !== undefined && identifierAtLeast(minor, "12"))
  );
}

function recognizedTarget(value: string): RuntimePlatformTarget | null {
  return RECOGNIZED_TARGET_SET.has(value as RuntimePlatformTarget)
    ? (value as RuntimePlatformTarget)
    : null;
}

export async function observeRuntimePlatformSupport(
  adapter: RuntimeSupportObservationAdapter,
): Promise<RuntimePlatformSupportResult> {
  const observe = observationMethod(adapter);
  if (observe === undefined) {
    return UNAVAILABLE;
  }

  let observation: RuntimeSupportObservation | undefined;
  try {
    observation = snapshotObservation(await Reflect.apply(observe, adapter, []));
  } catch {
    return UNAVAILABLE;
  }
  if (observation === undefined || observation.status === "unavailable") {
    return UNAVAILABLE;
  }

  const target = recognizedTarget(observation.target);
  if (!supportedNodeVersion(observation.version)) {
    return Object.freeze({
      status: "unsupported" as const,
      reason: "node-version" as const,
      runtime: "node" as const,
      version: observation.version,
      target,
    });
  }
  if (target === null || !RELEASED_TARGET_SET.has(target)) {
    return Object.freeze({
      status: "unsupported" as const,
      reason: "platform-target" as const,
      runtime: "node" as const,
      version: observation.version,
      target,
    });
  }
  return Object.freeze({
    status: "supported" as const,
    runtime: "node" as const,
    version: observation.version,
    target: target as ReleasedRuntimePlatformTarget,
  });
}
