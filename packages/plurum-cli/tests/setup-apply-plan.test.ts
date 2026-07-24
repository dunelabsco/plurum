import { describe, expect, it, vi } from "vitest";

import {
  prepareSetupApplyPlan,
  SetupApplyPlanError,
} from "../src/commands/setup-apply-plan.js";
import {
  createSetupApprovalAuthority,
  mintSetupApproval,
  type SetupApprovalAuthority,
} from "../src/commands/setup-approval.js";
import {
  isOwnedSetupCodexProjectionForCredential,
  planSetupCodexProjection,
  SetupCodexProjectionPlanError,
  type SetupCodexProjectionRelation,
  type SetupCodexProjectionResolvedPlan,
} from "../src/commands/setup-codex-projection-plan.js";
import {
  planSetupCredential,
  type SetupCanonicalCredentialObservation,
  type SetupCredentialCandidate,
  type SetupCredentialPlanningDecision,
  type SetupCredentialPlanningObservation,
  type SetupCredentialPlanningResult,
  type SetupCredentialResolvedPlan,
  type SetupCredentialSource,
} from "../src/commands/setup-credential-plan.js";
import { renderSetupApplyPlan } from "../src/commands/setup-output.js";
import {
  createSetupPreflightSnapshot,
  retainedSetupHostPlans,
  type SetupPreflightSnapshot,
} from "../src/commands/setup-preflight.js";
import type { CredentialKeyFingerprint } from "../src/credentials/fingerprint.js";
import {
  DEFAULT_API_ORIGIN,
  type ApiOrigin,
} from "../src/credentials/origin.js";
import type {
  DesiredHostConfiguration,
  HostConfiguration,
  HostExecutableAttestation,
  HostId,
  HostInspection,
  HostInspectionAdapter,
  HostInspectionRequest,
  HostMutationAdapter,
} from "../src/hosts/contracts.js";
import {
  CLAUDE_CODE_DESIRED_CONFIGURATION,
  CLAUDE_CODE_MUTATION_SUPPORT,
} from "../src/hosts/claude-code/configuration.js";
import {
  CODEX_DESIRED_CONFIGURATION,
  CODEX_MUTATION_SUPPORT,
} from "../src/hosts/codex/configuration.js";
import { setupPreflightScope } from "../src/system/scopes.js";
import type {
  SetupPreflightCapabilities,
  SystemCapabilities,
} from "../src/system/contracts.js";
import { createTestSystem } from "./support/system.js";

const OPERATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const CREATED_AT = "2026-07-21T09:10:11.123Z";
const AGENT_A = "00000000-0000-4000-8000-000000000011";
const AGENT_B = "00000000-0000-4000-8000-000000000012";
const FINGERPRINT_A =
  "plurum-fp-v1:111111111111" as CredentialKeyFingerprint;
const FINGERPRINT_B =
  "plurum-fp-v1:222222222222" as CredentialKeyFingerprint;
const RAW_KEY_CANARY = "plrm_live_SETUP_APPLY_PLAN_CANARY_123456";
const FIXED_ERROR =
  "The setup apply plan could not be created safely.";

const DESIRED_BY_HOST: Readonly<
  Record<HostId, DesiredHostConfiguration>
> = {
  "claude-code": CLAUDE_CODE_DESIRED_CONFIGURATION,
  codex: CODEX_DESIRED_CONFIGURATION,
};

type CredentialVariant =
  | "reuse"
  | "adopt"
  | "new-register"
  | "replace"
  | "resume";

function candidate(
  index: 1 | 2,
  sources: readonly SetupCredentialSource[],
): SetupCredentialCandidate {
  return {
    selectionId: `credential-${index}`,
    apiOrigin: DEFAULT_API_ORIGIN,
    fingerprint: index === 1 ? FINGERPRINT_A : FINGERPRINT_B,
    agent: {
      id: index === 1 ? AGENT_A : AGENT_B,
      name: index === 1 ? "Codex" : "Claude Code",
      username: index === 1 ? "codex-agent" : "claude-agent",
    },
    sources,
  };
}

function credentialObservation(
  options: Readonly<{
    transaction?: SetupCredentialPlanningObservation["transaction"];
    canonical?: SetupCanonicalCredentialObservation;
    candidates?: readonly SetupCredentialCandidate[];
    blockers?: SetupCredentialPlanningObservation["blockers"];
    invalidSources?: readonly SetupCredentialSource[];
  }> = {},
): SetupCredentialPlanningObservation {
  return {
    schemaVersion: 1,
    transaction: options.transaction ?? "clean",
    canonical: options.canonical ?? { status: "missing" },
    candidates: options.candidates ?? [],
    blockers: options.blockers ?? [],
    invalidSources: options.invalidSources ?? [],
  };
}

