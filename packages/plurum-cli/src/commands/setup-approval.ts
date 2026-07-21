export const SETUP_APPROVAL_SOURCES = Object.freeze([
  "interactive",
  "assume-yes",
] as const);

export type SetupApprovalSource =
  (typeof SETUP_APPROVAL_SOURCES)[number];

declare const setupApprovalIdentityBrand: unique symbol;
declare const setupPreparedPlanBrand: unique symbol;

/*
 * An approval is deliberately opaque, adapter-bound, one-use, and absent from
 * serialization. It carries no plan, command, credential, or diagnostic data.
 */
export interface SetupApprovalIdentity {
  readonly [setupApprovalIdentityBrand]: never;
}

/*
 * Prepared plans are owned canonical snapshots. Preview, approval, and future
 * execution must all use this exact object rather than the caller's candidate.
 */
export type SetupPreparedPlan<Plan extends object = object> =
  Readonly<Plan> & {
    readonly [setupPreparedPlanBrand]: never;
  };

export interface SetupApprovalRequest {
  readonly plan: SetupPreparedPlan;
  readonly source: SetupApprovalSource;
}

export interface SetupApprovalConsumeRequest {
  readonly approval: SetupApprovalIdentity;
  readonly plan: SetupPreparedPlan;
}

export type SetupApprovalConsumeResult =
  | Readonly<{
      readonly status: "approved";
      readonly source: SetupApprovalSource;
    }>
  | Readonly<{
      readonly status: "precondition-failed";
    }>;

export interface SetupApprovalAuthority {
  /*
   * Call this before rendering. The result is an owned, deeply frozen,
   * accessor-free tree; no caller object or Proxy survives into it.
   */
  prepare<Plan extends object>(
    plan: Plan,
  ): SetupPreparedPlan<Plan>;

  /*
   * The command orchestrator may call this only after the complete public
   * preview has been written successfully and the user has approved that exact
   * immutable plan. `--yes` changes the source, never the plan.
   */
  approve(request: SetupApprovalRequest): SetupApprovalIdentity;

  /*
   * The future executor must consume this synchronously before its first
   * mutation. A wrong plan consumes the approval and fails closed.
   */
  consume(
    request: SetupApprovalConsumeRequest,
  ): SetupApprovalConsumeResult;
}

interface ApprovalState {
  readonly plan: SetupPreparedPlan;
  readonly source: SetupApprovalSource;
}

interface PlanTraversal {
  nodes: number;
  properties: number;
  characters: number;
  readonly visiting: WeakSet<object>;
}

const MAX_PLAN_NODES = 4_096;
const MAX_PLAN_PROPERTIES = 16_384;
const MAX_PLAN_DEPTH = 64;
const MAX_PLAN_STRING_CHARACTERS = 1024 * 1024;
const MAX_PLAN_PROPERTY_NAME_CHARACTERS = 1_024;
const MAX_PLAN_TOTAL_CHARACTERS = 4 * 1024 * 1024;

const PRECONDITION_FAILED = Object.freeze({
  status: "precondition-failed",
} as const);
const APPROVED_INTERACTIVE = Object.freeze({
  status: "approved",
  source: "interactive",
} as const);
const APPROVED_ASSUME_YES = Object.freeze({
  status: "approved",
  source: "assume-yes",
} as const);
const TOKEN_TO_JSON = Object.freeze(function tokenToJson(): undefined {
  return undefined;
});
const OWNED_APPROVAL_AUTHORITIES = new WeakSet<object>();

class SetupApprovalError extends Error {
  constructor() {
    super("The setup approval could not be created safely.");
    this.name = "SetupApprovalError";
  }
}

function invalidApproval(): never {
  throw new SetupApprovalError();
}

