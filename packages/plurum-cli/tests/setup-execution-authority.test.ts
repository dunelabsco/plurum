import { describe, expect, it } from "vitest";

import {
  prepareSetupApplyPlan,
  type SetupApplyPlan,
} from "../src/commands/setup-apply-plan.js";
import {
  createSetupApprovalAuthority,
  type SetupApprovalAuthority,
  type SetupApprovalIdentity,
  type SetupPreparedPlan,
} from "../src/commands/setup-approval.js";
import {
  planSetupCodexProjection,
  type SetupCodexProjectionResolvedPlan,
} from "../src/commands/setup-codex-projection-plan.js";
import {
  planSetupCredential,
  type SetupCredentialResolvedPlan,
} from "../src/commands/setup-credential-plan.js";
import {
  createSetupExecutionAuthority,
  SetupExecutionAuthorityError,
  type SetupExecutionAuthority,
  type SetupExecutionSidecarIdentity,
} from "../src/commands/setup-execution-authority.js";
import {
  createSetupPreflightSnapshot,
} from "../src/commands/setup-preflight.js";
import type { CredentialKeyFingerprint } from "../src/credentials/fingerprint.js";
import { DEFAULT_API_ORIGIN } from "../src/credentials/origin.js";
import type {
  HostConfiguration,
  HostExecutableAttestation,
  HostInspection,
  HostMutationAdapter,
} from "../src/hosts/contracts.js";
import {
  CODEX_DESIRED_CONFIGURATION,
  CODEX_MUTATION_SUPPORT,
} from "../src/hosts/codex/configuration.js";
import { setupPreflightScope } from "../src/system/scopes.js";
import type { SystemCapabilities } from "../src/system/contracts.js";
import { createTestSystem } from "./support/system.js";

const OPERATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const CREATED_AT = "2026-07-21T09:10:11.123Z";
const AGENT_ID = "00000000-0000-4000-8000-000000000011";
const FINGERPRINT =
  "plurum-fp-v1:111111111111" as CredentialKeyFingerprint;
const RAW_KEY_CANARY = "plrm_live_EXECUTION_SIDECAR_CANARY_123456";
const REVISION_CANARY = "native-revision-execution-sidecar-canary";

interface SetupFixture {
  readonly approval: SetupApprovalAuthority;
  readonly execution: SetupExecutionAuthority;
  readonly credential: SetupCredentialResolvedPlan;
  readonly projection: SetupCodexProjectionResolvedPlan;
  readonly plan: SetupPreparedPlan<SetupApplyPlan>;
}

function absentConfiguration(): HostConfiguration {
  return {
    marketplace: { status: "absent" },
    plugin: { status: "absent" },
    pluginMcp: { status: "absent" },
    directMcp: { status: "absent" },
  };
}

function executable(): HostExecutableAttestation {
  const path = "/trusted/bin/codex";
  return {
    sourcePath: path,
    resolvedPath: path,
    revision: "codex-executable-revision",
    chain: [
      {
        path,
        kind: "binary",
        owner: "current-user",
        access: "not-broadly-writable",
        binding: "canonical",
        link: "direct",
        revision: "codex-chain-revision",
      },
    ],
    launch: {
      executable: path,
      argumentPrefix: [],
      shell: false,
    },
  };
}

function codexInspection(): HostInspection {
  return {
    host: "codex",
    status: "available",
    executable: executable(),
    version: CODEX_DESIRED_CONFIGURATION.minimumHostVersion,
    state: {
      revision: "codex-state-revision",
      configuration: absentConfiguration(),
    },
    mutationSupport: CODEX_MUTATION_SUPPORT,
  };
}

function mutationAdapter(): HostMutationAdapter {
  return Object.freeze({
    inspect: async () => codexInspection(),
    apply: async () => {
      throw new Error("execution-authority tests must not mutate hosts");
    },
    rollback: async () => {
      throw new Error("execution-authority tests must not mutate hosts");
    },
  });
}

