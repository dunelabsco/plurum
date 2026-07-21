import { validateAgentCredential } from "../api/agent-validation.js";
import { checkAgentUsernameAvailability } from "../api/agent-username.js";
import {
  DEFAULT_API_ORIGIN,
  type ApiOrigin,
} from "../credentials/origin.js";
import {
  identifyCredentialKey,
  identifyCredentialKeyBytes,
  type CredentialKeyFingerprint,
  type CredentialKeyIdentity,
} from "../credentials/fingerprint.js";
import {
  parseApiKey,
  type ApiKey,
  type ActiveCredentialV1,
  type AgentName,
  type CanonicalTimestamp,
  type CredentialV1,
  type PendingCredentialV1,
  type RegistrationRequestId,
  type Username,
  validateCredentialDocument,
} from "../credentials/schema.js";
import type {
  CredentialStoreObservationAuthority,
  CredentialStoreObservationEvidence,
} from "../credentials/store-observation-contracts.js";
import type { CredentialStoreWholePassEvidence } from "../credentials/store-contracts.js";
import type { CredentialReplaceTransactionV1 } from "../credentials/store-transaction.js";
import type { ResolvedCredential } from "../credentials/discovery.js";
import { CredentialError } from "../credentials/errors.js";
import {
  claimCredentialStoreObservationEvidence,
} from "../credentials/store-observer.js";
import {
  runExclusiveObservedCredentialSetup,
  type ExclusiveObservedCredentialSetupSession,
} from "../credentials/store-writer.js";
import type { CredentialStoreObservedMutationAdapter } from "../credentials/store-mutation-contracts.js";
import { wipeUint8Array } from "../data/uint8-array.js";
import {
  runRecoverableAgentRegistrationInSession,
  type RecoverableRegistrationOperationDependencies,
  type RecoverableRegistrationResult,
} from "../registration/state-machine.js";
import type {
  ClockAdapter,
  HashAdapter,
  NetworkAdapter,
  RandomAdapter,
  ReadOnlyNetworkAdapter,
} from "../system/contracts.js";
import {
  claimSetupCredentialInputBytes,
  type SetupCredentialInputIdentity,
} from "./setup-credential-input.js";
import type { SetupCredentialSource } from "./setup-credential-plan.js";
import type { SetupApplyPlan } from "./setup-apply-plan.js";
import type { SetupPreparedPlan } from "./setup-approval.js";
import {
  claimSetupExecutionGrant,
  type SetupExecutionAuthority,
  type SetupExecutionGrant,
} from "./setup-execution-authority.js";
import {
  claimSetupSecretLeaseBytes,
  createSetupSecretLease,
  discardSetupSecretLease,
  type SetupSecretLease,
} from "./setup-secret-lease.js";

export type SetupRegistrationResolvedCredential = Omit<
  ResolvedCredential,
  "sources"
> &
  Readonly<{ readonly sources: readonly SetupCredentialSource[] }>;

export type SetupRegistrationSelectedEvidence =
  | Readonly<{
      readonly kind: "existing";
      readonly credential: SetupRegistrationResolvedCredential;
    }>
  | Readonly<{
      readonly kind: "protected-input";
      readonly credential: SetupProtectedCredential;
    }>
  | Readonly<{
      readonly kind: "resume-registration";
      readonly credential: PendingCredentialV1;
      readonly identity: CredentialKeyIdentity;
    }>
  | Readonly<{
      readonly kind: "username-conflict-retry";
      readonly credential: PendingCredentialV1;
      readonly identity: CredentialKeyIdentity;
      readonly registration: Readonly<{
        readonly mode: "username-retry";
        readonly agent: Readonly<{
          readonly name: string;
          readonly username: string;
        }>;
      }>;
    }>
  | Readonly<{
      readonly kind: "new-registration";
      readonly credential: null;
      readonly registration: Readonly<{
        readonly mode: "new";
        readonly agent: Readonly<{
          readonly name: string;
          readonly username: string;
        }>;
      }>;
    }>;

export interface SetupRegistrationProjectionEvidence {
  /* Kept opaque here so this generic execution boundary cannot invoke a
   * host-specific credential projection. */
  readonly adapter: unknown;
  readonly identity: unknown;
  readonly deferred: boolean;
}

export interface SetupRegistrationExecutionEvidence {
  readonly canonicalDirectory: string;
  readonly cwd: string;
  readonly continuationScope: object;
  readonly storeAuthority: CredentialStoreObservationAuthority;
  readonly store: Readonly<{
    readonly credential: CredentialV1 | null;
    readonly transaction: CredentialReplaceTransactionV1 | null;
    readonly evidence: CredentialStoreObservationEvidence;
  }>;
  readonly selected: SetupRegistrationSelectedEvidence;
  readonly projection: SetupRegistrationProjectionEvidence | null;
}

declare const setupHostConfigurationGrantBrand: unique symbol;
declare const setupUsernameConflictContinuationBrand: unique symbol;

export interface SetupHostConfigurationGrant {
  readonly [setupHostConfigurationGrantBrand]: never;
}

export interface SetupUsernameConflictContinuation {
  readonly [setupUsernameConflictContinuationBrand]: never;
}

export interface SetupUsernameConflictContinuationClaim {
  readonly canonicalDirectory: string;
  readonly storeAuthority: CredentialStoreObservationAuthority;
  readonly pending: Readonly<{
    readonly apiOrigin: ApiOrigin;
    readonly identity: CredentialKeyIdentity;
    readonly fingerprint: CredentialKeyFingerprint;
    readonly agentName: AgentName;
    readonly username: Username;
    readonly registrationRequestId: RegistrationRequestId;
    readonly createdAt: CanonicalTimestamp;
    readonly updatedAt: CanonicalTimestamp;
  }>;
  readonly suggestions: readonly Username[];
}

export interface SetupRegistrationExecutionDependencies {
  readonly storage: CredentialStoreObservedMutationAdapter;
  readonly network: NetworkAdapter;
  readonly clock: ClockAdapter;
  readonly random: RandomAdapter;
  readonly hash: HashAdapter;
}

