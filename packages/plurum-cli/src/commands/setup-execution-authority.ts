import {
  isOwnedSetupApplyPlanForProvenance,
  type SetupApplyPlan,
} from "./setup-apply-plan.js";
import {
  isOwnedSetupApprovalAuthority,
  type SetupApprovalAuthority,
  type SetupApprovalIdentity,
  type SetupApprovalSource,
  type SetupPreparedPlan,
} from "./setup-approval.js";
import type {
  SetupCodexProjectionResolvedPlan,
} from "./setup-codex-projection-plan.js";
import type {
  SetupCredentialResolvedPlan,
} from "./setup-credential-plan.js";

declare const setupExecutionObservationBrand: unique symbol;
declare const setupExecutionSidecarBrand: unique symbol;
declare const setupExecutionGrantBrand: unique symbol;

/*
 * Observation, sidecar, and grant identities are in-memory capabilities. Their
 * runtime representations are opaque, one-use, and absent from serialization.
 */
export interface SetupExecutionObservationIdentity {
  readonly [setupExecutionObservationBrand]: never;
}

export interface SetupExecutionSidecarIdentity {
  readonly [setupExecutionSidecarBrand]: never;
}

export interface SetupExecutionGrant {
  /*
   * Future execution must hand this identity back to the same authority for
   * activation through a factory-owned executor boundary; retained evidence
   * must never enter a caller-provided callback or serialized value.
   */
  readonly [setupExecutionGrantBrand]: never;
}

export type SetupExecutionConsumeResult =
  | Readonly<{
      readonly status: "approved";
      readonly source: SetupApprovalSource;
      readonly grant: SetupExecutionGrant;
    }>
  | Readonly<{
      readonly status: "precondition-failed";
    }>;

export type SetupExecutionDiscardResult =
  | Readonly<{ readonly status: "discarded" }>
  | Readonly<{ readonly status: "precondition-failed" }>;

export interface SetupExecutionAuthority {
  /*
   * The authority-owning observer registers its private result as one opaque
   * object. The object is retained by identity, never inspected or copied by
   * this authority.
   */
  registerObservation(
    evidence: object,
  ): SetupExecutionObservationIdentity;

  /*
   * Binding consumes the observation even on failure. Only the exact apply
   * plan and the original planner-owned credential/projection identities may
   * receive a sidecar.
   */
  bind(
    plan: SetupPreparedPlan<SetupApplyPlan>,
    credential: SetupCredentialResolvedPlan,
    codexProjection: SetupCodexProjectionResolvedPlan | null,
    observation: SetupExecutionObservationIdentity,
  ): SetupExecutionSidecarIdentity;

  /*
   * Consumption burns both supplied capabilities before deciding the result.
   * Success returns another opaque capability, never the retained evidence.
   */
  consume(
    plan: SetupPreparedPlan<SetupApplyPlan>,
    approval: SetupApprovalIdentity,
    sidecar: SetupExecutionSidecarIdentity,
  ): SetupExecutionConsumeResult;

  /* Explicitly release any still-owned observation, sidecar, or grant. */
  discard(
    identity:
      | SetupExecutionObservationIdentity
      | SetupExecutionSidecarIdentity
      | SetupExecutionGrant,
  ): SetupExecutionDiscardResult;
}

interface SidecarState {
  readonly plan: SetupPreparedPlan<SetupApplyPlan>;
  readonly evidence: object;
}

const PRECONDITION_FAILED = Object.freeze({
  status: "precondition-failed",
} as const);
const DISCARDED = Object.freeze({ status: "discarded" } as const);
const TOKEN_TO_JSON = Object.freeze(function tokenToJson(): undefined {
  return undefined;
});

export class SetupExecutionAuthorityError extends Error {
  readonly code = "invalid_setup_execution_authority";

  constructor() {
    super("The setup execution authority could not be used safely.");
    this.name = "SetupExecutionAuthorityError";
  }
}

function invalidAuthority(): never {
  throw new SetupExecutionAuthorityError();
}

function issueIdentity<Identity extends object>(): Identity {
  const token = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(token, "toJSON", {
    configurable: false,
    enumerable: false,
    value: TOKEN_TO_JSON,
    writable: false,
  });
  return Object.freeze(token) as Identity;
}

