import { describe, expect, it, vi } from "vitest";

import {
  CODEX_DOTENV_API_ORIGIN,
  CODEX_DOTENV_PROJECTION_STATUSES,
  type CodexDotenvNativeAdapter,
  type CodexDotenvNativeEvidence,
  type CodexDotenvProjectionAdapter,
  type CodexDotenvProjectionEvidence,
  type CodexDotenvProjectionStatus,
} from "../src/credentials/codex-dotenv-contracts.js";
import {
  createCodexDotenvProjectionAdapter,
} from "../src/credentials/codex-dotenv-projection.js";

const PROJECT = "/synthetic/project";
const OTHER_PROJECT = "/synthetic/other-project";
const HOSTILE_API_KEY = `plrm_live_${"K".repeat(43)}`;

function nativeEvidence(
  revision: string,
  status: CodexDotenvProjectionStatus,
): CodexDotenvNativeEvidence {
  return Object.freeze({ revision, status });
}

function nativeFake(
  initialStatus: CodexDotenvProjectionStatus,
): Readonly<{
  native: CodexDotenvNativeAdapter;
  observations: () => readonly unknown[];
  mutations: () => readonly unknown[];
  setEvidence: (next: CodexDotenvNativeEvidence) => void;
  setObservation: (
    implementation: CodexDotenvNativeAdapter["observe"],
  ) => void;
  setMutation: (
    implementation: CodexDotenvNativeAdapter["synchronize"],
  ) => void;
}> {
  let current = nativeEvidence("state-1", initialStatus);
  const observed: unknown[] = [];
  const mutated: unknown[] = [];
  let observe: CodexDotenvNativeAdapter["observe"] = async () => current;
  let synchronize: CodexDotenvNativeAdapter["synchronize"] = async (
    request,
  ) => {
    if (
      request.expectedRevision !== current.revision ||
      request.expectedStatus !== current.status
    ) {
      return Object.freeze({ status: "precondition-failed" });
    }
    if (current.status === "exact") {
      return Object.freeze({
        status: "completed",
        disposition: "unchanged",
        stateRevision: current.revision,
      });
    }
    current = nativeEvidence("state-2", "exact");
    return Object.freeze({
      status: "completed",
      disposition: "changed",
      stateRevision: current.revision,
    });
  };

  return Object.freeze({
    native: Object.freeze({
      async observe(
        request: Parameters<CodexDotenvNativeAdapter["observe"]>[0],
      ) {
        observed.push(request);
        return observe(request);
      },
      async synchronize(
        request: Parameters<CodexDotenvNativeAdapter["synchronize"]>[0],
      ) {
        mutated.push(request);
        return synchronize(request);
      },
    }),
    observations: () => observed,
    mutations: () => mutated,
    setEvidence(next) {
      current = next;
    },
    setObservation(implementation) {
      observe = implementation;
    },
    setMutation(implementation) {
      synchronize = implementation;
    },
  });
}

async function inspectAvailable(
  adapter: CodexDotenvProjectionAdapter,
  excludedProjectDirectory = PROJECT,
): Promise<CodexDotenvProjectionEvidence> {
  const result = await adapter.inspect({ excludedProjectDirectory });
  expect(result.status).toBe("available");
  if (result.status !== "available") {
    throw new Error("expected available projection evidence");
  }
  return result.state;
}

function applyEvidence(
  adapter: CodexDotenvProjectionAdapter,
  state: CodexDotenvProjectionEvidence,
  excludedProjectDirectory = PROJECT,
) {
  return adapter.apply({
    expectedIdentity: state.identity,
    excludedProjectDirectory,
  });
}