export type SetupRegistrationExecutionResult =
  | Readonly<{
      readonly status: "ready";
      readonly agent: Readonly<{
        readonly id: string;
        readonly name: string;
        readonly username: string | null;
      }>;
      readonly grant: SetupHostConfigurationGrant;
    }>
  | Readonly<{ readonly status: "busy" }>
  | Readonly<{ readonly status: "precondition-failed" }>
  | Readonly<{
      readonly status: "retryable";
      readonly reason:
        | "credential_store_unavailable"
        | "credential_recovery_required"
        | "rate_limit"
        | "registration_unavailable"
        | "verification_unavailable";
    }>
  | Readonly<{
      readonly status: "blocked";
      readonly reason:
        | "active_credential_invalid"
        | "credential_conflict"
        | "credential_verification_failed"
        | "idempotency_conflict"
        | "identity_mismatch"
        | "local_credential_conflict"
        | "username_unavailable";
      readonly suggestions?: readonly Username[];
      readonly continuation?: SetupUsernameConflictContinuation;
    }>;

export type SetupRegistrationExecutionDiscardResult =
  | Readonly<{ readonly status: "discarded" }>
  | Readonly<{ readonly status: "precondition-failed" }>;

export interface SetupRegistrationExecutionAttempt {
  /* One attempt only; execution burns the approved grant before its first await. */
  execute(): Promise<SetupRegistrationExecutionResult>;
  discard(): SetupRegistrationExecutionDiscardResult;
}

interface SetupHostConfigurationState {
  readonly plan: SetupPreparedPlan<SetupApplyPlan>;
  readonly canonicalDirectory: string;
  readonly cwd: string;
  readonly projection: SetupRegistrationProjectionEvidence | null;
  readonly credential: ActiveCredentialV1;
  readonly credentialEvidence: CredentialStoreWholePassEvidence;
  readonly authority: object | null;
}

export interface SetupHostConfigurationClaim {
  readonly plan: SetupPreparedPlan<SetupApplyPlan>;
  readonly canonicalDirectory: string;
  readonly cwd: string;
  readonly projection: SetupRegistrationProjectionEvidence | null;
  readonly credential: ActiveCredentialV1;
  readonly credentialEvidence: CredentialStoreWholePassEvidence;
}

interface SetupUsernameConflictContinuationState
  extends SetupUsernameConflictContinuationClaim {
  readonly scope: object;
}

interface NormalizedExecutionDependencies {
  readonly storage: CredentialStoreObservedMutationAdapter;
  readonly network: NetworkAdapter;
  readonly clock: ClockAdapter;
  readonly random: RandomAdapter;
  readonly hash: HashAdapter;
}

type CredentialExecutionOutcome =
  | Readonly<{
      readonly status: "active";
      readonly credential: ActiveCredentialV1;
      readonly agent: Readonly<{
        readonly id: string;
        readonly name: string;
        readonly username: string | null;
      }>;
    }>
  | Readonly<{
      readonly status: "username-conflict";
      readonly pending: PendingCredentialV1;
      readonly identity: CredentialKeyIdentity;
      readonly fingerprint: CredentialKeyFingerprint;
      readonly suggestions: readonly Username[];
    }>
  | Exclude<
      SetupRegistrationExecutionResult,
      { readonly status: "ready" } | { readonly status: "busy" }
    >;

export interface SetupProtectedCredential {
  readonly apiOrigin: ApiOrigin;
  readonly identity: CredentialKeyIdentity;
  readonly fingerprint: CredentialKeyFingerprint;
  readonly agent: Readonly<{
    readonly id: string;
    readonly name: string;
    readonly username: string | null;
  }>;
  readonly sources: readonly ["protected-input"];
  readonly lease: SetupSecretLease;
}

export type SetupProtectedCredentialResolutionResult =
  | Readonly<{
      readonly status: "retained";
      readonly credential: SetupProtectedCredential;
    }>
  | Readonly<{ readonly status: "invalid" }>
  | Readonly<{
      readonly status: "indeterminate";
      readonly reason: "credential_validation_unavailable";
    }>
  | Readonly<{ readonly status: "precondition-failed" }>;

const INVALID = Object.freeze({ status: "invalid" as const });
const INDETERMINATE = Object.freeze({
  status: "indeterminate" as const,
  reason: "credential_validation_unavailable" as const,
});
const PRECONDITION_FAILED = Object.freeze({
  status: "precondition-failed" as const,
});
const BUSY = Object.freeze({ status: "busy" as const });
const DISCARDED = Object.freeze({ status: "discarded" as const });
const STORE_UNAVAILABLE = Object.freeze({
  status: "retryable" as const,
  reason: "credential_store_unavailable" as const,
});
const RECOVERY_REQUIRED = Object.freeze({
  status: "retryable" as const,
  reason: "credential_recovery_required" as const,
});
const TOKEN_TO_JSON = Object.freeze(function tokenToJson(): undefined {
  return undefined;
});
const HOST_CONFIGURATION_GRANTS = new WeakMap<
  SetupHostConfigurationGrant,
  SetupHostConfigurationState
>();
const USERNAME_CONFLICT_CONTINUATIONS = new WeakMap<
  SetupUsernameConflictContinuation,
  SetupUsernameConflictContinuationState
>();

/*
 * Today's HTTP and canonical-document ports require an ApiKey string. This is
 * the single reviewed conversion from protected mutable input bytes; the
 * claimed array is wiped on every path, while the unavoidable immutable string
 * remains private execution evidence and never enters a public plan or result.
 */
function apiKeyFromBytes(bytes: Uint8Array): ApiKey | undefined {
  try {
    const value = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    return parseApiKey(value);
  } catch {
    return undefined;
  }
}

function claimedApiKey(bytes: Uint8Array): ApiKey | undefined {
  try {
    return apiKeyFromBytes(bytes);
  } finally {
    wipeUint8Array(bytes);
  }
}

