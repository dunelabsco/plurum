import {
  isOwnedSetupCredentialResolvedPlan,
  type SetupCredentialPlanningResult,
  type SetupCredentialResolvedPlan,
} from "./setup-credential-plan.js";
import {
  isOwnedSetupCodexProjectionForCredential,
  type SetupCodexProjectionPlanningResult,
  type SetupCodexProjectionResolvedPlan,
} from "./setup-codex-projection-plan.js";
import {
  retainedSetupHostPlans,
  type SetupHostPreview,
  type SetupMutationPreview,
  type SetupPreflightSnapshot,
} from "./setup-preflight.js";
import {
  isOwnedSetupApprovalAuthority,
  type SetupApprovalAuthority,
  type SetupPreparedPlan,
} from "./setup-approval.js";
import type { ClientTarget } from "./types.js";
import { DEFAULT_API_ORIGIN } from "../credentials/origin.js";
import {
  HOST_IDS,
  type HostId,
  type HostPreflightPlan,
  type ReconciliationPlan,
} from "../hosts/contracts.js";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_TIMESTAMP =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;
const EXECUTABLE_CLASSIFICATIONS = Object.freeze([
  "healthy",
  "healthy-newer",
  "needs-changes",
] as const);

interface SetupApplyPlanProvenance {
  readonly approval: SetupApprovalAuthority;
  readonly credential: SetupCredentialResolvedPlan;
  readonly codexProjection: SetupCodexProjectionResolvedPlan | null;
}

const OWNED_PREPARED_APPLY_PLANS = new WeakMap<
  object,
  SetupApplyPlanProvenance
>();

export type SetupApplyReadiness = "ready" | "no-op";

export interface SetupApplyPathPreview {
  readonly kind:
    SetupPreflightSnapshot["destinations"][number]["kind"];
  readonly path: string;
}

export interface SetupApplyPreview {
  readonly mode: "apply";
  readonly requestedTarget: ClientTarget;
  readonly selectedClients: readonly HostId[];
  readonly readiness: SetupApplyReadiness;
  readonly services: Readonly<{
    readonly apiOrigin: string;
    readonly mcpEndpoint: string;
  }>;
  readonly paths: readonly SetupApplyPathPreview[];
  readonly credential: Readonly<{
    readonly destination: string;
    readonly resolution: SetupCredentialResolvedPlan;
    readonly codexProjection: SetupCodexProjectionResolvedPlan | null;
  }>;
  readonly hosts: readonly SetupHostPreview[];
  readonly mutations: readonly SetupMutationPreview[];
  readonly confirmation: "required" | "not-required";
}

export interface SetupApplyPlan {
  readonly schemaVersion: 1;
  readonly preview: SetupApplyPreview;
  readonly execution: Readonly<{
    readonly credential: SetupCredentialResolvedPlan;
    readonly codexProjection: SetupCodexProjectionResolvedPlan | null;
    readonly hostReconciliation: ReconciliationPlan;
  }>;
}

export class SetupApplyPlanError extends Error {
  readonly code = "invalid_setup_apply_plan";

  constructor() {
    super("The setup apply plan could not be created safely.");
    this.name = "SetupApplyPlanError";
  }
}

function invalidPlan(): never {
  throw new SetupApplyPlanError();
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function expectedClients(target: ClientTarget): readonly HostId[] {
  return target === "all" ? HOST_IDS : Object.freeze([target]);
}

function sameHostOrder(
  actual: readonly HostId[],
  expected: readonly HostId[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((host, index) => host === expected[index])
  );
}

function canonicalOperation(
  operationId: string,
  createdAt: string,
): Readonly<{
  readonly operationId: string;
  readonly createdAt: string;
}> {
  if (
    typeof operationId !== "string" ||
    !UUID_V4.test(operationId) ||
    typeof createdAt !== "string" ||
    !CANONICAL_TIMESTAMP.test(createdAt)
  ) {
    return invalidPlan();
  }
  const milliseconds = Date.parse(createdAt);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== createdAt
  ) {
    return invalidPlan();
  }
  return Object.freeze({ operationId, createdAt });
}