describe("Codex dotenv projection inspection", () => {
  it("runtime-freezes the exported projection statuses", () => {
    expect(Object.isFrozen(CODEX_DOTENV_PROJECTION_STATUSES)).toBe(true);
    expect(CODEX_DOTENV_PROJECTION_STATUSES).toEqual([
      "absent",
      "exact",
      "mismatched",
      "ambiguous",
      "unsafe",
      "credential-unavailable",
    ]);
  });

  it.each([
    "absent",
    "exact",
    "mismatched",
    "ambiguous",
    "unsafe",
    "credential-unavailable",
  ] as const)("returns opaque non-secret identity for %s", async (status) => {
    const fake = nativeFake(status);
    const adapter = createCodexDotenvProjectionAdapter(fake.native);

    const state = await inspectAvailable(adapter);

    expect(state.status).toBe(status);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.identity)).toBe(true);
    expect(Object.keys(state.identity)).toEqual([]);
    expect(JSON.stringify(state.identity)).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain("state-1");
    expect(Object.hasOwn(state, "revision")).toBe(false);
    expect(fake.observations()).toEqual([
      {
        kind: "codex-dotenv-observe",
        scope: "user",
        apiOrigin: CODEX_DOTENV_API_ORIGIN,
        excludedProjectDirectory: PROJECT,
      },
    ]);
    expect(Object.isFrozen(fake.observations()[0])).toBe(true);
  });

  it.each([
    {
      encoding: "base64url",
      revision: Buffer.from(HOSTILE_API_KEY, "utf8").toString("base64url"),
    },
    {
      encoding: "hex",
      revision: Buffer.from(HOSTILE_API_KEY, "utf8").toString("hex"),
    },
  ] as const)(
    "does not expose a reversible $encoding key-derived native revision in public JSON",
    async ({ encoding, revision }) => {
      expect(Buffer.from(revision, encoding).toString("utf8")).toBe(
        HOSTILE_API_KEY,
      );
      const fake = nativeFake("absent");
      fake.setEvidence(nativeEvidence(revision, "absent"));
      const adapter = createCodexDotenvProjectionAdapter(fake.native);

      const inspection = await adapter.inspect({
        excludedProjectDirectory: PROJECT,
      });
      expect(inspection.status).toBe("available");
      if (inspection.status !== "available") {
        throw new Error("expected available projection evidence");
      }
      const applied = await applyEvidence(adapter, inspection.state);
      expect(applied.status).toBe("changed");

      const inspectionJson = JSON.stringify(inspection);
      const appliedJson = JSON.stringify(applied);
      expect(JSON.parse(inspectionJson)).toEqual({
        status: "available",
        state: { status: "absent" },
      });
      expect(JSON.parse(appliedJson)).toEqual({
        status: "changed",
        state: { status: "exact" },
      });
      for (const publicJson of [inspectionJson, appliedJson]) {
        expect(publicJson).not.toContain(HOSTILE_API_KEY);
        expect(publicJson).not.toContain(revision);
      }
    },
  );

  it("rejects malformed requests without invoking accessors", async () => {
    const fake = nativeFake("absent");
    const adapter = createCodexDotenvProjectionAdapter(fake.native);
    let getterCalls = 0;
    const request = Object.defineProperty({}, "excludedProjectDirectory", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return PROJECT;
      },
    });

    await expect(
      adapter.inspect(request as { excludedProjectDirectory: string }),
    ).resolves.toEqual({ status: "unavailable" });
    expect(getterCalls).toBe(0);
    expect(fake.observations()).toHaveLength(0);
  });

  it.each([
    null,
    {},
    { revision: "state-1", status: "unknown" },
    { revision: "state-1", status: "exact", extra: true },
    { revision: "/private/path", status: "exact" },
    { revision: `plrm_live_${"A".repeat(43)}`, status: "exact" },
    Object.assign(Object.create({ inherited: true }), {
      revision: "state-1",
      status: "exact",
    }),
    { revision: "state-1", status: "exact", [Symbol("hidden")]: true },
  ])("fails closed for hostile native evidence %#", async (value) => {
    const fake = nativeFake("absent");
    fake.setObservation(vi.fn(async () => value) as never);
    const adapter = createCodexDotenvProjectionAdapter(fake.native);

    await expect(
      adapter.inspect({ excludedProjectDirectory: PROJECT }),
    ).resolves.toEqual({ status: "unavailable" });
  });

  it("does not invoke native evidence accessors", async () => {
    const fake = nativeFake("absent");
    let getterCalls = 0;
    const hostile = Object.defineProperty(
      { status: "absent" },
      "revision",
      {
        enumerable: true,
        get() {
          getterCalls += 1;
          return "state-1";
        },
      },
    );
    fake.setObservation(async () => hostile as never);
    const adapter = createCodexDotenvProjectionAdapter(fake.native);

    await expect(
      adapter.inspect({ excludedProjectDirectory: PROJECT }),
    ).resolves.toEqual({ status: "unavailable" });
    expect(getterCalls).toBe(0);
  });
});

