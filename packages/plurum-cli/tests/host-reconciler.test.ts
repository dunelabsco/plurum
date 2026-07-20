import { describe, expect, it } from "vitest";

import type {
  DesiredHostConfiguration,
  HostAction,
  HostAdapterMap,
  HostConfiguration,
  HostId,
  HostInspection,
  HostMutationAdapter,
  HostMutationSupport,
  ReconciliationPlan,
} from "../src/hosts/contracts.js";
import { HostError } from "../src/hosts/errors.js";
import {
  serializeReconciliationJournalDocumentBytes,
  validateReconciliationJournalDocument,
} from "../src/hosts/journal-codec.js";
import type {
  ReconciliationActionStage,
  ReconciliationHostStage,
  ReconciliationJournalLease,
  ReconciliationJournalRevisionSnapshot,
  ReconciliationJournalStoreAdapter,
  ReconciliationJournalV1,
  ReconciliationOperationStage,
} from "../src/hosts/journal-contracts.js";
import { createReconciliationPlan } from "../src/hosts/planner.js";
import {
  acquireAndReconcileHostPlan,
  reconcileHostPlan,
  type HostReconciliationOptions,
} from "../src/hosts/reconciler.js";

const OPERATION_ID = "ca908d9f-d901-4dac-b396-7f84377adfc8";
const RESTART_OPERATION_ID = "7c786a2d-98d6-4944-a8de-c6da2d06947b";
const CREATED_AT = "2026-07-20T12:00:00.000Z";
const RESTART_CREATED_AT = "2026-07-20T12:05:00.000Z";
const LEASE_NONCE = "5b4f52d6-15fe-467f-8f76-a47e16c2250e";
const OPTIONS: HostReconciliationOptions = Object.freeze({
  excludedProjectDirectory: "/isolated/project",
});
const FULL_SUPPORT: HostMutationSupport = Object.freeze({
  addMarketplace: true,
  removeMarketplace: true,
  installPlugin: true,
  removePlugin: true,
  updatePlugin: true,
  restorePlugin: true,
  enablePlugin: true,
  disablePlugin: true,
});

function cloneConfiguration(
  configuration: HostConfiguration,
): HostConfiguration {
  return structuredClone(configuration);
}

