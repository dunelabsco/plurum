import {
  isOwnedSetupApplyPlanForApproval,
  publicSetupApplyPreview,
  type SetupApplyPlan,
} from "./setup-apply-plan.js";
import {
  isOwnedSetupApprovalAuthority,
  mintSetupApproval,
  type SetupApprovalAuthority,
  type SetupApprovalSource,
  type SetupPreparedPlan,
} from "./setup-approval.js";
import {
  claimSetupExecutionSidecar,
  isOwnedSetupExecutionAuthorityForApproval,
  isOwnedSetupExecutionSidecarForPlan,
  type SetupExecutionAuthority,
  type SetupExecutionDiscardResult,
  type SetupExecutionGrant,
  type SetupExecutionSidecarIdentity,
} from "./setup-execution-authority.js";
import { renderSetupApplyPlan } from "./setup-output.js";

export const SETUP_CONFIRMATION_PROMPT =
  "Type 'yes' to apply this exact plan: " as const;

export type SetupConfirmationMode = "interactive" | "assume-yes";
export type SetupPlanPresentationResult = "presented" | "unavailable";
export type SetupInteractiveConfirmationResult =
  | "confirmed"
  | "declined"
  | "unavailable";

declare const setupPlanPresenterBrand: unique symbol;
declare const setupInteractiveConfirmationBrand: unique symbol;

export interface SetupPlanPresenter {
  readonly [setupPlanPresenterBrand]: never;
  presentPlan(text: string): Promise<SetupPlanPresentationResult>;
}

export interface SetupInteractiveConfirmation {
  readonly [setupInteractiveConfirmationBrand]: never;
  confirm(): Promise<SetupInteractiveConfirmationResult>;
}

export interface SetupInteractiveSessionPorts {
  readonly presenter: SetupPlanPresenter;
  readonly confirmation: SetupInteractiveConfirmation;
}

export type SetupConfirmationCancellation =
  | "declined"
  | "presentation-unavailable"
  | "interaction-unavailable";

export type SetupConfirmationResult =
  | Readonly<{
      readonly status: "approved";
      readonly source: SetupApprovalSource;
      readonly grant: SetupExecutionGrant;
    }>
  | Readonly<{ readonly status: "not-required" }>
  | Readonly<{
      readonly status: "cancelled";
      readonly reason: SetupConfirmationCancellation;
    }>
  | Readonly<{ readonly status: "precondition-failed" }>;

export interface SetupConfirmationAttempt {
  /*
   * One attempt only. The attempt is burned synchronously before rendering or
   * awaiting I/O. `assume-yes` still displays the exact plan and never calls
   * the interactive reader.
   */
  authorize(): Promise<SetupConfirmationResult>;

  /* Release the privately claimed sidecar if orchestration is abandoned. */
  discard(): SetupExecutionDiscardResult;
}

const PRECONDITION_FAILED = Object.freeze({
  status: "precondition-failed" as const,
});
const NOT_REQUIRED = Object.freeze({ status: "not-required" as const });
const CANCELLED_DECLINED = Object.freeze({
  status: "cancelled" as const,
  reason: "declined" as const,
});
const CANCELLED_PRESENTATION = Object.freeze({
  status: "cancelled" as const,
  reason: "presentation-unavailable" as const,
});
const CANCELLED_INTERACTION = Object.freeze({
  status: "cancelled" as const,
  reason: "interaction-unavailable" as const,
});
const ATTEMPTED_PLANS = new WeakSet<object>();
const OWNED_PLAN_PRESENTERS = new WeakMap<
  SetupPlanPresenter,
  "input-free" | "interactive"
>();
const OWNED_INTERACTIVE_PAIRS = new WeakMap<
  SetupPlanPresenter,
  SetupInteractiveConfirmation
>();

export class SetupConfirmationError extends Error {
  readonly code = "invalid_setup_confirmation";

  constructor() {
    super("The setup confirmation could not be created safely.");
    this.name = "SetupConfirmationError";
  }
}

function invalidConfirmation(): never {
  throw new SetupConfirmationError();
}

