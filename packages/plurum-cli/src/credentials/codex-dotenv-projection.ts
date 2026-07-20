import {
  CODEX_DOTENV_API_ORIGIN,
  CODEX_DOTENV_PROJECTION_STATUSES,
} from "./codex-dotenv-contracts.js";
import type {
  CodexDotenvApplyRequest,
  CodexDotenvApplyResult,
  CodexDotenvInspection,
  CodexDotenvInspectionRequest,
  CodexDotenvNativeAdapter,
  CodexDotenvNativeEvidence,
  CodexDotenvNativeMutationResult,
  CodexDotenvProjectionAdapter,
  CodexDotenvProjectionEvidence,
  CodexDotenvProjectionIdentity,
  CodexDotenvProjectionStatus,
} from "./codex-dotenv-contracts.js";
import {
  containsHostControlCharacter,
  containsHostSensitiveMaterial,
} from "../hosts/privacy.js";

const OPAQUE_REVISION = /^[A-Za-z0-9._~:+@=-]{1,512}$/u;

const BLOCKED_RESULT = Object.freeze({ status: "blocked" } as const);
const FAILED_RESULT = Object.freeze({ status: "failed" } as const);
const INDETERMINATE_RESULT = Object.freeze({
  status: "indeterminate",
} as const);
const PRECONDITION_FAILED_RESULT = Object.freeze({
  status: "precondition-failed",
} as const);
const UNAVAILABLE_INSPECTION = Object.freeze({ status: "unavailable" } as const);

const TOKEN_TO_JSON = Object.freeze(function tokenToJson(): undefined {
  return undefined;
});

interface DataSnapshot {
  readonly names: readonly string[];
  readonly values: Readonly<Record<string, unknown>>;
}

interface ProjectionTokenState {
  readonly excludedProjectDirectory: string;
  readonly native: CodexDotenvNativeEvidence;
}

function invalid(): never {
  throw new Error("The Codex credential projection could not be verified.");
}

/*
 * Snapshot every own data property exactly once. In particular, union
 * discriminants from native results must not be read once for branching and a
 * second time for validation: a Proxy can return different descriptors.
 */
function snapshotDataObject(value: unknown): DataSnapshot {
  if (value === null || typeof value !== "object") {
    return invalid();
  }

  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    if (Array.isArray(value)) {
      return invalid();
    }
    prototype = Object.getPrototypeOf(value) as object | null;
    keys = Reflect.ownKeys(value);
  } catch {
    return invalid();
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid();
  }

  const names: string[] = [];
  const copied: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of keys) {
    if (typeof key !== "string") {
      return invalid();
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return invalid();
    }
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      return invalid();
    }
    names.push(key);
    copied[key] = descriptor.value;
  }
  return Object.freeze({
    names: Object.freeze(names),
    values: Object.freeze(copied),
  });
}

function exactSnapshot(
  snapshot: DataSnapshot,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (
    snapshot.names.length !== keys.length ||
    snapshot.names.some((name) => !keys.includes(name)) ||
    keys.some((key) => !snapshot.names.includes(key))
  ) {
    return invalid();
  }
  return snapshot.values;
}

function exactDataObject(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  return exactSnapshot(snapshotDataObject(value), keys);
}

function safeRevision(value: unknown): string {
  if (
    typeof value !== "string" ||
    !OPAQUE_REVISION.test(value) ||
    containsHostControlCharacter(value) ||
    containsHostSensitiveMaterial(value)
  ) {
    return invalid();
  }
  return value;
}

function safeStatus(value: unknown): CodexDotenvProjectionStatus {
  if (
    typeof value !== "string" ||
    !CODEX_DOTENV_PROJECTION_STATUSES.includes(
      value as CodexDotenvProjectionStatus,
    )
  ) {
    return invalid();
  }
  return value as CodexDotenvProjectionStatus;
}

function safeExcludedProjectDirectory(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 32_767 ||
    containsHostControlCharacter(value) ||
    containsHostSensitiveMaterial(value)
  ) {
    return invalid();
  }
  return value;
}

function safeIdentity(value: unknown): CodexDotenvProjectionIdentity {
  if (value === null || typeof value !== "object") {
    return invalid();
  }
  return value as CodexDotenvProjectionIdentity;
}