describe("Codex dotenv projection identity", () => {
  it("is one-shot even when two applies race", async () => {
    const fake = nativeFake("absent");
    const adapter = createCodexDotenvProjectionAdapter(fake.native);
    const state = await inspectAvailable(adapter);

    const results = await Promise.all([
      applyEvidence(adapter, state),
      applyEvidence(adapter, state),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      "changed",
      "precondition-failed",
    ]);
    expect(fake.mutations()).toHaveLength(1);
  });

  it("rejects replay after a completed apply", async () => {
    const fake = nativeFake("exact");
    const adapter = createCodexDotenvProjectionAdapter(fake.native);
    const state = await inspectAvailable(adapter);

    await expect(applyEvidence(adapter, state)).resolves.toMatchObject({
      status: "unchanged",
    });
    await expect(applyEvidence(adapter, state)).resolves.toEqual({
      status: "precondition-failed",
    });
    expect(fake.mutations()).toHaveLength(1);
  });

  it("rejects identity minted by another adapter", async () => {
    const fake = nativeFake("absent");
    const first = createCodexDotenvProjectionAdapter(fake.native);
    const second = createCodexDotenvProjectionAdapter(fake.native);
    const state = await inspectAvailable(first);

    await expect(applyEvidence(second, state)).resolves.toEqual({
      status: "precondition-failed",
    });
    expect(fake.mutations()).toHaveLength(0);
  });

  it("rejects cloned identity and never exposes its native revision", async () => {
    const fake = nativeFake("absent");
    const adapter = createCodexDotenvProjectionAdapter(fake.native);
    const state = await inspectAvailable(adapter);
    const cloned = structuredClone(state.identity);

    expect(JSON.stringify({ expectedIdentity: state.identity })).toBe("{}");
    await expect(
      adapter.apply({
        expectedIdentity: cloned,
        excludedProjectDirectory: PROJECT,
      }),
    ).resolves.toEqual({ status: "precondition-failed" });
    expect(fake.mutations()).toHaveLength(0);
  });

  it("binds identity to the inspected project exclusion and consumes misuse", async () => {
    const fake = nativeFake("absent");
    const adapter = createCodexDotenvProjectionAdapter(fake.native);
    const state = await inspectAvailable(adapter);

    await expect(
      applyEvidence(adapter, state, OTHER_PROJECT),
    ).resolves.toEqual({ status: "precondition-failed" });
    await expect(applyEvidence(adapter, state)).resolves.toEqual({
      status: "precondition-failed",
    });
    expect(fake.mutations()).toHaveLength(0);
  });

  it("rejects malformed apply requests without invoking accessors", async () => {
    const fake = nativeFake("absent");
    const adapter = createCodexDotenvProjectionAdapter(fake.native);
    const state = await inspectAvailable(adapter);
    let getterCalls = 0;
    const request = Object.defineProperty(
      { excludedProjectDirectory: PROJECT },
      "expectedIdentity",
      {
        enumerable: true,
        get() {
          getterCalls += 1;
          return state.identity;
        },
      },
    );

    await expect(
      adapter.apply(request as never),
    ).resolves.toEqual({ status: "failed" });
    expect(getterCalls).toBe(0);
    expect(fake.mutations()).toHaveLength(0);
  });
});