/*
 * These factories are composition boundaries, not generic trust upgrades.
 * The capability verifier permits production imports only from the reviewed
 * Node terminal adapter; tests use them with isolated in-memory operations.
 */
function createPresenter(
  kind: "input-free" | "interactive",
  presentPlan: (
    text: string,
  ) => Promise<SetupPlanPresentationResult>,
): SetupPlanPresenter {
  if (typeof presentPlan !== "function") {
    return invalidConfirmation();
  }
  const presenter = Object.freeze({
    async presentPlan(text: string): Promise<SetupPlanPresentationResult> {
      if (typeof text !== "string") {
        return "unavailable";
      }
      try {
        return await presentPlan(text) === "presented"
          ? "presented"
          : "unavailable";
      } catch {
        return "unavailable";
      }
    },
  }) as SetupPlanPresenter;
  OWNED_PLAN_PRESENTERS.set(presenter, kind);
  return presenter;
}

export function createSetupInputFreePlanPresenter(
  presentPlan: (
    text: string,
  ) => Promise<SetupPlanPresentationResult>,
): SetupPlanPresenter {
  return createPresenter("input-free", presentPlan);
}

export function createSetupInteractiveSessionPorts(
  presentPlan: (
    text: string,
  ) => Promise<SetupPlanPresentationResult>,
  confirm: () => Promise<SetupInteractiveConfirmationResult>,
): SetupInteractiveSessionPorts {
  if (
    typeof presentPlan !== "function" ||
    typeof confirm !== "function"
  ) {
    return invalidConfirmation();
  }
  const presenter = createPresenter("interactive", presentPlan);
  const interaction = Object.freeze({
    async confirm(): Promise<SetupInteractiveConfirmationResult> {
      try {
        const result = await confirm();
        return result === "confirmed" || result === "declined"
          ? result
          : "unavailable";
      } catch {
        return "unavailable";
      }
    },
  }) as SetupInteractiveConfirmation;
  OWNED_INTERACTIVE_PAIRS.set(presenter, interaction);
  return Object.freeze({ presenter, confirmation: interaction });
}

function discardOrFail(
  execution: SetupExecutionAuthority,
  sidecar: SetupExecutionSidecarIdentity,
  result: Exclude<
    SetupConfirmationResult,
    Readonly<{
      readonly status: "approved";
      readonly source: SetupApprovalSource;
      readonly grant: SetupExecutionGrant;
    }>
  >,
): SetupConfirmationResult {
  try {
    return execution.discard(sidecar).status === "discarded"
      ? result
      : PRECONDITION_FAILED;
  } catch {
    return PRECONDITION_FAILED;
  }
}

function approveAndConsume(
  approval: SetupApprovalAuthority,
  execution: SetupExecutionAuthority,
  plan: SetupPreparedPlan<SetupApplyPlan>,
  sidecar: SetupExecutionSidecarIdentity,
  source: SetupApprovalSource,
): SetupConfirmationResult {
  try {
    const identity = mintSetupApproval(approval, { plan, source });
    return execution.consume(plan, identity, sidecar);
  } catch {
    return discardOrFail(
      execution,
      sidecar,
      PRECONDITION_FAILED,
    );
  }
}

/*
 * Capture all identity-bearing values and the primitive mode before any
 * output. The displayed plan cannot be replaced after the user sees it, and
 * no adapter ever receives private execution authority.
 */
