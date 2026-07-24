import {
  prepareSetupApplyPlan,
  type SetupApplyPlan,
} from "../commands/setup-apply-plan.js";
import {
  isOwnedSetupApprovalAuthority,
  type SetupApprovalAuthority,
  type SetupPreparedPlan,
} from "../commands/setup-approval.js";
import {
  createSetupConfirmationAttempt,
  type SetupConfirmationAttempt,
  type SetupConfirmationMode,
  type SetupInteractiveConfirmation,
  type SetupPlanPresenter,
} from "../commands/setup-confirmation.js";
import {
  planSetupCodexProjection,
  type SetupCodexProjectionPlanningResult,
  type SetupCodexProjectionRelation,
  type SetupCodexProjectionResolvedPlan,
} from "../commands/setup-codex-projection-plan.js";
import {
  planSetupCredential,
  SETUP_CREDENTIAL_SOURCES,
  type SetupCanonicalCredentialObservation,
  type SetupCredentialCandidate,
  type SetupCredentialPlanningBlocker,
  type SetupCredentialPlanningDecision,
  type SetupCredentialPlanningObservation,
  type SetupCredentialPlanningResult,
  type SetupCredentialResolvedPlan,
  type SetupCredentialSource,
} from "../commands/setup-credential-plan.js";
import {
  discardSetupCredentialInput,
  type SetupCredentialInputIdentity,
} from "../commands/setup-credential-input.js";
import {
  createSetupHostExecutionAuthority,
  isOwnedSetupHostExecutionAuthority,
  type SetupHostExecutionAuthority,
  type SetupHostExecutionAttempt,
  type SetupHostExecutionDependencies,
} from "../commands/setup-host-execution.js";
import {
  createSetupCredentialSessionAuthority,
  isOwnedSetupCredentialSessionAuthority,
  type SetupCredentialSessionAuthority,
} from "../commands/setup-credential-session.js";
import {
  claimSetupUsernameConflictContinuation,
  createSetupRegistrationExecutionAttempt,
  discardSetupHostConfigurationGrant,
  discardSetupUsernameConflictContinuation,
  transferSetupProtectedCredentialInput,
  type SetupRegistrationExecutionAttempt,
  type SetupRegistrationExecutionDependencies,
  type SetupRegistrationExecutionEvidence,
  type SetupRegistrationProjectionEvidence,
  type SetupRegistrationResolvedCredential,
  type SetupRegistrationSelectedEvidence,
  type SetupProtectedCredential,
  type SetupHostConfigurationGrant,
  type SetupUsernameConflictContinuation,
  type SetupUsernameConflictContinuationClaim,
} from "../commands/setup-registration-execution.js";
import {
  createSetupExecutionAuthority,
  type SetupExecutionDiscardResult,
  type SetupExecutionGrant,
  type SetupExecutionSidecarIdentity,
} from "../commands/setup-execution-authority.js";
import {
  retainedSetupHostPlans,
  retainedSetupPreflightEnvironment,
  isRetainedSetupPreflightHostAuthority,
  type SetupPreflightSnapshot,
} from "../commands/setup-preflight.js";
import {
  copySetupSecretLeaseBytes,
  discardSetupSecretLease,
  isOwnedSetupSecretLease,
  type SetupSecretLease,
} from "../commands/setup-secret-lease.js";
import {
  discoverCredentialsFromCanonicalObservation,
  type CredentialCandidateSummary,
  type CredentialDiscoveryBlocker,
  type CredentialDiscoveryResult,
  type CredentialDiscoverySource,
  type ObservedCredentialDiscoveryDependencies,
} from "./discovery.js";
import {
  identifyCredentialKey,
  type CredentialKeyIdentity,
} from "./fingerprint.js";
import type {
  CodexDotenvCredentialExpectation,
  CodexDotenvProjectionAdapter,
  CodexDotenvProjectionStatus,
} from "./codex-dotenv-contracts.js";
import {
  isOwnedCodexDotenvProjectionAdapter,
} from "./codex-dotenv-projection.js";
import {
  parseApiKey,
  type ApiKey,
  type CredentialV1,
  type PendingCredentialV1,
} from "./schema.js";
import type { CredentialStoreReadResult } from "./store.js";
import type {
  CredentialStoreObservationAuthority,
  CredentialStoreObservationEvidence,
} from "./store-observation-contracts.js";
import {
  isOwnedCredentialStoreObservationAuthority,
} from "./store-observer.js";
import type { CredentialReplaceTransactionV1 } from "./store-transaction.js";
import {
  containsHostControlCharacter,
  containsHostSensitiveMaterial,
} from "../hosts/privacy.js";
import { wipeUint8Array } from "../data/uint8-array.js";

declare const codexDotenvSetupObservationBrand: unique symbol;

export interface CodexDotenvSetupObservationIdentity {
  readonly [codexDotenvSetupObservationBrand]: never;
}

export type CodexDotenvSetupDiscoveryDependencies = Omit<
  ObservedCredentialDiscoveryDependencies,
  "canonical"
>;

export interface CodexDotenvSetupObservationOptions {
  readonly approval: SetupApprovalAuthority;
  readonly store: CredentialStoreObservationAuthority;
  readonly discovery: CodexDotenvSetupDiscoveryDependencies;
  /*
   * Optional only for read-only planning authorities. Executable setup binds
   * this complete adapter set before inspection; it is never caller-supplied
   * after approval.
   */
  readonly execution?: SetupRegistrationExecutionDependencies;
  readonly hostExecution?: SetupHostExecutionDependencies;
  readonly codexProjection?: CodexDotenvProjectionAdapter;
  readonly preflight: SetupPreflightSnapshot;
}

export type CodexDotenvSetupInspectionResult =
  | Readonly<{
      readonly status: "available";
      readonly identity: CodexDotenvSetupObservationIdentity;
      readonly observation: SetupCredentialPlanningObservation;
      readonly initial: SetupCredentialPlanningResult;
    }>
  | Readonly<{
      readonly status: "unavailable";
      readonly observation: SetupCredentialPlanningObservation;
      readonly initial: SetupCredentialPlanningResult;
    }>
  | Readonly<{ readonly status: "precondition-failed" }>;

export interface CodexDotenvSetupPrepareRequest {
  readonly identity: CodexDotenvSetupObservationIdentity;
  readonly decision: SetupCredentialPlanningDecision;
  readonly operationId: string;
  readonly createdAt: string;
}

export interface CodexDotenvSetupCredentialInputRequest {
  readonly identity: CodexDotenvSetupObservationIdentity;
  readonly credential: SetupCredentialInputIdentity;
}