function snapshotRequest(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  let array: boolean;
  try {
    array = Array.isArray(value);
  } catch {
    return invalidApproval();
  }
  if (
    value === null ||
    typeof value !== "object" ||
    array
  ) {
    return invalidApproval();
  }

  let names: readonly string[];
  let symbols: readonly symbol[];
  try {
    names = Object.getOwnPropertyNames(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return invalidApproval();
  }
  if (
    symbols.length !== 0 ||
    names.length !== keys.length ||
    names.some((name) => !keys.includes(name)) ||
    keys.some((key) => !names.includes(key))
  ) {
    return invalidApproval();
  }

  const snapshot: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of names) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return invalidApproval();
    }
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      return invalidApproval();
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function snapshotFrozenPlainData(
  value: unknown,
  traversal: PlanTraversal,
  depth: number,
): unknown {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : invalidApproval();
  }
  if (typeof value === "string") {
    if (
      value.length > MAX_PLAN_STRING_CHARACTERS ||
      traversal.characters + value.length >
        MAX_PLAN_TOTAL_CHARACTERS
    ) {
      return invalidApproval();
    }
    traversal.characters += value.length;
    return value;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    depth > MAX_PLAN_DEPTH
  ) {
    return invalidApproval();
  }
  if (traversal.visiting.has(value)) {
    return invalidApproval();
  }

  let prototype: object | null;
  let names: readonly string[];
  let symbols: readonly symbol[];
  let array: boolean;
  try {
    if (!Object.isFrozen(value)) {
      return invalidApproval();
    }
    array = Array.isArray(value);
    prototype = Object.getPrototypeOf(value) as object | null;
    names = Object.getOwnPropertyNames(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return invalidApproval();
  }
  if (
    symbols.length !== 0 ||
    (array
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null)
  ) {
    return invalidApproval();
  }

  let arrayLength: number | undefined;
  if (array) {
    let lengthDescriptor: PropertyDescriptor | undefined;
    try {
      lengthDescriptor = Object.getOwnPropertyDescriptor(
        value,
        "length",
      );
    } catch {
      return invalidApproval();
    }
    if (
      lengthDescriptor === undefined ||
      !Object.hasOwn(lengthDescriptor, "value") ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > MAX_PLAN_PROPERTIES ||
      names.length !== lengthDescriptor.value + 1
    ) {
      return invalidApproval();
    }
    arrayLength = lengthDescriptor.value;
  }

  traversal.nodes += 1;
  traversal.properties += names.length;
  if (
    traversal.nodes > MAX_PLAN_NODES ||
    traversal.properties > MAX_PLAN_PROPERTIES
  ) {
    return invalidApproval();
  }
  for (const name of names) {
    if (
      name.length > MAX_PLAN_PROPERTY_NAME_CHARACTERS ||
      traversal.characters + name.length >
        MAX_PLAN_TOTAL_CHARACTERS
    ) {
      return invalidApproval();
    }
    traversal.characters += name.length;
  }

  const snapshot = array
    ? new Array(arrayLength)
    : (Object.create(null) as Record<string, unknown>);
  traversal.visiting.add(value);

  for (const name of names) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, name);
    } catch {
      return invalidApproval();
    }
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.configurable ||
      descriptor.writable ||
      (array && name === "length"
        ? descriptor.enumerable
        : !descriptor.enumerable)
    ) {
      return invalidApproval();
    }
    if (
      array &&
      name !== "length" &&
      (arrayLength === undefined ||
        !/^(0|[1-9][0-9]*)$/u.test(name) ||
        Number(name) >= arrayLength)
    ) {
      return invalidApproval();
    }
    if (array && name === "length") {
      continue;
    }
    const child = snapshotFrozenPlainData(
      descriptor.value,
      traversal,
      depth + 1,
    );
    Object.defineProperty(snapshot, name, {
      configurable: false,
      enumerable: true,
      value: child,
      writable: false,
    });
  }
  traversal.visiting.delete(value);
  return Object.freeze(snapshot);
}

function preparePlan(value: unknown): SetupPreparedPlan {
  if (
    typeof value !== "object" ||
    value === null
  ) {
    return invalidApproval();
  }
  return snapshotFrozenPlainData(
    value,
    {
      nodes: 0,
      properties: 0,
      characters: 0,
      visiting: new WeakSet<object>(),
    },
    0,
  ) as SetupPreparedPlan;
}

function approvalSource(value: unknown): SetupApprovalSource {
  if (
    typeof value !== "string" ||
    !SETUP_APPROVAL_SOURCES.includes(
      value as SetupApprovalSource,
    )
  ) {
    return invalidApproval();
  }
  return value as SetupApprovalSource;
}

function issueIdentity(): SetupApprovalIdentity {
  const token = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(token, "toJSON", {
    configurable: false,
    enumerable: false,
    value: TOKEN_TO_JSON,
    writable: false,
  });
  return Object.freeze(token) as unknown as SetupApprovalIdentity;
}

export function createSetupApprovalAuthority(): SetupApprovalAuthority {
  const preparedPlans = new WeakSet<SetupPreparedPlan>();
  const approvals = new WeakMap<
    SetupApprovalIdentity,
    ApprovalState
  >();

  const authority = Object.freeze({
    prepare<Plan extends object>(
      candidate: Plan,
    ): SetupPreparedPlan<Plan> {
      const plan = preparePlan(candidate) as SetupPreparedPlan<Plan>;
      preparedPlans.add(plan);
      return plan;
    },

    approve(rawRequest: SetupApprovalRequest): SetupApprovalIdentity {
      const request = snapshotRequest(rawRequest, ["plan", "source"]);
      const plan = request.plan;
      if (
        typeof plan !== "object" ||
        plan === null ||
        !preparedPlans.has(plan as SetupPreparedPlan)
      ) {
        return invalidApproval();
      }
      const source = approvalSource(request.source);
      const approval = issueIdentity();
      approvals.set(
        approval,
        Object.freeze({
          plan: plan as SetupPreparedPlan,
          source,
        }),
      );
      return approval;
    },

    consume(
      rawRequest: SetupApprovalConsumeRequest,
    ): SetupApprovalConsumeResult {
      let request: Readonly<Record<string, unknown>>;
      try {
        request = snapshotRequest(rawRequest, ["approval", "plan"]);
      } catch {
        return PRECONDITION_FAILED;
      }
      const approval = request.approval;
      if (
        typeof approval !== "object" ||
        approval === null
      ) {
        return PRECONDITION_FAILED;
      }

      const identity = approval as SetupApprovalIdentity;
      const state = approvals.get(identity);
      if (state === undefined) {
        return PRECONDITION_FAILED;
      }
      approvals.delete(identity);
      if (state.plan !== request.plan) {
        return PRECONDITION_FAILED;
      }
      return state.source === "interactive"
        ? APPROVED_INTERACTIVE
        : APPROVED_ASSUME_YES;
    },
  });
  OWNED_APPROVAL_AUTHORITIES.add(authority);
  return authority;
}

export function isOwnedSetupApprovalAuthority(
  value: unknown,
): value is SetupApprovalAuthority {
  return (
    typeof value === "object" &&
    value !== null &&
    OWNED_APPROVAL_AUTHORITIES.has(value)
  );
}