export function createSetupExecutionAuthority(
  approvalAuthority: SetupApprovalAuthority,
): SetupExecutionAuthority {
  if (!isOwnedSetupApprovalAuthority(approvalAuthority)) {
    return invalidAuthority();
  }

  const observations = new WeakMap<
    SetupExecutionObservationIdentity,
    object
  >();
  const sidecars = new WeakMap<
    SetupExecutionSidecarIdentity,
    SidecarState
  >();
  const sidecarByPlan = new WeakMap<
    SetupPreparedPlan<SetupApplyPlan>,
    SetupExecutionSidecarIdentity
  >();
  const grants = new WeakMap<SetupExecutionGrant, SidecarState>();

  function releaseSidecar(
    identity: SetupExecutionSidecarIdentity,
    state: SidecarState,
  ): void {
    sidecars.delete(identity);
    if (sidecarByPlan.get(state.plan) === identity) {
      sidecarByPlan.delete(state.plan);
    }
  }

  return Object.freeze({
    registerObservation(
      evidence: object,
    ): SetupExecutionObservationIdentity {
      if (
        (typeof evidence !== "object" || evidence === null) &&
        typeof evidence !== "function"
      ) {
        return invalidAuthority();
      }
      const identity =
        issueIdentity<SetupExecutionObservationIdentity>();
      observations.set(identity, evidence);
      return identity;
    },

    bind(
      plan: SetupPreparedPlan<SetupApplyPlan>,
      credential: SetupCredentialResolvedPlan,
      codexProjection: SetupCodexProjectionResolvedPlan | null,
      observation: SetupExecutionObservationIdentity,
    ): SetupExecutionSidecarIdentity {
      const evidence = observations.get(observation);
      observations.delete(observation);

      const existing = sidecarByPlan.get(plan);
      if (existing !== undefined) {
        if (sidecars.get(existing) === undefined) {
          sidecarByPlan.delete(plan);
        } else {
          return invalidAuthority();
        }
      }

      if (
        evidence === undefined ||
        !isOwnedSetupApplyPlanForProvenance(
          plan,
          approvalAuthority,
          credential,
          codexProjection,
        )
      ) {
        return invalidAuthority();
      }

      const identity = issueIdentity<SetupExecutionSidecarIdentity>();
      const state = Object.freeze({ plan, evidence });
      sidecars.set(identity, state);
      sidecarByPlan.set(plan, identity);
      return identity;
    },

    consume(
      plan: SetupPreparedPlan<SetupApplyPlan>,
      approval: SetupApprovalIdentity,
      sidecar: SetupExecutionSidecarIdentity,
    ): SetupExecutionConsumeResult {
      const boundSidecar = sidecarByPlan.get(plan);
      const boundState =
        boundSidecar === undefined
          ? undefined
          : sidecars.get(boundSidecar);
      if (boundSidecar !== undefined && boundState !== undefined) {
        releaseSidecar(boundSidecar, boundState);
      } else if (boundSidecar !== undefined) {
        sidecarByPlan.delete(plan);
      }

      const suppliedState = sidecars.get(sidecar);
      if (suppliedState !== undefined) {
        releaseSidecar(sidecar, suppliedState);
      }

      const approved = approvalAuthority.consume({ approval, plan });
      if (
        boundSidecar !== sidecar ||
        boundState === undefined ||
        boundState.plan !== plan ||
        approved.status !== "approved"
      ) {
        return PRECONDITION_FAILED;
      }

      const grant = issueIdentity<SetupExecutionGrant>();
      grants.set(grant, boundState);
      return Object.freeze({
        status: "approved" as const,
        source: approved.source,
        grant,
      });
    },

    discard(
      identity:
        | SetupExecutionObservationIdentity
        | SetupExecutionSidecarIdentity
        | SetupExecutionGrant,
    ): SetupExecutionDiscardResult {
      if (
        observations.delete(
          identity as SetupExecutionObservationIdentity,
        )
      ) {
        return DISCARDED;
      }

      const sidecarIdentity = identity as SetupExecutionSidecarIdentity;
      const state = sidecars.get(sidecarIdentity);
      if (state !== undefined) {
        releaseSidecar(sidecarIdentity, state);
        return DISCARDED;
      }

      if (grants.delete(identity as SetupExecutionGrant)) {
        return DISCARDED;
      }
      return PRECONDITION_FAILED;
    },
  });
}