function normalizeNativeEvidence(value: unknown): CodexDotenvNativeEvidence {
  const object = exactDataObject(value, ["revision", "status"]);
  return Object.freeze({
    revision: safeRevision(object.revision),
    status: safeStatus(object.status),
  });
}

function normalizeInspectionRequest(
  value: unknown,
): CodexDotenvInspectionRequest {
  const object = exactDataObject(value, ["excludedProjectDirectory"]);
  return Object.freeze({
    excludedProjectDirectory: safeExcludedProjectDirectory(
      object.excludedProjectDirectory,
    ),
  });
}

function normalizeApplyRequest(value: unknown): CodexDotenvApplyRequest {
  const object = exactDataObject(value, [
    "expectedIdentity",
    "excludedProjectDirectory",
  ]);
  return Object.freeze({
    expectedIdentity: safeIdentity(object.expectedIdentity),
    excludedProjectDirectory: safeExcludedProjectDirectory(
      object.excludedProjectDirectory,
    ),
  });
}

function normalizeMutationResult(
  value: unknown,
): CodexDotenvNativeMutationResult {
  const snapshot = snapshotDataObject(value);
  const status = snapshot.values.status;
  if (status === "precondition-failed" || status === "failed") {
    exactSnapshot(snapshot, ["status"]);
    return Object.freeze({ status });
  }
  if (status !== "completed") {
    return invalid();
  }

  const object = exactSnapshot(snapshot, [
    "status",
    "disposition",
    "stateRevision",
  ]);
  if (
    object.disposition !== "changed" &&
    object.disposition !== "unchanged"
  ) {
    return invalid();
  }
  return Object.freeze({
    status: "completed",
    disposition: object.disposition,
    stateRevision: safeRevision(object.stateRevision),
  });
}

type BlockedProjectionStatus = Exclude<
  CodexDotenvProjectionStatus,
  "absent" | "exact" | "mismatched"
>;

function blockedStatus(
  status: CodexDotenvProjectionStatus,
): status is BlockedProjectionStatus {
  return (
    status === "ambiguous" ||
    status === "unsafe" ||
    status === "credential-unavailable"
  );
}

function sameNativeState(
  left: CodexDotenvNativeEvidence,
  right: CodexDotenvNativeEvidence,
): boolean {
  return left.revision === right.revision && left.status === right.status;
}