function credentialDecision(
  options: Readonly<{
    selectedCandidateId?: string | null;
    registration?: SetupCredentialPlanningDecision["registration"];
  }> = {},
): SetupCredentialPlanningDecision {
  return {
    selectedCandidateId: options.selectedCandidateId ?? null,
    registration: options.registration ?? null,
  };
}

function plannedCredential(
  observation: SetupCredentialPlanningObservation,
  decision = credentialDecision(),
): SetupCredentialPlanningResult {
  return planSetupCredential({ observation, decision });
}

function resolvedCredential(
  variant: CredentialVariant,
): SetupCredentialResolvedPlan {
  let result: SetupCredentialPlanningResult;
  switch (variant) {
    case "reuse": {
      const existing = candidate(1, ["canonical", "environment"]);
      result = plannedCredential(
        credentialObservation({
          canonical: {
            status: "active-valid",
            candidateSelectionId: existing.selectionId,
          },
          candidates: [existing],
        }),
      );
      break;
    }
    case "adopt":
      result = plannedCredential(
        credentialObservation({
          candidates: [candidate(1, ["environment", "hermes"])],
        }),
      );
      break;
    case "new-register":
      result = plannedCredential(
        credentialObservation(),
        credentialDecision({
          registration: {
            agentName: "Codex",
            username: "codex-agent",
          },
        }),
      );
      break;
    case "replace":
      result = plannedCredential(
        credentialObservation({
          canonical: { status: "active-invalid" },
          candidates: [candidate(1, ["hermes"])],
          invalidSources: ["canonical"],
        }),
      );
      break;
    case "resume":
      result = plannedCredential(
        credentialObservation({
          canonical: {
            status: "pending",
            apiOrigin: DEFAULT_API_ORIGIN,
            fingerprint: FINGERPRINT_A,
            agent: { name: "Codex", username: "codex-agent" },
            sources: ["canonical", "environment"],
            resumeEvidence: "authenticated-match",
          },
          candidates: [candidate(1, ["hermes"])],
        }),
      );
      break;
  }
  if (result.status !== "resolved") {
    throw new Error(`expected a resolved ${variant} credential`);
  }
  return result;
}

function resolvedProjection(
  credential: SetupCredentialResolvedPlan,
  relation: SetupCodexProjectionRelation =
    credential.acquisition === "new-registration"
      ? "absent"
      : "matches-selected",
): SetupCodexProjectionResolvedPlan {
  const result = planSetupCodexProjection(credential, relation);
  if (result.status !== "resolved") {
    throw new Error("expected a resolved Codex projection");
  }
  return result;
}

function prepareCodexApply(
  approval: SetupApprovalAuthority,
  snapshot: SetupPreflightSnapshot,
  credential: SetupCredentialResolvedPlan,
  operationId = OPERATION_ID,
  createdAt = CREATED_AT,
  relation?: SetupCodexProjectionRelation,
) {
  return prepareSetupApplyPlan(
    approval,
    snapshot,
    credential,
    resolvedProjection(credential, relation),
    operationId,
    createdAt,
  );
}

function absentConfiguration(): HostConfiguration {
  return {
    marketplace: { status: "absent" },
    plugin: { status: "absent" },
    pluginMcp: { status: "absent" },
    directMcp: { status: "absent" },
  };
}

function healthyConfiguration(host: HostId): HostConfiguration {
  const desired = DESIRED_BY_HOST[host];
  return {
    marketplace: {
      status: "present",
      value: { ...desired.marketplace },
    },
    plugin: {
      status: "present",
      value: {
        name: "plurum",
        source: desired.plugin.source,
        version: desired.plugin.version,
        enabled: true,
      },
    },
    pluginMcp: {
      status: "present",
      value: { ...desired.mcp },
    },
    directMcp: { status: "absent" },
  };
}

function executable(host: HostId): HostExecutableAttestation {
  const path = `/trusted/bin/${host}`;
  return {
    sourcePath: path,
    resolvedPath: path,
    revision: `${host}-private-executable-revision`,
    chain: [
      {
        path,
        kind: "binary",
        owner: "current-user",
        access: "not-broadly-writable",
        binding: "canonical",
        link: "direct",
        revision: `${host}-private-chain-revision`,
      },
    ],
    launch: {
      executable: path,
      argumentPrefix: [],
      shell: false,
    },
  };
}