/*
 * Only the coherent setup-observation authority may call this helper. It
 * consumes one protected-input identity, derives only its nonreversible
 * binding from bytes, and transfers the bytes into a private execution lease.
 * A transient string is unavoidable for the read-only pre-plan identity check;
 * it is not retained. The mutable lease survives confirmation and is decoded
 * again only after the approved observed credential-store transaction begins.
 */
export async function transferSetupProtectedCredentialInput(
  network: ReadOnlyNetworkAdapter,
  hash: HashAdapter,
  identity: SetupCredentialInputIdentity,
): Promise<SetupProtectedCredentialResolutionResult> {
  let bytes: Uint8Array | undefined;
  let lease: SetupSecretLease | undefined;
  try {
    bytes = claimSetupCredentialInputBytes(identity);
  } catch {
    return PRECONDITION_FAILED;
  }
  if (bytes === undefined) {
    return PRECONDITION_FAILED;
  }

  try {
    const apiKey = apiKeyFromBytes(bytes);
    if (apiKey === undefined) {
      return PRECONDITION_FAILED;
    }
    const validation = await validateAgentCredential(
      network,
      DEFAULT_API_ORIGIN,
      apiKey,
    );
    if (validation.status === "invalid") {
      return INVALID;
    }
    if (validation.status === "indeterminate") {
      return INDETERMINATE;
    }
    const identified = identifyCredentialKeyBytes(
      DEFAULT_API_ORIGIN,
      bytes,
      "https-only",
      hash,
    );
    lease = createSetupSecretLease(bytes);
    bytes = undefined;
    const credential = {
      apiOrigin: DEFAULT_API_ORIGIN,
      fingerprint: identified.fingerprint,
      agent: Object.freeze({
        id: validation.agent.id,
        name: validation.agent.name,
        username: validation.agent.username,
      }),
      sources: Object.freeze([
        "protected-input" as const,
      ]) as readonly ["protected-input"],
    } as SetupProtectedCredential;
    Object.defineProperty(credential, "identity", {
      configurable: false,
      enumerable: false,
      value: identified.identity,
      writable: false,
    });
    Object.defineProperty(credential, "lease", {
      configurable: false,
      enumerable: false,
      value: lease,
      writable: false,
    });
    const result = Object.freeze({
      status: "retained" as const,
      credential: Object.freeze(credential),
    });
    lease = undefined;
    return result;
  } catch {
    return INDETERMINATE;
  } finally {
    wipeUint8Array(bytes);
    if (lease !== undefined) {
      discardSetupSecretLease(lease);
    }
  }
}

function snapshotExecutionDependencies(
  value: SetupRegistrationExecutionDependencies,
): NormalizedExecutionDependencies | undefined {
  try {
    if (value === null || typeof value !== "object") {
      return undefined;
    }
    const names = Object.getOwnPropertyNames(value);
    const symbols = Object.getOwnPropertySymbols(value);
    const expected = ["storage", "network", "clock", "random", "hash"];
    if (
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null) ||
      symbols.length !== 0 ||
      names.length !== expected.length ||
      names.some((name) => !expected.includes(name))
    ) {
      return undefined;
    }
    const output: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const name of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        return undefined;
      }
      output[name] = descriptor.value;
    }
    return Object.freeze({
      storage: output.storage as CredentialStoreObservedMutationAdapter,
      network: output.network as NetworkAdapter,
      clock: output.clock as ClockAdapter,
      random: output.random as RandomAdapter,
      hash: output.hash as HashAdapter,
    });
  } catch {
    return undefined;
  }
}

function issueHostConfigurationGrant(
  state: SetupHostConfigurationState,
): SetupHostConfigurationGrant {
  const token = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(token, "toJSON", {
    configurable: false,
    enumerable: false,
    value: TOKEN_TO_JSON,
    writable: false,
  });
  const grant = Object.freeze(
    token,
  ) as unknown as SetupHostConfigurationGrant;
  HOST_CONFIGURATION_GRANTS.set(grant, Object.freeze(state));
  return grant;
}

function sameActiveCredential(
  left: ActiveCredentialV1,
  right: ActiveCredentialV1,
): boolean {
  return (
    left.schema_version === right.schema_version &&
    left.state === right.state &&
    left.api_origin === right.api_origin &&
    left.api_key === right.api_key &&
    left.agent_id === right.agent_id &&
    left.agent_name === right.agent_name &&
    left.username === right.username &&
    left.registration_request_id === right.registration_request_id &&
    left.created_at === right.created_at &&
    left.updated_at === right.updated_at &&
    left.activated_at === right.activated_at
  );
}

async function observeExactHostCredentialEvidence(
  authority: CredentialStoreObservationAuthority,
  canonicalDirectory: string,
  expected: ActiveCredentialV1,
): Promise<
  | Readonly<{
      readonly status: "ready";
      readonly evidence: CredentialStoreWholePassEvidence;
    }>
  | Readonly<{ readonly status: "state-changed" | "unavailable" }>
> {
  let inspected;
  try {
    inspected = await authority.inspect({ directory: canonicalDirectory });
  } catch {
    return Object.freeze({ status: "unavailable" as const });
  }
  if (inspected.status !== "available") {
    return Object.freeze({ status: "unavailable" as const });
  }
  if (
    inspected.canonical !== "active" ||
    inspected.transaction !== "clean"
  ) {
    return Object.freeze({ status: "state-changed" as const });
  }
  let redeemed;
  try {
    redeemed = authority.redeem({
      identity: inspected.identity,
      directory: canonicalDirectory,
    });
  } catch {
    return Object.freeze({ status: "unavailable" as const });
  }
  if (
    redeemed.status !== "redeemed" ||
    redeemed.transaction !== null ||
    redeemed.credential?.state !== "active" ||
    !sameActiveCredential(redeemed.credential, expected)
  ) {
    return Object.freeze({ status: "state-changed" as const });
  }
  const evidence = claimCredentialStoreObservationEvidence(
    authority,
    redeemed.evidence,
  );
  return evidence === undefined
    ? Object.freeze({ status: "unavailable" as const })
    : Object.freeze({ status: "ready" as const, evidence });
}

