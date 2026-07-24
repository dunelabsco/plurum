import {
  isOwnedSetupCredentialResolvedPlan,
  type SetupCredentialPlanningResult,
  type SetupCredentialResolvedPlan,
} from "./setup-credential-plan.js";

export const SETUP_CODEX_PROJECTION_RELATIONS = Object.freeze([
  "absent",
  "matches-selected",
  "replacement-required",
  "ambiguous",
  "unsafe",
  "unavailable",
] as const);

export type SetupCodexProjectionRelation =
  (typeof SETUP_CODEX_PROJECTION_RELATIONS)[number];

export const SETUP_CODEX_PROJECTION_DISCLOSURE =
  "The Plurum API key will be loaded into Codex and may be inherited by processes Codex starts." as const;

export interface SetupCodexProjectionResolvedPlan {
  readonly status: "resolved";
  readonly client: "codex";
  readonly method: "user-dotenv";
  readonly effect: "create" | "unchanged" | "replace";
  readonly reason:
    | "projection-missing"
    | "projection-matches-selected-credential"
    | "projection-replacement-required";
  readonly disclosure: typeof SETUP_CODEX_PROJECTION_DISCLOSURE;
}

export type SetupCodexProjectionPlanningResult =
  | SetupCodexProjectionResolvedPlan
  | Readonly<{
      readonly status: "blocked";
      readonly client: "codex";
      readonly method: "user-dotenv";
      readonly reason:
        | "projection-ambiguous"
        | "projection-unsafe"
        | "projection-unavailable";
    }>;

export class SetupCodexProjectionPlanError extends Error {
  readonly code = "invalid_setup_codex_projection_plan";

  constructor() {
    super("The Codex credential projection plan could not be created safely.");
    this.name = "SetupCodexProjectionPlanError";
  }
}

const OWNED_RESOLVED_PROJECTIONS = new WeakMap<
  SetupCodexProjectionResolvedPlan,
  SetupCredentialResolvedPlan
>();

function invalidPlan(): never {
  throw new SetupCodexProjectionPlanError();
}

function resolved(
  credential: SetupCredentialResolvedPlan,
  effect: SetupCodexProjectionResolvedPlan["effect"],
  reason: SetupCodexProjectionResolvedPlan["reason"],
): SetupCodexProjectionResolvedPlan {
  const plan = Object.freeze({
    status: "resolved" as const,
    client: "codex" as const,
    method: "user-dotenv" as const,
    effect,
    reason,
    disclosure: SETUP_CODEX_PROJECTION_DISCLOSURE,
  });
  OWNED_RESOLVED_PROJECTIONS.set(plan, credential);
  return plan;
}

export function planSetupCodexProjection(
  credential: SetupCredentialPlanningResult,
  relation: SetupCodexProjectionRelation,
): SetupCodexProjectionPlanningResult {
  if (
    !isOwnedSetupCredentialResolvedPlan(credential) ||
    typeof relation !== "string" ||
    !SETUP_CODEX_PROJECTION_RELATIONS.includes(relation)
  ) {
    return invalidPlan();
  }

  if (relation === "matches-selected") {
    if (credential.acquisition === "new-registration") {
      return invalidPlan();
    }
    return resolved(
      credential,
      "unchanged",
      "projection-matches-selected-credential",
    );
  }
  if (relation === "absent") {
    return resolved(credential, "create", "projection-missing");
  }
  if (relation === "replacement-required") {
    return resolved(
      credential,
      "replace",
      "projection-replacement-required",
    );
  }
  return Object.freeze({
    status: "blocked" as const,
    client: "codex" as const,
    method: "user-dotenv" as const,
    reason:
      relation === "ambiguous"
        ? ("projection-ambiguous" as const)
        : relation === "unsafe"
          ? ("projection-unsafe" as const)
          : ("projection-unavailable" as const),
  });
}

export function isOwnedSetupCodexProjectionForCredential(
  projection: unknown,
  credential: SetupCredentialResolvedPlan,
): projection is SetupCodexProjectionResolvedPlan {
  return (
    typeof projection === "object" &&
    projection !== null &&
    OWNED_RESOLVED_PROJECTIONS.get(
      projection as SetupCodexProjectionResolvedPlan,
    ) === credential
  );
}