describe("Codex dotenv projection mutation", () => {
  it.each(["absent", "mismatched"] as const)(
    "projects the canonical credential from %s without exposing a revision",
    async (status) => {
      const fake = nativeFake(status);
      const adapter = createCodexDotenvProjectionAdapter(fake.native);
      const before = await inspectAvailable(adapter);

      const result = await applyEvidence(adapter, before);

      expect(result.status).toBe("changed");
      expect(Object.isFrozen(result)).toBe(true);
      if (result.status !== "changed") {
        throw new Error("expected changed result");
      }
      expect(result.state.status).toBe("exact");
      expect(Object.hasOwn(result, "stateRevision")).toBe(false);
      expect(JSON.stringify(result)).not.toContain("state-2");
      expect(fake.mutations()).toEqual([
        {
          kind: "codex-dotenv-synchronize",
          scope: "user",
          apiOrigin: CODEX_DOTENV_API_ORIGIN,
          expectedRevision: "state-1",
          expectedStatus: status,
          excludedProjectDirectory: PROJECT,
        },
      ]);
      expect(Object.isFrozen(fake.mutations()[0])).toBe(true);
      expect(fake.observations()).toHaveLength(2);
    },
  );

  it("proves an already exact projection without rewriting", async () => {
    const fake = nativeFake("exact");
    const adapter = createCodexDotenvProjectionAdapter(fake.native);
    const before = await inspectAvailable(adapter);

    const result = await applyEvidence(adapter, before);

    expect(result.status).toBe("unchanged");
    if (result.status !== "unchanged") {
      throw new Error("expected unchanged result");
    }
    expect(result.state.status).toBe("exact");
    expect(fake.mutations()).toHaveLength(1);
    expect(fake.observations()).toHaveLength(2);
  });

  it.each([
    "ambiguous",
    "unsafe",
    "credential-unavailable",
  ] as const)("blocks one-use %s evidence before mutation", async (status) => {
    const fake = nativeFake(status);
    const adapter = createCodexDotenvProjectionAdapter(fake.native);
    const before = await inspectAvailable(adapter);

    await expect(applyEvidence(adapter, before)).resolves.toEqual({
      status: "blocked",
    });
    await expect(applyEvidence(adapter, before)).resolves.toEqual({
      status: "precondition-failed",
    });
    expect(fake.mutations()).toHaveLength(0);
  });

  it("re-observes a native precondition failure", async () => {
    const fake = nativeFake("absent");
    fake.setMutation(async () =>
      Object.freeze({ status: "precondition-failed" }),
    );
    const adapter = createCodexDotenvProjectionAdapter(fake.native);
    const before = await inspectAvailable(adapter);

    await expect(applyEvidence(adapter, before)).resolves.toEqual({
      status: "precondition-failed",
    });
    expect(fake.observations()).toHaveLength(2);
  });

  it("reports converged-unowned when another writer wins the CAS", async () => {
    const fake = nativeFake("absent");
    fake.setMutation(async () => {
      fake.setEvidence(nativeEvidence("external-state", "exact"));
      return Object.freeze({ status: "precondition-failed" });
    });
    const adapter = createCodexDotenvProjectionAdapter(fake.native);
    const before = await inspectAvailable(adapter);

    const result = await applyEvidence(adapter, before);

    expect(result.status).toBe("converged-unowned");
    if (result.status !== "converged-unowned") {
      throw new Error("expected converged-unowned result");
    }
    expect(result.state.status).toBe("exact");
    expect(JSON.stringify(result)).not.toContain("external-state");
    expect(fake.observations()).toHaveLength(2);
  });

  it("re-observes native failed and proves a no-write failure", async () => {
    const fake = nativeFake("absent");
    fake.setMutation(async () => Object.freeze({ status: "failed" }));
    const adapter = createCodexDotenvProjectionAdapter(fake.native);
    const before = await inspectAvailable(adapter);

    await expect(applyEvidence(adapter, before)).resolves.toEqual({
      status: "failed",
    });
    expect(fake.observations()).toHaveLength(2);
  });

  it("reports converged-unowned after a throw that may have written", async () => {
    const fake = nativeFake("absent");
    fake.setMutation(async () => {
      fake.setEvidence(nativeEvidence("state-after-throw", "exact"));
      throw new Error(`plrm_live_${"S".repeat(43)}`);
    });
    const adapter = createCodexDotenvProjectionAdapter(fake.native);
    const before = await inspectAvailable(adapter);

    const result = await applyEvidence(adapter, before);

    expect(result.status).toBe("converged-unowned");
    expect(JSON.stringify(result)).not.toContain("plrm_live_");
    expect(JSON.stringify(result)).not.toContain("state-after-throw");
    expect(fake.observations()).toHaveLength(2);
  });

  it("reports indeterminate when re-observation after a throw fails", async () => {
    const fake = nativeFake("absent");
    let observation = 0;
    fake.setObservation(async () => {
      observation += 1;
      if (observation === 1) {
        return nativeEvidence("state-1", "absent");
      }
      throw new Error("observation unavailable");
    });
    fake.setMutation(async () => {
      throw new Error("write outcome unavailable");
    });
    const adapter = createCodexDotenvProjectionAdapter(fake.native);
    const before = await inspectAvailable(adapter);

    await expect(applyEvidence(adapter, before)).resolves.toEqual({
      status: "indeterminate",
    });
    expect(fake.observations()).toHaveLength(2);
  });

  it("reports indeterminate when a failed write leaves a changed non-exact state", async () => {
    const fake = nativeFake("absent");
    fake.setMutation(async () => {
      fake.setEvidence(nativeEvidence("state-after-failure", "mismatched"));
      return Object.freeze({ status: "failed" });
    });
    const adapter = createCodexDotenvProjectionAdapter(fake.native);
    const before = await inspectAvailable(adapter);

    await expect(applyEvidence(adapter, before)).resolves.toEqual({
      status: "indeterminate",
    });
    expect(fake.observations()).toHaveLength(2);
  });

  it("reports indeterminate when completed mutation cannot be re-observed", async () => {
    const fake = nativeFake("absent");
    let observation = 0;
    fake.setObservation(async () => {
      observation += 1;
      if (observation === 1) {
        return nativeEvidence("state-1", "absent");
      }
      throw new Error("post-observation unavailable");
    });
    fake.setMutation(async () => {
      fake.setEvidence(nativeEvidence("state-2", "exact"));
      return Object.freeze({
        status: "completed",
        disposition: "changed",
        stateRevision: "state-2",
      });
    });
    const adapter = createCodexDotenvProjectionAdapter(fake.native);
    const before = await inspectAvailable(adapter);

    await expect(applyEvidence(adapter, before)).resolves.toEqual({
      status: "indeterminate",
    });
    expect(fake.observations()).toHaveLength(2);
  });

  it("reports converged-unowned when a completed receipt disagrees with exact observed state", async () => {
    const fake = nativeFake("absent");
    fake.setMutation(async () => {
      fake.setEvidence(nativeEvidence("actual-state", "exact"));
      return Object.freeze({
        status: "completed",
        disposition: "changed",
        stateRevision: "claimed-state",
      });
    });
    const adapter = createCodexDotenvProjectionAdapter(fake.native);
    const before = await inspectAvailable(adapter);

    await expect(applyEvidence(adapter, before)).resolves.toMatchObject({
      status: "converged-unowned",
      state: { status: "exact" },
    });
    expect(fake.observations()).toHaveLength(2);
  });

  it("reads every hostile native result descriptor at most once", async () => {
    const fake = nativeFake("absent");
    let statusDescriptorReads = 0;
    fake.setMutation(async () => {
      fake.setEvidence(nativeEvidence("state-2", "exact"));
      const target = Object.assign(Object.create(null), {
        status: "completed",
        disposition: "changed",
        stateRevision: "state-2",
      });
      return new Proxy(target, {
        getOwnPropertyDescriptor(object, key) {
          if (key === "status") {
            statusDescriptorReads += 1;
          }
          return Reflect.getOwnPropertyDescriptor(object, key);
        },
      });
    });
    const adapter = createCodexDotenvProjectionAdapter(fake.native);
    const before = await inspectAvailable(adapter);

    await expect(applyEvidence(adapter, before)).resolves.toMatchObject({
      status: "changed",
      state: { status: "exact" },
    });
    expect(statusDescriptorReads).toBe(1);
  });

  it("never invokes a hostile native result accessor and re-observes", async () => {
    const fake = nativeFake("absent");
    let getterCalls = 0;
    fake.setMutation(async () =>
      Object.defineProperty({}, "status", {
        enumerable: true,
        get() {
          getterCalls += 1;
          return "failed";
        },
      }) as never,
    );
    const adapter = createCodexDotenvProjectionAdapter(fake.native);
    const before = await inspectAvailable(adapter);

    await expect(applyEvidence(adapter, before)).resolves.toEqual({
      status: "failed",
    });
    expect(getterCalls).toBe(0);
    expect(fake.observations()).toHaveLength(2);
  });

  it("re-observes malformed native results rather than assuming no write", async () => {
    const fake = nativeFake("absent");
    fake.setMutation(async () => {
      fake.setEvidence(nativeEvidence("state-after-malformed", "exact"));
      return { status: "completed", disposition: "changed" } as never;
    });
    const adapter = createCodexDotenvProjectionAdapter(fake.native);
    const before = await inspectAvailable(adapter);

    await expect(applyEvidence(adapter, before)).resolves.toMatchObject({
      status: "converged-unowned",
      state: { status: "exact" },
    });
    expect(fake.observations()).toHaveLength(2);
  });

  it("proves no write after an internally inconsistent receipt", async () => {
    const fake = nativeFake("absent");
    fake.setMutation(async () =>
      Object.freeze({
        status: "completed",
        disposition: "changed",
        stateRevision: "state-1",
      }),
    );
    const adapter = createCodexDotenvProjectionAdapter(fake.native);
    const before = await inspectAvailable(adapter);

    await expect(applyEvidence(adapter, before)).resolves.toEqual({
      status: "failed",
    });
    expect(fake.observations()).toHaveLength(2);
  });
});