export function createSetupConfirmationAttempt(
  plan: SetupPreparedPlan<SetupApplyPlan>,
  sidecar: SetupExecutionSidecarIdentity,
  approval: SetupApprovalAuthority,
  execution: SetupExecutionAuthority,
  mode: SetupConfirmationMode,
  presenter: SetupPlanPresenter,
  interaction: SetupInteractiveConfirmation | null,
): SetupConfirmationAttempt {
  const ownedApproval = isOwnedSetupApprovalAuthority(approval);
  const ownedExecution =
    ownedApproval &&
    isOwnedSetupExecutionAuthorityForApproval(execution, approval);
  if (
    !ownedExecution ||
    !isOwnedSetupApplyPlanForApproval(plan, approval) ||
    !isOwnedSetupExecutionSidecarForPlan(execution, sidecar, plan) ||
    (mode !== "interactive" && mode !== "assume-yes")
  ) {
    if (ownedExecution) {
      try {
        execution.discard(sidecar);
      } catch {
        /* Fixed failure below; never reflect an authority error. */
      }
    }
    return invalidConfirmation();
  }

  let requiresConfirmation: boolean;
  try {
    requiresConfirmation =
      publicSetupApplyPreview(plan).confirmation === "required";
  } catch {
    try {
      execution.discard(sidecar);
    } catch {
      /* Fixed failure below; never reflect an authority error. */
    }
    return invalidConfirmation();
  }
  const expectedPresenter =
    requiresConfirmation && mode === "interactive"
      ? "interactive"
      : "input-free";
  if (
    OWNED_PLAN_PRESENTERS.get(presenter) !== expectedPresenter ||
    (expectedPresenter === "interactive"
      ? interaction === null ||
        OWNED_INTERACTIVE_PAIRS.get(presenter) !== interaction
      : interaction !== null)
  ) {
    try {
      execution.discard(sidecar);
    } catch {
      /* Fixed failure below; never reflect an authority error. */
    }
    return invalidConfirmation();
  }

  const presentPlan = presenter.presentPlan;
  const confirm = interaction?.confirm;
  let claimedSidecar: SetupExecutionSidecarIdentity;
  try {
    claimedSidecar = claimSetupExecutionSidecar(
      execution,
      plan,
      sidecar,
    );
  } catch {
    return invalidConfirmation();
  }
  let state: "ready" | "authorizing" | "released" = "ready";

  const release = (
    result: Exclude<
      SetupConfirmationResult,
      Readonly<{
        readonly status: "approved";
        readonly source: SetupApprovalSource;
        readonly grant: SetupExecutionGrant;
      }>
    >,
  ): SetupConfirmationResult => {
    if (state === "released") {
      return PRECONDITION_FAILED;
    }
    state = "released";
    return discardOrFail(execution, claimedSidecar, result);
  };

  return Object.freeze({
    async authorize(): Promise<SetupConfirmationResult> {
      if (state !== "ready") {
        return PRECONDITION_FAILED;
      }
      if (ATTEMPTED_PLANS.has(plan)) {
        return release(PRECONDITION_FAILED);
      }
      state = "authorizing";
      ATTEMPTED_PLANS.add(plan);

      let rendered: string;
      try {
        rendered = renderSetupApplyPlan(plan);
      } catch {
        return release(PRECONDITION_FAILED);
      }

      let presentation: SetupPlanPresentationResult;
      try {
        presentation = await presentPlan(rendered);
      } catch {
        return release(CANCELLED_PRESENTATION);
      }
      if (state !== "authorizing") {
        return PRECONDITION_FAILED;
      }
      if (presentation !== "presented") {
        return release(CANCELLED_PRESENTATION);
      }

      if (!requiresConfirmation) {
        return release(NOT_REQUIRED);
      }

      if (mode === "assume-yes") {
        const result = approveAndConsume(
          approval,
          execution,
          plan,
          claimedSidecar,
          "assume-yes",
        );
        state = "released";
        return result;
      }

      let decision: SetupInteractiveConfirmationResult;
      try {
        decision = await confirm?.() ?? "unavailable";
      } catch {
        return release(CANCELLED_INTERACTION);
      }
      if (state !== "authorizing") {
        return PRECONDITION_FAILED;
      }
      if (decision === "declined") {
        return release(CANCELLED_DECLINED);
      }
      if (decision !== "confirmed") {
        return release(CANCELLED_INTERACTION);
      }
      const result = approveAndConsume(
        approval,
        execution,
        plan,
        claimedSidecar,
        "interactive",
      );
      state = "released";
      return result;
    },

    discard(): SetupExecutionDiscardResult {
      if (state === "released") {
        return PRECONDITION_FAILED;
      }
      state = "released";
      ATTEMPTED_PLANS.add(plan);
      try {
        return execution.discard(claimedSidecar);
      } catch {
        return PRECONDITION_FAILED;
      }
    },
  });
}