function available(
  host: HostId,
  configuration: HostConfiguration,
): HostInspection {
  return {
    host,
    status: "available",
    executable: executable(host),
    version: DESIRED_BY_HOST[host].minimumHostVersion,
    state: {
      revision: `${host}-private-state-revision`,
      configuration,
    },
    mutationSupport:
      host === "claude-code"
        ? CLAUDE_CODE_MUTATION_SUPPORT
        : CODEX_MUTATION_SUPPORT,
  };
}

function inspectionAdapter(
  inspect: (request: HostInspectionRequest) => Promise<HostInspection>,
): HostInspectionAdapter {
  return Object.freeze({ inspect });
}

function preflightCapabilities(
  inspections: Readonly<
    Record<HostId, HostInspectionAdapter>
  >,
): SetupPreflightCapabilities {
  const base = createTestSystem();
  const asMutation = (
    adapter: HostInspectionAdapter,
  ): HostMutationAdapter => Object.freeze({
    inspect: adapter.inspect,
    apply: async () => {
      throw new Error("apply-plan preflight cannot mutate a host");
    },
    rollback: async () => {
      throw new Error("apply-plan preflight cannot mutate a host");
    },
  });
  const mutation = Object.freeze({
    "claude-code": asMutation(inspections["claude-code"]),
    codex: asMutation(inspections.codex),
  });
  const system: SystemCapabilities = Object.freeze({
    ...base,
    hosts: Object.freeze({
      inspection: base.hosts.inspection,
      mutation,
    }),
  });
  return setupPreflightScope(system);
}

function fixedCapabilities(
  inspections: Readonly<Record<HostId, HostInspection>>,
): SetupPreflightCapabilities {
  return preflightCapabilities({
    "claude-code": inspectionAdapter(async () =>
      inspections["claude-code"]
    ),
    codex: inspectionAdapter(async () => inspections.codex),
  });
}

function healthyInspections(): Readonly<Record<HostId, HostInspection>> {
  return {
    "claude-code": available(
      "claude-code",
      healthyConfiguration("claude-code"),
    ),
    codex: available("codex", healthyConfiguration("codex")),
  };
}

function expectApplyFailure(callback: () => unknown): void {
  try {
    callback();
    throw new Error("unsafe setup apply plan unexpectedly succeeded");
  } catch (error) {
    expect(error).toBeInstanceOf(SetupApplyPlanError);
    expect(String(error)).toBe(
      `SetupApplyPlanError: ${FIXED_ERROR}`,
    );
    expect(String(error)).not.toContain(RAW_KEY_CANARY);
  }
}

function expectDeepFrozen(
  value: unknown,
  seen = new WeakSet<object>(),
): void {
  if (
    typeof value !== "object" ||
    value === null ||
    seen.has(value)
  ) {
    return;
  }
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) {
    expectDeepFrozen(child, seen);
  }
}

describe("setup Codex credential projection plan", () => {
  it.each([
    ["absent", "create", "projection-missing"],
    [
      "matches-selected",
      "unchanged",
      "projection-matches-selected-credential",
    ],
    [
      "replacement-required",
      "replace",
      "projection-replacement-required",
    ],
  ] as const)(
    "maps %s to one credential-bound %s projection",
    (relation, effect, reason) => {
      const credential = resolvedCredential("reuse");
      const projection = planSetupCodexProjection(
        credential,
        relation,
      );

      expect(projection).toEqual({
        status: "resolved",
        client: "codex",
        method: "user-dotenv",
        effect,
        reason,
        disclosure:
          "The Plurum API key will be loaded into Codex and may be inherited by processes Codex starts.",
      });
      expect(
        isOwnedSetupCodexProjectionForCredential(
          projection,
          credential,
        ),
      ).toBe(true);
      expect(Object.isFrozen(projection)).toBe(true);
    },
  );

  it.each([
    ["ambiguous", "projection-ambiguous"],
    ["unsafe", "projection-unsafe"],
    ["unavailable", "projection-unavailable"],
  ] as const)("blocks a %s projection", (relation, reason) => {
    const credential = resolvedCredential("reuse");
    const projection = planSetupCodexProjection(
      credential,
      relation,
    );

    expect(projection).toEqual({
      status: "blocked",
      client: "codex",
      method: "user-dotenv",
      reason,
    });
    expect(
      isOwnedSetupCodexProjectionForCredential(
        projection,
        credential,
      ),
    ).toBe(false);
  });

  it("rejects impossible, unresolved, cloned, and cross-credential evidence", () => {
    const registration = resolvedCredential("new-register");
    expect(() =>
      planSetupCodexProjection(registration, "matches-selected"),
    ).toThrow(SetupCodexProjectionPlanError);

    const unresolved = plannedCredential(credentialObservation());
    expect(() =>
      planSetupCodexProjection(
        unresolved,
        "absent",
      ),
    ).toThrow(SetupCodexProjectionPlanError);

    const first = resolvedCredential("reuse");
    const second = resolvedCredential("reuse");
    const projection = resolvedProjection(first);
    expect(
      isOwnedSetupCodexProjectionForCredential(
        structuredClone(projection),
        first,
      ),
    ).toBe(false);
    expect(
      isOwnedSetupCodexProjectionForCredential(
        projection,
        second,
      ),
    ).toBe(false);
  });
});

