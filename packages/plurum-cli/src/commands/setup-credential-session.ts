import { CredentialError } from "../credentials/errors.js";
import type { CredentialStoreObservedMutationAdapter } from "../credentials/store-mutation-contracts.js";
import type { CredentialStoreWholePassEvidence } from "../credentials/store-contracts.js";
import {
  runExclusiveObservedCredentialSetup,
} from "../credentials/store-writer.js";
import {
  validateCredentialDocument,
  type ActiveCredentialV1,
} from "../credentials/schema.js";
import type {
  ClockAdapter,
  RandomAdapter,
} from "../system/contracts.js";

export interface SetupCredentialSessionDependencies {
  readonly storage: CredentialStoreObservedMutationAdapter;
  readonly clock: ClockAdapter;
  readonly random: RandomAdapter;
}

export interface SetupCredentialSessionRequest {
  readonly canonicalDirectory: string;
  readonly expectedCredential: ActiveCredentialV1;
  readonly evidence: CredentialStoreWholePassEvidence;
}

export type SetupCredentialSessionRevalidation =
  | "exact"
  | "state-changed"
  | "unavailable";

export interface SetupCredentialSessionGuard {
  revalidate(): Promise<SetupCredentialSessionRevalidation>;
}

export type SetupCredentialSessionResult<T> =
  | Readonly<{ readonly status: "completed"; readonly value: T }>
  | Readonly<{ readonly status: "busy" }>
  | Readonly<{
      readonly status: "state-changed" | "unavailable";
      readonly operation: "not-started";
    }>
  | Readonly<{
      readonly status: "state-changed" | "unavailable";
      readonly operation: "started";
      readonly completed: false;
    }>
  | Readonly<{
      readonly status: "state-changed" | "unavailable";
      readonly operation: "started";
      readonly completed: true;
      readonly value: T;
    }>;

declare const setupCredentialSessionAuthorityBrand: unique symbol;

export interface SetupCredentialSessionAuthority {
  readonly [setupCredentialSessionAuthorityBrand]: never;
  run<T>(
    request: SetupCredentialSessionRequest,
    operation: (guard: SetupCredentialSessionGuard) => Promise<T>,
  ): Promise<SetupCredentialSessionResult<T>>;
}

interface NormalizedDependencies
  extends SetupCredentialSessionDependencies {}

const MAX_PATH_CHARACTERS = 32_767;
const PATH_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const BUSY = Object.freeze({ status: "busy" as const });
const OWNED_AUTHORITIES = new WeakSet<SetupCredentialSessionAuthority>();

class SetupCredentialSessionError extends Error {
  constructor() {
    super("The setup credential session could not be created safely.");
    this.name = "SetupCredentialSessionError";
  }
}

function invalid(): never {
  throw new SetupCredentialSessionError();
}

function normalizeDependencies(
  value: SetupCredentialSessionDependencies,
): NormalizedDependencies {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.isFrozen(value) ||
      value.storage === null ||
      typeof value.storage !== "object" ||
      typeof value.storage.acquireObservedSetupLease !== "function" ||
      typeof value.clock?.now !== "function" ||
      typeof value.random?.uuid !== "function"
    ) {
      return invalid();
    }
    return Object.freeze({
      storage: value.storage,
      clock: value.clock,
      random: value.random,
    });
  } catch (error) {
    if (error instanceof SetupCredentialSessionError) {
      throw error;
    }
    return invalid();
  }
}

function normalizeRequest(
  value: SetupCredentialSessionRequest,
): SetupCredentialSessionRequest {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.isFrozen(value) ||
      typeof value.canonicalDirectory !== "string" ||
      value.canonicalDirectory.length === 0 ||
      value.canonicalDirectory.length > MAX_PATH_CHARACTERS ||
      PATH_CONTROL.test(value.canonicalDirectory) ||
      value.evidence === null ||
      typeof value.evidence !== "object"
    ) {
      return invalid();
    }
    const credential = validateCredentialDocument(
      value.expectedCredential,
    );
    if (credential.state !== "active") {
      return invalid();
    }
    return Object.freeze({
      canonicalDirectory: value.canonicalDirectory,
      expectedCredential: credential,
      evidence: value.evidence,
    });
  } catch (error) {
    if (error instanceof SetupCredentialSessionError) {
      throw error;
    }
    return invalid();
  }
}

function unsettled<T>(
  status: "state-changed" | "unavailable",
  started: boolean,
  completed: boolean,
  value: T | undefined,
): SetupCredentialSessionResult<T> {
  if (!started) {
    return Object.freeze({ status, operation: "not-started" as const });
  }
  if (!completed) {
    return Object.freeze({
      status,
      operation: "started" as const,
      completed: false as const,
    });
  }
  return Object.freeze({
    status,
    operation: "started" as const,
    completed: true as const,
    value: value as T,
  });
}

function failureStatus(error: unknown): "state-changed" | "unavailable" {
  return error instanceof CredentialError &&
    error.code === "credential_store_conflict"
    ? "state-changed"
    : "unavailable";
}

export function createSetupCredentialSessionAuthority(
  rawDependencies: SetupCredentialSessionDependencies,
): SetupCredentialSessionAuthority {
  const dependencies = normalizeDependencies(rawDependencies);
  const authority = Object.freeze({
    async run<T>(
      rawRequest: SetupCredentialSessionRequest,
      operation: (guard: SetupCredentialSessionGuard) => Promise<T>,
    ): Promise<SetupCredentialSessionResult<T>> {
      let request: SetupCredentialSessionRequest;
      try {
        request = normalizeRequest(rawRequest);
        if (typeof operation !== "function") {
          return unsettled<T>("unavailable", false, false, undefined);
        }
      } catch {
        return unsettled<T>("unavailable", false, false, undefined);
      }

      let started = false;
      let completed = false;
      let value: T | undefined;
      try {
        const result = await runExclusiveObservedCredentialSetup(
          Object.freeze({
            storage: dependencies.storage,
            clock: dependencies.clock,
            random: dependencies.random,
          }),
          Object.freeze({ directory: request.canonicalDirectory }),
          Object.freeze({
            credential: request.expectedCredential,
            transaction: null,
            temporaryEntries: "empty" as const,
            evidence: request.evidence,
          }),
          async (session) => {
            await session.readExactCredential(request.expectedCredential);
            const guard = Object.freeze({
              async revalidate(): Promise<SetupCredentialSessionRevalidation> {
                try {
                  await session.readExactCredential(
                    request.expectedCredential,
                  );
                  return "exact";
                } catch (error) {
                  return failureStatus(error);
                }
              },
            });
            started = true;
            value = await operation(guard);
            completed = true;
            await session.readExactCredential(request.expectedCredential);
            return value;
          },
        );
        if (result.status === "busy") {
          return BUSY;
        }
        if (result.status === "precondition-failed") {
          return unsettled<T>("state-changed", false, false, undefined);
        }
        return Object.freeze({
          status: "completed" as const,
          value: result.value,
        });
      } catch (error) {
        return unsettled(
          failureStatus(error),
          started,
          completed,
          value,
        );
      }
    },
  }) as SetupCredentialSessionAuthority;
  OWNED_AUTHORITIES.add(authority);
  return authority;
}

export function isOwnedSetupCredentialSessionAuthority(
  value: unknown,
): value is SetupCredentialSessionAuthority {
  return (
    typeof value === "object" &&
    value !== null &&
    OWNED_AUTHORITIES.has(value as SetupCredentialSessionAuthority)
  );
}