function issueUsernameConflictContinuation(
  state: SetupUsernameConflictContinuationState,
): SetupUsernameConflictContinuation {
  const token = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(token, "toJSON", {
    configurable: false,
    enumerable: false,
    value: TOKEN_TO_JSON,
    writable: false,
  });
  const continuation = Object.freeze(
    token,
  ) as unknown as SetupUsernameConflictContinuation;
  USERNAME_CONFLICT_CONTINUATIONS.set(
    continuation,
    Object.freeze({
      canonicalDirectory: state.canonicalDirectory,
      storeAuthority: state.storeAuthority,
      scope: state.scope,
      pending: Object.freeze({ ...state.pending }),
      suggestions: Object.freeze([...state.suggestions]),
    }),
  );
  return continuation;
}

/*
 * Only the coherent setup-observation authority may redeem this token. The
 * claim burns first so a wrong authority, stale store, or failed reinspection
 * cannot replay the server's authoritative conflict evidence.
 */
export function claimSetupUsernameConflictContinuation(
  continuation: SetupUsernameConflictContinuation,
  scope: object,
): SetupUsernameConflictContinuationClaim | undefined {
  let state: SetupUsernameConflictContinuationState | undefined;
  try {
    state = USERNAME_CONFLICT_CONTINUATIONS.get(continuation);
    if (state !== undefined) {
      USERNAME_CONFLICT_CONTINUATIONS.delete(continuation);
    }
  } catch {
    return undefined;
  }
  return state?.scope === scope ? state : undefined;
}

export function discardSetupUsernameConflictContinuation(
  continuation: SetupUsernameConflictContinuation,
  scope: object,
): SetupRegistrationExecutionDiscardResult {
  try {
    const state = USERNAME_CONFLICT_CONTINUATIONS.get(continuation);
    if (state !== undefined) {
      USERNAME_CONFLICT_CONTINUATIONS.delete(continuation);
    }
    return state?.scope === scope ? DISCARDED : PRECONDITION_FAILED;
  } catch {
    return PRECONDITION_FAILED;
  }
}

function canonicalTimestamp(clock: ClockAdapter): CanonicalTimestamp | undefined {
  try {
    const milliseconds = clock.now();
    if (!Number.isFinite(milliseconds)) {
      return undefined;
    }
    return new Date(milliseconds).toISOString() as CanonicalTimestamp;
  } catch {
    return undefined;
  }
}

function activeCredentialForExistingKey(
  selected: SetupRegistrationResolvedCredential,
  agent: Readonly<{
    readonly id: string;
    readonly name: string;
    readonly username: string | null;
  }>,
  clock: ClockAdapter,
): ActiveCredentialV1 | undefined {
  const installedAt = canonicalTimestamp(clock);
  if (installedAt === undefined) {
    return undefined;
  }
  try {
    const credential = validateCredentialDocument({
      schema_version: 1,
      state: "active",
      api_origin: selected.apiOrigin,
      api_key: selected.apiKey,
      agent_id: agent.id,
      agent_name: agent.name,
      username: agent.username,
      registration_request_id: null,
      created_at: installedAt,
      updated_at: installedAt,
      activated_at: installedAt,
    });
    return credential.state === "active" ? credential : undefined;
  } catch {
    return undefined;
  }
}

function registrationInput(
  evidence: SetupRegistrationExecutionEvidence,
): Readonly<{
  readonly apiOrigin: PendingCredentialV1["api_origin"];
  readonly agentName: AgentName;
  readonly username: Username;
}> | undefined {
  if (evidence.selected.kind === "new-registration") {
    return Object.freeze({
      apiOrigin: DEFAULT_API_ORIGIN,
      agentName: evidence.selected.registration.agent.name as AgentName,
      username: evidence.selected.registration.agent.username as Username,
    });
  }
  if (evidence.selected.kind === "resume-registration") {
    return Object.freeze({
      apiOrigin: evidence.selected.credential.api_origin,
      agentName: evidence.selected.credential.agent_name,
      username: evidence.selected.credential.username,
    });
  }
  if (evidence.selected.kind === "username-conflict-retry") {
    return Object.freeze({
      apiOrigin: evidence.selected.credential.api_origin,
      agentName: evidence.selected.credential.agent_name,
      username: evidence.selected.registration.agent.username as Username,
    });
  }
  return undefined;
}

function blockedRegistrationResult(
  result: Extract<RecoverableRegistrationResult, { status: "blocked" }>,
  suggestions?: readonly Username[],
): Extract<SetupRegistrationExecutionResult, { status: "blocked" }> {
  return Object.freeze({
    status: "blocked" as const,
    reason: result.reason,
    ...(result.reason === "username_unavailable" && suggestions !== undefined
      ? { suggestions: Object.freeze([...suggestions]) }
      : {}),
  });
}

function publicUsernameConflictResult(
  evidence: SetupRegistrationExecutionEvidence,
  outcome: Extract<CredentialExecutionOutcome, { status: "username-conflict" }>,
): Extract<SetupRegistrationExecutionResult, { status: "blocked" }> {
  const continuation = issueUsernameConflictContinuation({
    canonicalDirectory: evidence.canonicalDirectory,
    storeAuthority: evidence.storeAuthority,
    scope: evidence.continuationScope,
    pending: Object.freeze({
      apiOrigin: outcome.pending.api_origin,
      identity: outcome.identity,
      fingerprint: outcome.fingerprint,
      agentName: outcome.pending.agent_name,
      username: outcome.pending.username,
      registrationRequestId: outcome.pending.registration_request_id,
      createdAt: outcome.pending.created_at,
      updatedAt: outcome.pending.updated_at,
    }),
    suggestions: outcome.suggestions,
  });
  const result = {
    status: "blocked" as const,
    reason: "username_unavailable" as const,
    ...(outcome.suggestions.length > 0
      ? { suggestions: outcome.suggestions }
      : {}),
  } as Extract<SetupRegistrationExecutionResult, { status: "blocked" }> &
    Record<string, unknown>;
  Object.defineProperty(result, "continuation", {
    configurable: false,
    enumerable: false,
    value: continuation,
    writable: false,
  });
  return Object.freeze(result);
}

