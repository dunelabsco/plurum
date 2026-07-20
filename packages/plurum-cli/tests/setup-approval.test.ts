import { describe, expect, it } from "vitest";

import {
  createSetupApprovalAuthority,
  type SetupApprovalIdentity,
  type SetupApprovalSource,
  type SetupPreparedPlan,
} from "../src/commands/setup-approval.js";

const CANARY = "plrm_live_STEP_4_8_APPROVAL_CANARY";

function planCandidate(label = "plan") {
  return Object.freeze({
    schemaVersion: 1,
    label,
    preview: Object.freeze({
      readiness: "ready",
      clients: Object.freeze(["claude-code", "codex"]),
    }),
    execution: Object.freeze({
      hostPlanIds: Object.freeze([
        "claude-code:01:add-marketplace",
        "codex:01:add-marketplace",
      ]),
    }),
  });
}

function approve(
  source: SetupApprovalSource = "interactive",
): Readonly<{
  authority: ReturnType<typeof createSetupApprovalAuthority>;
  approval: SetupApprovalIdentity;
  plan: SetupPreparedPlan<ReturnType<typeof planCandidate>>;
}> {
  const authority = createSetupApprovalAuthority();
  const plan = authority.prepare(planCandidate());
  const approval = authority.approve({ plan, source });
  return { authority, approval, plan };
}