function executableHostPlans(
  snapshot: SetupPreflightSnapshot,
  plans: readonly HostPreflightPlan[],
): readonly HostPreflightPlan[] {
  if (
    snapshot.readiness !== "ready" &&
    snapshot.readiness !== "no-op"
  ) {
    return invalidPlan();
  }

  const selected = expectedClients(snapshot.requestedTarget);
  if (
    !sameHostOrder(snapshot.selectedClients, selected) ||
    plans.length !== selected.length ||
    !plans.every((plan, index) => plan.host === selected[index]) ||
    snapshot.hosts.length !== selected.length ||
    !snapshot.hosts.every(
      (host, index) => host.client === selected[index],
    )
  ) {
    return invalidPlan();
  }

  const executable: HostPreflightPlan[] = [];
  for (const plan of plans) {
    if (plan.classification === "absent") {
      if (
        plan.automatic ||
        plan.executable !== null ||
        plan.baseline !== null ||
        plan.actions.length !== 0
      ) {
        return invalidPlan();
      }
      continue;
    }
    if (
      !EXECUTABLE_CLASSIFICATIONS.includes(
        plan.classification as (typeof EXECUTABLE_CLASSIFICATIONS)[number],
      ) ||
      !plan.automatic ||
      plan.executable === null ||
      plan.baseline === null ||
      (plan.classification === "needs-changes") !==
        (plan.actions.length > 0)
    ) {
      return invalidPlan();
    }
    executable.push(plan);
  }
  if (executable.length === 0) {
    return invalidPlan();
  }

  const actionShape = executable.flatMap((plan) =>
    plan.actions.map((action) => ({
      id: action.id,
      client: action.host,
      kind: action.kind,
    })),
  );
  if (
    actionShape.length !== snapshot.mutations.length ||
    actionShape.some((action, index) => {
      const mutation = snapshot.mutations[index];
      return (
        mutation === undefined ||
        mutation.id !== action.id ||
        mutation.client !== action.client ||
        mutation.kind !== action.kind
      );
    }) ||
    snapshot.readiness !==
      (snapshot.mutations.length === 0 ? "no-op" : "ready")
  ) {
    return invalidPlan();
  }

  return Object.freeze(executable);
}

function canonicalCredentialDestination(
  snapshot: SetupPreflightSnapshot,
): string {
  const destinations = snapshot.destinations.filter(
    ({ kind }) => kind === "canonical-credential",
  );
  if (destinations.length !== 1) {
    return invalidPlan();
  }
  return destinations[0]?.path ?? invalidPlan();
}

function applyPaths(
  snapshot: SetupPreflightSnapshot,
): readonly SetupApplyPathPreview[] {
  return Object.freeze(
    snapshot.destinations.map(({ kind, path }) =>
      Object.freeze({ kind, path }),
    ),
  );
}

/*
 * This is intentionally a pure, unwired boundary. It consumes one retained
 * host-inspection snapshot, one planner-owned secret-free credential
 * resolution, and the required selected-credential Codex projection. It then
 * asks the supplied approval authority to canonicalize the complete plan. It
 * performs no inspection, prompting, credential access, registration,
 * persistence, reconciliation, clock, randomness, or hashing.
 */