describe("setup apply plan", () => {
  it.each([
    ["reuse", "reuse", "unchanged", "no-op", "not-required"],
    ["adopt", "adopt", "unchanged", "ready", "required"],
    ["new-register", "register", "create", "ready", "required"],
    ["replace", "replace", "unchanged", "ready", "required"],
    ["resume", "register", "unchanged", "ready", "required"],
  ] as const)(
    "composes a resolved %s credential into an immutable %s plan",
    async (
      variant,
      disposition,
      projectionEffect,
      readiness,
      confirmation,
    ) => {
      const snapshot = await createSetupPreflightSnapshot(
        "codex",
        fixedCapabilities(healthyInspections()),
      );
      const credential = resolvedCredential(variant);
      const prepared = prepareCodexApply(
        createSetupApprovalAuthority(),
        snapshot,
        credential,
      );

      expect(prepared).toMatchObject({
        schemaVersion: 1,
        preview: {
          mode: "apply",
          requestedTarget: "codex",
          selectedClients: ["codex"],
          readiness,
          services: {
            apiOrigin: DEFAULT_API_ORIGIN,
            mcpEndpoint: "https://mcp.plurum.ai/mcp",
          },
          paths: [
            {
              kind: "credential-directory",
              path: "/isolated/plurum",
            },
            {
              kind: "canonical-credential",
              path: "/isolated/plurum/credentials.json",
            },
            {
              kind: "setup-lock",
              path: "/isolated/plurum/setup.lock",
            },
            {
              kind: "credential-transaction",
              path:
                "/isolated/plurum/credentials-transaction.json",
            },
          ],
          credential: {
            destination: "/isolated/plurum/credentials.json",
            resolution: {
              status: "resolved",
              disposition,
            },
            codexProjection: {
              status: "resolved",
              effect: projectionEffect,
            },
          },
          confirmation,
        },
        execution: {
          hostReconciliation: {
            schemaVersion: 1,
            operationId: OPERATION_ID,
            createdAt: CREATED_AT,
            hosts: [{ host: "codex", classification: "healthy" }],
          },
        },
      });
      expect(prepared.execution.credential).toEqual(
        prepared.preview.credential.resolution,
      );
      expect(prepared.execution.credential).not.toBe(
        prepared.preview.credential.resolution,
      );
      expect(prepared.execution.codexProjection).toEqual(
        prepared.preview.credential.codexProjection,
      );
      expect(Object.getPrototypeOf(prepared)).toBe(null);
      expect(Object.getPrototypeOf(prepared.preview)).toBe(null);
      expect(Object.getPrototypeOf(prepared.execution)).toBe(null);
      expectDeepFrozen(prepared);
    },
  );

  it("is ready when host changes are planned even if the credential is unchanged", async () => {
    const snapshot = await createSetupPreflightSnapshot(
      "codex",
      fixedCapabilities({
        ...healthyInspections(),
        codex: available("codex", absentConfiguration()),
      }),
    );
    const credential = resolvedCredential("reuse");
    const prepared = prepareCodexApply(
      createSetupApprovalAuthority(),
      snapshot,
      credential,
    );

    expect(snapshot.readiness).toBe("ready");
    expect(prepared.preview.readiness).toBe("ready");
    expect(prepared.preview.confirmation).toBe("required");
    expect(prepared.preview.mutations.map(({ kind }) => kind)).toEqual([
      "add-marketplace",
      "install-plugin",
    ]);
  });

  it("is ready when only the Codex credential projection needs replacement", async () => {
    const snapshot = await createSetupPreflightSnapshot(
      "codex",
      fixedCapabilities(healthyInspections()),
    );
    const credential = resolvedCredential("reuse");
    const prepared = prepareCodexApply(
      createSetupApprovalAuthority(),
      snapshot,
      credential,
      OPERATION_ID,
      CREATED_AT,
      "replacement-required",
    );

    expect(snapshot.readiness).toBe("no-op");
    expect(credential.canonicalEffect).toBe("unchanged");
    expect(prepared.preview.credential.codexProjection?.effect).toBe(
      "replace",
    );
    expect(prepared.preview.readiness).toBe("ready");
    expect(prepared.preview.confirmation).toBe("required");
  });

  it("keeps an absent selected host visible but omits it from executable reconciliation", async () => {
    const snapshot = await createSetupPreflightSnapshot(
      "all",
      fixedCapabilities({
        "claude-code": { host: "claude-code", status: "absent" },
        codex: available("codex", healthyConfiguration("codex")),
      }),
    );
    const retained = retainedSetupHostPlans(snapshot);
    const credential = resolvedCredential("reuse");
    const prepared = prepareCodexApply(
      createSetupApprovalAuthority(),
      snapshot,
      credential,
    );

    expect(retained.map(({ classification }) => classification)).toEqual([
      "absent",
      "healthy",
    ]);
    expect(prepared.preview.selectedClients).toEqual([
      "claude-code",
      "codex",
    ]);
    expect(prepared.preview.hosts.map(({ classification }) => classification))
      .toEqual(["absent", "healthy"]);
    expect(
      prepared.execution.hostReconciliation.hosts.map(({ host }) => host),
    ).toEqual(["codex"]);
    expect(prepared.preview.readiness).toBe("no-op");
  });

  it("requires an exact selected-credential projection only for an executable Codex host", async () => {
    const codexSnapshot = await createSetupPreflightSnapshot(
      "codex",
      fixedCapabilities(healthyInspections()),
    );
    const credential = resolvedCredential("reuse");
    const otherCredential = resolvedCredential("reuse");
    const blocked = planSetupCodexProjection(
      credential,
      "ambiguous",
    );
    const wrongCredential = resolvedProjection(otherCredential);
    const owned = resolvedProjection(credential);
    const cloned = structuredClone(owned);
    const forged = Object.freeze({ ...owned });
    let traps = 0;
    const proxied = new Proxy(owned, {
      get() {
        traps += 1;
        throw new Error("an unowned projection must not be read");
      },
      getOwnPropertyDescriptor() {
        traps += 1;
        throw new Error("an unowned projection must not be inspected");
      },
      ownKeys() {
        traps += 1;
        throw new Error("an unowned projection must not be inspected");
      },
    });

    for (const projection of [
      null,
      blocked,
      wrongCredential,
      cloned,
      forged,
      proxied,
    ]) {
      expectApplyFailure(() =>
        prepareSetupApplyPlan(
          createSetupApprovalAuthority(),
          codexSnapshot,
          credential,
          projection,
          OPERATION_ID,
          CREATED_AT,
        ),
      );
    }
    expect(traps).toBe(0);

    const claudeOnly = await createSetupPreflightSnapshot(
      "all",
      fixedCapabilities({
        "claude-code": available(
          "claude-code",
          healthyConfiguration("claude-code"),
        ),
        codex: { host: "codex", status: "absent" },
      }),
    );
    const prepared = prepareSetupApplyPlan(
      createSetupApprovalAuthority(),
      claudeOnly,
      credential,
      null,
      OPERATION_ID,
      CREATED_AT,
    );
    expect(
      prepared.execution.hostReconciliation.hosts.map(({ host }) => host),
    ).toEqual(["claude-code"]);
    expect(prepared.preview.credential.codexProjection).toBeNull();
    expectApplyFailure(() =>
      prepareSetupApplyPlan(
        createSetupApprovalAuthority(),
        claudeOnly,
        credential,
        resolvedProjection(credential),
        OPERATION_ID,
        CREATED_AT,
      ),
    );
  });

  it.each([
    { host: "codex", status: "absent" },
    {
      host: "codex",
      status: "blocked",
      reason: "unsafe-executable",
    },
    {
      host: "codex",
      status: "unavailable",
      reason: "probe-failed",
      executable: executable("codex"),
    },
  ] as const)(
    "rejects non-approvable host preflight status $status",
    async (codexInspection) => {
      const snapshot = await createSetupPreflightSnapshot(
        "codex",
        fixedCapabilities({
          ...healthyInspections(),
          codex: codexInspection,
        }),
      );
      const credential = resolvedCredential("reuse");
      expectApplyFailure(() =>
        prepareSetupApplyPlan(
          createSetupApprovalAuthority(),
          snapshot,
          credential,
          resolvedProjection(credential),
          OPERATION_ID,
          CREATED_AT,
        ),
      );
    },
  );

  it("retains exact executable, baseline, action, and rollback evidence for later reconciliation", async () => {
    const snapshot = await createSetupPreflightSnapshot(
      "claude-code",
      fixedCapabilities({
        ...healthyInspections(),
        "claude-code": available(
          "claude-code",
          absentConfiguration(),
        ),
      }),
    );
    const retained = retainedSetupHostPlans(snapshot);
    const prepared = prepareSetupApplyPlan(
      createSetupApprovalAuthority(),
      snapshot,
      resolvedCredential("reuse"),
      null,
      OPERATION_ID,
      CREATED_AT,
    );
    const executionHost =
      prepared.execution.hostReconciliation.hosts[0];
    const retainedHost = retained[0];

    expect(executionHost).toEqual(retainedHost);
    expect(executionHost).not.toBe(retainedHost);
    expect(executionHost?.executable).toMatchObject({
      revision: "claude-code-private-executable-revision",
      chain: [
        { revision: "claude-code-private-chain-revision" },
      ],
    });
    expect(executionHost?.baseline?.revision).toBe(
      "claude-code-private-state-revision",
    );
    expect(executionHost?.actions).toHaveLength(2);
    expect(executionHost?.actions[0]).toMatchObject({
      id: "claude-code:01:add-marketplace",
      kind: "add-marketplace",
      before: absentConfiguration(),
      rollback: { kind: "remove-cli-created-marketplace" },
    });
    expect(executionHost?.actions[1]).toMatchObject({
      id: "claude-code:02:install-plugin",
      kind: "install-plugin",
      rollback: { kind: "remove-cli-created-plugin" },
    });
  });

  it("binds approval to the exact prepared plan identity", async () => {
    const authority = createSetupApprovalAuthority();
    const snapshot = await createSetupPreflightSnapshot(
      "codex",
      fixedCapabilities(healthyInspections()),
    );
    const credential = resolvedCredential("reuse");
    const first = prepareCodexApply(
      authority,
      snapshot,
      credential,
    );
    const equivalent = prepareCodexApply(
      authority,
      snapshot,
      credential,
    );

    expect(equivalent).toEqual(first);
    expect(equivalent).not.toBe(first);
    const mismatchedApproval = mintSetupApproval(authority, {
      plan: first,
      source: "interactive",
    });
    expect(
      authority.consume({
        approval: mismatchedApproval,
        plan: equivalent,
      }),
    ).toEqual({ status: "precondition-failed" });
    expect(
      authority.consume({
        approval: mismatchedApproval,
        plan: first,
      }),
    ).toEqual({ status: "precondition-failed" });

    expect(() =>
      mintSetupApproval(authority, {
        plan: first,
        source: "assume-yes",
      }),
    ).toThrow("The setup approval could not be created safely.");

    const exactApproval = mintSetupApproval(authority, {
      plan: equivalent,
      source: "assume-yes",
    });
    expect(
      authority.consume({
        approval: exactApproval,
        plan: equivalent,
      }),
    ).toEqual({ status: "approved", source: "assume-yes" });
  });

  it("rejects an unowned approval authority without invoking its traps", async () => {
    const snapshot = await createSetupPreflightSnapshot(
      "codex",
      fixedCapabilities(healthyInspections()),
    );
    const credential = resolvedCredential("reuse");
    let traps = 0;
    const authority = new Proxy(Object.freeze({}), {
      get() {
        traps += 1;
        throw new Error("an unowned approval authority must not be read");
      },
      getOwnPropertyDescriptor() {
        traps += 1;
        throw new Error("an unowned approval authority must not be inspected");
      },
      ownKeys() {
        traps += 1;
        throw new Error("an unowned approval authority must not be inspected");
      },
    }) as unknown as SetupApprovalAuthority;

    expectApplyFailure(() =>
      prepareSetupApplyPlan(
        authority,
        snapshot,
        credential,
        resolvedProjection(credential),
        OPERATION_ID,
        CREATED_AT,
      ),
    );
    expect(traps).toBe(0);
  });

  it("renders only the public preview and omits private reconciliation evidence", async () => {
    const snapshot = await createSetupPreflightSnapshot(
      "codex",
      fixedCapabilities({
        ...healthyInspections(),
        codex: available("codex", absentConfiguration()),
      }),
    );
    const credential = resolvedCredential("adopt");
    const prepared = prepareCodexApply(
      createSetupApprovalAuthority(),
      snapshot,
      credential,
      OPERATION_ID,
      CREATED_AT,
      "absent",
    );
    const serializedExecution = JSON.stringify(prepared.execution);
    const serializedPreview = JSON.stringify(prepared.preview);
    const output = renderSetupApplyPlan(prepared);

    expect(serializedExecution).toContain(
      "codex-private-executable-revision",
    );
    expect(serializedExecution).toContain("codex-private-chain-revision");
    expect(serializedExecution).toContain("codex-private-state-revision");
    expect(output).toContain("Plurum setup plan");
    expect(output).toContain("canonical effect: create");
    expect(output).toContain("codex credential projection:");
    expect(output).toContain("effect: create");
    expect(output).toContain(
      "may be inherited by processes Codex starts",
    );
    expect(output).toContain("execution locations:");
    expect(output).toContain("confirmation: required before any change");
    expect(output).not.toContain("may-create");
    expect(output).not.toContain("may-create-or-replace");
    expect(output).not.toContain(OPERATION_ID);
    expect(output).not.toContain(CREATED_AT);
    expect(output).not.toContain("private-executable-revision");
    expect(output).not.toContain("private-chain-revision");
    expect(output).not.toContain("private-state-revision");
    expect(output).not.toContain("hostReconciliation");
    expect(output).not.toContain("baseline");
    expect(output).not.toContain(RAW_KEY_CANARY);
    for (const privateField of [
      '"revision"',
      '"chain"',
      '"baseline"',
      '"before"',
      '"after"',
      '"hostReconciliation"',
    ]) {
      expect(serializedPreview).not.toContain(privateField);
    }
  });

  it("rejects generic, cloned, and proxied prepared lookalikes before reading them", async () => {
    const authority = createSetupApprovalAuthority();
    const snapshot = await createSetupPreflightSnapshot(
      "codex",
      fixedCapabilities(healthyInspections()),
    );
    const credential = resolvedCredential("reuse");
    const prepared = prepareCodexApply(
      authority,
      snapshot,
      credential,
    );
    const genericLookalike = authority.prepare(prepared);
    const cloned = structuredClone(prepared) as typeof prepared;
    let traps = 0;
    const proxied = new Proxy(prepared, {
      get() {
        traps += 1;
        throw new Error("an unowned plan must not be read");
      },
      getOwnPropertyDescriptor() {
        traps += 1;
        throw new Error("an unowned plan must not be inspected");
      },
      ownKeys() {
        traps += 1;
        throw new Error("an unowned plan must not be inspected");
      },
    });

    for (const lookalike of [genericLookalike, cloned, proxied]) {
      expectApplyFailure(() => renderSetupApplyPlan(lookalike));
    }
    expect(traps).toBe(0);
  });

  it("rejects every genuine unresolved credential result", async () => {
    const first = candidate(1, ["canonical"]);
    const unresolved: readonly SetupCredentialPlanningResult[] = [
      plannedCredential(
        credentialObservation({
          canonical: {
            status: "active-valid",
            candidateSelectionId: first.selectionId,
          },
          candidates: [first, candidate(2, ["hermes"])],
        }),
      ),
      plannedCredential(credentialObservation()),
      plannedCredential(
        credentialObservation({
          blockers: [
            {
              reason: "credential_source_malformed",
              sources: ["hermes"],
            },
          ],
        }),
      ),
    ];
    expect(unresolved.map(({ status }) => status)).toEqual([
      "selection-required",
      "registration-input-required",
      "blocked",
    ]);
    const snapshot = await createSetupPreflightSnapshot(
      "codex",
      fixedCapabilities(healthyInspections()),
    );

    for (const credential of unresolved) {
      expectApplyFailure(() =>
        prepareSetupApplyPlan(
          createSetupApprovalAuthority(),
          snapshot,
          credential,
          null,
          OPERATION_ID,
          CREATED_AT,
        ),
      );
    }
  });

  it("rejects forged and cloned resolved credentials", async () => {
    const snapshot = await createSetupPreflightSnapshot(
      "codex",
      fixedCapabilities(healthyInspections()),
    );
    const owned = resolvedCredential("reuse");
    const forged = Object.freeze({
      ...owned,
      apiOrigin: DEFAULT_API_ORIGIN as ApiOrigin,
    }) as SetupCredentialResolvedPlan;
    const cloned = structuredClone(owned) as SetupCredentialResolvedPlan;

    for (const credential of [forged, cloned]) {
      expectApplyFailure(() =>
        prepareSetupApplyPlan(
          createSetupApprovalAuthority(),
          snapshot,
          credential,
          null,
          OPERATION_ID,
          CREATED_AT,
        ),
      );
    }
  });

  it("rejects a proxied resolved credential without invoking its traps", async () => {
    const snapshot = await createSetupPreflightSnapshot(
      "codex",
      fixedCapabilities(healthyInspections()),
    );
    let reads = 0;
    const proxied = new Proxy(resolvedCredential("reuse"), {
      get(target, property, receiver) {
        reads += 1;
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor(target, property) {
        reads += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      ownKeys(target) {
        reads += 1;
        return Reflect.ownKeys(target);
      },
    });

    expectApplyFailure(() =>
      prepareSetupApplyPlan(
        createSetupApprovalAuthority(),
        snapshot,
        proxied,
        null,
        OPERATION_ID,
        CREATED_AT,
      ),
    );
    expect(reads).toBe(0);
  });

  it("rejects forged, cloned, and reordered preflight snapshots", async () => {
    const snapshot = await createSetupPreflightSnapshot(
      "all",
      fixedCapabilities(healthyInspections()),
    );
    const forged = Object.freeze({
      ...snapshot,
    }) as unknown as SetupPreflightSnapshot;
    const cloned = structuredClone(snapshot) as SetupPreflightSnapshot;
    const reordered = Object.freeze({
      ...snapshot,
      selectedClients: Object.freeze([
        ...snapshot.selectedClients,
      ].reverse()),
      hosts: Object.freeze([...snapshot.hosts].reverse()),
    }) as unknown as SetupPreflightSnapshot;
    const credential = resolvedCredential("reuse");
    const projection = resolvedProjection(credential);

    for (const candidateSnapshot of [forged, cloned, reordered]) {
      expectApplyFailure(() =>
        prepareSetupApplyPlan(
          createSetupApprovalAuthority(),
          candidateSnapshot,
          credential,
          projection,
          OPERATION_ID,
          CREATED_AT,
        ),
      );
    }
  });

  it.each([
    ["not-a-uuid", CREATED_AT],
    ["00000000-0000-1000-8000-000000000001", CREATED_AT],
    [OPERATION_ID, "2026-07-21T09:10:11Z"],
    [OPERATION_ID, "2026-02-30T09:10:11.123Z"],
    [OPERATION_ID.toUpperCase(), CREATED_AT],
  ])(
    "rejects invalid operation metadata (%s, %s)",
    async (operationId, createdAt) => {
      const snapshot = await createSetupPreflightSnapshot(
        "codex",
        fixedCapabilities(healthyInspections()),
      );
      const credential = resolvedCredential("reuse");
      expectApplyFailure(() =>
        prepareSetupApplyPlan(
          createSetupApprovalAuthority(),
          snapshot,
          credential,
          resolvedProjection(credential),
          operationId,
          createdAt,
        ),
      );
    },
  );

  it("does not reinspect a host while composing or rendering a retained snapshot", async () => {
    const codexInspect = vi.fn(async () =>
      available("codex", healthyConfiguration("codex")),
    );
    const capabilities = preflightCapabilities({
      "claude-code": inspectionAdapter(async () => ({
        host: "claude-code",
        status: "absent",
      })),
      codex: inspectionAdapter(codexInspect),
    });
    const snapshot = await createSetupPreflightSnapshot(
      "codex",
      capabilities,
    );
    expect(codexInspect).toHaveBeenCalledTimes(1);
    codexInspect.mockImplementation(async () => {
      throw new Error("a second inspection must never occur");
    });

    const credential = resolvedCredential("reuse");
    const prepared = prepareCodexApply(
      createSetupApprovalAuthority(),
      snapshot,
      credential,
    );
    renderSetupApplyPlan(prepared);

    expect(codexInspect).toHaveBeenCalledTimes(1);
  });
});