describe("setup approval authority", () => {
  it("prepares an owned canonical tree before rendering or approval", () => {
    const authority = createSetupApprovalAuthority();
    const candidate = planCandidate();
    const plan = authority.prepare(candidate);

    expect(plan).toEqual(candidate);
    expect(plan).not.toBe(candidate);
    expect(plan.preview).not.toBe(candidate.preview);
    expect(plan.preview.clients).not.toBe(
      candidate.preview.clients,
    );
    expect(Object.getPrototypeOf(plan)).toBe(null);
    expect(Object.getPrototypeOf(plan.preview)).toBe(null);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.preview)).toBe(true);
    expect(Object.isFrozen(plan.preview.clients)).toBe(true);
  });

  it.each(["interactive", "assume-yes"] as const)(
    "binds one opaque %s approval to one exact immutable plan",
    (source) => {
      const { authority, approval, plan } = approve(source);

      expect(Object.isFrozen(approval)).toBe(true);
      expect(Object.getPrototypeOf(approval)).toBe(null);
      expect(Object.keys(approval)).toEqual([]);
      expect(Object.getOwnPropertySymbols(approval)).toEqual([]);
      expect(JSON.stringify({ approval })).toBe("{}");

      expect(authority.consume({ approval, plan })).toEqual({
        status: "approved",
        source,
      });
      expect(authority.consume({ approval, plan })).toEqual({
        status: "precondition-failed",
      });
    },
  );

  it("consumes an approval when a structurally equal but different plan is supplied", () => {
    const { authority, approval, plan } = approve();
    const lookalike = authority.prepare(planCandidate());

    expect(lookalike).toEqual(plan);
    expect(lookalike).not.toBe(plan);
    expect(
      authority.consume({ approval, plan: lookalike }),
    ).toEqual({ status: "precondition-failed" });
    expect(authority.consume({ approval, plan })).toEqual({
      status: "precondition-failed",
    });
  });

  it("rejects cloned, forged, and foreign-authority tokens", () => {
    const { authority, approval, plan } = approve();
    const foreign = createSetupApprovalAuthority();
    const cloned = structuredClone(
      approval,
    ) as SetupApprovalIdentity;
    const forged = Object.freeze(
      Object.create(null),
    ) as SetupApprovalIdentity;

    expect(foreign.consume({ approval, plan })).toEqual({
      status: "precondition-failed",
    });
    expect(authority.consume({ approval: cloned, plan })).toEqual({
      status: "precondition-failed",
    });
    expect(authority.consume({ approval: forged, plan })).toEqual({
      status: "precondition-failed",
    });
    expect(authority.consume({ approval, plan })).toEqual({
      status: "approved",
      source: "interactive",
    });
  });

  it("rejects unprepared, cloned, and foreign prepared plans", () => {
    const authority = createSetupApprovalAuthority();
    const foreign = createSetupApprovalAuthority();
    const plan = authority.prepare(planCandidate());
    const unprepared = planCandidate() as unknown as SetupPreparedPlan;
    const cloned = structuredClone(plan) as SetupPreparedPlan;
    const foreignPlan = foreign.prepare(planCandidate());

    for (const rejected of [unprepared, cloned, foreignPlan]) {
      expect(() =>
        authority.approve({
          plan: rejected,
          source: "interactive",
        }),
      ).toThrow(
        "The setup approval could not be created safely.",
      );
    }

    expect(() =>
      foreign.approve({
        plan,
        source: "interactive",
      }),
    ).toThrow(
      "The setup approval could not be created safely.",
    );
  });

  it("does not retain virtual fields from a live frozen Proxy", () => {
    const authority = createSetupApprovalAuthority();
    let phase = "preview";
    let getCalls = 0;
    const candidate = new Proxy(
      Object.freeze({ action: "safe" }),
      {
        get(target, property, receiver) {
          if (property === "action" || property === "virtual") {
            getCalls += 1;
            return phase;
          }
          return Reflect.get(target, property, receiver);
        },
      },
    ) as Readonly<{ action: string; virtual: string }>;

    const plan = authority.prepare(candidate);
    expect(getCalls).toBe(0);
    expect(Object.keys(plan)).toEqual(["action"]);
    expect(plan.action).toBe("safe");
    expect(
      (plan as unknown as Readonly<Record<string, unknown>>)
        .virtual,
    ).toBeUndefined();

    phase = "execute";
    expect(plan.action).toBe("safe");
    expect(
      (plan as unknown as Readonly<Record<string, unknown>>)
        .virtual,
    ).toBeUndefined();
    expect(getCalls).toBe(0);

    const approval = authority.approve({
      plan,
      source: "interactive",
    });
    expect(authority.consume({ approval, plan })).toEqual({
      status: "approved",
      source: "interactive",
    });
  });

  it("never serializes a canary retained only by the approved plan", () => {
    const authority = createSetupApprovalAuthority();
    const plan = authority.prepare(planCandidate(CANARY));
    const approval = authority.approve({
      plan,
      source: "assume-yes",
    });

    const serialized = JSON.stringify({
      approval,
      result: authority.consume({ approval, plan }),
    });
    expect(serialized).toBe(
      '{"result":{"status":"approved","source":"assume-yes"}}',
    );
    expect(serialized).not.toContain(CANARY);
  });

  it.each([
    ["unfrozen root", { value: 1 }],
    [
      "unfrozen child",
      Object.freeze({ child: { value: 1 } }),
    ],
    ["non-plain object", Object.freeze(new Date(0))],
    [
      "function value",
      Object.freeze({ callback: () => CANARY }),
    ],
    [
      "symbol value",
      Object.freeze({ value: Symbol(CANARY) }),
    ],
    [
      "non-finite number",
      Object.freeze({ value: Number.POSITIVE_INFINITY }),
    ],
    [
      "undefined value",
      Object.freeze({ value: undefined }),
    ],
  ] as const)("rejects a %s with one fixed error", (_label, plan) => {
    const authority = createSetupApprovalAuthority();

    expect(() =>
      authority.prepare(plan),
    ).toThrow(
      "The setup approval could not be created safely.",
    );
  });

  it("rejects hostile request accessors without invoking or reflecting them", () => {
    const authority = createSetupApprovalAuthority();
    let getterCalls = 0;
    const request = Object.defineProperty(
      { source: "interactive" },
      "plan",
      {
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new Error(CANARY);
        },
      },
    );

    try {
      authority.approve(request as never);
      throw new Error("hostile approval unexpectedly succeeded");
    } catch (error) {
      expect(String(error)).toBe(
        "SetupApprovalError: The setup approval could not be created safely.",
      );
      expect(String(error)).not.toContain(CANARY);
    }
    expect(getterCalls).toBe(0);
  });

  it("rejects non-enumerable plan state", () => {
    const authority = createSetupApprovalAuthority();
    const plan = Object.freeze(
      Object.defineProperty({}, "hidden", {
        configurable: false,
        enumerable: false,
        value: CANARY,
        writable: false,
      }),
    );

    expect(() =>
      authority.prepare(plan),
    ).toThrow(
      "The setup approval could not be created safely.",
    );
  });

  it("rejects cycles and canonicalizes shared frozen subtrees as a tree", () => {
    const authority = createSetupApprovalAuthority();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    Object.freeze(cyclic);

    expect(() =>
      authority.prepare(cyclic),
    ).toThrow(
      "The setup approval could not be created safely.",
    );

    const shared = Object.freeze({ state: "ready" });
    const plan = authority.prepare(
      Object.freeze({
        first: shared,
        second: shared,
      }),
    );
    expect(plan.first).toEqual(plan.second);
    expect(plan.first).not.toBe(plan.second);
    expect(plan.first).not.toBe(shared);
    const approval = authority.approve({
      plan,
      source: "interactive",
    });
    expect(authority.consume({ approval, plan })).toEqual({
      status: "approved",
      source: "interactive",
    });
  });

  it("enforces text, property-name, depth, node, and property budgets", () => {
    const authority = createSetupApprovalAuthority();
    const oversizedString = Object.freeze({
      value: "x".repeat(1024 * 1024 + 1),
    });
    const repeated = "x".repeat(300_000);
    const excessiveTotalText = Object.freeze(
      Object.fromEntries(
        Array.from({ length: 15 }, (_, index) => [
          `value${index}`,
          repeated,
        ]),
      ),
    );
    const oversizedPropertyName = Object.freeze({
      ["x".repeat(1_025)]: true,
    });

    let excessiveDepth: object = Object.freeze({});
    for (let depth = 0; depth < 66; depth += 1) {
      excessiveDepth = Object.freeze({ child: excessiveDepth });
    }
    const excessiveNodes = Object.freeze(
      Array.from(
        { length: 4_097 },
        () => Object.freeze({}),
      ),
    );
    const excessiveProperties = Object.freeze(
      Array.from({ length: 16_384 }, () => null),
    );

    for (const plan of [
      oversizedString,
      excessiveTotalText,
      oversizedPropertyName,
      excessiveDepth,
      excessiveNodes,
      excessiveProperties,
    ]) {
      expect(() => authority.prepare(plan)).toThrow(
        "The setup approval could not be created safely.",
      );
    }
  });

  it("rejects sparse arrays and arrays with hidden or named state", () => {
    const authority = createSetupApprovalAuthority();
    const sparse: Array<null | undefined> = [null, null];
    delete sparse[0];
    Object.freeze(sparse);
    const withNamedState = ["ready"] as string[] & {
      state?: string;
    };
    withNamedState.state = CANARY;
    Object.freeze(withNamedState);

    for (const plan of [
      Object.freeze({ values: sparse }),
      Object.freeze({ values: withNamedState }),
    ]) {
      expect(() =>
        authority.prepare(plan),
      ).toThrow(
        "The setup approval could not be created safely.",
      );
    }
  });

  it("rejects frozen plan accessors without invoking them", () => {
    const authority = createSetupApprovalAuthority();
    let getterCalls = 0;
    const plan = Object.freeze(
      Object.defineProperty({}, "hidden", {
        configurable: false,
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new Error(CANARY);
        },
      }),
    );

    expect(() =>
      authority.prepare(plan),
    ).toThrow(
      "The setup approval could not be created safely.",
    );
    expect(getterCalls).toBe(0);
  });

  it("rejects hidden request fields", () => {
    const authority = createSetupApprovalAuthority();
    const request = Object.defineProperty(
      {
        plan: authority.prepare(planCandidate()),
        source: "interactive" as const,
      },
      "extra",
      {
        configurable: false,
        enumerable: false,
        value: CANARY,
        writable: false,
      },
    );

    expect(() => authority.approve(request)).toThrow(
      "The setup approval could not be created safely.",
    );
  });

  it("maps hostile plan candidates and approval sources to one fixed error", () => {
    const authority = createSetupApprovalAuthority();
    const proxy = Proxy.revocable(planCandidate(), {});
    proxy.revoke();

    for (const operation of [
      () => authority.prepare(proxy.proxy),
      () =>
        authority.approve({
          plan: authority.prepare(planCandidate()),
          source: CANARY,
        } as never),
    ]) {
      try {
        operation();
        throw new Error("hostile approval unexpectedly succeeded");
      } catch (error) {
        expect(String(error)).toBe(
          "SetupApprovalError: The setup approval could not be created safely.",
        );
        expect(String(error)).not.toContain(CANARY);
      }
    }
  });

  it("does not consume a valid token through a malformed consume request", () => {
    const { authority, approval, plan } = approve();
    let getterCalls = 0;
    const request = Object.defineProperty(
      { plan },
      "approval",
      {
        enumerable: true,
        get() {
          getterCalls += 1;
          return approval;
        },
      },
    );

    expect(authority.consume(request as never)).toEqual({
      status: "precondition-failed",
    });
    expect(getterCalls).toBe(0);
    expect(authority.consume({ approval, plan })).toEqual({
      status: "approved",
      source: "interactive",
    });
  });
});