function resolvedCredential(): SetupCredentialResolvedPlan {
  const result = planSetupCredential({
    observation: {
      schemaVersion: 1,
      transaction: "clean",
      canonical: {
        status: "active-valid",
        candidateSelectionId: "credential-1",
      },
      candidates: [
        {
          selectionId: "credential-1",
          apiOrigin: DEFAULT_API_ORIGIN,
          fingerprint: FINGERPRINT,
          agent: {
            id: AGENT_ID,
            name: "Codex",
            username: "codex-agent",
          },
          sources: ["canonical"],
        },
      ],
      blockers: [],
      invalidSources: [],
    },
    decision: {
      selectedCandidateId: null,
      registration: null,
    },
  });
  if (result.status !== "resolved") {
    throw new Error("expected a resolved credential");
  }
  return result;
}

async function setupFixture(): Promise<SetupFixture> {
  const base = createTestSystem();
  const system: SystemCapabilities = Object.freeze({
    ...base,
    hosts: Object.freeze({
      inspection: base.hosts.inspection,
      mutation: Object.freeze({
        "claude-code": base.hosts.mutation["claude-code"],
        codex: mutationAdapter(),
      }),
    }),
  });
  const snapshot = await createSetupPreflightSnapshot(
    "codex",
    setupPreflightScope(system),
  );
  const credential = resolvedCredential();
  const projection = planSetupCodexProjection(
    credential,
    "matches-selected",
  );
  if (projection.status !== "resolved") {
    throw new Error("expected a resolved Codex projection");
  }
  const approval = createSetupApprovalAuthority();
  const plan = prepareSetupApplyPlan(
    approval,
    snapshot,
    credential,
    projection,
    OPERATION_ID,
    CREATED_AT,
  );
  return {
    approval,
    execution: createSetupExecutionAuthority(approval),
    credential,
    projection,
    plan,
  };
}

function privateEvidence(): object {
  return Object.freeze({
    credential: Object.freeze({ key: RAW_KEY_CANARY }),
    transaction: Object.freeze({ revision: REVISION_CANARY }),
    projection: Object.freeze({ revision: REVISION_CANARY }),
  });
}