export type CodexDotenvSetupPrepareResult =
  | Readonly<{
      readonly status: "prepared";
      readonly plan: SetupPreparedPlan<SetupApplyPlan>;
      readonly sidecar: SetupExecutionSidecarIdentity;
    }>
  | Readonly<{
      readonly status: "blocked";
      readonly stage: "credential";
      readonly credential: SetupCredentialPlanningResult;
    }>
  | Readonly<{
      readonly status: "blocked";
      readonly stage: "preflight";
      readonly reason: "preflight-not-executable";
    }>
  | Readonly<{
      readonly status: "blocked";
      readonly stage: "codex-projection";
      readonly projection: SetupCodexProjectionPlanningResult;
    }>
  | Readonly<{ readonly status: "precondition-failed" }>;

export interface CodexDotenvSetupObservationAuthority {
  inspect(): Promise<CodexDotenvSetupInspectionResult>;
  /*
   * Add or replace one protected-input candidate before the apply plan is
   * prepared. The observation identity and credential identity are both
   * consumed on every attempt; success returns a fresh observation identity.
   */
  resolveCredentialInput(
    request: CodexDotenvSetupCredentialInputRequest,
  ): Promise<CodexDotenvSetupInspectionResult>;
  /*
   * Consume one authoritative registration-conflict continuation and bind a
   * fresh exact store observation to a new username decision and approval.
   */
  inspectUsernameConflict(
    continuation: SetupUsernameConflictContinuation,
  ): Promise<CodexDotenvSetupInspectionResult>;
  /*
   * The caller must resolve any selection or registration input reported by
   * inspect().initial before this single prepare attempt. Incomplete decisions
   * fail closed and consume the observation rather than minting a continuation.
   */
  prepare(
    request: CodexDotenvSetupPrepareRequest,
  ): Promise<CodexDotenvSetupPrepareResult>;
  createConfirmation(
    plan: SetupPreparedPlan<SetupApplyPlan>,
    sidecar: SetupExecutionSidecarIdentity,
    mode: SetupConfirmationMode,
    presenter: SetupPlanPresenter,
    confirmation: SetupInteractiveConfirmation | null,
  ): SetupConfirmationAttempt;
  createRegistrationExecution(
    plan: SetupPreparedPlan<SetupApplyPlan>,
    grant: SetupExecutionGrant,
  ): SetupRegistrationExecutionAttempt;
  createHostExecution(
    plan: SetupPreparedPlan<SetupApplyPlan>,
    grant: SetupHostConfigurationGrant,
  ): SetupHostExecutionAttempt;
  discard(
    identity:
      | CodexDotenvSetupObservationIdentity
      | SetupExecutionSidecarIdentity
      | SetupExecutionGrant
      | SetupUsernameConflictContinuation,
  ): SetupExecutionDiscardResult;
}

interface RetainedStoreObservation {
  readonly credential: CredentialV1 | null;
  readonly transaction: CredentialReplaceTransactionV1 | null;
  readonly evidence: CredentialStoreObservationEvidence;
}

interface RetainedSetupObservation {
  readonly observation: SetupCredentialPlanningObservation;
  readonly candidates: ReadonlyMap<string, RetainedResolvedCredential>;
  readonly pendingIdentity: CredentialKeyIdentity | null;
  readonly usernameConflict: SetupUsernameConflictContinuationClaim | null;
  readonly store: RetainedStoreObservation;
}

type RetainedResolvedCredential =
  | SetupRegistrationResolvedCredential
  | SetupProtectedCredential;

const TOKEN_TO_JSON = Object.freeze(function tokenToJson(): undefined {
  return undefined;
});
const PRECONDITION_FAILED = Object.freeze({
  status: "precondition-failed" as const,
});
const MAX_PATH_CHARACTERS = 32_767;
const EXECUTABLE_CLASSIFICATIONS = new Set([
  "healthy",
  "healthy-newer",
  "needs-changes",
]);

export class CodexDotenvSetupObservationError extends Error {
  readonly code = "invalid_setup_observation";

  constructor() {
    super("The setup observation could not be composed safely.");
    this.name = "CodexDotenvSetupObservationError";
  }
}

function invalid(): never {
  throw new CodexDotenvSetupObservationError();
}

interface DataSnapshot {
  readonly names: readonly string[];
  readonly values: Readonly<Record<string, unknown>>;
}

function snapshotDataObject(value: unknown): DataSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid();
  }
  let prototype: object | null;
  let names: string[];
  let symbols: symbol[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    names = Object.getOwnPropertyNames(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return invalid();
  }
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    symbols.length !== 0
  ) {
    return invalid();
  }
  const copied: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const name of names) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, name);
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
    copied[name] = descriptor.value;
  }
  return Object.freeze({
    names: Object.freeze([...names]),
    values: Object.freeze(copied),
  });
}

function exactDataObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = Object.freeze([]),
): Readonly<Record<string, unknown>> {
  const snapshot = snapshotDataObject(value);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((name) => !snapshot.names.includes(name)) ||
    snapshot.names.some((name) => !allowed.has(name))
  ) {
    return invalid();
  }
  return snapshot.values;
}

interface NormalizedSetupObservationOptions {
  readonly approval: SetupApprovalAuthority;
  readonly store: CredentialStoreObservationAuthority;
  readonly discovery: CodexDotenvSetupDiscoveryDependencies;
  readonly execution?: SetupRegistrationExecutionDependencies;
  readonly hostExecution?: SetupHostExecutionDependencies;
  readonly codexProjection?: CodexDotenvProjectionAdapter;
  readonly preflight: SetupPreflightSnapshot;
}

