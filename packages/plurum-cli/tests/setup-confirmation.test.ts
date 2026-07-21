import { describe, expect, it, vi } from "vitest";

import {
  prepareSetupApplyPlan,
  type SetupApplyPlan,
} from "../src/commands/setup-apply-plan.js";
import {
  createSetupApprovalAuthority,
  mintSetupApproval,
  type SetupApprovalAuthority,
  type SetupPreparedPlan,
} from "../src/commands/setup-approval.js";
import {
  createSetupConfirmationAttempt,
  createSetupInputFreePlanPresenter,
  createSetupInteractiveSessionPorts,
  SetupConfirmationError,
  type SetupConfirmationMode,
  type SetupInteractiveConfirmation,
  type SetupInteractiveConfirmationResult,
  type SetupPlanPresenter,
  type SetupPlanPresentationResult,
} from "../src/commands/setup-confirmation.js";
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
  type SetupExecutionAuthority,
  type SetupExecutionSidecarIdentity,
} from "../src/commands/setup-execution-authority.js";
import { renderSetupApplyPlan } from "../src/commands/setup-output.js";
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
const RAW_KEY_CANARY =
  "plrm_live_SETUP_CONFIRMATION_PRIVATE_CANARY_123456";
const REVISION_CANARY = "setup-confirmation-private-revision-canary";
const ADAPTER_ERROR_CANARY = "setup-confirmation-adapter-error-canary";

interface SetupFixture {
  readonly approval: SetupApprovalAuthority;
  readonly execution: SetupExecutionAuthority;
  readonly credential: SetupCredentialResolvedPlan;
  readonly projection: SetupCodexProjectionResolvedPlan;
  readonly plan: SetupPreparedPlan<SetupApplyPlan>;
  readonly sidecar: SetupExecutionSidecarIdentity;
}

interface InteractionHarness {
  readonly presenter: SetupPlanPresenter;
  readonly inputFreePresenter: SetupPlanPresenter;
  readonly confirmation: SetupInteractiveConfirmation;
  readonly presentations: string[];
  readonly events: string[];
  readonly presentPlan: ReturnType<typeof vi.fn>;
  readonly confirm: ReturnType<typeof vi.fn>;
}

function absentConfiguration(): HostConfiguration {
  return {
    marketplace: { status: "absent" },
    plugin: { status: "absent" },
    pluginMcp: { status: "absent" },
    directMcp: { status: "absent" },
  };
}