function retryableRegistrationResult(
  result: Extract<RecoverableRegistrationResult, { status: "retryable" }>,
): Extract<SetupRegistrationExecutionResult, { status: "retryable" }> {
  return Object.freeze({
    status: "retryable" as const,
    reason: result.reason,
  });
}

function sameAgentIdentity(
  left: Readonly<{
    readonly id: string;
    readonly name: string;
    readonly username: string | null;
  }>,
  right: Readonly<{
    readonly id: string;
    readonly name: string;
    readonly username: string | null;
  }>,
): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.username === right.username
  );
}

function exactCredentialEffect(
  plan: SetupPreparedPlan<SetupApplyPlan>,
  evidence: SetupRegistrationExecutionEvidence,
): boolean {
  const credentialPlan = plan.execution.credential;
  const canonical = evidence.store.credential;
  if (credentialPlan.acquisition === "existing") {
    return credentialPlan.canonicalEffect === "unchanged"
      ? canonical?.state === "active"
      : credentialPlan.canonicalEffect === "create"
        ? canonical === null
        : credentialPlan.canonicalEffect === "replace" &&
          canonical?.state === "active";
  }
  if (credentialPlan.acquisition === "new-registration") {
    return credentialPlan.canonicalEffect === "create"
      ? canonical === null
      : credentialPlan.canonicalEffect === "replace" &&
        canonical?.state === "active";
  }
  return (
    credentialPlan.canonicalEffect === "resume" &&
    canonical?.state === "pending" &&
    (evidence.selected.kind === "resume-registration" ||
      evidence.selected.kind === "username-conflict-retry") &&
    evidence.selected.credential === canonical
  );
}

async function revalidateReplacementPremise(
  dependencies: NormalizedExecutionDependencies,
  plan: SetupPreparedPlan<SetupApplyPlan>,
  evidence: SetupRegistrationExecutionEvidence,
): Promise<CredentialExecutionOutcome | undefined> {
  const credentialPlan = plan.execution.credential;
  if (
    credentialPlan.canonicalEffect !== "replace" ||
    credentialPlan.reason !== "canonical-credential-invalid"
  ) {
    return undefined;
  }
  const canonical = evidence.store.credential;
  if (canonical?.state !== "active") {
    return PRECONDITION_FAILED;
  }
  const validation = await validateAgentCredential(
    dependencies.network,
    canonical.api_origin,
    canonical.api_key,
  );
  if (validation.status === "indeterminate") {
    return Object.freeze({
      status: "retryable" as const,
      reason: "verification_unavailable" as const,
    });
  }
  return validation.status === "invalid" ? undefined : PRECONDITION_FAILED;
}

async function verifyPersistedCredential(
  dependencies: NormalizedExecutionDependencies,
  credential: ActiveCredentialV1,
): Promise<CredentialExecutionOutcome> {
  const validation = await validateAgentCredential(
    dependencies.network,
    credential.api_origin,
    credential.api_key,
  );
  if (validation.status === "indeterminate") {
    return Object.freeze({
      status: "retryable" as const,
      reason: "verification_unavailable" as const,
    });
  }
  if (validation.status === "invalid") {
    return Object.freeze({
      status: "blocked" as const,
      reason: "credential_verification_failed" as const,
    });
  }
  if (validation.agent.id !== credential.agent_id) {
    return Object.freeze({
      status: "blocked" as const,
      reason: "identity_mismatch" as const,
    });
  }
  return Object.freeze({
    status: "active" as const,
    credential,
    agent: Object.freeze({
      id: validation.agent.id,
      name: validation.agent.name,
      username: validation.agent.username,
    }),
  });
}