function normalizeOptions(
  value: unknown,
): NormalizedSetupObservationOptions {
  const object = exactDataObject(
    value,
    ["approval", "store", "discovery", "preflight"],
    ["codexProjection", "execution", "hostExecution"],
  );
  const discovery = exactDataObject(object.discovery, [
    "credentialEnvironment",
    "legacyStore",
    "network",
    "hash",
    "platform",
  ]);
  const execution = Object.hasOwn(object, "execution")
    ? exactDataObject(object.execution, [
        "storage",
        "network",
        "clock",
        "random",
        "hash",
      ])
    : undefined;
  const hostExecution = Object.hasOwn(object, "hostExecution")
    ? exactDataObject(object.hostExecution, [
        "hosts",
        "journal",
        "verification",
        "containment",
        "nonce",
        "network",
      ])
    : undefined;
  return Object.freeze({
    approval: object.approval as SetupApprovalAuthority,
    store: object.store as CredentialStoreObservationAuthority,
    discovery: Object.freeze({
      credentialEnvironment:
        discovery.credentialEnvironment as CodexDotenvSetupDiscoveryDependencies["credentialEnvironment"],
      legacyStore:
        discovery.legacyStore as CodexDotenvSetupDiscoveryDependencies["legacyStore"],
      network:
        discovery.network as CodexDotenvSetupDiscoveryDependencies["network"],
      hash: discovery.hash as CodexDotenvSetupDiscoveryDependencies["hash"],
      platform:
        discovery.platform as CodexDotenvSetupDiscoveryDependencies["platform"],
    }),
    ...(execution === undefined
      ? {}
      : {
          execution: Object.freeze({
            storage:
              execution.storage as SetupRegistrationExecutionDependencies["storage"],
            network:
              execution.network as SetupRegistrationExecutionDependencies["network"],
            clock:
              execution.clock as SetupRegistrationExecutionDependencies["clock"],
            random:
              execution.random as SetupRegistrationExecutionDependencies["random"],
            hash:
              execution.hash as SetupRegistrationExecutionDependencies["hash"],
          }),
        }),
    ...(hostExecution === undefined
      ? {}
      : {
          hostExecution: Object.freeze({
            hosts:
              hostExecution.hosts as SetupHostExecutionDependencies["hosts"],
            journal:
              hostExecution.journal as SetupHostExecutionDependencies["journal"],
            verification:
              hostExecution.verification as SetupHostExecutionDependencies["verification"],
            containment:
              hostExecution.containment as SetupHostExecutionDependencies["containment"],
            nonce:
              hostExecution.nonce as SetupHostExecutionDependencies["nonce"],
            network:
              hostExecution.network as SetupHostExecutionDependencies["network"],
          }),
        }),
    ...(Object.hasOwn(object, "codexProjection")
      ? {
          codexProjection:
            object.codexProjection as CodexDotenvProjectionAdapter,
        }
      : {}),
    preflight: object.preflight as SetupPreflightSnapshot,
  });
}

function normalizePrepareRequest(
  value: unknown,
): CodexDotenvSetupPrepareRequest {
  const object = exactDataObject(value, [
    "identity",
    "decision",
    "operationId",
    "createdAt",
  ]);
  return Object.freeze({
    identity: object.identity as CodexDotenvSetupObservationIdentity,
    decision: object.decision as SetupCredentialPlanningDecision,
    operationId: object.operationId as string,
    createdAt: object.createdAt as string,
  });
}

function normalizeCredentialInputRequest(
  value: unknown,
): CodexDotenvSetupCredentialInputRequest {
  const object = exactDataObject(value, ["identity", "credential"]);
  return Object.freeze({
    identity: object.identity as CodexDotenvSetupObservationIdentity,
    credential: object.credential as SetupCredentialInputIdentity,
  });
}

function safeBoundPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PATH_CHARACTERS ||
    containsHostControlCharacter(value) ||
    containsHostSensitiveMaterial(value)
  ) {
    return invalid();
  }
  return value;
}

function issueIdentity(): CodexDotenvSetupObservationIdentity {
  const token = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(token, "toJSON", {
    configurable: false,
    enumerable: false,
    value: TOKEN_TO_JSON,
    writable: false,
  });
  return Object.freeze(
    token,
  ) as unknown as CodexDotenvSetupObservationIdentity;
}

function publicCandidate(
  value: CredentialCandidateSummary,
  selectionId = value.selectionId,
): SetupCredentialCandidate {
  return Object.freeze({
    selectionId,
    apiOrigin: value.apiOrigin,
    fingerprint: value.fingerprint,
    agent: Object.freeze({
      id: value.agent.id,
      name: value.agent.name,
      username: value.agent.username,
    }),
    sources: Object.freeze([...value.sources]),
  });
}

function publicBlocker(
  value: CredentialDiscoveryBlocker,
): SetupCredentialPlanningBlocker {
  return Object.freeze({
    reason: value.reason,
    sources: Object.freeze([...value.sources]),
  });
}

function discoveryCandidates(
  discovery: CredentialDiscoveryResult,
): readonly CredentialCandidateSummary[] {
  if (discovery.status === "ready") {
    return Object.freeze([discovery.candidate]);
  }
  if (discovery.status === "selection-required") {
    return discovery.candidates;
  }
  if (discovery.status === "blocked") {
    return discovery.validCandidates;
  }
  return Object.freeze([]);
}

function resolvedCandidates(
  discovery: CredentialDiscoveryResult,
): ReadonlyMap<string, RetainedResolvedCredential> {
  const output = new Map<string, RetainedResolvedCredential>();
  if (discovery.status === "ready") {
    output.set(discovery.candidate.selectionId, discovery.credential);
  } else if (discovery.status === "selection-required") {
    for (const candidate of discovery.candidates) {
      output.set(candidate.selectionId, discovery.select(candidate.selectionId));
    }
  }
  return output;
}

function orderedSources(
  sources: readonly SetupCredentialSource[],
): readonly SetupCredentialSource[] {
  const order = new Map(
    SETUP_CREDENTIAL_SOURCES.map((source, index) => [source, index]),
  );
  return Object.freeze(
    [...new Set(sources)].sort(
      (left, right) =>
        (order.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right) ?? Number.MAX_SAFE_INTEGER),
    ),
  );
}

function isProtectedCredential(
  credential: RetainedResolvedCredential,
): credential is SetupProtectedCredential {
  return isOwnedSetupSecretLease(
    (credential as SetupProtectedCredential).lease,
  );
}

function cloneResolvedCredential(
  credential: SetupRegistrationResolvedCredential,
  sources: readonly SetupCredentialSource[],
  agent: SetupRegistrationResolvedCredential["agent"] = credential.agent,
): SetupRegistrationResolvedCredential {
  const output = {
    apiOrigin: credential.apiOrigin,
    fingerprint: credential.fingerprint,
    agent,
    sources: orderedSources(sources),
  } as SetupRegistrationResolvedCredential;
  Object.defineProperty(output, "apiKey", {
    configurable: false,
    enumerable: false,
    value: credential.apiKey,
    writable: false,
  });
  Object.defineProperty(output, "identity", {
    configurable: false,
    enumerable: false,
    value: credential.identity,
    writable: false,
  });
  return Object.freeze(output);
}

function copiedProtectedApiKey(
  credential: SetupProtectedCredential,
): ApiKey | undefined {
  const bytes = copySetupSecretLeaseBytes(credential.lease);
  if (bytes === undefined) {
    return undefined;
  }
  try {
    return parseApiKey(
      new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes),
    );
  } catch {
    return undefined;
  } finally {
    wipeUint8Array(bytes);
  }
}