function expectAuthorityError(callback: () => unknown): void {
  let captured: unknown;
  try {
    callback();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(SetupExecutionAuthorityError);
  expect(String(captured)).toBe(
    "SetupExecutionAuthorityError: The setup execution authority could not be used safely.",
  );
  expect(String(captured)).not.toContain(RAW_KEY_CANARY);
  expect(String(captured)).not.toContain(REVISION_CANARY);
}

describe("setup execution authority", () => {
  it("moves private evidence through opaque one-use identities into an opaque grant", async () => {
    const fixture = await setupFixture();
    const observation = fixture.execution.registerObservation(
      privateEvidence(),
    );
    const sidecar = fixture.execution.bind(
      fixture.plan,
      fixture.credential,
      fixture.projection,
      observation,
    );
    const approval = fixture.approval.approve({
      plan: fixture.plan,
      source: "interactive",
    });
    const result = fixture.execution.consume(
      fixture.plan,
      approval,
      sidecar,
    );

    expect(Object.isFrozen(fixture.execution)).toBe(true);
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(sidecar)).toBe(true);
    expect(Object.keys(observation)).toEqual([]);
    expect(Object.keys(sidecar)).toEqual([]);
    expect(result.status).toBe("approved");
    if (result.status !== "approved") {
      throw new Error("expected an execution grant");
    }
    expect(result.source).toBe("interactive");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.grant)).toBe(true);
    expect(Object.keys(result.grant)).toEqual([]);

    const serialized = JSON.stringify({ observation, sidecar, result });
    expect(serialized).toBe(
      '{"result":{"status":"approved","source":"interactive"}}',
    );
    expect(serialized).not.toContain(RAW_KEY_CANARY);
    expect(serialized).not.toContain(REVISION_CANARY);
    expect(
      fixture.execution.consume(fixture.plan, approval, sidecar),
    ).toEqual({ status: "precondition-failed" });
    expect(fixture.execution.discard(observation)).toEqual({
      status: "precondition-failed",
    });
    expect(fixture.execution.discard(sidecar)).toEqual({
      status: "precondition-failed",
    });
    expect(fixture.execution.discard(result.grant)).toEqual({
      status: "discarded",
    });
    expect(fixture.execution.discard(result.grant)).toEqual({
      status: "precondition-failed",
    });
  });

  it("binds only the exact plan and its original credential/projection provenance", async () => {
    const fixture = await setupFixture();
    const foreignCredential = resolvedCredential();
    const foreignProjection = planSetupCodexProjection(
      foreignCredential,
      "matches-selected",
    );
    if (foreignProjection.status !== "resolved") {
      throw new Error("expected a resolved foreign projection");
    }

    const wrongCredentialObservation =
      fixture.execution.registerObservation(privateEvidence());
    expectAuthorityError(() =>
      fixture.execution.bind(
        fixture.plan,
        foreignCredential,
        foreignProjection,
        wrongCredentialObservation,
      ),
    );
    expectAuthorityError(() =>
      fixture.execution.bind(
        fixture.plan,
        fixture.credential,
        fixture.projection,
        wrongCredentialObservation,
      ),
    );

    const cloned = structuredClone(fixture.plan) as SetupPreparedPlan<
      SetupApplyPlan
    >;
    const clonedPlanObservation =
      fixture.execution.registerObservation(privateEvidence());
    expectAuthorityError(() =>
      fixture.execution.bind(
        cloned,
        fixture.credential,
        fixture.projection,
        clonedPlanObservation,
      ),
    );

    const foreignApproval = createSetupApprovalAuthority();
    const foreignExecution = createSetupExecutionAuthority(foreignApproval);
    const foreignObservation =
      foreignExecution.registerObservation(privateEvidence());
    expectAuthorityError(() =>
      foreignExecution.bind(
        fixture.plan,
        fixture.credential,
        fixture.projection,
        foreignObservation,
      ),
    );
  });

  it("rejects plan proxies without invoking traps and burns supplied observation evidence", async () => {
    const fixture = await setupFixture();
    const observation = fixture.execution.registerObservation(
      privateEvidence(),
    );
    let traps = 0;
    const proxy = new Proxy(fixture.plan, {
      get() {
        traps += 1;
        throw new Error("the plan proxy must not be read");
      },
      getOwnPropertyDescriptor() {
        traps += 1;
        throw new Error("the plan proxy must not be inspected");
      },
      ownKeys() {
        traps += 1;
        throw new Error("the plan proxy must not be inspected");
      },
    });

    expectAuthorityError(() =>
      fixture.execution.bind(
        proxy,
        fixture.credential,
        fixture.projection,
        observation,
      ),
    );
    expectAuthorityError(() =>
      fixture.execution.bind(
        fixture.plan,
        fixture.credential,
        fixture.projection,
        observation,
      ),
    );
    expect(traps).toBe(0);
  });

  it("rejects credential and projection proxies without invoking traps", async () => {
    const fixture = await setupFixture();
    let traps = 0;
    const proxyHandler: ProxyHandler<object> = {
      get() {
        traps += 1;
        throw new Error("provenance proxies must not be read");
      },
      getOwnPropertyDescriptor() {
        traps += 1;
        throw new Error("provenance proxies must not be inspected");
      },
      ownKeys() {
        traps += 1;
        throw new Error("provenance proxies must not be inspected");
      },
    };
    const credentialProxy = new Proxy(
      fixture.credential,
      proxyHandler,
    );
    const projectionProxy = new Proxy(
      fixture.projection,
      proxyHandler,
    );

    expectAuthorityError(() =>
      fixture.execution.bind(
        fixture.plan,
        credentialProxy as SetupCredentialResolvedPlan,
        fixture.projection,
        fixture.execution.registerObservation(privateEvidence()),
      ),
    );
    expectAuthorityError(() =>
      fixture.execution.bind(
        fixture.plan,
        fixture.credential,
        projectionProxy as SetupCodexProjectionResolvedPlan,
        fixture.execution.registerObservation(privateEvidence()),
      ),
    );
    expect(traps).toBe(0);
  });

  it("burns exact approvals and bound sidecars on forged or proxied consume inputs", async () => {
    const forgedFixture = await setupFixture();
    const forgedSidecar = forgedFixture.execution.bind(
      forgedFixture.plan,
      forgedFixture.credential,
      forgedFixture.projection,
      forgedFixture.execution.registerObservation(privateEvidence()),
    );
    const forgedApproval = forgedFixture.approval.approve({
      plan: forgedFixture.plan,
      source: "assume-yes",
    });
    const fakeSidecar = Object.freeze({}) as SetupExecutionSidecarIdentity;

    expect(
      forgedFixture.execution.consume(
        forgedFixture.plan,
        forgedApproval,
        fakeSidecar,
      ),
    ).toEqual({ status: "precondition-failed" });
    expect(
      forgedFixture.execution.consume(
        forgedFixture.plan,
        forgedApproval,
        forgedSidecar,
      ),
    ).toEqual({ status: "precondition-failed" });

    const proxyFixture = await setupFixture();
    const proxySidecar = proxyFixture.execution.bind(
      proxyFixture.plan,
      proxyFixture.credential,
      proxyFixture.projection,
      proxyFixture.execution.registerObservation(privateEvidence()),
    );
    const proxyApproval = proxyFixture.approval.approve({
      plan: proxyFixture.plan,
      source: "interactive",
    });
    let traps = 0;
    const sidecarProxy = new Proxy(proxySidecar, {
      get() {
        traps += 1;
        throw new Error("the sidecar proxy must not be read");
      },
      getOwnPropertyDescriptor() {
        traps += 1;
        throw new Error("the sidecar proxy must not be inspected");
      },
      ownKeys() {
        traps += 1;
        throw new Error("the sidecar proxy must not be inspected");
      },
    });

    expect(
      proxyFixture.execution.consume(
        proxyFixture.plan,
        proxyApproval,
        sidecarProxy,
      ),
    ).toEqual({ status: "precondition-failed" });
    expect(
      proxyFixture.execution.consume(
        proxyFixture.plan,
        proxyApproval,
        proxySidecar,
      ),
    ).toEqual({ status: "precondition-failed" });
    expect(traps).toBe(0);
  });

  it("rejects plan and approval proxies during consume without invoking traps", async () => {
    const planFixture = await setupFixture();
    const planSidecar = planFixture.execution.bind(
      planFixture.plan,
      planFixture.credential,
      planFixture.projection,
      planFixture.execution.registerObservation(privateEvidence()),
    );
    const planApproval = planFixture.approval.approve({
      plan: planFixture.plan,
      source: "interactive",
    });
    let traps = 0;
    const proxyHandler: ProxyHandler<object> = {
      get() {
        traps += 1;
        throw new Error("consume proxies must not be read");
      },
      getOwnPropertyDescriptor() {
        traps += 1;
        throw new Error("consume proxies must not be inspected");
      },
      ownKeys() {
        traps += 1;
        throw new Error("consume proxies must not be inspected");
      },
    };
    const planProxy = new Proxy(planFixture.plan, proxyHandler);

    expect(
      planFixture.execution.consume(
        planProxy as SetupPreparedPlan<SetupApplyPlan>,
        planApproval,
        planSidecar,
      ),
    ).toEqual({ status: "precondition-failed" });
    expect(
      planFixture.execution.consume(
        planFixture.plan,
        planApproval,
        planSidecar,
      ),
    ).toEqual({ status: "precondition-failed" });

    const approvalFixture = await setupFixture();
    const approvalSidecar = approvalFixture.execution.bind(
      approvalFixture.plan,
      approvalFixture.credential,
      approvalFixture.projection,
      approvalFixture.execution.registerObservation(privateEvidence()),
    );
    const exactApproval = approvalFixture.approval.approve({
      plan: approvalFixture.plan,
      source: "assume-yes",
    });
    const approvalProxy = new Proxy(exactApproval, proxyHandler);
    expect(
      approvalFixture.execution.consume(
        approvalFixture.plan,
        approvalProxy as SetupApprovalIdentity,
        approvalSidecar,
      ),
    ).toEqual({ status: "precondition-failed" });
    expect(approvalFixture.execution.discard(approvalSidecar)).toEqual({
      status: "precondition-failed",
    });
    expect(traps).toBe(0);
  });

  it("burns sidecars on wrong plans and approvals and never grants execution", async () => {
    const first = await setupFixture();
    const second = await setupFixture();
    const sidecar = first.execution.bind(
      first.plan,
      first.credential,
      first.projection,
      first.execution.registerObservation(privateEvidence()),
    );
    const approval = first.approval.approve({
      plan: first.plan,
      source: "interactive",
    });

    expect(
      first.execution.consume(
        second.plan,
        approval,
        sidecar,
      ),
    ).toEqual({ status: "precondition-failed" });
    expect(
      first.execution.consume(first.plan, approval, sidecar),
    ).toEqual({ status: "precondition-failed" });

    const third = await setupFixture();
    const thirdSidecar = third.execution.bind(
      third.plan,
      third.credential,
      third.projection,
      third.execution.registerObservation(privateEvidence()),
    );
    const foreignApproval = second.approval.approve({
      plan: second.plan,
      source: "assume-yes",
    });
    expect(
      third.execution.consume(
        third.plan,
        foreignApproval as SetupApprovalIdentity,
        thirdSidecar,
      ),
    ).toEqual({ status: "precondition-failed" });
    expect(third.execution.discard(thirdSidecar)).toEqual({
      status: "precondition-failed",
    });
  });

  it("explicitly discards observations and sidecars before approval", async () => {
    const fixture = await setupFixture();
    const observation = fixture.execution.registerObservation(
      privateEvidence(),
    );
    expect(fixture.execution.discard(observation)).toEqual({
      status: "discarded",
    });
    expectAuthorityError(() =>
      fixture.execution.bind(
        fixture.plan,
        fixture.credential,
        fixture.projection,
        observation,
      ),
    );

    const sidecar = fixture.execution.bind(
      fixture.plan,
      fixture.credential,
      fixture.projection,
      fixture.execution.registerObservation(privateEvidence()),
    );
    expect(fixture.execution.discard(sidecar)).toEqual({
      status: "discarded",
    });
    const approval = fixture.approval.approve({
      plan: fixture.plan,
      source: "interactive",
    });
    expect(
      fixture.execution.consume(fixture.plan, approval, sidecar),
    ).toEqual({ status: "precondition-failed" });
  });

  it("rejects duplicate binding while preserving the original sidecar", async () => {
    const fixture = await setupFixture();
    const first = fixture.execution.bind(
      fixture.plan,
      fixture.credential,
      fixture.projection,
      fixture.execution.registerObservation(privateEvidence()),
    );
    const duplicateObservation =
      fixture.execution.registerObservation(privateEvidence());

    expectAuthorityError(() =>
      fixture.execution.bind(
        fixture.plan,
        fixture.credential,
        fixture.projection,
        duplicateObservation,
      ),
    );
    expect(fixture.execution.discard(duplicateObservation)).toEqual({
      status: "precondition-failed",
    });

    const approval = fixture.approval.approve({
      plan: fixture.plan,
      source: "assume-yes",
    });
    expect(
      fixture.execution.consume(fixture.plan, approval, first),
    ).toMatchObject({
      status: "approved",
      source: "assume-yes",
    });
  });

  it("rejects foreign approval authorities without invoking traps", () => {
    let traps = 0;
    const proxy = new Proxy(Object.freeze({}), {
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

    expectAuthorityError(() => createSetupExecutionAuthority(proxy));
    expect(traps).toBe(0);
  });
});
