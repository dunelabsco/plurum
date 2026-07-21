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
import {
  discardSetupSecretLease,
  isOwnedSetupSecretLease,
  type SetupSecretLease,
} from "./setup-secret-lease.js";

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
    secretLease?: SetupSecretLease,
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

interface ObservationState {
  readonly evidence: object;
  readonly secretLease: SetupSecretLease | null;
}

interface SidecarState extends ObservationState {
  readonly plan: SetupPreparedPlan<SetupApplyPlan>;
}

interface OwnedSidecarState {
  readonly authority: SetupExecutionAuthority;
  readonly plan: SetupPreparedPlan<SetupApplyPlan>;
}

interface OwnedGrantState {
  readonly authority: SetupExecutionAuthority;
  readonly state: SidecarState;
}

const PRECONDITION_FAILED = Object.freeze({
  status: "precondition-failed",
} as const);
const DISCARDED = Object.freeze({ status: "discarded" } as const);
const TOKEN_TO_JSON = Object.freeze(function tokenToJson(): undefined {
  return undefined;
});
const OWNED_EXECUTION_AUTHORITIES = new WeakMap<
  SetupExecutionAuthority,
  SetupApprovalAuthority
>();
const OWNED_SIDECARS = new WeakMap<
  SetupExecutionSidecarIdentity,
  OwnedSidecarState
>();
const OWNED_GRANTS = new WeakMap<
  SetupExecutionGrant,
  OwnedGrantState
>();
const SETUP_EXECUTION_SIDECAR_CLAIMERS = new WeakMap<
  SetupExecutionAuthority,
  (
    plan: SetupPreparedPlan<SetupApplyPlan>,
    sidecar: SetupExecutionSidecarIdentity,
  ) => SetupExecutionSidecarIdentity
>();
const SETUP_EXECUTION_GRANT_BURNERS = new WeakMap<
  SetupExecutionAuthority,
  (grant: SetupExecutionGrant, dispose: boolean) => void
>();

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
    ObservationState
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

  function disposeState(state: ObservationState | SidecarState): void {
    if (state.secretLease !== null) {
      discardSetupSecretLease(state.secretLease);
    }
  }

  function releaseSidecar(
    identity: SetupExecutionSidecarIdentity,
    state: SidecarState,
  ): void {
    sidecars.delete(identity);
    OWNED_SIDECARS.delete(identity);
    if (sidecarByPlan.get(state.plan) === identity) {
      sidecarByPlan.delete(state.plan);
    }
  }

  function releaseGrant(
    identity: SetupExecutionGrant,
    state: SidecarState,
  ): void {
    grants.delete(identity);
    const owned = OWNED_GRANTS.get(identity);
    if (owned?.authority === authority && owned.state === state) {
      OWNED_GRANTS.delete(identity);
    }
  }

  function claimSidecar(
    plan: SetupPreparedPlan<SetupApplyPlan>,
    sidecar: SetupExecutionSidecarIdentity,
  ): SetupExecutionSidecarIdentity {
    const boundSidecar = sidecarByPlan.get(plan);
    const boundState =
      boundSidecar === undefined
        ? undefined
        : sidecars.get(boundSidecar);
    const suppliedState = sidecars.get(sidecar);
    if (suppliedState !== undefined) {
      releaseSidecar(sidecar, suppliedState);
    } else if (boundSidecar === sidecar) {
      sidecarByPlan.delete(plan);
    }
    if (
      boundSidecar !== sidecar ||
      boundState === undefined ||
      suppliedState !== boundState ||
      boundState.plan !== plan
    ) {
      if (suppliedState !== undefined) {
        disposeState(suppliedState);
      }
      return invalidAuthority();
    }

    const claimed = issueIdentity<SetupExecutionSidecarIdentity>();
    sidecars.set(claimed, boundState);
    sidecarByPlan.set(plan, claimed);
    OWNED_SIDECARS.set(
      claimed,
      Object.freeze({ authority, plan }),
    );
    return claimed;
  }

  const authority: SetupExecutionAuthority = Object.freeze({
    registerObservation(
      evidence: object,
      secretLease?: SetupSecretLease,
    ): SetupExecutionObservationIdentity {
      const retainedLease =
        secretLease === undefined
          ? null
          : isOwnedSetupSecretLease(secretLease)
            ? secretLease
            : undefined;
      if (
        ((typeof evidence !== "object" || evidence === null) &&
          typeof evidence !== "function") ||
        retainedLease === undefined
      ) {
        if (retainedLease !== null && retainedLease !== undefined) {
          discardSetupSecretLease(retainedLease);
        }
        return invalidAuthority();
      }
      const identity =
        issueIdentity<SetupExecutionObservationIdentity>();
      observations.set(
        identity,
        Object.freeze({ evidence, secretLease: retainedLease }),
      );
      return identity;
    },

    bind(
      plan: SetupPreparedPlan<SetupApplyPlan>,
      credential: SetupCredentialResolvedPlan,
      codexProjection: SetupCodexProjectionResolvedPlan | null,
      observation: SetupExecutionObservationIdentity,
    ): SetupExecutionSidecarIdentity {
      const observationState = observations.get(observation);
      observations.delete(observation);

      const existing = sidecarByPlan.get(plan);
      if (existing !== undefined) {
        if (sidecars.get(existing) === undefined) {
          sidecarByPlan.delete(plan);
        } else {
          if (observationState !== undefined) {
            disposeState(observationState);
          }
          return invalidAuthority();
        }
      }

      if (
        observationState === undefined ||
        !isOwnedSetupApplyPlanForProvenance(
          plan,
          approvalAuthority,
          credential,
          codexProjection,
        )
      ) {
        if (observationState !== undefined) {
          disposeState(observationState);
        }
        return invalidAuthority();
      }

      const identity = issueIdentity<SetupExecutionSidecarIdentity>();
      const state = Object.freeze({ plan, ...observationState });
      sidecars.set(identity, state);
      sidecarByPlan.set(plan, identity);
      OWNED_SIDECARS.set(
        identity,
        Object.freeze({ authority, plan }),
      );
      return identity;
    },

    consume(
      plan: SetupPreparedPlan<SetupApplyPlan>,
      approval: SetupApprovalIdentity,
      sidecar: SetupExecutionSidecarIdentity,
    ): SetupExecutionConsumeResult {
      const boundSidecar = sidecarByPlan.get(plan);
      const suppliedState = sidecars.get(sidecar);
      if (suppliedState !== undefined) {
        releaseSidecar(sidecar, suppliedState);
      } else if (boundSidecar === sidecar) {
        sidecarByPlan.delete(plan);
      }

      const approved = approvalAuthority.consume({ approval, plan });
      if (
        boundSidecar !== sidecar ||
        suppliedState === undefined ||
        suppliedState.plan !== plan ||
        approved.status !== "approved"
      ) {
        if (suppliedState !== undefined) {
          disposeState(suppliedState);
        }
        return PRECONDITION_FAILED;
      }

      const grant = issueIdentity<SetupExecutionGrant>();
      grants.set(grant, suppliedState);
      OWNED_GRANTS.set(
        grant,
        Object.freeze({ authority, state: suppliedState }),
      );
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
      const observationIdentity =
        identity as SetupExecutionObservationIdentity;
      const observationState = observations.get(observationIdentity);
      if (observationState !== undefined) {
        observations.delete(observationIdentity);
        disposeState(observationState);
        return DISCARDED;
      }

      const sidecarIdentity = identity as SetupExecutionSidecarIdentity;
      const state = sidecars.get(sidecarIdentity);
      if (state !== undefined) {
        releaseSidecar(sidecarIdentity, state);
        disposeState(state);
        return DISCARDED;
      }

      const grantIdentity = identity as SetupExecutionGrant;
      const grantState = grants.get(grantIdentity);
      if (grantState !== undefined) {
        releaseGrant(grantIdentity, grantState);
        disposeState(grantState);
        return DISCARDED;
      }
      return PRECONDITION_FAILED;
    },
  });
  OWNED_EXECUTION_AUTHORITIES.set(authority, approvalAuthority);
  SETUP_EXECUTION_SIDECAR_CLAIMERS.set(authority, claimSidecar);
  SETUP_EXECUTION_GRANT_BURNERS.set(authority, (grant, dispose) => {
    const state = grants.get(grant);
    if (state !== undefined) {
      releaseGrant(grant, state);
      if (dispose) {
        disposeState(state);
      }
    }
  });
  return authority;
}