function discardProtectedCredential(
  credential: RetainedResolvedCredential,
): void {
  if (isProtectedCredential(credential)) {
    discardSetupSecretLease(credential.lease);
  }
}

function discardProtectedCandidates(
  candidates: ReadonlyMap<string, RetainedResolvedCredential>,
  retainedLease: SetupSecretLease | null = null,
): void {
  for (const credential of candidates.values()) {
    if (
      isProtectedCredential(credential) &&
      credential.lease !== retainedLease
    ) {
      discardSetupSecretLease(credential.lease);
    }
  }
}

function protectedPublicCandidate(
  selectionId: string,
  credential: RetainedResolvedCredential,
): SetupCredentialCandidate {
  return Object.freeze({
    selectionId,
    apiOrigin: credential.apiOrigin,
    fingerprint: credential.fingerprint,
    agent: Object.freeze({
      id: credential.agent.id,
      name: credential.agent.name,
      username: credential.agent.username,
    }),
    sources: orderedSources(credential.sources),
  });
}

function hasBlocker(
  discovery: CredentialDiscoveryResult,
  reason: CredentialDiscoveryBlocker["reason"],
  source: CredentialDiscoverySource,
): boolean {
  return (
    discovery.status === "blocked" &&
    discovery.blockers.some(
      (entry) => entry.reason === reason && entry.sources.includes(source),
    )
  );
}

function discoveryBlockers(
  discovery: CredentialDiscoveryResult,
): readonly CredentialDiscoveryBlocker[] {
  return discovery.status === "blocked"
    ? discovery.blockers
    : Object.freeze([]);
}

function canonicalActiveObservation(
  discovery: CredentialDiscoveryResult,
  summaries: readonly CredentialCandidateSummary[],
): SetupCanonicalCredentialObservation {
  const canonical = summaries.find((entry) =>
    entry.sources.includes("canonical"),
  );
  if (canonical !== undefined) {
    return Object.freeze({
      status: "active-valid" as const,
      candidateSelectionId: canonical.selectionId,
    });
  }
  if (discovery.invalidSources.includes("canonical")) {
    return Object.freeze({ status: "active-invalid" as const });
  }
  return Object.freeze({ status: "unavailable" as const });
}

function pendingResumeEvidence(
  discovery: CredentialDiscoveryResult,
  canonical: CredentialCandidateSummary | undefined,
): Extract<
  SetupCanonicalCredentialObservation,
  { status: "pending" }
>["resumeEvidence"] {
  if (canonical !== undefined) {
    return "authenticated-match";
  }
  if (
    hasBlocker(discovery, "canonical_identity_mismatch", "canonical")
  ) {
    return "identity-mismatch";
  }
  if (
    hasBlocker(
      discovery,
      "credential_validation_unavailable",
      "canonical",
    )
  ) {
    return "validation-unavailable";
  }
  if (discovery.invalidSources.includes("canonical")) {
    return "definitively-inactive";
  }
  return "validation-unavailable";
}

function pendingObservation(
  credential: PendingCredentialV1,
  discovery: CredentialDiscoveryResult,
  summaries: readonly CredentialCandidateSummary[],
  hash: CodexDotenvSetupDiscoveryDependencies["hash"],
): Readonly<{
  canonical: SetupCanonicalCredentialObservation;
  candidates: readonly SetupCredentialCandidate[];
}> {
  const canonical = summaries.find((entry) =>
    entry.sources.includes("canonical"),
  );
  const identified = identifyCredentialKey(
    credential.api_origin,
    credential.api_key,
    "https-only",
    hash,
  );
  if (
    canonical !== undefined &&
    canonical.fingerprint !== identified.fingerprint
  ) {
    return invalid();
  }
  const remaining = summaries.filter(
    (entry) => !entry.sources.includes("canonical"),
  );
  return Object.freeze({
    canonical: Object.freeze({
      status: "pending" as const,
      apiOrigin: credential.api_origin,
      fingerprint: identified.fingerprint,
      agent: Object.freeze({
        name: credential.agent_name,
        username: credential.username,
      }),
      sources: Object.freeze([
        ...(canonical?.sources ?? ["canonical"]),
      ]) as readonly SetupCredentialSource[],
      resumeEvidence: pendingResumeEvidence(discovery, canonical),
    }),
    candidates: Object.freeze(
      remaining.map((entry, index) =>
        publicCandidate(entry, `credential-${index + 1}`),
      ),
    ),
  });
}

function planningObservation(
  credential: CredentialV1 | null,
  transaction: SetupCredentialPlanningObservation["transaction"],
  discovery: CredentialDiscoveryResult,
  hash: CodexDotenvSetupDiscoveryDependencies["hash"],
): SetupCredentialPlanningObservation {
  const summaries = discoveryCandidates(discovery);
  let canonical: SetupCanonicalCredentialObservation;
  let candidates: readonly SetupCredentialCandidate[];
  let blockers = discoveryBlockers(discovery);

  if (credential === null) {
    canonical = Object.freeze({ status: "missing" as const });
    candidates = Object.freeze(summaries.map((entry) => publicCandidate(entry)));
  } else if (credential.state === "active") {
    canonical = canonicalActiveObservation(discovery, summaries);
    candidates = Object.freeze(summaries.map((entry) => publicCandidate(entry)));
  } else {
    const pending = pendingObservation(
      credential,
      discovery,
      summaries,
      hash,
    );
    canonical = pending.canonical;
    candidates = pending.candidates;
    blockers = blockers.filter(
      (entry) => entry.reason !== "canonical_credential_pending",
    );
  }

  return Object.freeze({
    schemaVersion: 1 as const,
    transaction,
    canonical,
    candidates,
    blockers: Object.freeze(blockers.map(publicBlocker)),
    invalidSources: Object.freeze([
      ...discovery.invalidSources,
    ]) as readonly SetupCredentialSource[],
  });
}

function unavailableObservation(): SetupCredentialPlanningObservation {
  return Object.freeze({
    schemaVersion: 1,
    transaction: "unavailable",
    canonical: Object.freeze({ status: "unavailable" }),
    candidates: Object.freeze([]),
    blockers: Object.freeze([
      Object.freeze({
        reason: "canonical_credential_unavailable",
        sources: Object.freeze(["canonical"] as const),
      }),
    ]),
    invalidSources: Object.freeze([]),
  });
}