function healthyConfiguration(): HostConfiguration {
  const desired = CODEX_DESIRED_CONFIGURATION;
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

function codexInspection(configuration: HostConfiguration): HostInspection {
  return {
    host: "codex",
    status: "available",
    executable: executable(),
    version: CODEX_DESIRED_CONFIGURATION.minimumHostVersion,
    state: {
      revision: "codex-state-revision",
      configuration,
    },
    mutationSupport: CODEX_MUTATION_SUPPORT,
  };
}

function mutationAdapter(
  configuration: HostConfiguration,
): HostMutationAdapter {
  return Object.freeze({
    inspect: async () => codexInspection(configuration),
    apply: async () => {
      throw new Error("setup confirmation tests must not mutate hosts");
    },
    rollback: async () => {
      throw new Error("setup confirmation tests must not mutate hosts");
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

function privateEvidence(): object {
  return Object.freeze({
    credential: Object.freeze({ key: RAW_KEY_CANARY }),
    transaction: Object.freeze({ revision: REVISION_CANARY }),
    projection: Object.freeze({ revision: REVISION_CANARY }),
  });
}

async function setupFixture(
  readiness: "ready" | "no-op" = "ready",
): Promise<SetupFixture> {
  const base = createTestSystem();
  const configuration =
    readiness === "ready"
      ? absentConfiguration()
      : healthyConfiguration();
  const system: SystemCapabilities = Object.freeze({
    ...base,
    hosts: Object.freeze({
      inspection: base.hosts.inspection,
      mutation: Object.freeze({
        "claude-code": base.hosts.mutation["claude-code"],
        codex: mutationAdapter(configuration),
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
  const execution = createSetupExecutionAuthority(approval);
  const sidecar = execution.bind(
    plan,
    credential,
    projection,
    execution.registerObservation(privateEvidence()),
  );
  expect(plan.preview.readiness).toBe(readiness);
  return { approval, execution, credential, projection, plan, sidecar };
}

function interaction(
  options: Readonly<{
    presentation?: SetupPlanPresentationResult;
    decision?: SetupInteractiveConfirmationResult;
    presentError?: unknown;
    confirmError?: unknown;
  }> = {},
): InteractionHarness {
  const presentations: string[] = [];
  const events: string[] = [];
  const presentPlan = vi.fn(async (text: string) => {
    events.push("present:start");
    presentations.push(text);
    if (options.presentError !== undefined) {
      throw options.presentError;
    }
    events.push("present:complete");
    return options.presentation ?? "presented";
  });
  const confirm = vi.fn(async () => {
    events.push("confirm");
    if (options.confirmError !== undefined) {
      throw options.confirmError;
    }
    return options.decision ?? "confirmed";
  });
  const ports = createSetupInteractiveSessionPorts(
    presentPlan,
    confirm,
  );
  return {
    presenter: ports.presenter,
    inputFreePresenter: createSetupInputFreePlanPresenter(presentPlan),
    confirmation: ports.confirmation,
    presentations,
    events,
    presentPlan,
    confirm,
  };
}

function confirmationAttempt(
  fixture: SetupFixture,
  io: Pick<InteractionHarness, "presenter" | "confirmation"> &
    Partial<Pick<InteractionHarness, "inputFreePresenter">>,
  mode: SetupConfirmationMode = "interactive",
) {
  const interactive =
    fixture.plan.preview.confirmation === "required" &&
    mode === "interactive";
  const presenter = interactive
    ? io.presenter
    : io.inputFreePresenter;
  if (presenter === undefined) {
    throw new Error("expected an input-free test presenter");
  }
  return createSetupConfirmationAttempt(
    fixture.plan,
    fixture.sidecar,
    fixture.approval,
    fixture.execution,
    mode,
    presenter,
    interactive ? io.confirmation : null,
  );
}

function expectSidecarReleased(fixture: SetupFixture): void {
  expect(fixture.execution.discard(fixture.sidecar)).toEqual({
    status: "precondition-failed",
  });
}

function expectConfirmationError(callback: () => unknown): void {
  let captured: unknown;
  try {
    callback();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(SetupConfirmationError);
  expect(String(captured)).toBe(
    "SetupConfirmationError: The setup confirmation could not be created safely.",
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("setup confirmation", () => {
  it("presents and interactively approves only the exact captured plan", async () => {
    const fixture = await setupFixture();
    const io = interaction();
    const attempt = confirmationAttempt(fixture, io);

    const result = await attempt.authorize();

    expect(io.presentations).toEqual([
      renderSetupApplyPlan(fixture.plan),
    ]);
    expect(io.events).toEqual([
      "present:start",
      "present:complete",
      "confirm",
    ]);
    expect(io.confirm).toHaveBeenCalledWith();
    expect(result).toMatchObject({
      status: "approved",
      source: "interactive",
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status !== "approved") {
      throw new Error("expected an approved confirmation");
    }
    expect(Object.isFrozen(result.grant)).toBe(true);
    expect(Object.keys(result.grant)).toEqual([]);
    expectSidecarReleased(fixture);
    expect(fixture.execution.discard(result.grant)).toEqual({
      status: "discarded",
    });
  });

  it("uses assume-yes only after presentation and never accesses the reader", async () => {
    const fixture = await setupFixture();
    const gate = deferred<SetupPlanPresentationResult>();
    const events: string[] = [];
    const presentPlan = vi.fn(async (text: string) => {
      events.push("present:start");
      expect(text).toBe(renderSetupApplyPlan(fixture.plan));
      const result = await gate.promise;
      events.push("present:complete");
      return result;
    });
    const confirm = vi.fn(async () => {
      throw new Error("assume-yes must not read interactive input");
    });
    const attempt = createSetupConfirmationAttempt(
      fixture.plan,
      fixture.sidecar,
      fixture.approval,
      fixture.execution,
      "assume-yes",
      createSetupInputFreePlanPresenter(presentPlan),
      null,
    );
    expect(fixture.execution.discard(fixture.sidecar)).toEqual({
      status: "precondition-failed",
    });
    const pending = attempt.authorize();

    expect(events).toEqual(["present:start"]);
    expect(confirm).not.toHaveBeenCalled();
    gate.resolve("presented");
    const result = await pending;

    expect(events).toEqual(["present:start", "present:complete"]);
    expect(confirm).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "approved",
      source: "assume-yes",
    });
    if (result.status !== "approved") {
      throw new Error("expected an assume-yes grant");
    }
    expect(fixture.execution.discard(result.grant)).toEqual({
      status: "discarded",
    });
  });

  it("rejects every interactive-session capability in assume-yes mode", async () => {
    for (const variant of ["presenter", "confirmation"] as const) {
      const fixture = await setupFixture();
      const io = interaction();

      expectConfirmationError(() =>
        createSetupConfirmationAttempt(
          fixture.plan,
          fixture.sidecar,
          fixture.approval,
          fixture.execution,
          "assume-yes",
          variant === "presenter"
            ? io.presenter
            : io.inputFreePresenter,
          variant === "confirmation" ? io.confirmation : null,
        )
      );
      expect(io.presentPlan).not.toHaveBeenCalled();
      expect(io.confirm).not.toHaveBeenCalled();
      expectSidecarReleased(fixture);
    }
  });

  it("requires presenter-only composition for a no-op plan", async () => {
    const fixture = await setupFixture("no-op");
    const io = interaction();

    expectConfirmationError(() =>
      createSetupConfirmationAttempt(
        fixture.plan,
        fixture.sidecar,
        fixture.approval,
        fixture.execution,
        "interactive",
        io.presenter,
        io.confirmation,
      )
    );
    expect(io.presentPlan).not.toHaveBeenCalled();
    expect(io.confirm).not.toHaveBeenCalled();
    expectSidecarReleased(fixture);
  });

  it("rejects an input-free presenter for required interactive confirmation", async () => {
    const fixture = await setupFixture();
    const io = interaction();

    expectConfirmationError(() =>
      createSetupConfirmationAttempt(
        fixture.plan,
        fixture.sidecar,
        fixture.approval,
        fixture.execution,
        "interactive",
        io.inputFreePresenter,
        io.confirmation,
      )
    );
    expect(io.presentPlan).not.toHaveBeenCalled();
    expect(io.confirm).not.toHaveBeenCalled();
    expectSidecarReleased(fixture);
  });

  it("rejects presenter and confirmation ports from different interactive sessions", async () => {
    const fixture = await setupFixture();
    const first = interaction();
    const second = interaction();

    expectConfirmationError(() =>
      createSetupConfirmationAttempt(
        fixture.plan,
        fixture.sidecar,
        fixture.approval,
        fixture.execution,
        "interactive",
        first.presenter,
        second.confirmation,
      )
    );
    expect(first.presentPlan).not.toHaveBeenCalled();
    expect(first.confirm).not.toHaveBeenCalled();
    expect(second.presentPlan).not.toHaveBeenCalled();
    expect(second.confirm).not.toHaveBeenCalled();
    expectSidecarReleased(fixture);
  });

  it("does not begin confirmation before presentation completes", async () => {
    const fixture = await setupFixture();
    const gate = deferred<SetupPlanPresentationResult>();
    const events: string[] = [];
    const ports = createSetupInteractiveSessionPorts(
      async () => {
        events.push("present:start");
        const result = await gate.promise;
        events.push("present:complete");
        return result;
      },
      async (): Promise<SetupInteractiveConfirmationResult> => {
        events.push("confirm");
        return "confirmed";
      },
    );

    const pending = confirmationAttempt(
      fixture,
      ports,
    ).authorize();
    expect(events).toEqual(["present:start"]);

    gate.resolve("presented");
    const result = await pending;
    expect(events).toEqual([
      "present:start",
      "present:complete",
      "confirm",
    ]);
    expect(result.status).toBe("approved");
    if (result.status === "approved") {
      fixture.execution.discard(result.grant);
    }
  });

  it.each(["interactive", "assume-yes"] as const)(
    "presents a no-op under %s without prompting or granting execution",
    async (mode) => {
      const fixture = await setupFixture("no-op");
      const io = interaction();

      const result = await confirmationAttempt(
        fixture,
        io,
        mode,
      ).authorize();

      expect(result).toEqual({ status: "not-required" });
      expect(io.presentations).toEqual([
        renderSetupApplyPlan(fixture.plan),
      ]);
      expect(io.confirm).not.toHaveBeenCalled();
      expectSidecarReleased(fixture);
    },
  );

  it.each([
    ["declined", "declined"],
    ["unavailable", "interaction-unavailable"],
  ] as const)(
    "cancels a %s interactive result and releases the sidecar",
    async (decision, reason) => {
      const fixture = await setupFixture();
      const io = interaction({ decision });

      const result = await confirmationAttempt(
        fixture,
        io,
      ).authorize();

      expect(result).toEqual({ status: "cancelled", reason });
      expect(io.presentPlan).toHaveBeenCalledOnce();
      expect(io.confirm).toHaveBeenCalledOnce();
      expectSidecarReleased(fixture);
    },
  );

  it.each([
    ["unavailable"],
    ["invalid-result"],
  ] as const)(
    "cancels an unavailable presentation result %s before reading input",
    async (presentation) => {
      const fixture = await setupFixture();
      const io = interaction({
        presentation:
          presentation as SetupPlanPresentationResult,
      });

      const result = await confirmationAttempt(
        fixture,
        io,
      ).authorize();

      expect(result).toEqual({
        status: "cancelled",
        reason: "presentation-unavailable",
      });
      expect(io.confirm).not.toHaveBeenCalled();
      expectSidecarReleased(fixture);
    },
  );

  it("maps presentation and interaction failures to fixed cancellation results", async () => {
    const presentationFixture = await setupFixture();
    const presentationIo = interaction({
      presentError: new Error(ADAPTER_ERROR_CANARY),
    });
    const presentation = await confirmationAttempt(
      presentationFixture,
      presentationIo,
    ).authorize();
    expect(presentation).toEqual({
      status: "cancelled",
      reason: "presentation-unavailable",
    });
    expect(presentationIo.confirm).not.toHaveBeenCalled();
    expectSidecarReleased(presentationFixture);

    const interactionFixture = await setupFixture();
    const confirmationIo = interaction({
      confirmError: new Error(ADAPTER_ERROR_CANARY),
    });
    const confirmation = await confirmationAttempt(
      interactionFixture,
      confirmationIo,
    ).authorize();
    expect(confirmation).toEqual({
      status: "cancelled",
      reason: "interaction-unavailable",
    });
    expectSidecarReleased(interactionFixture);

    const serialized = JSON.stringify({ presentation, confirmation });
    expect(serialized).not.toContain(ADAPTER_ERROR_CANARY);
    expect(serialized).not.toContain(RAW_KEY_CANARY);
    expect(serialized).not.toContain(REVISION_CANARY);
  });

  it("treats unknown interaction results as unavailable without reflecting them", async () => {
    const fixture = await setupFixture();
    const io = interaction({
      decision:
        ADAPTER_ERROR_CANARY as SetupInteractiveConfirmationResult,
    });

    const result = await confirmationAttempt(
      fixture,
      io,
    ).authorize();

    expect(result).toEqual({
      status: "cancelled",
      reason: "interaction-unavailable",
    });
    expect(JSON.stringify(result)).not.toContain(ADAPTER_ERROR_CANARY);
    expectSidecarReleased(fixture);
  });

  it("rejects an invalid or proxied mode without presentation or traps", async () => {
    const invalidFixture = await setupFixture();
    const invalidIo = interaction();
    expectConfirmationError(() =>
      createSetupConfirmationAttempt(
        invalidFixture.plan,
        invalidFixture.sidecar,
        invalidFixture.approval,
        invalidFixture.execution,
        "invalid" as SetupConfirmationMode,
        invalidIo.presenter,
        invalidIo.confirmation,
      )
    );
    expect(invalidIo.presentPlan).not.toHaveBeenCalled();
    expect(invalidIo.confirm).not.toHaveBeenCalled();
    expectSidecarReleased(invalidFixture);

    const proxyFixture = await setupFixture();
    const proxyIo = interaction();
    let traps = 0;
    const mode = new Proxy(Object.freeze({}), {
      get() {
        traps += 1;
        throw new Error("confirmation mode proxy must not be read");
      },
      getOwnPropertyDescriptor() {
        traps += 1;
        throw new Error("confirmation mode proxy must not be inspected");
      },
      ownKeys() {
        traps += 1;
        throw new Error("confirmation mode proxy must not be inspected");
      },
    }) as unknown as SetupConfirmationMode;
    expectConfirmationError(() =>
      createSetupConfirmationAttempt(
        proxyFixture.plan,
        proxyFixture.sidecar,
        proxyFixture.approval,
        proxyFixture.execution,
        mode,
        proxyIo.presenter,
        proxyIo.confirmation,
      )
    );
    expect(traps).toBe(0);
    expect(proxyIo.presentPlan).not.toHaveBeenCalled();
    expectSidecarReleased(proxyFixture);
  });

  it("rejects cloned, forged, and proxied interaction capabilities without traps", async () => {
    let traps = 0;
    const handler: ProxyHandler<object> = {
      get() {
        traps += 1;
        throw new Error("interaction capabilities must not be read");
      },
      getOwnPropertyDescriptor() {
        traps += 1;
        throw new Error("interaction capabilities must not be inspected");
      },
      ownKeys() {
        traps += 1;
        throw new Error("interaction capabilities must not be inspected");
      },
    };

    for (const variant of ["clone", "forgery", "proxy"] as const) {
      const fixture = await setupFixture();
      const io = interaction();
      const presenter =
        variant === "clone"
          ? Object.freeze({
              presentPlan: io.presenter.presentPlan,
            }) as SetupPlanPresenter
          : variant === "forgery"
          ? Object.freeze(Object.create(null)) as SetupPlanPresenter
          : new Proxy(
              io.presenter,
              handler,
            ) as SetupPlanPresenter;

      expectConfirmationError(() =>
        createSetupConfirmationAttempt(
          fixture.plan,
          fixture.sidecar,
          fixture.approval,
          fixture.execution,
          "interactive",
          presenter,
          io.confirmation,
        )
      );
      expect(io.presentPlan).not.toHaveBeenCalled();
      expect(io.confirm).not.toHaveBeenCalled();
      expectSidecarReleased(fixture);
    }

    for (const variant of ["clone", "forgery", "proxy"] as const) {
      const fixture = await setupFixture();
      const io = interaction();
      const confirmation =
        variant === "clone"
          ? Object.freeze({
              confirm: io.confirmation.confirm,
            }) as SetupInteractiveConfirmation
          : variant === "forgery"
          ? Object.freeze(
              Object.create(null),
            ) as SetupInteractiveConfirmation
          : new Proxy(
              io.confirmation,
              handler,
            ) as SetupInteractiveConfirmation;

      expectConfirmationError(() =>
        createSetupConfirmationAttempt(
          fixture.plan,
          fixture.sidecar,
          fixture.approval,
          fixture.execution,
          "interactive",
          io.presenter,
          confirmation,
        )
      );
      expect(io.presentPlan).not.toHaveBeenCalled();
      expect(io.confirm).not.toHaveBeenCalled();
      expectSidecarReleased(fixture);
    }

    expect(traps).toBe(0);
  });

  it("is one-use across concurrent calls and rejects a second wrapper", async () => {
    const fixture = await setupFixture();
    const gate = deferred<SetupPlanPresentationResult>();
    const presentPlan = vi.fn(async () => gate.promise);
    const confirm = vi.fn(async () => "confirmed" as const);
    const io = createSetupInteractiveSessionPorts(
      presentPlan,
      confirm,
    );
    const firstAttempt = confirmationAttempt(fixture, io);
    expectConfirmationError(() => confirmationAttempt(fixture, io));

    const first = firstAttempt.authorize();
    const repeated = await firstAttempt.authorize();

    expect(repeated).toEqual({ status: "precondition-failed" });
    expect(presentPlan).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();

    gate.resolve("presented");
    const approved = await first;
    expect(approved.status).toBe("approved");
    expect(confirm).toHaveBeenCalledOnce();
    if (approved.status === "approved") {
      fixture.execution.discard(approved.grant);
    }
    expect(await firstAttempt.authorize()).toEqual({
      status: "precondition-failed",
    });
  });

  it("explicitly discards an abandoned attempt before any output", async () => {
    const fixture = await setupFixture();
    const io = interaction();
    const attempt = confirmationAttempt(fixture, io);

    expect(attempt.discard()).toEqual({ status: "discarded" });
    expect(attempt.discard()).toEqual({
      status: "precondition-failed",
    });
    expect(await attempt.authorize()).toEqual({
      status: "precondition-failed",
    });
    expect(io.presentPlan).not.toHaveBeenCalled();
    expect(io.confirm).not.toHaveBeenCalled();
    expectSidecarReleased(fixture);
  });

  it("discards safely while presentation is pending and never prompts", async () => {
    const fixture = await setupFixture();
    const gate = deferred<SetupPlanPresentationResult>();
    const presentPlan = vi.fn(async () => gate.promise);
    const confirm = vi.fn(async () => "confirmed" as const);
    const ports = createSetupInteractiveSessionPorts(
      presentPlan,
      confirm,
    );
    const attempt = createSetupConfirmationAttempt(
      fixture.plan,
      fixture.sidecar,
      fixture.approval,
      fixture.execution,
      "interactive",
      ports.presenter,
      ports.confirmation,
    );
    const pending = attempt.authorize();

    expect(presentPlan).toHaveBeenCalledOnce();
    expect(attempt.discard()).toEqual({ status: "discarded" });
    gate.resolve("presented");

    expect(await pending).toEqual({ status: "precondition-failed" });
    expect(confirm).not.toHaveBeenCalled();
    expect(attempt.discard()).toEqual({
      status: "precondition-failed",
    });
  });

  it("releases a second claimed sidecar when the plan was already attempted", async () => {
    const fixture = await setupFixture();
    expect(
      await confirmationAttempt(
        fixture,
        interaction({ decision: "declined" }),
      ).authorize(),
    ).toEqual({ status: "cancelled", reason: "declined" });

    const secondSidecar = fixture.execution.bind(
      fixture.plan,
      fixture.credential,
      fixture.projection,
      fixture.execution.registerObservation(privateEvidence()),
    );
    const io = interaction();
    const secondAttempt = createSetupConfirmationAttempt(
      fixture.plan,
      secondSidecar,
      fixture.approval,
      fixture.execution,
      "assume-yes",
      io.inputFreePresenter,
      null,
    );
    expect(await secondAttempt.authorize()).toEqual({
      status: "precondition-failed",
    });

    const thirdSidecar = fixture.execution.bind(
      fixture.plan,
      fixture.credential,
      fixture.projection,
      fixture.execution.registerObservation(privateEvidence()),
    );
    expect(fixture.execution.discard(thirdSidecar)).toEqual({
      status: "discarded",
    });
  });

  it("allows at most one approval identity for a prepared plan", async () => {
    const fixture = await setupFixture();
    const result = await confirmationAttempt(
      fixture,
      interaction(),
    ).authorize();

    expect(result.status).toBe("approved");
    expect(() =>
      mintSetupApproval(fixture.approval, {
        plan: fixture.plan,
        source: "assume-yes",
      })
    ).toThrow("The setup approval could not be created safely.");
    if (result.status === "approved") {
      fixture.execution.discard(result.grant);
    }
  });

  it("fails closed when approval was already issued", async () => {
    const approvedFixture = await setupFixture();
    const reservedApproval = mintSetupApproval(approvedFixture.approval, {
      plan: approvedFixture.plan,
      source: "interactive",
    });
    const approvalResult = await confirmationAttempt(
      approvedFixture,
      interaction(),
    ).authorize();
    expect(approvalResult).toEqual({ status: "precondition-failed" });
    expectSidecarReleased(approvedFixture);
    expect(
      approvedFixture.approval.consume({
        approval: reservedApproval,
        plan: approvedFixture.plan,
      }),
    ).toEqual({ status: "approved", source: "interactive" });

  });

  it("atomically claims the sidecar before deferred presentation", async () => {
    const fixture = await setupFixture();
    const gate = deferred<SetupPlanPresentationResult>();
    const presentPlan = vi.fn(async () => gate.promise);
    const confirm = vi.fn(async () => "confirmed" as const);
    const io = createSetupInteractiveSessionPorts(
      presentPlan,
      confirm,
    );
    const attempt = confirmationAttempt(fixture, io);

    expect(fixture.execution.discard(fixture.sidecar)).toEqual({
      status: "precondition-failed",
    });
    const pending = attempt.authorize();
    expect(presentPlan).toHaveBeenCalledOnce();
    expect(fixture.execution.discard(fixture.sidecar)).toEqual({
      status: "precondition-failed",
    });
    expect(confirm).not.toHaveBeenCalled();

    gate.resolve("presented");
    const result = await pending;
    expect(result.status).toBe("approved");
    if (result.status === "approved") {
      expect(fixture.execution.discard(result.grant)).toEqual({
        status: "discarded",
      });
    }
  });

  it("rejects foreign, cloned, and forged identities before interaction", async () => {
    const io = interaction();
    const forgedSidecar = Object.freeze(
      Object.create(null),
    ) as SetupExecutionSidecarIdentity;

    {
      const fixture = await setupFixture();
      const clonedPlan = structuredClone(
        fixture.plan,
      ) as SetupPreparedPlan<SetupApplyPlan>;
      expectConfirmationError(() =>
        createSetupConfirmationAttempt(
          clonedPlan,
          fixture.sidecar,
          fixture.approval,
          fixture.execution,
          "interactive",
          io.presenter,
          io.confirmation,
        )
      );
      expectSidecarReleased(fixture);
    }

    {
      const first = await setupFixture();
      const second = await setupFixture();
      expectConfirmationError(() =>
        createSetupConfirmationAttempt(
          second.plan,
          first.sidecar,
          first.approval,
          first.execution,
          "interactive",
          io.presenter,
          io.confirmation,
        )
      );
      expectSidecarReleased(first);
      expect(second.execution.discard(second.sidecar)).toEqual({
        status: "discarded",
      });
    }

    {
      const first = await setupFixture();
      const second = await setupFixture();
      expectConfirmationError(() =>
        createSetupConfirmationAttempt(
          first.plan,
          second.sidecar,
          first.approval,
          first.execution,
          "interactive",
          io.presenter,
          io.confirmation,
        )
      );
      expect(first.execution.discard(first.sidecar)).toEqual({
        status: "discarded",
      });
      expect(second.execution.discard(second.sidecar)).toEqual({
        status: "discarded",
      });
    }

    {
      const fixture = await setupFixture();
      expectConfirmationError(() =>
        createSetupConfirmationAttempt(
          fixture.plan,
          forgedSidecar,
          fixture.approval,
          fixture.execution,
          "interactive",
          io.presenter,
          io.confirmation,
        )
      );
      expect(fixture.execution.discard(fixture.sidecar)).toEqual({
        status: "discarded",
      });
    }

    {
      const first = await setupFixture();
      const second = await setupFixture();
      expectConfirmationError(() =>
        createSetupConfirmationAttempt(
          first.plan,
          first.sidecar,
          second.approval,
          first.execution,
          "interactive",
          io.presenter,
          io.confirmation,
        )
      );
      expect(first.execution.discard(first.sidecar)).toEqual({
        status: "discarded",
      });
      expect(second.execution.discard(second.sidecar)).toEqual({
        status: "discarded",
      });
    }

    {
      const first = await setupFixture();
      const second = await setupFixture();
      expectConfirmationError(() =>
        createSetupConfirmationAttempt(
          first.plan,
          first.sidecar,
          first.approval,
          second.execution,
          "interactive",
          io.presenter,
          io.confirmation,
        )
      );
      expect(first.execution.discard(first.sidecar)).toEqual({
        status: "discarded",
      });
      expect(second.execution.discard(second.sidecar)).toEqual({
        status: "discarded",
      });
    }

    expect(io.presentPlan).not.toHaveBeenCalled();
    expect(io.confirm).not.toHaveBeenCalled();
  });

  it("rejects proxied plan, sidecar, approval, and execution identities without traps", async () => {
    const io = interaction();
    let traps = 0;
    const handler: ProxyHandler<object> = {
      get() {
        traps += 1;
        throw new Error("confirmation identities must not be read");
      },
      getOwnPropertyDescriptor() {
        traps += 1;
        throw new Error("confirmation identities must not be inspected");
      },
      ownKeys() {
        traps += 1;
        throw new Error("confirmation identities must not be inspected");
      },
    };

    {
      const fixture = await setupFixture();
      const planProxy = new Proxy(
        fixture.plan,
        handler,
      ) as SetupPreparedPlan<SetupApplyPlan>;
      expectConfirmationError(() =>
        createSetupConfirmationAttempt(
          planProxy,
          fixture.sidecar,
          fixture.approval,
          fixture.execution,
          "interactive",
          io.presenter,
          io.confirmation,
        )
      );
      expectSidecarReleased(fixture);
    }

    {
      const fixture = await setupFixture();
      const sidecarProxy = new Proxy(
        fixture.sidecar,
        handler,
      ) as SetupExecutionSidecarIdentity;
      expectConfirmationError(() =>
        createSetupConfirmationAttempt(
          fixture.plan,
          sidecarProxy,
          fixture.approval,
          fixture.execution,
          "interactive",
          io.presenter,
          io.confirmation,
        )
      );
      expect(fixture.execution.discard(fixture.sidecar)).toEqual({
        status: "discarded",
      });
    }

    {
      const fixture = await setupFixture();
      const approvalProxy = new Proxy(
        fixture.approval,
        handler,
      ) as SetupApprovalAuthority;
      expectConfirmationError(() =>
        createSetupConfirmationAttempt(
          fixture.plan,
          fixture.sidecar,
          approvalProxy,
          fixture.execution,
          "interactive",
          io.presenter,
          io.confirmation,
        )
      );
      expect(fixture.execution.discard(fixture.sidecar)).toEqual({
        status: "discarded",
      });
    }

    {
      const fixture = await setupFixture();
      const executionProxy = new Proxy(
        fixture.execution,
        handler,
      ) as SetupExecutionAuthority;
      expectConfirmationError(() =>
        createSetupConfirmationAttempt(
          fixture.plan,
          fixture.sidecar,
          fixture.approval,
          executionProxy,
          "interactive",
          io.presenter,
          io.confirmation,
        )
      );
      expect(fixture.execution.discard(fixture.sidecar)).toEqual({
        status: "discarded",
      });
    }

    expect(traps).toBe(0);
    expect(io.presentPlan).not.toHaveBeenCalled();
    expect(io.confirm).not.toHaveBeenCalled();
  });

  it("never exposes private evidence through rendering, results, or serialization", async () => {
    const fixture = await setupFixture();
    const io = interaction();
    const attempt = confirmationAttempt(fixture, io);
    const result = await attempt.authorize();
    const serialized = JSON.stringify({
      attempt,
      result,
      presentation: io.presentations,
    });

    expect(serialized).not.toContain(RAW_KEY_CANARY);
    expect(serialized).not.toContain(REVISION_CANARY);
    expect(serialized).not.toContain(ADAPTER_ERROR_CANARY);
    expect(io.presentations.join("\n")).not.toContain(RAW_KEY_CANARY);
    expect(io.presentations.join("\n")).not.toContain(REVISION_CANARY);
    expect(serialized).toContain(
      '"result":{"status":"approved","source":"interactive"}',
    );
    expect(serialized).not.toContain("grant");
    if (result.status === "approved") {
      fixture.execution.discard(result.grant);
    }
  });
});
