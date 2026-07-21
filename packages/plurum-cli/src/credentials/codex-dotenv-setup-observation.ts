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
  createSetupExecutionAuthority,
  type SetupExecutionDiscardResult,
  type SetupExecutionGrant,
  type SetupExecutionSidecarIdentity,
} from "../commands/setup-execution-authority.js";
import {
  retainedSetupHostPlans,
  retainedSetupPreflightEnvironment,
  type SetupPreflightSnapshot,
} from "../commands/setup-preflight.js";
import {
  discoverCredentialsFromCanonicalObservation,
  type CredentialCandidateSummary,
  type CredentialDiscoveryBlocker,
  type CredentialDiscoveryResult,
  type CredentialDiscoverySource,
  type ObservedCredentialDiscoveryDependencies,
  type ResolvedCredential,
} from "./discovery.js";
import {
  identifyCredentialKey,
  type CredentialKeyIdentity,
} from "./fingerprint.js";
import type {
  CodexDotenvCredentialExpectation,
  CodexDotenvProjectionAdapter,
  CodexDotenvProjectionIdentity,
  CodexDotenvProjectionStatus,
} from "./codex-dotenv-contracts.js";
import {
  isOwnedCodexDotenvProjectionAdapter,
} from "./codex-dotenv-projection.js";
import type { CredentialV1, PendingCredentialV1 } from "./schema.js";
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
  discard(
    identity:
      | CodexDotenvSetupObservationIdentity
      | SetupExecutionSidecarIdentity
      | SetupExecutionGrant,
  ): SetupExecutionDiscardResult;
}

interface RetainedStoreObservation {
  readonly credential: CredentialV1 | null;
  readonly transaction: CredentialReplaceTransactionV1 | null;
  readonly evidence: CredentialStoreObservationEvidence;
}

interface RetainedSetupObservation {
  readonly observation: SetupCredentialPlanningObservation;
  readonly candidates: ReadonlyMap<string, ResolvedCredential>;
  readonly pendingIdentity: CredentialKeyIdentity | null;
  readonly store: RetainedStoreObservation;
}

type SelectedCredentialEvidence =
  | Readonly<{
      readonly kind: "existing";
      readonly credential: ResolvedCredential;
    }>
  | Readonly<{
      readonly kind: "resume-registration";
      readonly credential: PendingCredentialV1;
      readonly identity: CredentialKeyIdentity;
    }>
  | Readonly<{
      readonly kind: "new-registration";
      readonly credential: null;
      readonly registration: Extract<
        SetupCredentialResolvedPlan,
        { acquisition: "new-registration" }
      >["registration"];
    }>;

interface ProjectionEvidence {
  readonly adapter: CodexDotenvProjectionAdapter;
  readonly identity: CodexDotenvProjectionIdentity;
  readonly deferred: boolean;
}

interface PrivateExecutionEvidence {
  readonly canonicalDirectory: string;
  readonly cwd: string;
  readonly storeAuthority: CredentialStoreObservationAuthority;
  readonly store: RetainedStoreObservation;
  readonly selected: SelectedCredentialEvidence;
  readonly projection: ProjectionEvidence | null;
}

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
  readonly codexProjection?: CodexDotenvProjectionAdapter;
  readonly preflight: SetupPreflightSnapshot;
}

function normalizeOptions(
  value: unknown,
): NormalizedSetupObservationOptions {
  const object = exactDataObject(
    value,
    ["approval", "store", "discovery", "preflight"],
    ["codexProjection"],
  );
  const discovery = exactDataObject(object.discovery, [
    "credentialEnvironment",
    "legacyStore",
    "network",
    "hash",
    "platform",
  ]);
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
): ReadonlyMap<string, ResolvedCredential> {
  const output = new Map<string, ResolvedCredential>();
  if (discovery.status === "ready") {
    output.set(discovery.candidate.selectionId, discovery.credential);
  } else if (discovery.status === "selection-required") {
    for (const candidate of discovery.candidates) {
      output.set(candidate.selectionId, discovery.select(candidate.selectionId));
    }
  }
  return output;
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
  selected: SelectedCredentialEvidence;
  expectation: CodexDotenvCredentialExpectation;
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
    return Object.freeze({
      selected: Object.freeze({
        kind: "existing" as const,
        credential: selected,
      }),
      expectation: Object.freeze({
        kind: "known" as const,
        apiKey: selected.apiKey,
      }),
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
  } catch {
    return invalid();
  }

  const execution = createSetupExecutionAuthority(approval);
  const observations = new WeakMap<
    CodexDotenvSetupObservationIdentity,
    RetainedSetupObservation
  >();
  let inspectionStarted = false;

  async function inspect(): Promise<CodexDotenvSetupInspectionResult> {
    if (inspectionStarted) {
      return PRECONDITION_FAILED;
    }
    inspectionStarted = true;
    try {
      const inspected = await store.inspect({
        directory: canonicalDirectory,
      });
      if (inspected.status !== "available") {
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

      const discovered = await discoverCredentialsFromCanonicalObservation(
        Object.freeze({
          ...boundedDiscovery,
          canonical: canonicalReadResult(redeemed.credential),
        }),
      );
      const observation = planningObservation(
        redeemed.credential,
        inspected.transaction,
        discovered,
        boundedDiscovery.hash,
      );
      const pendingIdentity =
        redeemed.credential?.state === "pending"
          ? identifyCredentialKey(
              redeemed.credential.api_origin,
              redeemed.credential.api_key,
              "https-only",
              boundedDiscovery.hash,
            ).identity
          : null;
      const retained = Object.freeze({
        observation,
        candidates: resolvedCandidates(discovered),
        pendingIdentity,
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
      let projectionEvidence: ProjectionEvidence | null = null;
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
      const privateEvidence: PrivateExecutionEvidence = Object.freeze({
        canonicalDirectory,
        cwd,
        storeAuthority: store,
        store: retained.store,
        selected: selection.selected,
        projection: projectionEvidence,
      });
      const observation = execution.registerObservation(privateEvidence);
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
    }
  }

  return Object.freeze({
    inspect,
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
    discard(
      identity:
        | CodexDotenvSetupObservationIdentity
        | SetupExecutionSidecarIdentity
        | SetupExecutionGrant,
    ): SetupExecutionDiscardResult {
      if (
        observations.delete(
          identity as CodexDotenvSetupObservationIdentity,
        )
      ) {
        return Object.freeze({ status: "discarded" as const });
      }
      return execution.discard(
        identity as SetupExecutionSidecarIdentity | SetupExecutionGrant,
      );
    },
  });
}