async function executeExistingCredential(
  dependencies: NormalizedExecutionDependencies,
  session: ExclusiveObservedCredentialSetupSession,
  plan: SetupPreparedPlan<SetupApplyPlan>,
  evidence: SetupRegistrationExecutionEvidence,
): Promise<CredentialExecutionOutcome> {
  const selectedEvidence = evidence.selected;
  const credentialPlan = plan.execution.credential;
  let selected: SetupRegistrationResolvedCredential;
  let expectedAgentId: string | null;
  if (selectedEvidence.kind === "protected-input") {
    if (
      credentialPlan.acquisition !== "existing" ||
      selectedEvidence.credential.apiOrigin !== credentialPlan.apiOrigin ||
      selectedEvidence.credential.fingerprint !==
        credentialPlan.credential.fingerprint ||
      !sameAgentIdentity(
        selectedEvidence.credential.agent,
        credentialPlan.credential.agent,
      )
    ) {
      return PRECONDITION_FAILED;
    }
    const bytes = claimSetupSecretLeaseBytes(
      selectedEvidence.credential.lease,
    );
    if (bytes === undefined) {
      return PRECONDITION_FAILED;
    }
    const apiKey = claimedApiKey(bytes);
    if (apiKey === undefined) {
      return PRECONDITION_FAILED;
    }
    selected = Object.freeze({
      apiOrigin: selectedEvidence.credential.apiOrigin,
      apiKey,
      identity: selectedEvidence.credential.identity,
      fingerprint: selectedEvidence.credential.fingerprint,
      agent: selectedEvidence.credential.agent,
      sources: selectedEvidence.credential.sources,
    });
    expectedAgentId = selectedEvidence.credential.agent.id;
  } else {
    if (
      selectedEvidence.kind !== "existing" ||
      credentialPlan.acquisition !== "existing" ||
      selectedEvidence.credential.apiOrigin !== credentialPlan.apiOrigin ||
      selectedEvidence.credential.fingerprint !==
        credentialPlan.credential.fingerprint ||
      !sameAgentIdentity(
        selectedEvidence.credential.agent,
        credentialPlan.credential.agent,
      )
    ) {
      return PRECONDITION_FAILED;
    }
    selected = selectedEvidence.credential;
    expectedAgentId = selected.agent.id;
  }

  const identified = identifyCredentialKey(
    selected.apiOrigin,
    selected.apiKey,
    "https-only",
    dependencies.hash,
  );
  if (
    identified.identity !== selected.identity ||
    identified.fingerprint !== selected.fingerprint
  ) {
    return PRECONDITION_FAILED;
  }
  const validation = await validateAgentCredential(
    dependencies.network,
    selected.apiOrigin,
    selected.apiKey,
  );
  if (validation.status === "indeterminate") {
    return Object.freeze({
      status: "retryable" as const,
      reason: "verification_unavailable" as const,
    });
  }
  if (validation.status === "invalid") {
    return Object.freeze({
      status: "blocked" as const,
      reason:
        credentialPlan.disposition === "reuse"
          ? ("active_credential_invalid" as const)
          : ("credential_verification_failed" as const),
    });
  }
  if (
    expectedAgentId !== null &&
    validation.agent.id !== expectedAgentId
  ) {
    return Object.freeze({
      status: "blocked" as const,
      reason: "identity_mismatch" as const,
    });
  }

  let installed: ActiveCredentialV1;
  if (credentialPlan.canonicalEffect === "unchanged") {
    const expected = evidence.store.credential;
    if (
      expected === null ||
      expected.state !== "active" ||
      expected.api_origin !== selected.apiOrigin ||
      expected.api_key !== selected.apiKey ||
      expected.agent_id !== validation.agent.id
    ) {
      return PRECONDITION_FAILED;
    }
    const reread = await session.readExactCredential(expected);
    if (reread === null || reread.state !== "active") {
      return PRECONDITION_FAILED;
    }
    installed = reread;
  } else {
    const desired = activeCredentialForExistingKey(
      selected,
      validation.agent,
      dependencies.clock,
    );
    if (desired === undefined) {
      return STORE_UNAVAILABLE;
    }
    await session.writeExactCredential(evidence.store.credential, desired);
    const reread = await session.readExactCredential(desired);
    if (reread === null || reread.state !== "active") {
      return PRECONDITION_FAILED;
    }
    installed = reread;
  }
  return verifyPersistedCredential(dependencies, installed);
}

async function usernameSuggestions(
  dependencies: NormalizedExecutionDependencies,
  apiOrigin: ApiOrigin,
  username: Username,
): Promise<readonly Username[] | undefined> {
  const availability = await checkAgentUsernameAvailability(
    dependencies.network,
    apiOrigin,
    username,
  );
  return availability.status === "unavailable"
    ? availability.suggestions
    : undefined;
}

async function authoritativeUsernameConflict(
  dependencies: NormalizedExecutionDependencies,
  session: ExclusiveObservedCredentialSetupSession,
  input: Readonly<{
    readonly apiOrigin: PendingCredentialV1["api_origin"];
    readonly agentName: AgentName;
    readonly username: Username;
  }>,
  expectedIdentity: CredentialKeyIdentity | null,
): Promise<CredentialExecutionOutcome> {
  let observed;
  try {
    observed = await session.readOrCreatePending(() => {
      throw new CredentialError("credential_store_conflict");
    });
  } catch {
    return PRECONDITION_FAILED;
  }
  if (
    observed.status !== "pending-resumed" ||
    observed.credential.api_origin !== input.apiOrigin ||
    observed.credential.agent_name !== input.agentName ||
    observed.credential.username !== input.username
  ) {
    return PRECONDITION_FAILED;
  }
  const identified = identifyCredentialKey(
    observed.credential.api_origin,
    observed.credential.api_key,
    "https-only",
    dependencies.hash,
  );
  if (
    expectedIdentity !== null &&
    identified.identity !== expectedIdentity
  ) {
    return PRECONDITION_FAILED;
  }
  const suggestions = await usernameSuggestions(
    dependencies,
    input.apiOrigin,
    input.username,
  );
  return Object.freeze({
    status: "username-conflict" as const,
    pending: observed.credential,
    identity: identified.identity,
    fingerprint: identified.fingerprint,
    suggestions: Object.freeze([...(suggestions ?? [])]),
  });
}