/*
 * Confirmation atomically replaces the caller-held sidecar with a new private
 * identity before any await. The original can no longer be discarded or
 * consumed while the exact plan is being displayed.
 */
export function claimSetupExecutionSidecar(
  authority: SetupExecutionAuthority,
  plan: SetupPreparedPlan<SetupApplyPlan>,
  sidecar: SetupExecutionSidecarIdentity,
): SetupExecutionSidecarIdentity {
  const claim = SETUP_EXECUTION_SIDECAR_CLAIMERS.get(authority);
  if (claim === undefined) {
    return invalidAuthority();
  }
  return claim(plan, sidecar);
}

/*
 * Registration execution burns the supplied grant before validating its
 * authority and exact prepared-plan identity. Only the reviewed, factory-owned
 * executor may receive the retained private evidence; no caller callback is
 * accepted and no evidence is copied into another serializable wrapper.
 */
export function claimSetupExecutionGrant(
  authority: SetupExecutionAuthority,
  plan: SetupPreparedPlan<SetupApplyPlan>,
  grant: SetupExecutionGrant,
): object {
  const owned = OWNED_GRANTS.get(grant);
  OWNED_GRANTS.delete(grant);
  const valid =
    owned !== undefined &&
    owned.authority === authority &&
    owned.state.plan === plan;
  if (owned !== undefined) {
    SETUP_EXECUTION_GRANT_BURNERS.get(owned.authority)?.(grant, !valid);
  }
  if (!valid || owned === undefined) {
    return invalidAuthority();
  }
  return owned.state.evidence;
}

export function isOwnedSetupExecutionAuthorityForApproval(
  authority: unknown,
  approval: unknown,
): authority is SetupExecutionAuthority {
  return (
    typeof authority === "object" &&
    authority !== null &&
    OWNED_EXECUTION_AUTHORITIES.get(
      authority as SetupExecutionAuthority,
    ) === approval
  );
}

export function isOwnedSetupExecutionSidecarForPlan(
  authority: unknown,
  sidecar: unknown,
  plan: unknown,
): sidecar is SetupExecutionSidecarIdentity {
  if (
    typeof authority !== "object" ||
    authority === null ||
    typeof sidecar !== "object" ||
    sidecar === null ||
    typeof plan !== "object" ||
    plan === null
  ) {
    return false;
  }
  const state = OWNED_SIDECARS.get(
    sidecar as SetupExecutionSidecarIdentity,
  );
  return state?.authority === authority && state.plan === plan;
}
