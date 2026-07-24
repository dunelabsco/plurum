import { describe, expect, it } from "vitest";

import type {
  HostAction,
  HostApplyRequest,
  HostConfiguration,
  HostMutationAdapter,
  HostMutationResult,
  HostRollbackRequest,
} from "../src/hosts/contracts.js";
import { CapabilityPolicyError } from "../src/system/errors.js";
import type { SystemCapabilities } from "../src/system/contracts.js";
import { setupScope } from "../src/system/scopes.js";
import { createTestSystem } from "./support/system.js";

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && Object.hasOwn(descriptor, "value")) {
      deepFreeze(descriptor.value, seen);
    }
  }
  return Object.freeze(value);
}

function configuration(version: string): HostConfiguration {
  return {
    marketplace: {
      status: "present",
      value: { name: "plurum", source: "dunelabsco/plurum" },
    },
    plugin: {
      status: "present",
      value: {
        name: "plurum",
        source: "plurum@plurum",
        version,
        enabled: true,
      },
    },
    pluginMcp: {
      status: "present",
      value: {
        name: "plurum",
        endpoint: "https://mcp.plurum.ai/mcp",
      },
    },
    directMcp: { status: "absent" },
  };
}

function validAction(): HostAction {
  return deepFreeze({
    id: "claude-code:01:update-plugin",
    host: "claude-code",
    kind: "update-plugin",
    before: configuration("1.2.0"),
    after: configuration("1.4.0"),
    rollback: {
      kind: "restore-plugin-version",
      pluginVersion: "1.2.0",
    },
    display: "update the Plurum plugin",
  } satisfies HostAction);
}

function applyRequest(action = validAction()): HostApplyRequest {
  return deepFreeze({
    host: "claude-code",
    executableRevision: "claude-executable-revision",
    expectedBeforeRevision: "claude-state-before",
    expectedBefore: action.before,
    action,
  });
}

function rollbackRequest(action = validAction()): HostRollbackRequest {
  return deepFreeze({
    host: "claude-code",
    executableRevision: "claude-executable-revision",
    expectedAfterRevision: "claude-state-after",
    expectedAfter: action.after,
    action,
  });
}

function systemWithMutation(
  mutation: HostMutationAdapter,
  inspection = createTestSystem().hosts.inspection["claude-code"],
): SystemCapabilities {
  const base = createTestSystem();
  return Object.freeze({
    ...base,
    hosts: Object.freeze({
      inspection: Object.freeze({
        ...base.hosts.inspection,
        "claude-code": inspection,
      }),
      mutation: Object.freeze({
        ...base.hosts.mutation,
        "claude-code": mutation,
      }),
    }),
  });
}

function mutationAdapter(
  options: Readonly<{
    apply?: (request: HostApplyRequest) => Promise<HostMutationResult>;
    rollback?: (request: HostRollbackRequest) => Promise<HostMutationResult>;
    inspect?: HostMutationAdapter["inspect"];
  }> = {},
): HostMutationAdapter {
  return Object.freeze({
    inspect:
      options.inspect ??
      (async () => ({ host: "claude-code", status: "absent" })),
    apply:
      options.apply ??
      (async () => ({
        status: "changed" as const,
        stateRevision: "claude-state-after",
      })),
    rollback:
      options.rollback ??
      (async () => ({
        status: "changed" as const,
        stateRevision: "claude-state-restored",
      })),
  });
}