function withoutProtectedInput(
  retained: RetainedSetupObservation,
): Readonly<{
  observation: SetupCredentialPlanningObservation;
  candidates: Map<string, RetainedResolvedCredential>;
}> {
  const candidates = new Map<string, RetainedResolvedCredential>();
  const publicCandidates: SetupCredentialCandidate[] = [];
  for (const candidate of retained.observation.candidates) {
    const resolved = retained.candidates.get(candidate.selectionId);
    if (resolved === undefined) {
      return invalid();
    }
    if (isProtectedCredential(resolved)) {
      discardSetupSecretLease(resolved.lease);
      continue;
    }
    const sources = resolved.sources.filter(
      (source) => source !== "protected-input",
    );
    if (sources.length === 0) {
      continue;
    }
    const next = cloneResolvedCredential(resolved, sources);
    candidates.set(candidate.selectionId, next);
    publicCandidates.push(
      protectedPublicCandidate(candidate.selectionId, next),
    );
  }
  return Object.freeze({
    candidates,
    observation: Object.freeze({
      schemaVersion: 1 as const,
      transaction: retained.observation.transaction,
      canonical: retained.observation.canonical,
      candidates: Object.freeze(publicCandidates),
      blockers: Object.freeze(
        retained.observation.blockers.filter(
          (entry) => !entry.sources.includes("protected-input"),
        ),
      ),
      invalidSources: Object.freeze(
        retained.observation.invalidSources.filter(
          (source) => source !== "protected-input",
        ),
      ),
    }),
  });
}

function nextSelectionId(
  candidates: ReadonlyMap<string, RetainedResolvedCredential>,
): string {
  for (let index = 1; index <= 32; index += 1) {
    const selectionId = `credential-${index}`;
    if (!candidates.has(selectionId)) {
      return selectionId;
    }
  }
  return invalid();
}

function addProtectedCredential(
  base: ReturnType<typeof withoutProtectedInput>,
  protectedCredential: SetupProtectedCredential,
): ReturnType<typeof withoutProtectedInput> {
  const candidates = new Map(base.candidates);
  let selectionId: string | undefined;
  let merged: RetainedResolvedCredential | undefined;
  for (const [candidateId, candidate] of candidates) {
    if (candidate.identity !== protectedCredential.identity) {
      continue;
    }
    if (
      candidate.apiOrigin !== protectedCredential.apiOrigin ||
      candidate.fingerprint !== protectedCredential.fingerprint ||
      candidate.agent.id !== protectedCredential.agent.id ||
      isProtectedCredential(candidate)
    ) {
      discardSetupSecretLease(protectedCredential.lease);
      return invalid();
    }
    selectionId = candidateId;
    merged = cloneResolvedCredential(
      candidate,
      [
        ...candidate.sources,
        "protected-input",
      ],
      protectedCredential.agent,
    );
    discardSetupSecretLease(protectedCredential.lease);
    break;
  }
  if (selectionId === undefined || merged === undefined) {
    selectionId = nextSelectionId(candidates);
    merged = protectedCredential;
  }
  candidates.set(selectionId, merged);

  const publicCandidates = [...candidates.entries()]
    .sort(([left], [right]) =>
      Number(left.slice("credential-".length)) -
      Number(right.slice("credential-".length)),
    )
    .map(([candidateId, candidate]) =>
      protectedPublicCandidate(candidateId, candidate),
    );
  return Object.freeze({
    candidates,
    observation: Object.freeze({
      ...base.observation,
      candidates: Object.freeze(publicCandidates),
    }),
  });
}

function protectedInputFailure(
  base: ReturnType<typeof withoutProtectedInput>,
  status: "invalid" | "indeterminate",
): ReturnType<typeof withoutProtectedInput> {
  return Object.freeze({
    candidates: base.candidates,
    observation: Object.freeze({
      ...base.observation,
      blockers:
        status === "indeterminate"
          ? Object.freeze([
              ...base.observation.blockers,
              Object.freeze({
                reason: "credential_validation_unavailable" as const,
                sources: Object.freeze([
                  "protected-input" as const,
                ]),
              }),
            ])
          : base.observation.blockers,
      invalidSources:
        status === "invalid"
          ? orderedSources([
              ...base.observation.invalidSources,
              "protected-input",
            ])
          : base.observation.invalidSources,
    }),
  });
}

function canonicalReadResult(
  credential: CredentialV1 | null,
): CredentialStoreReadResult {
  return credential === null
    ? Object.freeze({
        status: "missing" as const,
        reason: "credential_missing" as const,
      })
    : Object.freeze({ status: "loaded" as const, credential });
}

function selectedEvidence(
  credential: SetupCredentialResolvedPlan,
  retained: RetainedSetupObservation,
): Readonly<{
  selected: SetupRegistrationSelectedEvidence;
  expectation: CodexDotenvCredentialExpectation;
  secretLease: SetupSecretLease | null;
}> {
  if (credential.acquisition === "existing") {
    const selected = retained.candidates.get(
      credential.credential.selectionId,
    );
    if (
      selected === undefined ||
      selected.apiOrigin !== credential.apiOrigin ||
      selected.fingerprint !== credential.credential.fingerprint
    ) {
      return invalid();
    }
    if (isProtectedCredential(selected)) {
      const apiKey = copiedProtectedApiKey(selected);
      if (apiKey === undefined) {
        return invalid();
      }
      return Object.freeze({
        selected: Object.freeze({
          kind: "protected-input" as const,
          credential: selected,
        }),
        expectation: Object.freeze({
          kind: "known" as const,
          apiKey,
        }),
        secretLease: selected.lease,
      });
    }
    return Object.freeze({
      selected: Object.freeze({
        kind: "existing" as const,
        credential: selected,
      }),
      expectation: Object.freeze({
        kind: "known" as const,
        apiKey: selected.apiKey,
      }),
      secretLease: null,
    });
  }

  if (credential.acquisition === "resume-registration") {
    const pending = retained.store.credential;
    if (
      pending === null ||
      pending.state !== "pending" ||
      retained.pendingIdentity === null ||
      pending.api_origin !== credential.apiOrigin ||
      pending.agent_name !== credential.registration.agent.name ||
      pending.username !== credential.registration.agent.username
    ) {
      return invalid();
    }
    return Object.freeze({
      selected: Object.freeze({
        kind: "resume-registration" as const,
        credential: pending,
        identity: retained.pendingIdentity,
      }),
      expectation: Object.freeze({
        kind: "known" as const,
        apiKey: pending.api_key,
      }),
      secretLease: null,
    });
  }

  if (credential.acquisition === "username-conflict-retry") {
    const pending = retained.store.credential;
    const conflict = retained.usernameConflict;
    if (
      pending === null ||
      pending.state !== "pending" ||
      retained.pendingIdentity === null ||
      conflict === null ||
      pending.api_origin !== credential.apiOrigin ||
      pending.agent_name !== credential.registration.agent.name ||
      pending.username !== credential.registration.previousUsername ||
      conflict.pending.identity !== retained.pendingIdentity ||
      conflict.pending.fingerprint !== credential.registration.fingerprint ||
      conflict.pending.agentName !== pending.agent_name ||
      conflict.pending.username !== pending.username ||
      conflict.pending.registrationRequestId !==
        pending.registration_request_id ||
      conflict.pending.createdAt !== pending.created_at ||
      conflict.pending.updatedAt !== pending.updated_at
    ) {
      return invalid();
    }
    return Object.freeze({
      selected: Object.freeze({
        kind: "username-conflict-retry" as const,
        credential: pending,
        identity: retained.pendingIdentity,
        registration: Object.freeze({
          mode: "username-retry" as const,
          agent: credential.registration.agent,
        }),
      }),
      expectation: Object.freeze({
        kind: "known" as const,
        apiKey: pending.api_key,
      }),
      secretLease: null,
    });
  }

  return Object.freeze({
    selected: Object.freeze({
      kind: "new-registration" as const,
      credential: null,
      registration: credential.registration,
    }),
    expectation: Object.freeze({
      kind: "deferred-registration" as const,
    }),
    secretLease: null,
  });
}