async function executeRegistration(
  dependencies: NormalizedExecutionDependencies,
  session: ExclusiveObservedCredentialSetupSession,
  plan: SetupPreparedPlan<SetupApplyPlan>,
  evidence: SetupRegistrationExecutionEvidence,
): Promise<CredentialExecutionOutcome> {
  const credentialPlan = plan.execution.credential;
  const input = registrationInput(evidence);
  const acquisition = credentialPlan.acquisition;
  if (
    input === undefined ||
    (acquisition !== "new-registration" &&
      acquisition !== "resume-registration" &&
      acquisition !== "username-conflict-retry") ||
    input.apiOrigin !== credentialPlan.apiOrigin ||
    input.agentName !== credentialPlan.registration.agent.name ||
    input.username !== credentialPlan.registration.agent.username ||
    credentialPlan.registration.mode !==
      (acquisition === "new-registration"
        ? "new"
        : acquisition === "resume-registration"
          ? "resume"
          : "username-retry")
  ) {
    return PRECONDITION_FAILED;
  }

  let approvedActiveReplacement: ActiveCredentialV1 | undefined;
  let expectedPendingIdentity: CredentialKeyIdentity | null = null;
  if (acquisition === "new-registration") {
    if (
      evidence.selected.kind !== "new-registration" ||
      evidence.selected.registration.mode !== credentialPlan.registration.mode ||
      evidence.selected.registration.agent.name !==
        credentialPlan.registration.agent.name ||
      evidence.selected.registration.agent.username !==
        credentialPlan.registration.agent.username
    ) {
      return PRECONDITION_FAILED;
    }
    const availability = await checkAgentUsernameAvailability(
      dependencies.network,
      input.apiOrigin,
      input.username,
    );
    if (availability.status === "unavailable") {
      return Object.freeze({
        status: "blocked" as const,
        reason: "username_unavailable" as const,
        suggestions: availability.suggestions,
      });
    }
    if (evidence.store.credential !== null) {
      if (
        credentialPlan.canonicalEffect !== "replace" ||
        evidence.store.credential.state !== "active"
      ) {
        return PRECONDITION_FAILED;
      }
      approvedActiveReplacement = evidence.store.credential;
    }
  } else if (acquisition === "resume-registration") {
    if (
      evidence.selected.kind !== "resume-registration" ||
      evidence.store.credential !== evidence.selected.credential ||
      evidence.selected.credential.api_origin !== input.apiOrigin ||
      evidence.selected.credential.agent_name !== input.agentName ||
      evidence.selected.credential.username !== input.username
    ) {
      return PRECONDITION_FAILED;
    }
    const identified = identifyCredentialKey(
      evidence.selected.credential.api_origin,
      evidence.selected.credential.api_key,
      "https-only",
      dependencies.hash,
    );
    if (identified.identity !== evidence.selected.identity) {
      return PRECONDITION_FAILED;
    }
    expectedPendingIdentity = evidence.selected.identity;
  } else {
    if (
      evidence.selected.kind !== "username-conflict-retry" ||
      evidence.store.credential !== evidence.selected.credential ||
      evidence.selected.credential.api_origin !== input.apiOrigin ||
      evidence.selected.credential.agent_name !== input.agentName ||
      evidence.selected.credential.username !==
        credentialPlan.registration.previousUsername ||
      evidence.selected.registration.mode !== "username-retry" ||
      evidence.selected.registration.agent.name !== input.agentName ||
      evidence.selected.registration.agent.username !== input.username ||
      input.username === evidence.selected.credential.username
    ) {
      return PRECONDITION_FAILED;
    }
    const identified = identifyCredentialKey(
      evidence.selected.credential.api_origin,
      evidence.selected.credential.api_key,
      "https-only",
      dependencies.hash,
    );
    if (
      identified.identity !== evidence.selected.identity ||
      identified.fingerprint !== credentialPlan.registration.fingerprint
    ) {
      return PRECONDITION_FAILED;
    }
    const pendingValidation = await validateAgentCredential(
      dependencies.network,
      evidence.selected.credential.api_origin,
      evidence.selected.credential.api_key,
    );
    if (pendingValidation.status === "indeterminate") {
      return Object.freeze({
        status: "retryable" as const,
        reason: "verification_unavailable" as const,
      });
    }
    if (pendingValidation.status === "valid") {
      return PRECONDITION_FAILED;
    }
    const availability = await checkAgentUsernameAvailability(
      dependencies.network,
      input.apiOrigin,
      input.username,
    );
    if (availability.status === "unavailable") {
      return Object.freeze({
        status: "username-conflict" as const,
        pending: evidence.selected.credential,
        identity: identified.identity,
        fingerprint: identified.fingerprint,
        suggestions: availability.suggestions,
      });
    }
    const previous = evidence.selected.credential;
    const replaced = await session.replaceUsernameAfterConflict(
      input.username,
      () => dependencies.random.uuid() as RegistrationRequestId,
    );
    if (
      replaced.status !== "pending-replaced" ||
      replaced.credential.api_origin !== previous.api_origin ||
      replaced.credential.api_key !== previous.api_key ||
      replaced.credential.agent_name !== previous.agent_name ||
      replaced.credential.username !== input.username ||
      replaced.credential.registration_request_id ===
        previous.registration_request_id ||
      replaced.credential.created_at !== previous.created_at
    ) {
      return PRECONDITION_FAILED;
    }
    const replacedIdentity = identifyCredentialKey(
      replaced.credential.api_origin,
      replaced.credential.api_key,
      "https-only",
      dependencies.hash,
    );
    if (replacedIdentity.identity !== evidence.selected.identity) {
      return PRECONDITION_FAILED;
    }
    expectedPendingIdentity = evidence.selected.identity;
  }

  const operationDependencies: RecoverableRegistrationOperationDependencies =
    Object.freeze({
      network: dependencies.network,
      clock: dependencies.clock,
      random: dependencies.random,
      hash: dependencies.hash,
    });
  const registration = await runRecoverableAgentRegistrationInSession(
    operationDependencies,
    session,
    input,
    approvedActiveReplacement,
  );
  if (registration.status === "busy") {
    return PRECONDITION_FAILED;
  }
  if (registration.status === "retryable") {
    return retryableRegistrationResult(registration);
  }
  if (registration.status === "blocked") {
    return registration.reason === "username_unavailable"
      ? authoritativeUsernameConflict(
          dependencies,
          session,
          input,
          expectedPendingIdentity,
        )
      : blockedRegistrationResult(registration);
  }

  const persisted = await session.readActiveCredential();
  if (
    !sameAgentIdentity(
      {
        id: persisted.agent_id,
        name: persisted.agent_name,
        username: persisted.username,
      },
      registration.agent,
    ) ||
    persisted.agent_name !== input.agentName ||
    persisted.username !== input.username
  ) {
    return Object.freeze({
      status: "blocked" as const,
      reason: "identity_mismatch" as const,
    });
  }
  return verifyPersistedCredential(dependencies, persisted);
}

async function executeCredentialTransition(
  dependencies: NormalizedExecutionDependencies,
  session: ExclusiveObservedCredentialSetupSession,
  plan: SetupPreparedPlan<SetupApplyPlan>,
  evidence: SetupRegistrationExecutionEvidence,
): Promise<CredentialExecutionOutcome> {
  if (!exactCredentialEffect(plan, evidence)) {
    return PRECONDITION_FAILED;
  }
  const replacementPremise = await revalidateReplacementPremise(
    dependencies,
    plan,
    evidence,
  );
  if (replacementPremise !== undefined) {
    return replacementPremise;
  }
  return plan.execution.credential.acquisition === "existing"
    ? executeExistingCredential(dependencies, session, plan, evidence)
    : executeRegistration(dependencies, session, plan, evidence);
}