describe("setup host mutation capability boundary", () => {
  it("uses the mutation adapter's own inspection and not the read-only adapter", async () => {
    let mutationInspections = 0;
    let readOnlyInspections = 0;
    const mutation = mutationAdapter({
      async inspect() {
        mutationInspections += 1;
        return { host: "claude-code", status: "absent" };
      },
    });
    const readOnly = Object.freeze({
      async inspect() {
        readOnlyInspections += 1;
        return { host: "claude-code" as const, status: "absent" as const };
      },
    });
    const scoped = setupScope(systemWithMutation(mutation, readOnly));

    const request = {
      host: "claude-code" as const,
      scope: "user" as const,
      excludedProjectDirectory: "/isolated/neutral",
    };
    await expect(
      scoped.hosts.inspection["claude-code"].inspect(request),
    ).resolves.toEqual({ host: "claude-code", status: "absent" });
    await expect(
      scoped.hosts.mutation["claude-code"].inspect(request),
    ).resolves.toEqual({ host: "claude-code", status: "absent" });

    expect(mutationInspections).toBe(2);
    expect(readOnlyInspections).toBe(0);
    expect(scoped.hosts.inspection).toBe(scoped.hosts.mutation);
  });

  it("delegates immutable defensive apply and rollback snapshots and normalizes results", async () => {
    let delegatedApply: HostApplyRequest | undefined;
    let delegatedRollback: HostRollbackRequest | undefined;
    const mutableApplyResult = {
      status: "changed" as const,
      stateRevision: "claude-state-after",
    };
    const mutation = mutationAdapter({
      async apply(request) {
        delegatedApply = request;
        return mutableApplyResult;
      },
      async rollback(request) {
        delegatedRollback = request;
        return {
          status: "changed",
          stateRevision: "claude-state-restored",
        };
      },
    });
    const scoped = setupScope(systemWithMutation(mutation)).hosts.mutation[
      "claude-code"
    ];
    const apply = applyRequest();
    const rollback = rollbackRequest();

    const applyResult = await scoped.apply(apply);
    const rollbackResult = await scoped.rollback(rollback);

    expect(delegatedApply).toEqual(apply);
    expect(delegatedApply).not.toBe(apply);
    expect(delegatedApply?.action).not.toBe(apply.action);
    expect(Object.isFrozen(delegatedApply)).toBe(true);
    expect(Object.isFrozen(delegatedApply?.action)).toBe(true);
    expect(Object.isFrozen(delegatedApply?.action.before.plugin)).toBe(true);
    expect(delegatedRollback).toEqual(rollback);
    expect(delegatedRollback).not.toBe(rollback);
    expect(Object.isFrozen(delegatedRollback)).toBe(true);
    expect(applyResult).toEqual(mutableApplyResult);
    expect(applyResult).not.toBe(mutableApplyResult);
    expect(Object.isFrozen(applyResult)).toBe(true);
    expect(Object.isFrozen(rollbackResult)).toBe(true);
  });

  it("rejects hostile or inconsistent apply requests before delegation", async () => {
    let calls = 0;
    const scoped = setupScope(
      systemWithMutation(
        mutationAdapter({
          async apply() {
            calls += 1;
            return { status: "failed" };
          },
        }),
      ),
    ).hosts.mutation["claude-code"];
    const valid = applyRequest();
    let getterCalls = 0;
    const getter = Object.freeze(
      Object.defineProperty(
        {
          host: "claude-code",
          expectedBeforeRevision: valid.expectedBeforeRevision,
          expectedBefore: valid.expectedBefore,
          action: valid.action,
        },
        "executableRevision",
        {
          enumerable: true,
          get() {
            getterCalls += 1;
            return valid.executableRevision;
          },
        },
      ),
    );
    const symbol = Symbol("hostile");
    const withSymbol = deepFreeze({
      ...valid,
      [symbol]: true,
    });
    const inconsistentAction = deepFreeze({
      ...valid.action,
      after: configuration("1.2.0"),
    }) as HostAction;
    const wrongRollback = deepFreeze({
      ...valid.action,
      rollback: { kind: "remove-cli-created-plugin" },
    }) as HostAction;
    const nonFrozenAction = { ...valid.action };
    const attempts = [
      deepFreeze({ ...valid, host: "codex" }),
      deepFreeze({ ...valid, extra: true }),
      withSymbol,
      getter,
      deepFreeze({ ...valid, executableRevision: "/tmp/host" }),
      deepFreeze({
        ...valid,
        expectedBeforeRevision: "secret=NEVER_ALLOWED",
      }),
      Object.freeze({ ...valid, action: nonFrozenAction }),
      applyRequest(inconsistentAction),
      applyRequest(wrongRollback),
      deepFreeze({
        ...valid,
        expectedBefore: configuration("1.1.0"),
      }),
    ];

    for (const attempt of attempts) {
      await expect(
        scoped.apply(attempt as HostApplyRequest),
      ).rejects.toBeInstanceOf(CapabilityPolicyError);
    }
    expect(getterCalls).toBe(0);
    expect(calls).toBe(0);
  });

  it("rejects malformed rollback requests and hostile mutation results", async () => {
    let result: unknown = { status: "failed", extra: true };
    let rollbackCalls = 0;
    const scoped = setupScope(
      systemWithMutation(
        mutationAdapter({
          async apply() {
            return result as HostMutationResult;
          },
          async rollback() {
            rollbackCalls += 1;
            return { status: "failed" };
          },
        }),
      ),
    ).hosts.mutation["claude-code"];

    const invalidRollback = deepFreeze({
      ...rollbackRequest(),
      expectedAfterRevision: "file:C:",
    });
    await expect(
      scoped.rollback(invalidRollback),
    ).rejects.toBeInstanceOf(CapabilityPolicyError);
    expect(rollbackCalls).toBe(0);

    const hostileResults: unknown[] = [
      { status: "failed", extra: true },
      { status: "changed" },
      {
        status: "changed",
        stateRevision: "password=NEVER_ALLOWED",
      },
      { status: "unknown" },
      Object.defineProperty({}, "status", {
        enumerable: true,
        get() {
          throw new Error("plrm_test_NEVER_REFLECT");
        },
      }),
    ];
    for (const hostile of hostileResults) {
      result = hostile;
      await expect(
        scoped.apply(applyRequest()),
      ).rejects.toBeInstanceOf(CapabilityPolicyError);
    }
  });

  it("replaces hostile adapter failures with fixed non-reflective policy errors", async () => {
    const canary = "plrm_test_NEVER_REFLECT_ADAPTER_FAILURE";
    const scoped = setupScope(
      systemWithMutation(
        mutationAdapter({
          async apply() {
            throw new Error(canary);
          },
          async rollback() {
            throw new Error(canary);
          },
        }),
      ),
    ).hosts.mutation["claude-code"];

    for (const attempt of [
      () => scoped.apply(applyRequest()),
      () => scoped.rollback(rollbackRequest()),
    ]) {
      try {
        await attempt();
        throw new Error("hostile mutation adapter unexpectedly succeeded");
      } catch (error) {
        expect(error).toBeInstanceOf(CapabilityPolicyError);
        expect(String(error)).not.toContain(canary);
      }
    }
  });
});