function projectionRelation(
  status: CodexDotenvProjectionStatus,
  deferred: boolean,
): SetupCodexProjectionRelation {
  if (status === "absent") {
    return "absent";
  }
  if (status === "exact") {
    return deferred ? "replacement-required" : "matches-selected";
  }
  if (status === "mismatched") {
    return "replacement-required";
  }
  if (status === "credential-unavailable") {
    return "unavailable";
  }
  return status;
}

function isExecutableCodex(snapshot: SetupPreflightSnapshot): boolean {
  const plans = retainedSetupHostPlans(snapshot);
  return plans.some(
    (plan) =>
      plan.host === "codex" &&
      plan.automatic &&
      plan.executable !== null &&
      EXECUTABLE_CLASSIFICATIONS.has(plan.classification),
  );
}

function hasExecutableHost(snapshot: SetupPreflightSnapshot): boolean {
  const plans = retainedSetupHostPlans(snapshot);
  return plans.some(
    (plan) =>
      plan.automatic &&
      plan.executable !== null &&
      EXECUTABLE_CLASSIFICATIONS.has(plan.classification),
  );
}

export function createCodexDotenvSetupObservationAuthority(
  rawOptions: CodexDotenvSetupObservationOptions,
): CodexDotenvSetupObservationAuthority {
  let options: NormalizedSetupObservationOptions;
  try {
    options = normalizeOptions(rawOptions);
  } catch {
    return invalid();
  }
  const approval = options.approval;
  const store = options.store;
  const discovery = options.discovery;
  const executionDependencies = options.execution;
  const hostExecutionDependencies = options.hostExecution;
  const codexProjection = options.codexProjection;
  const preflight = options.preflight;
  if (
    !isOwnedSetupApprovalAuthority(approval) ||
    !isOwnedCredentialStoreObservationAuthority(store) ||
    (codexProjection !== undefined &&
      !isOwnedCodexDotenvProjectionAdapter(codexProjection))
  ) {
    return invalid();
  }
  let canonicalDirectory: string;
  let cwd: string;
  let boundedDiscovery: CodexDotenvSetupDiscoveryDependencies;
  let hostExecutionAuthority:
    | SetupHostExecutionAuthority
    | undefined;
  let credentialSessionAuthority:
    | SetupCredentialSessionAuthority
    | undefined;
  try {
    retainedSetupHostPlans(preflight);
    const environment = retainedSetupPreflightEnvironment(
      preflight,
      discovery.platform,
    );
    canonicalDirectory = safeBoundPath(environment.credentialDirectory);
    cwd = safeBoundPath(environment.cwd);
    boundedDiscovery = Object.freeze({
      ...discovery,
      platform: environment.platform,
    });
    if (
      executionDependencies !== undefined &&
      (executionDependencies.network !== boundedDiscovery.network ||
        executionDependencies.hash !== boundedDiscovery.hash)
    ) {
      return invalid();
    }
    if (hostExecutionDependencies !== undefined) {
      if (
        executionDependencies === undefined ||
        hostExecutionDependencies.network !== executionDependencies.network ||
        !isRetainedSetupPreflightHostAuthority(
          preflight,
          hostExecutionDependencies.hosts,
        )
      ) {
        return invalid();
      }
      credentialSessionAuthority = createSetupCredentialSessionAuthority(
        Object.freeze({
          storage: executionDependencies.storage,
          clock: executionDependencies.clock,
          random: executionDependencies.random,
        }),
      );
      if (!isOwnedSetupCredentialSessionAuthority(credentialSessionAuthority)) {
        return invalid();
      }
      hostExecutionAuthority = createSetupHostExecutionAuthority(
        hostExecutionDependencies,
        credentialSessionAuthority,
      );
      if (!isOwnedSetupHostExecutionAuthority(hostExecutionAuthority)) {
        return invalid();
      }
    }
  } catch {
    return invalid();
  }

  const execution = createSetupExecutionAuthority(approval);
  const continuationScope = Object.freeze(Object.create(null)) as object;
  const observations = new WeakMap<
    CodexDotenvSetupObservationIdentity,
    RetainedSetupObservation
  >();
  let inspectionStarted = false;

  function unavailableInspection(): CodexDotenvSetupInspectionResult {
    const observation = unavailableObservation();
    return Object.freeze({
      status: "unavailable" as const,
      observation,
      initial: planSetupCredential({
        observation,
        decision: Object.freeze({
          selectedCandidateId: null,
          registration: null,
        }),
      }),
    });
  }

  function exactConflictPending(
    credential: PendingCredentialV1,
    conflict: SetupUsernameConflictContinuationClaim,
    identity: CredentialKeyIdentity,
    fingerprint: SetupUsernameConflictContinuationClaim["pending"]["fingerprint"],
  ): boolean {
    return (
      conflict.storeAuthority === store &&
      conflict.canonicalDirectory === canonicalDirectory &&
      credential.api_origin === conflict.pending.apiOrigin &&
      identity === conflict.pending.identity &&
      fingerprint === conflict.pending.fingerprint &&
      credential.agent_name === conflict.pending.agentName &&
      credential.username === conflict.pending.username &&
      credential.registration_request_id ===
        conflict.pending.registrationRequestId &&
      credential.created_at === conflict.pending.createdAt &&
      credential.updated_at === conflict.pending.updatedAt &&
      credential.agent_id === null &&
      credential.activated_at === null
    );
  }

  async function inspectCurrent(
    conflict: SetupUsernameConflictContinuationClaim | null,
  ): Promise<CodexDotenvSetupInspectionResult> {
    try {
      const inspected = await store.inspect({
        directory: canonicalDirectory,
      });
      if (inspected.status !== "available") {
        return unavailableInspection();
      }
      const redeemed = store.redeem({
        identity: inspected.identity,
        directory: canonicalDirectory,
      });
      if (redeemed.status !== "redeemed") {
        return PRECONDITION_FAILED;
      }
      const canonicalState =
        redeemed.credential === null
          ? "missing"
          : redeemed.credential.state;
      if (
        canonicalState !== inspected.canonical ||
        (inspected.transaction === "clean" &&
          redeemed.transaction !== null)
      ) {
        return PRECONDITION_FAILED;
      }

      let pendingIdentity: CredentialKeyIdentity | null = null;
      let pendingFingerprint:
        | SetupUsernameConflictContinuationClaim["pending"]["fingerprint"]
        | null = null;
      if (redeemed.credential?.state === "pending") {
        const identified = identifyCredentialKey(
          redeemed.credential.api_origin,
          redeemed.credential.api_key,
          "https-only",
          boundedDiscovery.hash,
        );
        pendingIdentity = identified.identity;
        pendingFingerprint = identified.fingerprint;
      }
      if (
        conflict !== null &&
        (inspected.transaction !== "clean" ||
          redeemed.transaction !== null ||
          redeemed.credential?.state !== "pending" ||
          pendingIdentity === null ||
          pendingFingerprint === null ||
          !exactConflictPending(
            redeemed.credential,
            conflict,
            pendingIdentity,
            pendingFingerprint,
          ))
      ) {
        return PRECONDITION_FAILED;
      }

      const discovered = await discoverCredentialsFromCanonicalObservation(
        Object.freeze({
          ...boundedDiscovery,
          canonical: canonicalReadResult(redeemed.credential),
        }),
      );
      const baseObservation = planningObservation(
        redeemed.credential,
        inspected.transaction,
        discovered,
        boundedDiscovery.hash,
      );
      const usernameConflict =
        conflict !== null &&
        baseObservation.canonical.status === "pending" &&
        baseObservation.canonical.resumeEvidence ===
          "definitively-inactive"
          ? conflict
          : null;
      const observation =
        usernameConflict === null
          ? baseObservation
          : Object.freeze({
              ...baseObservation,
              canonical: Object.freeze({
                ...baseObservation.canonical,
                resumeEvidence: "username-conflict" as const,
              }),
            });
      const retained = Object.freeze({
        observation,
        candidates: resolvedCandidates(discovered),
        pendingIdentity,
        usernameConflict,
        store: Object.freeze({
          credential: redeemed.credential,
          transaction: redeemed.transaction,
          evidence: redeemed.evidence,
        }),
      });
      const identity = issueIdentity();
      observations.set(identity, retained);
      return Object.freeze({
        status: "available" as const,
        identity,
        observation,
        initial: planSetupCredential({
          observation,
          decision: Object.freeze({
            selectedCandidateId: null,
            registration: null,
          }),
        }),
      });
    } catch {
      return unavailableInspection();
    }
  }

  async function inspect(): Promise<CodexDotenvSetupInspectionResult> {
    if (inspectionStarted) {
      return PRECONDITION_FAILED;
    }
    inspectionStarted = true;
    return inspectCurrent(null);
  }

  async function inspectUsernameConflict(
    continuation: SetupUsernameConflictContinuation,
  ): Promise<CodexDotenvSetupInspectionResult> {
    const conflict = claimSetupUsernameConflictContinuation(
      continuation,
      continuationScope,
    );
    if (
      conflict === undefined ||
      conflict.storeAuthority !== store ||
      conflict.canonicalDirectory !== canonicalDirectory
    ) {
      return PRECONDITION_FAILED;
    }
    return inspectCurrent(conflict);
  }

  async function resolveCredentialInput(
    rawRequest: CodexDotenvSetupCredentialInputRequest,
  ): Promise<CodexDotenvSetupInspectionResult> {
    let request: CodexDotenvSetupCredentialInputRequest;
    try {
      request = normalizeCredentialInputRequest(rawRequest);
    } catch {
      return PRECONDITION_FAILED;
    }

    let retained: RetainedSetupObservation | undefined;
    try {
      retained = observations.get(request.identity);
      observations.delete(request.identity);
    } catch {
      return PRECONDITION_FAILED;
    }
    if (retained === undefined) {
      discardSetupCredentialInput(request.credential);
      return PRECONDITION_FAILED;
    }
    if (retained.observation.canonical.status === "pending") {
      discardSetupCredentialInput(request.credential);
      discardProtectedCandidates(retained.candidates);
      return PRECONDITION_FAILED;
    }

    let nextCandidates:
      | ReadonlyMap<string, RetainedResolvedCredential>
      | undefined;
    let unresolvedProtected: SetupProtectedCredential | undefined;
    try {
      const base = withoutProtectedInput(retained);
      const resolved = await transferSetupProtectedCredentialInput(
        boundedDiscovery.network,
        boundedDiscovery.hash,
        request.credential,
      );
      if (resolved.status === "precondition-failed") {
        return PRECONDITION_FAILED;
      }
      const next =
        resolved.status === "retained"
          ? (() => {
              unresolvedProtected = resolved.credential;
              return addProtectedCredential(base, resolved.credential);
            })()
          : protectedInputFailure(base, resolved.status);
      nextCandidates = next.candidates;
      unresolvedProtected = undefined;
      const identity = issueIdentity();
      const nextRetained = Object.freeze({
        observation: next.observation,
        candidates: next.candidates,
        pendingIdentity: retained.pendingIdentity,
        usernameConflict: retained.usernameConflict,
        store: retained.store,
      });
      observations.set(identity, nextRetained);
      nextCandidates = undefined;
      return Object.freeze({
        status: "available" as const,
        identity,
        observation: next.observation,
        initial: planSetupCredential({
          observation: next.observation,
          decision: Object.freeze({
            selectedCandidateId: null,
            registration: null,
          }),
        }),
      });
    } catch {
      discardSetupCredentialInput(request.credential);
      if (unresolvedProtected !== undefined) {
        discardSetupSecretLease(unresolvedProtected.lease);
      }
      discardProtectedCandidates(
        nextCandidates ?? retained.candidates,
      );
      return PRECONDITION_FAILED;
    }
  }

  async function prepare(
    rawRequest: CodexDotenvSetupPrepareRequest,
  ): Promise<CodexDotenvSetupPrepareResult> {
    let request: CodexDotenvSetupPrepareRequest;
    try {
      request = normalizePrepareRequest(rawRequest);
    } catch {
      return PRECONDITION_FAILED;
    }
    let retained: RetainedSetupObservation | undefined;
    try {
      retained = observations.get(request.identity);
      observations.delete(request.identity);
    } catch {
      return PRECONDITION_FAILED;
    }
    if (retained === undefined) {
      return PRECONDITION_FAILED;
    }

    let transferredSecret = false;
    try {
      const credential = planSetupCredential({
        observation: retained.observation,
        decision: request.decision,
      });
      if (
        credential.status === "selection-required" ||
        credential.status === "registration-input-required"
      ) {
        return PRECONDITION_FAILED;
      }
      if (credential.status === "blocked") {
        return Object.freeze({
          status: "blocked" as const,
          stage: "credential" as const,
          credential,
        });
      }
      if (
        (preflight.readiness !== "ready" &&
          preflight.readiness !== "no-op") ||
        !hasExecutableHost(preflight)
      ) {
        return Object.freeze({
          status: "blocked" as const,
          stage: "preflight" as const,
          reason: "preflight-not-executable" as const,
        });
      }

      const selection = selectedEvidence(credential, retained);
      let projectionPlan: SetupCodexProjectionResolvedPlan | null = null;
      let projectionEvidence: SetupRegistrationProjectionEvidence | null =
        null;
      if (isExecutableCodex(preflight)) {
        if (codexProjection === undefined) {
          const projection = planSetupCodexProjection(
            credential,
            "unavailable",
          );
          return Object.freeze({
            status: "blocked" as const,
            stage: "codex-projection" as const,
            projection,
          });
        }
        const inspected = await codexProjection.inspect({
          expectation: selection.expectation,
          excludedProjectDirectory: cwd,
        });
        const relation =
          inspected.status === "available"
            ? projectionRelation(
                inspected.state.status,
                selection.expectation.kind === "deferred-registration",
              )
            : "unavailable";
        const planned = planSetupCodexProjection(credential, relation);
        if (planned.status === "blocked") {
          return Object.freeze({
            status: "blocked" as const,
            stage: "codex-projection" as const,
            projection: planned,
          });
        }
        if (inspected.status !== "available") {
          return invalid();
        }
        projectionPlan = planned;
        projectionEvidence = Object.freeze({
          adapter: codexProjection,
          identity: inspected.state.identity,
          deferred:
            selection.expectation.kind === "deferred-registration",
        });
      }

      const plan = prepareSetupApplyPlan(
        approval,
        preflight,
        credential,
        projectionPlan,
        request.operationId,
        request.createdAt,
      );
      const privateEvidence: SetupRegistrationExecutionEvidence = Object.freeze({
        canonicalDirectory,
        cwd,
        continuationScope,
        storeAuthority: store,
        store: retained.store,
        selected: selection.selected,
        projection: projectionEvidence,
      });
      const observation = execution.registerObservation(
        privateEvidence,
        selection.secretLease ?? undefined,
      );
      transferredSecret = selection.secretLease !== null;
      discardProtectedCandidates(
        retained.candidates,
        selection.secretLease,
      );
      const sidecar = execution.bind(
        plan,
        credential,
        projectionPlan,
        observation,
      );
      return Object.freeze({
        status: "prepared" as const,
        plan,
        sidecar,
      });
    } catch {
      return PRECONDITION_FAILED;
    } finally {
      if (!transferredSecret) {
        discardProtectedCandidates(retained.candidates);
      }
    }
  }

  return Object.freeze({
    inspect,
    inspectUsernameConflict,
    resolveCredentialInput,
    prepare,
    createConfirmation(
      plan: SetupPreparedPlan<SetupApplyPlan>,
      sidecar: SetupExecutionSidecarIdentity,
      mode: SetupConfirmationMode,
      presenter: SetupPlanPresenter,
      confirmation: SetupInteractiveConfirmation | null,
    ): SetupConfirmationAttempt {
      return createSetupConfirmationAttempt(
        plan,
        sidecar,
        approval,
        execution,
        mode,
        presenter,
        confirmation,
      );
    },
    createRegistrationExecution(
      plan: SetupPreparedPlan<SetupApplyPlan>,
      grant: SetupExecutionGrant,
    ): SetupRegistrationExecutionAttempt {
      if (executionDependencies === undefined) {
        execution.discard(grant);
        return Object.freeze({
          async execute() {
            return PRECONDITION_FAILED;
          },
          discard() {
            return PRECONDITION_FAILED;
          },
        });
      }
      return createSetupRegistrationExecutionAttempt(
        execution,
        plan,
        grant,
        executionDependencies,
        hostExecutionAuthority ?? null,
      );
    },
    createHostExecution(
      plan: SetupPreparedPlan<SetupApplyPlan>,
      grant: SetupHostConfigurationGrant,
    ): SetupHostExecutionAttempt {
      if (hostExecutionAuthority === undefined) {
        discardSetupHostConfigurationGrant(grant);
        return Object.freeze({
          async execute() {
            return PRECONDITION_FAILED;
          },
          discard() {
            return PRECONDITION_FAILED;
          },
        });
      }
      return hostExecutionAuthority.createAttempt(plan, grant);
    },
    discard(
      identity:
        | CodexDotenvSetupObservationIdentity
        | SetupExecutionSidecarIdentity
        | SetupExecutionGrant
        | SetupUsernameConflictContinuation,
    ): SetupExecutionDiscardResult {
      const observationIdentity =
        identity as CodexDotenvSetupObservationIdentity;
      const retained = observations.get(observationIdentity);
      if (retained !== undefined) {
        observations.delete(observationIdentity);
        discardProtectedCandidates(retained.candidates);
        return Object.freeze({ status: "discarded" as const });
      }
      const continuation = discardSetupUsernameConflictContinuation(
        identity as SetupUsernameConflictContinuation,
        continuationScope,
      );
      if (continuation.status === "discarded") {
        return continuation;
      }
      return execution.discard(
        identity as SetupExecutionSidecarIdentity | SetupExecutionGrant,
      );
    },
  });
}