function mapCredentialFailure(error: unknown): SetupRegistrationExecutionResult {
  if (error instanceof CredentialError) {
    if (error.code === "credential_recovery_required") {
      return RECOVERY_REQUIRED;
    }
    if (error.code === "credential_store_busy") {
      return BUSY;
    }
    if (error.code === "credential_store_conflict") {
      return Object.freeze({
        status: "blocked" as const,
        reason: "local_credential_conflict" as const,
      });
    }
  }
  return STORE_UNAVAILABLE;
}

function discardExecutionSecret(
  evidence: SetupRegistrationExecutionEvidence | undefined,
): void {
  if (evidence?.selected.kind === "protected-input") {
    discardSetupSecretLease(evidence.selected.credential.lease);
  }
}

export function createSetupRegistrationExecutionAttempt(
  authority: SetupExecutionAuthority,
  plan: SetupPreparedPlan<SetupApplyPlan>,
  grant: SetupExecutionGrant,
  rawDependencies: SetupRegistrationExecutionDependencies,
  hostConfigurationAuthority: object | null = null,
): SetupRegistrationExecutionAttempt {
  const dependencies = snapshotExecutionDependencies(rawDependencies);
  let state: "ready" | "running" | "settled" = "ready";

  return Object.freeze({
    async execute(): Promise<SetupRegistrationExecutionResult> {
      if (state !== "ready") {
        return PRECONDITION_FAILED;
      }
      state = "running";

      let evidence: SetupRegistrationExecutionEvidence | undefined;
      let wholePassEvidence;
      try {
        const claimed = claimSetupExecutionGrant(authority, plan, grant);
        evidence = claimed as SetupRegistrationExecutionEvidence;
        wholePassEvidence = claimCredentialStoreObservationEvidence(
          evidence.storeAuthority,
          evidence.store.evidence,
        );
      } catch {
        discardExecutionSecret(evidence);
        state = "settled";
        return PRECONDITION_FAILED;
      }

      try {
        if (
          evidence === undefined ||
          dependencies === undefined ||
          wholePassEvidence === undefined ||
          evidence.store.transaction !== null
        ) {
          return PRECONDITION_FAILED;
        }
        const execution = await runExclusiveObservedCredentialSetup(
          {
            storage: dependencies.storage,
            random: dependencies.random,
            clock: dependencies.clock,
          },
          { directory: evidence.canonicalDirectory },
          Object.freeze({
            credential: evidence.store.credential,
            transaction: null,
            temporaryEntries: "empty" as const,
            evidence: wholePassEvidence,
          }),
          (session) =>
            executeCredentialTransition(
              dependencies,
              session,
              plan,
              evidence,
            ),
        );
        if (execution.status === "busy") {
          return BUSY;
        }
        if (execution.status === "precondition-failed") {
          return PRECONDITION_FAILED;
        }
        if (execution.value.status === "username-conflict") {
          return publicUsernameConflictResult(evidence, execution.value);
        }
        if (execution.value.status !== "active") {
          return execution.value;
        }

        const credentialGuard = await observeExactHostCredentialEvidence(
          evidence.storeAuthority,
          evidence.canonicalDirectory,
          execution.value.credential,
        );
        if (credentialGuard.status !== "ready") {
          return credentialGuard.status === "state-changed"
            ? PRECONDITION_FAILED
            : STORE_UNAVAILABLE;
        }

        const hostGrant = issueHostConfigurationGrant({
          plan,
          canonicalDirectory: evidence.canonicalDirectory,
          cwd: evidence.cwd,
          projection: evidence.projection,
          credential: execution.value.credential,
          credentialEvidence: credentialGuard.evidence,
          authority: hostConfigurationAuthority,
        });
        return Object.freeze({
          status: "ready" as const,
          agent: execution.value.agent,
          grant: hostGrant,
        });
      } catch (error) {
        return mapCredentialFailure(error);
      } finally {
        discardExecutionSecret(evidence);
        state = "settled";
      }
    },

    discard(): SetupRegistrationExecutionDiscardResult {
      if (state !== "ready") {
        return PRECONDITION_FAILED;
      }
      state = "settled";
      return authority.discard(grant).status === "discarded"
        ? DISCARDED
        : PRECONDITION_FAILED;
    },
  });
}

/*
 * Only the factory-owned Step 4.8.6 executor may redeem this capability. The
 * grant burns before authority and plan checks, and the returned claim exposes
 * only the exact post-persistence data needed for Codex projection and host
 * execution. It must never enter a renderer, callback, or serializable result.
 */
export function claimSetupHostConfigurationGrant(
  grant: SetupHostConfigurationGrant,
  authority: object,
  plan: SetupPreparedPlan<SetupApplyPlan>,
): SetupHostConfigurationClaim | undefined {
  let state: SetupHostConfigurationState | undefined;
  try {
    state = HOST_CONFIGURATION_GRANTS.get(grant);
    if (state !== undefined) {
      HOST_CONFIGURATION_GRANTS.delete(grant);
    }
  } catch {
    return undefined;
  }
  if (
    state === undefined ||
    state.authority !== authority ||
    state.plan !== plan
  ) {
    return undefined;
  }
  return Object.freeze({
    plan: state.plan,
    canonicalDirectory: state.canonicalDirectory,
    cwd: state.cwd,
    projection: state.projection,
    credential: state.credential,
    credentialEvidence: state.credentialEvidence,
  });
}

export function discardSetupHostConfigurationGrant(
  grant: SetupHostConfigurationGrant,
): SetupRegistrationExecutionDiscardResult {
  return HOST_CONFIGURATION_GRANTS.delete(grant)
    ? DISCARDED
    : PRECONDITION_FAILED;
}