function sameConfiguration(
  left: HostConfiguration,
  right: HostConfiguration,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function desired(host: HostId): DesiredHostConfiguration {
  return {
    host,
    minimumHostVersion: "1.2.0",
    marketplace: {
      name: "plurum",
      source: "dunelabsco/plurum",
    },
    plugin: {
      name: "plurum",
      source: "plurum@plurum",
      version: "1.4.0",
      compatibleMinimum: "1.4.0",
      compatibleMaximumExclusive: "2.0.0",
    },
    mcp: {
      name: "plurum",
      endpoint: "https://mcp.plurum.ai/mcp",
    },
  };
}

function executable(host: HostId) {
  const path =
    host === "claude-code"
      ? "/trusted/bin/claude"
      : "/trusted/bin/codex";
  return {
    sourcePath: path,
    resolvedPath: path,
    revision: `${host}-executable-revision`,
    chain: [
      {
        path,
        kind: "binary" as const,
        owner: "current-user" as const,
        access: "not-broadly-writable" as const,
        binding: "canonical" as const,
        link: "direct" as const,
        revision: `${host}-chain-revision`,
      },
    ],
    launch: {
      executable: path,
      argumentPrefix: [] as readonly string[],
      shell: false as const,
    },
  };
}

function absentConfiguration(): HostConfiguration {
  return {
    marketplace: { status: "absent" },
    plugin: { status: "absent" },
    pluginMcp: { status: "absent" },
    directMcp: { status: "absent" },
  };
}

function installedConfiguration(
  version = "1.4.0",
): HostConfiguration {
  return {
    marketplace: {
      status: "present",
      value: {
        name: "plurum",
        source: "dunelabsco/plurum",
      },
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

function availableInspection(
  host: HostId,
  configuration: HostConfiguration,
): Extract<HostInspection, { status: "available" }> {
  return {
    host,
    status: "available",
    executable: executable(host),
    version: "2.1.0",
    state: {
      revision: `${host}-state-revision`,
      configuration: cloneConfiguration(configuration),
    },
    mutationSupport: FULL_SUPPORT,
  };
}

function planFor(
  configurations: Readonly<Partial<Record<HostId, HostConfiguration>>>,
  operationId = OPERATION_ID,
  createdAt = CREATED_AT,
): ReconciliationPlan {
  const hosts = (["claude-code", "codex"] as const).filter(
    (host) => configurations[host] !== undefined,
  );
  return createReconciliationPlan({
    operationId,
    createdAt,
    inspections: hosts.map((host) =>
      availableInspection(
        host,
        configurations[host] ?? absentConfiguration(),
      ),
    ),
    desired: hosts.map((host) => desired(host)),
  });
}

function absentPlanFor(
  host: HostId,
  operationId = RESTART_OPERATION_ID,
  createdAt = RESTART_CREATED_AT,
): ReconciliationPlan {
  return createReconciliationPlan({
    operationId,
    createdAt,
    inspections: [{ host, status: "absent" }],
    desired: [desired(host)],
  });
}

interface HostFakeOptions {
  readonly executableRevision?: string;
  readonly stateRevision?: string;
  readonly failApplyAction?: string;
  readonly preconditionRaceApplyAction?: string;
  readonly throwAfterApplyAction?: string;
  readonly reuseBeforeRevisionApplyAction?: string;
  readonly driftOnRollbackAction?: string;
}

interface HostFake {
  readonly adapter: HostMutationAdapter;
  readonly control: Readonly<{
    configuration(): HostConfiguration;
    revision(): string;
    inspections(): number;
    applied(): readonly string[];
    rolledBack(): readonly string[];
  }>;
}

function hostFake(
  host: HostId,
  initial: HostConfiguration,
  options: HostFakeOptions = {},
): HostFake {
  let configuration = cloneConfiguration(initial);
  let revision =
    options.stateRevision ?? `${host}-state-revision`;
  let revisionCounter = 0;
  let inspectionCalls = 0;
  const applied: string[] = [];
  const rolledBack: string[] = [];

  function advance(next: HostConfiguration): string {
    configuration = cloneConfiguration(next);
    revisionCounter += 1;
    revision = `${host}-mutated-${revisionCounter}`;
    return revision;
  }

  const adapter = Object.freeze<HostMutationAdapter>({
    async inspect(request) {
      inspectionCalls += 1;
      expect(request).toEqual({
        host,
        scope: "user",
        excludedProjectDirectory: "/isolated/project",
      });
      return {
        host,
        status: "available",
        executable: {
          ...executable(host),
          revision:
            options.executableRevision ??
            `${host}-executable-revision`,
        },
        version: "2.1.0",
        state: {
          revision,
          configuration: cloneConfiguration(configuration),
        },
        mutationSupport: FULL_SUPPORT,
      };
    },
    async apply(request) {
      expect(request.host).toBe(host);
      expect(request.executableRevision).toBe(
        `${host}-executable-revision`,
      );
      expect(request.expectedBeforeRevision).toBe(revision);
      expect(sameConfiguration(configuration, request.expectedBefore)).toBe(
        true,
      );
      applied.push(request.action.id);
      if (
        options.preconditionRaceApplyAction === request.action.id
      ) {
        advance(request.action.after);
        return Object.freeze({
          status: "precondition-failed" as const,
        });
      }
      if (options.failApplyAction === request.action.id) {
        return Object.freeze({ status: "failed" as const });
      }
      const changedRevision = advance(request.action.after);
      if (options.throwAfterApplyAction === request.action.id) {
        throw new Error("simulated adapter interruption");
      }
      return Object.freeze({
        status: "changed" as const,
        stateRevision:
          options.reuseBeforeRevisionApplyAction === request.action.id
            ? request.expectedBeforeRevision
            : changedRevision,
      });
    },
    async rollback(request) {
      expect(request.host).toBe(host);
      expect(request.executableRevision).toBe(
        `${host}-executable-revision`,
      );
      expect(request.expectedAfterRevision).toBe(revision);
      expect(sameConfiguration(configuration, request.expectedAfter)).toBe(
        true,
      );
      rolledBack.push(request.action.id);
      if (options.driftOnRollbackAction === request.action.id) {
        advance({
          ...request.action.after,
          directMcp: {
            status: "present",
            value: {
              name: "plurum",
              endpoint: "https://drift.invalid/mcp",
            },
          },
        });
        return Object.freeze({ status: "failed" as const });
      }
      const changedRevision = advance(request.action.before);
      return Object.freeze({
        status: "changed" as const,
        stateRevision: changedRevision,
      });
    },
  });

  return Object.freeze({
    adapter,
    control: Object.freeze({
      configuration: () => cloneConfiguration(configuration),
      revision: () => revision,
      inspections: () => inspectionCalls,
      applied: () => Object.freeze([...applied]),
      rolledBack: () => Object.freeze([...rolledBack]),
    }),
  });
}

interface JournalLeaseOptions {
  readonly initialBytes?: Uint8Array;
  readonly replaceConflictAt?: number;
  readonly loseAtRenew?: number;
}

interface JournalFake {
  readonly lease: ReconciliationJournalLease;
  readonly control: Readonly<{
    hasJournal(): boolean;
    bytes(): Uint8Array | undefined;
    writes(): readonly string[];
    replaceCalls(): number;
    removeCalls(): number;
    releaseCalls(): number;
    abandonCalls(): number;
  }>;
}

function revisionToken(
  revision: number,
): ReconciliationJournalRevisionSnapshot {
  return Object.freeze({ revision }) as unknown as
    ReconciliationJournalRevisionSnapshot;
}

function journalFake(
  options: JournalLeaseOptions = {},
): JournalFake {
  let active = true;
  let bytes =
    options.initialBytes === undefined
      ? undefined
      : Uint8Array.prototype.slice.call(options.initialBytes);
  let revision = bytes === undefined ? 0 : 1;
  let renewCalls = 0;
  let replaceCalls = 0;
  let removeCalls = 0;
  let releaseCalls = 0;
  let abandonCalls = 0;
  const writes: string[] = [];

  function requireActive(): void {
    if (!active) {
      throw new Error("inactive in-memory journal lease");
    }
  }

  function matches(
    candidate: ReconciliationJournalRevisionSnapshot,
  ): boolean {
    return (
      (
        candidate as unknown as {
          readonly revision?: unknown;
        }
      ).revision === revision
    );
  }

  const lease = Object.freeze<ReconciliationJournalLease>({
    async renew() {
      requireActive();
      renewCalls += 1;
      return Object.freeze({
        status:
          renewCalls === options.loseAtRenew ? "lost" : "held",
      } as const);
    },
    async observe() {
      requireActive();
      const snapshot = revisionToken(revision);
      return bytes === undefined
        ? Object.freeze({
            status: "missing" as const,
            revision: snapshot,
          })
        : Object.freeze({
            status: "present" as const,
            revision: snapshot,
            bytes: Uint8Array.prototype.slice.call(bytes),
          });
    },
    async replace(request) {
      requireActive();
      replaceCalls += 1;
      if (
        replaceCalls === options.replaceConflictAt ||
        !matches(request.expected)
      ) {
        return Object.freeze({ status: "conflict" as const });
      }
      const copied = Uint8Array.prototype.slice.call(request.bytes);
      writes.push(new TextDecoder().decode(copied));
      bytes = copied;
      revision += 1;
      return Object.freeze({
        status: "replaced" as const,
        revision: revisionToken(revision),
      });
    },
    async remove(request) {
      requireActive();
      removeCalls += 1;
      if (bytes === undefined || !matches(request.expected)) {
        return Object.freeze({ status: "conflict" as const });
      }
      bytes.fill(0);
      bytes = undefined;
      revision += 1;
      return Object.freeze({ status: "removed" as const });
    },
    async release() {
      requireActive();
      releaseCalls += 1;
      active = false;
    },
    async abandon() {
      requireActive();
      abandonCalls += 1;
      active = false;
    },
  });

  return Object.freeze({
    lease,
    control: Object.freeze({
      hasJournal: () => bytes !== undefined,
      bytes: () =>
        bytes === undefined
          ? undefined
          : Uint8Array.prototype.slice.call(bytes),
      writes: () => Object.freeze([...writes]),
      replaceCalls: () => replaceCalls,
      removeCalls: () => removeCalls,
      releaseCalls: () => releaseCalls,
      abandonCalls: () => abandonCalls,
    }),
  });
}

function adapters(
  claude: HostFake,
  codex: HostFake = hostFake("codex", installedConfiguration()),
): HostAdapterMap<HostMutationAdapter> {
  return Object.freeze({
    "claude-code": claude.adapter,
    codex: codex.adapter,
  });
}

function recoveryJournal(
  plan: ReconciliationPlan,
  options: Readonly<{
    operationStage: ReconciliationOperationStage;
    hostStage: ReconciliationHostStage;
    actionStages: readonly ReconciliationActionStage[];
    ownedStateRevision?: string | null;
    hostOverrides?: Readonly<
      Partial<
        Record<
          HostId,
          Readonly<{
            hostStage: ReconciliationHostStage;
            actionStages: readonly ReconciliationActionStage[];
            ownedStateRevision: string | null;
          }>
        >
      >
    >;
  }>,
): ReconciliationJournalV1 {
  const actionable = plan.hosts.filter(
    (host) => host.actions.length > 0,
  );
  return validateReconciliationJournalDocument({
    schema_version: 1,
    kind: "host-reconciliation",
    operation_id: plan.operationId,
    created_at: plan.createdAt,
    updated_at: plan.createdAt,
    stage: options.operationStage,
    hosts: actionable.map((host) => {
      const override = options.hostOverrides?.[host.host];
      const hostStage = override?.hostStage ?? options.hostStage;
      const actionStages =
        override?.actionStages ?? options.actionStages;
      const ownedStateRevision =
        override === undefined
          ? (options.ownedStateRevision ?? null)
          : override.ownedStateRevision;
      return {
        host: host.host,
        stage: hostStage,
        executable_revision: host.executable?.revision,
        baseline_revision: host.baseline?.revision,
        owned_state_revision: ownedStateRevision,
        actions: host.actions.map((action, index) => ({
          action_id: action.id,
          kind: action.kind,
          stage: actionStages[index] ?? "pending",
          before: action.before,
          after: action.after,
          rollback: action.rollback,
        })),
      };
    }),
  });
}

function journalBytes(journal: ReconciliationJournalV1): Uint8Array {
  return serializeReconciliationJournalDocumentBytes(journal);
}

async function expectHostError(
  operation: Promise<unknown>,
  code:
    | "invalid_reconciliation_plan"
    | "invalid_reconciliation_journal"
    | "reconciliation_busy"
    | "reconciliation_conflict"
    | "reconciliation_failed",
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(HostError);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain("/isolated/project");
    expect(String(error)).not.toContain("plrm_live_");
    return;
  }
  throw new Error("host reconciliation unexpectedly succeeded");
}

describe("journaled host reconciliation", () => {
  it("returns an exact no-op without creating a journal or inspecting a host", async () => {
    const plan = planFor({
      "claude-code": installedConfiguration(),
      codex: installedConfiguration(),
    });
    const claude = hostFake("claude-code", installedConfiguration());
    const codex = hostFake("codex", installedConfiguration());
    const journal = journalFake();

    await expect(
      reconcileHostPlan(
        plan,
        adapters(claude, codex),
        journal.lease,
        OPTIONS,
      ),
    ).resolves.toEqual({
      status: "no-op",
      committedHosts: [],
    });

    expect(journal.control.replaceCalls()).toBe(0);
    expect(journal.control.removeCalls()).toBe(0);
    expect(claude.control.inspections()).toBe(0);
    expect(codex.control.inspections()).toBe(0);
    expect(journal.control.releaseCalls()).toBe(1);
  });

  it("maps an active protected journal lease to a stable busy result", async () => {
    const plan = planFor({
      "claude-code": installedConfiguration(),
    });
    let receivedNonce: string | undefined;
    const store: ReconciliationJournalStoreAdapter = Object.freeze({
      async acquire(
        request: Parameters<
          ReconciliationJournalStoreAdapter["acquire"]
        >[0],
      ) {
        receivedNonce = request.nonce;
        return Object.freeze({ status: "busy" as const });
      },
    });

    await expectHostError(
      acquireAndReconcileHostPlan(
        plan,
        adapters(hostFake("claude-code", installedConfiguration())),
        store,
        LEASE_NONCE,
        OPTIONS,
      ),
      "reconciliation_busy",
    );
    expect(receivedNonce).toBe(LEASE_NONCE);
  });

  it("acquires one protected lease and releases it after reconciliation", async () => {
    const plan = planFor({
      "claude-code": installedConfiguration(),
    });
    const journal = journalFake();
    let acquireCalls = 0;
    const store: ReconciliationJournalStoreAdapter = Object.freeze({
      async acquire() {
        acquireCalls += 1;
        return Object.freeze({
          status: "acquired" as const,
          priorLease: "absent" as const,
          lease: journal.lease,
        });
      },
    });

    await expect(
      acquireAndReconcileHostPlan(
        plan,
        adapters(hostFake("claude-code", installedConfiguration())),
        store,
        LEASE_NONCE,
        OPTIONS,
      ),
    ).resolves.toEqual({ status: "no-op", committedHosts: [] });
    expect(acquireCalls).toBe(1);
    expect(journal.control.releaseCalls()).toBe(1);
  });

  it("releases an acquired lease when the supplied plan is invalid", async () => {
    const valid = planFor({
      "claude-code": installedConfiguration(),
    });
    const invalid = {
      ...valid,
      hosts: [...valid.hosts],
    } as ReconciliationPlan;
    const journal = journalFake();

    await expectHostError(
      reconcileHostPlan(
        invalid,
        adapters(hostFake("claude-code", installedConfiguration())),
        journal.lease,
        OPTIONS,
      ),
      "invalid_reconciliation_plan",
    );
    expect(journal.control.releaseCalls()).toBe(1);
    expect(journal.control.abandonCalls()).toBe(0);
  });

  it("durably records intent, apply, verification, and commit before removal", async () => {
    const baseline = installedConfiguration("1.2.0");
    const plan = planFor({ "claude-code": baseline });
    const claude = hostFake("claude-code", baseline);
    const journal = journalFake();

    await expect(
      reconcileHostPlan(
        plan,
        adapters(claude),
        journal.lease,
        OPTIONS,
      ),
    ).resolves.toEqual({
      status: "complete",
      committedHosts: ["claude-code"],
    });

    expect(claude.control.applied()).toEqual([
      "claude-code:01:update-plugin",
    ]);
    expect(claude.control.rolledBack()).toEqual([]);
    expect(claude.control.configuration()).toEqual(
      installedConfiguration(),
    );
    expect(journal.control.hasJournal()).toBe(false);
    const writes = journal.control.writes().join("\n");
    expect(writes).toContain('"stage": "apply-started"');
    expect(writes).toContain('"stage": "applied"');
    expect(writes).toContain('"stage": "verified"');
    expect(writes).toContain('"stage": "committed"');
    expect(writes).not.toContain("/isolated/project");
    expect(writes).not.toContain("/trusted/bin");
    expect(writes).not.toContain("output");
    expect(writes).not.toContain("environment");
  });

  it("keeps the first host committed when the second host fails and restores only the second", async () => {
    const baseline = absentConfiguration();
    const plan = planFor({
      "claude-code": baseline,
      codex: baseline,
    });
    const claude = hostFake("claude-code", baseline);
    const codexPlan = plan.hosts.find((host) => host.host === "codex");
    const codexFirst = codexPlan?.actions[0];
    const codexSecond = codexPlan?.actions[1];
    if (codexFirst === undefined || codexSecond === undefined) {
      throw new Error("expected two Codex actions");
    }
    const codex = hostFake("codex", baseline, {
      failApplyAction: codexSecond.id,
    });
    const journal = journalFake();

    await expectHostError(
      reconcileHostPlan(
        plan,
        adapters(claude, codex),
        journal.lease,
        OPTIONS,
      ),
      "reconciliation_failed",
    );

    expect(claude.control.configuration()).toEqual(
      installedConfiguration(),
    );
    expect(claude.control.rolledBack()).toEqual([]);
    expect(codex.control.configuration()).toEqual(baseline);
    expect(codex.control.applied()).toEqual([
      codexFirst.id,
      codexSecond.id,
    ]);
    expect(codex.control.rolledBack()).toEqual([codexFirst.id]);
    expect(journal.control.hasJournal()).toBe(false);
  });

  it("preserves concurrent exact-state creation after a precondition failure", async () => {
    const baseline = absentConfiguration();
    const plan = planFor({ "claude-code": baseline });
    const action = plan.hosts[0]?.actions[0];
    if (action === undefined) {
      throw new Error("expected a marketplace action");
    }
    const claude = hostFake("claude-code", baseline, {
      preconditionRaceApplyAction: action.id,
    });
    const journal = journalFake();

    await expect(
      reconcileHostPlan(
        plan,
        adapters(claude),
        journal.lease,
        OPTIONS,
      ),
    ).resolves.toEqual({
      status: "recovered",
      committedHosts: [],
      replanRequired: true,
    });

    expect(claude.control.configuration()).toEqual(action.after);
    expect(claude.control.applied()).toEqual([action.id]);
    expect(claude.control.rolledBack()).toEqual([]);
    expect(journal.control.hasJournal()).toBe(false);
  });

  it("rejects a changed receipt that reuses the pre-mutation revision", async () => {
    const baseline = installedConfiguration("1.2.0");
    const plan = planFor({ "claude-code": baseline });
    const action = plan.hosts[0]?.actions[0];
    if (action === undefined) {
      throw new Error("expected one update action");
    }
    const claude = hostFake("claude-code", baseline, {
      reuseBeforeRevisionApplyAction: action.id,
    });
    const journal = journalFake();

    await expect(
      reconcileHostPlan(
        plan,
        adapters(claude),
        journal.lease,
        OPTIONS,
      ),
    ).resolves.toEqual({
      status: "recovered",
      committedHosts: [],
      replanRequired: true,
    });

    expect(claude.control.configuration()).toEqual(action.after);
    expect(claude.control.rolledBack()).toEqual([]);
    expect(journal.control.hasJournal()).toBe(false);
  });

  it("preserves exact after-state when the adapter changed receipt is uncertain", async () => {
    const baseline = installedConfiguration("1.2.0");
    const plan = planFor({ "claude-code": baseline });
    const action = plan.hosts[0]?.actions[0];
    if (action === undefined) {
      throw new Error("expected one update action");
    }
    const claude = hostFake("claude-code", baseline, {
      throwAfterApplyAction: action.id,
    });
    const journal = journalFake();

    await expect(
      reconcileHostPlan(
        plan,
        adapters(claude),
        journal.lease,
        OPTIONS,
      ),
    ).resolves.toEqual({
      status: "recovered",
      committedHosts: [],
      replanRequired: true,
    });

    expect(claude.control.applied()).toEqual([action.id]);
    expect(claude.control.rolledBack()).toEqual([]);
    expect(claude.control.configuration()).toEqual(action.after);
    expect(journal.control.hasJournal()).toBe(false);
  });

  it("recovers an old operation with a fresh plan without running its pending actions", async () => {
    const baseline = absentConfiguration();
    const oldPlan = planFor({ "claude-code": baseline });
    const first = oldPlan.hosts[0]?.actions[0];
    const second = oldPlan.hosts[0]?.actions[1];
    if (first === undefined || second === undefined) {
      throw new Error("expected two historical actions");
    }
    const ownedRevision = "claude-code-owned-first-action";
    const claude = hostFake("claude-code", first.after, {
      stateRevision: ownedRevision,
    });
    const oldJournal = recoveryJournal(oldPlan, {
      operationStage: "verify",
      hostStage: "verify-complete",
      actionStages: ["verified", "pending"],
      ownedStateRevision: ownedRevision,
    });
    const bytes = journalBytes(oldJournal);
    const journal = journalFake({ initialBytes: bytes });
    bytes.fill(0);
    const freshPlan = planFor(
      { "claude-code": first.after },
      RESTART_OPERATION_ID,
      RESTART_CREATED_AT,
    );

    await expect(
      reconcileHostPlan(
        freshPlan,
        adapters(claude),
        journal.lease,
        OPTIONS,
      ),
    ).resolves.toEqual({
      status: "recovered",
      committedHosts: [],
      replanRequired: true,
    });

    expect(claude.control.applied()).toEqual([]);
    expect(claude.control.rolledBack()).toEqual([first.id]);
    expect(claude.control.rolledBack()).not.toContain(second.id);
    expect(claude.control.configuration()).toEqual(baseline);
    expect(journal.control.hasJournal()).toBe(false);
  });

  it("recovers owned history even when the fresh preflight is non-automatic", async () => {
    const baseline = installedConfiguration("1.2.0");
    const oldPlan = planFor({ "claude-code": baseline });
    const action = oldPlan.hosts[0]?.actions[0];
    if (action === undefined) {
      throw new Error("expected one historical update");
    }
    const ownedRevision = "claude-code-owned-update";
    const claude = hostFake("claude-code", action.after, {
      stateRevision: ownedRevision,
    });
    const oldJournal = recoveryJournal(oldPlan, {
      operationStage: "verify",
      hostStage: "verify-complete",
      actionStages: ["verified"],
      ownedStateRevision: ownedRevision,
    });
    const bytes = journalBytes(oldJournal);
    const journal = journalFake({ initialBytes: bytes });
    bytes.fill(0);

    await expect(
      reconcileHostPlan(
        absentPlanFor("claude-code"),
        adapters(claude),
        journal.lease,
        OPTIONS,
      ),
    ).resolves.toEqual({
      status: "recovered",
      committedHosts: [],
      replanRequired: true,
    });

    expect(claude.control.applied()).toEqual([]);
    expect(claude.control.rolledBack()).toEqual([action.id]);
    expect(claude.control.configuration()).toEqual(baseline);
    expect(journal.control.hasJournal()).toBe(false);
  });

  it("rejects a non-automatic plan when no historical journal exists", async () => {
    const claude = hostFake("claude-code", absentConfiguration());
    const journal = journalFake();

    await expectHostError(
      reconcileHostPlan(
        absentPlanFor("claude-code"),
        adapters(claude),
        journal.lease,
        OPTIONS,
      ),
      "invalid_reconciliation_plan",
    );

    expect(claude.control.inspections()).toBe(0);
    expect(claude.control.applied()).toEqual([]);
    expect(journal.control.replaceCalls()).toBe(0);
  });

  it("discards pending historical intent after external drift without inspecting or mutating", async () => {
    const oldBaseline = installedConfiguration("1.2.0");
    const oldPlan = planFor({ "claude-code": oldBaseline });
    const pending = recoveryJournal(oldPlan, {
      operationStage: "apply",
      hostStage: "pending",
      actionStages: ["pending"],
    });
    const bytes = journalBytes(pending);
    const journal = journalFake({ initialBytes: bytes });
    bytes.fill(0);
    const externalState = installedConfiguration("1.3.0");
    const claude = hostFake("claude-code", externalState, {
      stateRevision: "claude-code-external-drift",
    });
    const freshPlan = planFor(
      { "claude-code": externalState },
      RESTART_OPERATION_ID,
      RESTART_CREATED_AT,
    );

    await expect(
      reconcileHostPlan(
        freshPlan,
        adapters(claude),
        journal.lease,
        OPTIONS,
      ),
    ).resolves.toEqual({
      status: "recovered",
      committedHosts: [],
      replanRequired: true,
    });

    expect(claude.control.inspections()).toBe(0);
    expect(claude.control.applied()).toEqual([]);
    expect(claude.control.rolledBack()).toEqual([]);
    expect(claude.control.configuration()).toEqual(externalState);
    expect(journal.control.hasJournal()).toBe(false);
  });

  it("preserves a committed host while recovering a later owned host under a fresh plan", async () => {
    const baseline = installedConfiguration("1.2.0");
    const oldPlan = planFor({
      "claude-code": baseline,
      codex: baseline,
    });
    const claudeAction = oldPlan.hosts.find(
      (host) => host.host === "claude-code",
    )?.actions[0];
    const codexAction = oldPlan.hosts.find(
      (host) => host.host === "codex",
    )?.actions[0];
    if (claudeAction === undefined || codexAction === undefined) {
      throw new Error("expected one action for each host");
    }
    const oldJournal = recoveryJournal(oldPlan, {
      operationStage: "verify",
      hostStage: "pending",
      actionStages: ["pending"],
      hostOverrides: {
        "claude-code": {
          hostStage: "committed",
          actionStages: ["committed"],
          ownedStateRevision: "claude-code-original-owned-state",
        },
        codex: {
          hostStage: "verify-complete",
          actionStages: ["verified"],
          ownedStateRevision: "codex-owned-update",
        },
      },
    });
    const bytes = journalBytes(oldJournal);
    const journal = journalFake({ initialBytes: bytes });
    bytes.fill(0);
    const claude = hostFake("claude-code", claudeAction.after, {
      stateRevision: "claude-code-benign-state-rewrite",
    });
    const codex = hostFake("codex", codexAction.after, {
      stateRevision: "codex-owned-update",
    });
    const freshPlan = planFor(
      {
        "claude-code": claudeAction.after,
        codex: codexAction.after,
      },
      RESTART_OPERATION_ID,
      RESTART_CREATED_AT,
    );

    await expect(
      reconcileHostPlan(
        freshPlan,
        adapters(claude, codex),
        journal.lease,
        OPTIONS,
      ),
    ).resolves.toEqual({
      status: "recovered",
      committedHosts: ["claude-code"],
      replanRequired: true,
    });

    expect(claude.control.configuration()).toEqual(claudeAction.after);
    expect(claude.control.rolledBack()).toEqual([]);
    expect(codex.control.configuration()).toEqual(baseline);
    expect(codex.control.rolledBack()).toEqual([codexAction.id]);
    expect(journal.control.hasJournal()).toBe(false);
  });

  it.each(["before", "after"] as const)(
    "recovers an apply-started intent observed in the exact %s state",
    async (position) => {
      const baseline = installedConfiguration("1.2.0");
      const plan = planFor({ "claude-code": baseline });
      const action = plan.hosts[0]?.actions[0];
      if (action === undefined) {
        throw new Error("expected one update action");
      }
      const initial =
        position === "before" ? action.before : action.after;
      const claude = hostFake("claude-code", initial, {
        stateRevision:
          position === "before"
            ? "claude-code-state-revision"
            : "claude-code-external-state-revision",
      });
      const existing = recoveryJournal(plan, {
        operationStage: "apply",
        hostStage: "apply-started",
        actionStages: ["apply-started"],
      });
      const bytes = journalBytes(existing);
      const journal = journalFake({ initialBytes: bytes });
      bytes.fill(0);

      await expect(
        reconcileHostPlan(
          plan,
          adapters(claude),
          journal.lease,
          OPTIONS,
        ),
      ).resolves.toMatchObject({
        status: position === "before" ? "complete" : "recovered",
      });

      expect(claude.control.applied()).toHaveLength(
        position === "before" ? 1 : 0,
      );
      expect(claude.control.configuration()).toEqual(action.after);
      expect(journal.control.hasJournal()).toBe(false);
    },
  );

  it.each([
    {
      name: "after the first action verified",
      operationStage: "verify",
      hostStage: "verify-complete",
      stages: ["verified", "pending"],
      state: "first-after",
      expectedApplied: ["second"],
      ownedRevision: "claude-code-owned-first",
      liveRevision: "claude-code-owned-first",
      expectedStatus: "complete",
    },
    {
      name: "after second-action intent with its before state",
      operationStage: "apply",
      hostStage: "apply-started",
      stages: ["verified", "apply-started"],
      state: "first-after",
      expectedApplied: ["second"],
      ownedRevision: "claude-code-owned-first",
      liveRevision: "claude-code-owned-first",
      expectedStatus: "complete",
    },
    {
      name: "after second-action intent with its after state",
      operationStage: "apply",
      hostStage: "apply-started",
      stages: ["verified", "apply-started"],
      state: "final",
      expectedApplied: [],
      ownedRevision: "claude-code-owned-first",
      liveRevision: "claude-code-owned-final",
      expectedStatus: "recovered",
    },
    {
      name: "after the second action applied",
      operationStage: "apply",
      hostStage: "apply-complete",
      stages: ["verified", "applied"],
      state: "final",
      expectedApplied: [],
      ownedRevision: "claude-code-owned-final",
      liveRevision: "claude-code-owned-final",
      expectedStatus: "complete",
    },
    {
      name: "after second-action verification intent",
      operationStage: "verify",
      hostStage: "verify-started",
      stages: ["verified", "verify-started"],
      state: "final",
      expectedApplied: [],
      ownedRevision: "claude-code-owned-final",
      liveRevision: "claude-code-owned-final",
      expectedStatus: "complete",
    },
    {
      name: "after every action verified",
      operationStage: "verify",
      hostStage: "verify-complete",
      stages: ["verified", "verified"],
      state: "final",
      expectedApplied: [],
      ownedRevision: "claude-code-owned-final",
      liveRevision: "claude-code-owned-final",
      expectedStatus: "complete",
    },
    {
      name: "after first-action commit intent",
      operationStage: "commit",
      hostStage: "commit-started",
      stages: ["commit-started", "verified"],
      state: "final",
      expectedApplied: [],
      ownedRevision: "claude-code-owned-final",
      liveRevision: "claude-code-owned-final",
      expectedStatus: "complete",
    },
    {
      name: "after the first action committed",
      operationStage: "commit",
      hostStage: "commit-started",
      stages: ["committed", "verified"],
      state: "final",
      expectedApplied: [],
      ownedRevision: "claude-code-owned-final",
      liveRevision: "claude-code-owned-final",
      expectedStatus: "complete",
    },
    {
      name: "after second-action commit intent",
      operationStage: "commit",
      hostStage: "commit-started",
      stages: ["committed", "commit-started"],
      state: "final",
      expectedApplied: [],
      ownedRevision: "claude-code-owned-final",
      liveRevision: "claude-code-owned-final",
      expectedStatus: "complete",
    },
    {
      name: "after every action committed but before host commit",
      operationStage: "commit",
      hostStage: "commit-started",
      stages: ["committed", "committed"],
      state: "final",
      expectedApplied: [],
      ownedRevision: "claude-code-owned-final",
      liveRevision: "claude-code-owned-final",
      expectedStatus: "complete",
    },
  ] as const)(
    "resumes a multi-action host $name without replaying completed actions",
    async (scenario) => {
      const baseline = absentConfiguration();
      const plan = planFor({ "claude-code": baseline });
      const first = plan.hosts[0]?.actions[0];
      const second = plan.hosts[0]?.actions[1];
      if (first === undefined || second === undefined) {
        throw new Error("expected two ordered actions");
      }
      const initial =
        scenario.state === "first-after"
          ? first.after
          : second.after;
      const claude = hostFake("claude-code", initial, {
        stateRevision: scenario.liveRevision,
      });
      const existing = recoveryJournal(plan, {
        operationStage: scenario.operationStage,
        hostStage: scenario.hostStage,
        actionStages: scenario.stages,
        ownedStateRevision: scenario.ownedRevision,
      });
      const bytes = journalBytes(existing);
      const journal = journalFake({ initialBytes: bytes });
      bytes.fill(0);

      await expect(
        reconcileHostPlan(
          plan,
          adapters(claude),
          journal.lease,
          OPTIONS,
        ),
      ).resolves.toMatchObject({ status: scenario.expectedStatus });

      expect(claude.control.applied()).toEqual(
        scenario.expectedApplied.length === 0
          ? []
          : [second.id],
      );
      expect(claude.control.configuration()).toEqual(second.after);
      expect(journal.control.hasJournal()).toBe(false);
    },
  );

  it("rejects a stale baseline revision before the first action and retains recovery state", async () => {
    const baseline = installedConfiguration("1.2.0");
    const plan = planFor({ "claude-code": baseline });
    const claude = hostFake("claude-code", baseline, {
      stateRevision: "stale-semantic-plan-revision",
    });
    const journal = journalFake();

    await expectHostError(
      reconcileHostPlan(
        plan,
        adapters(claude),
        journal.lease,
        OPTIONS,
      ),
      "reconciliation_conflict",
    );

    expect(claude.control.applied()).toEqual([]);
    expect(journal.control.hasJournal()).toBe(true);
    expect(journal.control.removeCalls()).toBe(0);
  });

  it.each([
    "plrm_test_NEVER_ALLOWED",
    "api_key=NEVER_ALLOWED",
    "access_token=NEVER_ALLOWED",
    "secret=NEVER_ALLOWED",
    "password=NEVER_ALLOWED",
  ])(
    "rejects secret-like observed state revision %s before mutation",
    async (stateRevision) => {
      const baseline = installedConfiguration("1.2.0");
      const plan = planFor({ "claude-code": baseline });
      const claude = hostFake("claude-code", baseline, {
        stateRevision,
      });
      const journal = journalFake();

      await expectHostError(
        reconcileHostPlan(
          plan,
          adapters(claude),
          journal.lease,
          OPTIONS,
        ),
        "reconciliation_failed",
      );

      expect(claude.control.applied()).toEqual([]);
      expect(journal.control.hasJournal()).toBe(true);
      expect(journal.control.removeCalls()).toBe(0);
    },
  );

  it("rejects an executable revision change before mutation and retains the journal", async () => {
    const baseline = installedConfiguration("1.2.0");
    const plan = planFor({ "claude-code": baseline });
    const claude = hostFake("claude-code", baseline, {
      executableRevision: "claude-code-executable-replaced",
    });
    const journal = journalFake();

    await expectHostError(
      reconcileHostPlan(
        plan,
        adapters(claude),
        journal.lease,
        OPTIONS,
      ),
      "reconciliation_conflict",
    );

    expect(claude.control.applied()).toEqual([]);
    expect(journal.control.hasJournal()).toBe(true);
    expect(journal.control.removeCalls()).toBe(0);
  });

  it("retains the journal and stops when rollback observes drift", async () => {
    const baseline = absentConfiguration();
    const plan = planFor({ "claude-code": baseline });
    const hostPlan = plan.hosts[0];
    const marketplaceAction = hostPlan?.actions[0];
    const installAction = hostPlan?.actions[1];
    if (
      marketplaceAction === undefined ||
      installAction === undefined
    ) {
      throw new Error("expected marketplace and install actions");
    }
    const claude = hostFake("claude-code", baseline, {
      failApplyAction: installAction.id,
      driftOnRollbackAction: marketplaceAction.id,
    });
    const journal = journalFake();

    await expectHostError(
      reconcileHostPlan(
        plan,
        adapters(claude),
        journal.lease,
        OPTIONS,
      ),
      "reconciliation_conflict",
    );

    expect(claude.control.applied()).toEqual([
      marketplaceAction.id,
      installAction.id,
    ]);
    expect(claude.control.rolledBack()).toEqual([
      marketplaceAction.id,
    ]);
    expect(journal.control.hasJournal()).toBe(true);
    expect(journal.control.removeCalls()).toBe(0);
  });

  it.each(["before", "after"] as const)(
    "recovers a reverse-order rollback intent observed in the exact %s state",
    async (position) => {
      const baseline = absentConfiguration();
      const plan = planFor({ "claude-code": baseline });
      const first = plan.hosts[0]?.actions[0];
      const second = plan.hosts[0]?.actions[1];
      if (first === undefined || second === undefined) {
        throw new Error("expected two ordered actions");
      }
      const initial =
        position === "before" ? first.after : first.before;
      const claude = hostFake("claude-code", initial, {
        stateRevision:
          position === "before"
            ? "claude-code-owned-after-second-rollback"
            : "claude-code-unacknowledged-final-rollback",
      });
      const existing = recoveryJournal(plan, {
        operationStage: "rollback",
        hostStage: "rollback-started",
        actionStages: ["rollback-started", "rolled-back"],
        ownedStateRevision:
          "claude-code-owned-after-second-rollback",
      });
      const bytes = journalBytes(existing);
      const journal = journalFake({ initialBytes: bytes });
      bytes.fill(0);

      const operation = reconcileHostPlan(
          plan,
          adapters(claude),
          journal.lease,
          OPTIONS,
      );
      if (position === "before") {
        await expectHostError(operation, "reconciliation_failed");
      } else {
        await expect(operation).resolves.toEqual({
          status: "recovered",
          committedHosts: [],
          replanRequired: true,
        });
      }

      expect(claude.control.applied()).toEqual([]);
      expect(claude.control.rolledBack()).toHaveLength(
        position === "before" ? 1 : 0,
      );
      expect(claude.control.configuration()).toEqual(baseline);
      expect(journal.control.hasJournal()).toBe(false);
    },
  );

  it("removes an already restored multi-action failure without replaying rollback", async () => {
    const baseline = absentConfiguration();
    const plan = planFor({ "claude-code": baseline });
    const claude = hostFake("claude-code", baseline);
    const restored = recoveryJournal(plan, {
      operationStage: "failed",
      hostStage: "rolled-back",
      actionStages: ["rolled-back", "rolled-back"],
    });
    const bytes = journalBytes(restored);
    const journal = journalFake({ initialBytes: bytes });
    bytes.fill(0);

    await expectHostError(
      reconcileHostPlan(
        plan,
        adapters(claude),
        journal.lease,
        OPTIONS,
      ),
      "reconciliation_failed",
    );

    expect(claude.control.applied()).toEqual([]);
    expect(claude.control.rolledBack()).toEqual([]);
    expect(claude.control.configuration()).toEqual(baseline);
    expect(journal.control.hasJournal()).toBe(false);
  });

  it("fails closed on the initial journal CAS conflict without host mutation", async () => {
    const baseline = installedConfiguration("1.2.0");
    const plan = planFor({ "claude-code": baseline });
    const claude = hostFake("claude-code", baseline);
    const journal = journalFake({ replaceConflictAt: 1 });

    await expectHostError(
      reconcileHostPlan(
        plan,
        adapters(claude),
        journal.lease,
        OPTIONS,
      ),
      "reconciliation_conflict",
    );

    expect(claude.control.applied()).toEqual([]);
    expect(claude.control.inspections()).toBe(0);
    expect(journal.control.removeCalls()).toBe(0);
    expect(journal.control.releaseCalls()).toBe(1);
  });

  it("retains durable intent when the applied-state journal CAS conflicts", async () => {
    const baseline = installedConfiguration("1.2.0");
    const plan = planFor({ "claude-code": baseline });
    const action = plan.hosts[0]?.actions[0];
    if (action === undefined) {
      throw new Error("expected one update action");
    }
    const claude = hostFake("claude-code", baseline);
    const journal = journalFake({ replaceConflictAt: 3 });

    await expectHostError(
      reconcileHostPlan(
        plan,
        adapters(claude),
        journal.lease,
        OPTIONS,
      ),
      "reconciliation_conflict",
    );

    expect(claude.control.applied()).toEqual([action.id]);
    expect(claude.control.configuration()).toEqual(action.after);
    expect(journal.control.hasJournal()).toBe(true);
    expect(journal.control.removeCalls()).toBe(0);
    expect(journal.control.releaseCalls()).toBe(1);
  });

  it("fresh-process recovery preserves an exact after-state whose ownership receipt lost its journal CAS", async () => {
    const baseline = installedConfiguration("1.2.0");
    const oldPlan = planFor({ "claude-code": baseline });
    const action = oldPlan.hosts[0]?.actions[0];
    if (action === undefined) {
      throw new Error("expected one update action");
    }
    const claude = hostFake("claude-code", baseline);
    const interrupted = journalFake({ replaceConflictAt: 3 });

    await expectHostError(
      reconcileHostPlan(
        oldPlan,
        adapters(claude),
        interrupted.lease,
        OPTIONS,
      ),
      "reconciliation_conflict",
    );
    const durableIntent = interrupted.control.bytes();
    if (durableIntent === undefined) {
      throw new Error("expected durable apply intent");
    }

    const restarted = journalFake({ initialBytes: durableIntent });
    durableIntent.fill(0);
    const freshPlan = planFor(
      { "claude-code": action.after },
      RESTART_OPERATION_ID,
      RESTART_CREATED_AT,
    );
    await expect(
      reconcileHostPlan(
        freshPlan,
        adapters(claude),
        restarted.lease,
        OPTIONS,
      ),
    ).resolves.toEqual({
      status: "recovered",
      committedHosts: [],
      replanRequired: true,
    });

    expect(claude.control.applied()).toEqual([action.id]);
    expect(claude.control.rolledBack()).toEqual([]);
    expect(claude.control.configuration()).toEqual(action.after);
    expect(restarted.control.hasJournal()).toBe(false);
  });

  it.each([
    { renew: 5, applied: false },
    { renew: 6, applied: true },
  ] as const)(
    "abandons on proven lease loss at renew $renew and leaves durable intent",
    async ({ renew, applied }) => {
      const baseline = installedConfiguration("1.2.0");
      const plan = planFor({ "claude-code": baseline });
      const action = plan.hosts[0]?.actions[0];
      if (action === undefined) {
        throw new Error("expected one update action");
      }
      const claude = hostFake("claude-code", baseline);
      const journal = journalFake({ loseAtRenew: renew });

      await expectHostError(
        reconcileHostPlan(
          plan,
          adapters(claude),
          journal.lease,
          OPTIONS,
        ),
        "reconciliation_failed",
      );

      expect(claude.control.applied()).toEqual(
        applied ? [action.id] : [],
      );
      expect(claude.control.configuration()).toEqual(
        applied ? action.after : action.before,
      );
      expect(journal.control.hasJournal()).toBe(true);
      expect(journal.control.abandonCalls()).toBe(1);
      expect(journal.control.releaseCalls()).toBe(0);
    },
  );

  it("rejects a corrupt existing journal without mutation or removal", async () => {
    const baseline = installedConfiguration("1.2.0");
    const plan = planFor({ "claude-code": baseline });
    const claude = hostFake("claude-code", baseline);
    const corrupt = new TextEncoder().encode(
      `{"raw_output":"${"plrm_live_"}${"X".repeat(43)}"}\n`,
    );
    const journal = journalFake({ initialBytes: corrupt });
    corrupt.fill(0);

    await expectHostError(
      reconcileHostPlan(
        plan,
        adapters(claude),
        journal.lease,
        OPTIONS,
      ),
      "invalid_reconciliation_journal",
    );

    expect(claude.control.inspections()).toBe(0);
    expect(claude.control.applied()).toEqual([]);
    expect(journal.control.hasJournal()).toBe(true);
    expect(journal.control.removeCalls()).toBe(0);
    expect(journal.control.releaseCalls()).toBe(1);
  });

  it("rejects a canonically encoded but logically inconsistent journal", async () => {
    const baseline = installedConfiguration("1.2.0");
    const plan = planFor({ "claude-code": baseline });
    const action = plan.hosts[0]?.actions[0];
    if (action === undefined) {
      throw new Error("expected one update action");
    }
    const valid = recoveryJournal(plan, {
      operationStage: "complete",
      hostStage: "committed",
      actionStages: ["committed"],
      ownedStateRevision: "claude-code-owned-state",
    });
    const inconsistent = structuredClone(valid) as unknown as {
      hosts: Array<{ actions: Array<{ stage: string }> }>;
    };
    const inconsistentAction = inconsistent.hosts[0]?.actions[0];
    if (inconsistentAction === undefined) {
      throw new Error("expected an encoded recovery action");
    }
    inconsistentAction.stage = "verified";
    const bytes = new TextEncoder().encode(
      `${JSON.stringify(inconsistent, null, 2)}\n`,
    );
    const journal = journalFake({ initialBytes: bytes });
    bytes.fill(0);
    const claude = hostFake("claude-code", action.after);

    await expectHostError(
      reconcileHostPlan(
        plan,
        adapters(claude),
        journal.lease,
        OPTIONS,
      ),
      "invalid_reconciliation_journal",
    );

    expect(claude.control.inspections()).toBe(0);
    expect(claude.control.applied()).toEqual([]);
    expect(journal.control.hasJournal()).toBe(true);
    expect(journal.control.removeCalls()).toBe(0);
  });

  it("reverifies a committed host without applying or rolling it back", async () => {
    const baseline = installedConfiguration("1.2.0");
    const plan = planFor({ "claude-code": baseline });
    const action = plan.hosts[0]?.actions[0];
    if (action === undefined) {
      throw new Error("expected one update action");
    }
    const claude = hostFake("claude-code", action.after, {
      stateRevision: "claude-code-benign-rewrite",
    });
    const complete = recoveryJournal(plan, {
      operationStage: "complete",
      hostStage: "committed",
      actionStages: ["committed"],
      ownedStateRevision: "claude-code-original-owned-state",
    });
    const bytes = journalBytes(complete);
    const journal = journalFake({ initialBytes: bytes });
    bytes.fill(0);

    await expect(
      reconcileHostPlan(
        plan,
        adapters(claude),
        journal.lease,
        OPTIONS,
      ),
    ).resolves.toMatchObject({ status: "complete" });

    expect(claude.control.applied()).toEqual([]);
    expect(claude.control.rolledBack()).toEqual([]);
    expect(claude.control.inspections()).toBeGreaterThan(0);
    expect(journal.control.hasJournal()).toBe(false);
  });
});