export function createCodexDotenvProjectionAdapter(
  native: CodexDotenvNativeAdapter,
): CodexDotenvProjectionAdapter {
  /*
   * Keeping the registry inside the factory makes identity inherently bound to
   * one adapter. Deleting before the first await makes use atomic and one-shot,
   * including under concurrent calls.
   */
  const identities = new WeakMap<
    CodexDotenvProjectionIdentity,
    ProjectionTokenState
  >();

  function issueEvidence(
    observed: CodexDotenvNativeEvidence,
    excludedProjectDirectory: string,
  ): CodexDotenvProjectionEvidence {
    const token = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(token, "toJSON", {
      configurable: false,
      enumerable: false,
      value: TOKEN_TO_JSON,
      writable: false,
    });
    const identity = Object.freeze(
      token,
    ) as unknown as CodexDotenvProjectionIdentity;
    identities.set(
      identity,
      Object.freeze({
        excludedProjectDirectory,
        native: observed,
      }),
    );
    return Object.freeze({ identity, status: observed.status });
  }

  async function observeNative(
    excludedProjectDirectory: string,
  ): Promise<CodexDotenvNativeEvidence> {
    return normalizeNativeEvidence(
      await native.observe(
        Object.freeze({
          kind: "codex-dotenv-observe",
          scope: "user",
          apiOrigin: CODEX_DOTENV_API_ORIGIN,
          excludedProjectDirectory,
        }),
      ),
    );
  }

  function convergedUnowned(
    observed: CodexDotenvNativeEvidence,
    excludedProjectDirectory: string,
  ): CodexDotenvApplyResult {
    return Object.freeze({
      status: "converged-unowned",
      state: issueEvidence(observed, excludedProjectDirectory),
    });
  }

  async function recoverUncertainMutation(
    before: CodexDotenvNativeEvidence,
    excludedProjectDirectory: string,
  ): Promise<CodexDotenvApplyResult> {
    let observed: CodexDotenvNativeEvidence;
    try {
      observed = await observeNative(excludedProjectDirectory);
    } catch {
      return INDETERMINATE_RESULT;
    }
    if (sameNativeState(before, observed)) {
      return FAILED_RESULT;
    }
    if (observed.revision === before.revision) {
      return INDETERMINATE_RESULT;
    }
    if (observed.status === "exact") {
      return convergedUnowned(observed, excludedProjectDirectory);
    }
    return INDETERMINATE_RESULT;
  }

  async function recoverPreconditionFailure(
    before: CodexDotenvNativeEvidence,
    excludedProjectDirectory: string,
  ): Promise<CodexDotenvApplyResult> {
    let observed: CodexDotenvNativeEvidence;
    try {
      observed = await observeNative(excludedProjectDirectory);
    } catch {
      return INDETERMINATE_RESULT;
    }
    if (
      !sameNativeState(before, observed) &&
      observed.revision !== before.revision &&
      observed.status === "exact"
    ) {
      return convergedUnowned(observed, excludedProjectDirectory);
    }
    return PRECONDITION_FAILED_RESULT;
  }

  async function inspect(
    rawRequest: CodexDotenvInspectionRequest,
  ): Promise<CodexDotenvInspection> {
    try {
      const request = normalizeInspectionRequest(rawRequest);
      const observed = await observeNative(request.excludedProjectDirectory);
      return Object.freeze({
        status: "available",
        state: issueEvidence(observed, request.excludedProjectDirectory),
      });
    } catch {
      return UNAVAILABLE_INSPECTION;
    }
  }

  async function apply(
    rawRequest: CodexDotenvApplyRequest,
  ): Promise<CodexDotenvApplyResult> {
    let request: CodexDotenvApplyRequest;
    try {
      request = normalizeApplyRequest(rawRequest);
    } catch {
      return FAILED_RESULT;
    }

    const before = identities.get(request.expectedIdentity);
    if (before === undefined) {
      return PRECONDITION_FAILED_RESULT;
    }
    identities.delete(request.expectedIdentity);
    if (
      before.excludedProjectDirectory !== request.excludedProjectDirectory
    ) {
      return PRECONDITION_FAILED_RESULT;
    }
    if (blockedStatus(before.native.status)) {
      return BLOCKED_RESULT;
    }

    let rawMutation: unknown;
    try {
      rawMutation = await native.synchronize(
        Object.freeze({
          kind: "codex-dotenv-synchronize",
          scope: "user",
          apiOrigin: CODEX_DOTENV_API_ORIGIN,
          expectedRevision: before.native.revision,
          expectedStatus: before.native.status,
          excludedProjectDirectory: request.excludedProjectDirectory,
        }),
      );
    } catch {
      return recoverUncertainMutation(
        before.native,
        request.excludedProjectDirectory,
      );
    }

    let mutation: CodexDotenvNativeMutationResult;
    try {
      mutation = normalizeMutationResult(rawMutation);
    } catch {
      return recoverUncertainMutation(
        before.native,
        request.excludedProjectDirectory,
      );
    }
    if (mutation.status === "failed") {
      return recoverUncertainMutation(
        before.native,
        request.excludedProjectDirectory,
      );
    }
    if (mutation.status === "precondition-failed") {
      return recoverPreconditionFailure(
        before.native,
        request.excludedProjectDirectory,
      );
    }

    if (
      (before.native.status === "exact" &&
        mutation.disposition !== "unchanged") ||
      (before.native.status !== "exact" &&
        mutation.disposition !== "changed") ||
      (mutation.disposition === "unchanged" &&
        mutation.stateRevision !== before.native.revision) ||
      (mutation.disposition === "changed" &&
        mutation.stateRevision === before.native.revision)
    ) {
      return recoverUncertainMutation(
        before.native,
        request.excludedProjectDirectory,
      );
    }

    let observed: CodexDotenvNativeEvidence;
    try {
      observed = await observeNative(request.excludedProjectDirectory);
    } catch {
      return INDETERMINATE_RESULT;
    }
    if (
      observed.status === "exact" &&
      observed.revision === mutation.stateRevision
    ) {
      return Object.freeze({
        status: mutation.disposition,
        state: issueEvidence(
          observed,
          request.excludedProjectDirectory,
        ),
      });
    }
    if (
      observed.status === "exact" &&
      observed.revision !== before.native.revision
    ) {
      return convergedUnowned(
        observed,
        request.excludedProjectDirectory,
      );
    }
    return INDETERMINATE_RESULT;
  }

  return Object.freeze({ inspect, apply });
}