export function prepareSetupApplyPlan(
  approval: SetupApprovalAuthority,
  snapshot: SetupPreflightSnapshot,
  credential: SetupCredentialPlanningResult,
  codexProjection: SetupCodexProjectionPlanningResult | null,
  operationId: string,
  createdAt: string,
): SetupPreparedPlan<SetupApplyPlan> {
  try {
    if (!isOwnedSetupApprovalAuthority(approval)) {
      return invalidPlan();
    }
    const plans = retainedSetupHostPlans(snapshot);
    if (!isOwnedSetupCredentialResolvedPlan(credential)) {
      return invalidPlan();
    }
    if (
      snapshot.services.apiOrigin !== DEFAULT_API_ORIGIN ||
      credential.apiOrigin !== DEFAULT_API_ORIGIN ||
      snapshot.services.apiOrigin !== credential.apiOrigin
    ) {
      return invalidPlan();
    }

    const operation = canonicalOperation(operationId, createdAt);
    const hosts = executableHostPlans(snapshot, plans);
    const needsCodexProjection = hosts.some(
      ({ host }) => host === "codex",
    );
    let resolvedCodexProjection: SetupCodexProjectionResolvedPlan | null =
      null;
    if (needsCodexProjection) {
      if (
        !isOwnedSetupCodexProjectionForCredential(
          codexProjection,
          credential,
        )
      ) {
        return invalidPlan();
      }
      resolvedCodexProjection = codexProjection;
    } else if (codexProjection !== null) {
      return invalidPlan();
    }
    const readiness: SetupApplyReadiness =
      snapshot.readiness === "ready" ||
      credential.canonicalEffect !== "unchanged" ||
      (resolvedCodexProjection !== null &&
        resolvedCodexProjection.effect !== "unchanged")
        ? "ready"
        : "no-op";
    const candidate = deepFreeze({
      schemaVersion: 1 as const,
      preview: {
        mode: "apply" as const,
        requestedTarget: snapshot.requestedTarget,
        selectedClients: snapshot.selectedClients,
        readiness,
        services: snapshot.services,
        paths: applyPaths(snapshot),
        credential: {
          destination: canonicalCredentialDestination(snapshot),
          resolution: credential,
          codexProjection: resolvedCodexProjection,
        },
        hosts: snapshot.hosts,
        mutations: snapshot.mutations,
        confirmation:
          readiness === "ready"
            ? ("required" as const)
            : ("not-required" as const),
      },
      execution: {
        credential,
        codexProjection: resolvedCodexProjection,
        hostReconciliation: {
          schemaVersion: 1 as const,
          operationId: operation.operationId,
          createdAt: operation.createdAt,
          hosts,
        },
      },
    });
    const prepared = approval.prepare(candidate);
    OWNED_PREPARED_APPLY_PLANS.set(
      prepared,
      Object.freeze({
        approval,
        credential,
        codexProjection: resolvedCodexProjection,
      }),
    );
    return prepared;
  } catch {
    throw new SetupApplyPlanError();
  }
}

/*
 * Rendering and future execution must start from this apply-specific runtime
 * provenance check, not from the generic compile-time prepared-plan brand.
 */
export function requireOwnedSetupApplyPlan(
  plan: unknown,
): SetupPreparedPlan<SetupApplyPlan> {
  if (
    typeof plan !== "object" ||
    plan === null ||
    !OWNED_PREPARED_APPLY_PLANS.has(plan)
  ) {
    return invalidPlan();
  }
  return plan as SetupPreparedPlan<SetupApplyPlan>;
}

/*
 * The execution sidecar uses this identity-only check to prove that it is
 * attaching observation evidence to the exact apply plan, approval authority,
 * credential resolution, and Codex projection that were prepared together.
 * Nothing from the retained provenance is exposed to the caller.
 */
export function isOwnedSetupApplyPlanForProvenance(
  plan: unknown,
  approval: unknown,
  credential: unknown,
  codexProjection: unknown,
): plan is SetupPreparedPlan<SetupApplyPlan> {
  if (typeof plan !== "object" || plan === null) {
    return false;
  }
  const provenance = OWNED_PREPARED_APPLY_PLANS.get(plan);
  return (
    provenance !== undefined &&
    provenance.approval === approval &&
    provenance.credential === credential &&
    provenance.codexProjection === codexProjection
  );
}

/*
 * Confirmation needs only an identity check against the authority that
 * prepared the plan. It must not receive the credential or projection
 * identities retained for the later execution-sidecar check.
 */
export function isOwnedSetupApplyPlanForApproval(
  plan: unknown,
  approval: unknown,
): plan is SetupPreparedPlan<SetupApplyPlan> {
  if (typeof plan !== "object" || plan === null) {
    return false;
  }
  return OWNED_PREPARED_APPLY_PLANS.get(plan)?.approval === approval;
}

export function publicSetupApplyPreview(
  plan: unknown,
): SetupApplyPreview {
  return requireOwnedSetupApplyPlan(plan).preview;
}
