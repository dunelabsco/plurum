import {
  HOST_IDS,
  type HostAction,
  type HostAdapterMap,
  type HostConfiguration,
  type HostId,
  type HostInspectionRequest,
  type HostMutationAdapter,
  type HostMutationResult,
  type HostPreflightPlan,
  type ReconciliationPlan,
} from "./contracts.js";
import { HostError } from "./errors.js";
import { copyHostConfiguration } from "./inspection.js";
import {
  parseReconciliationJournalDocumentBytes,
  serializeReconciliationJournalDocumentBytes,
  validateReconciliationJournalDocument,
  validateReconciliationJournalLeaseNonce,
  validateReconciliationOperationId,
} from "./journal-codec.js";
import {
  RECONCILIATION_JOURNAL_KIND,
  RECONCILIATION_JOURNAL_SCHEMA_VERSION,
  type ReconciliationActionStage,
  type ReconciliationHostStage,
  type ReconciliationJournalLease,
  type ReconciliationJournalRevisionSnapshot,
  type ReconciliationJournalStoreAdapter,
  type ReconciliationJournalV1,
  type ReconciliationOperationStage,
} from "./journal-contracts.js";
import {
  containsHostControlCharacter,
  containsHostSensitiveMaterial,
} from "./privacy.js";

export interface HostReconciliationOptions {
  /*
   * This path is ephemeral inspection context. It is returned only to the
   * semantic host adapter and is never copied into the recovery journal,
   * results, or errors.
   */
  readonly excludedProjectDirectory: string;
}

export type HostReconciliationResult =
  | Readonly<{
      status: "no-op";
      committedHosts: readonly [];
    }>
  | Readonly<{
      status: "complete";
      committedHosts: readonly HostId[];
    }>
  | Readonly<{
      status: "recovered";
      committedHosts: readonly HostId[];
      replanRequired: true;
    }>;

interface PreparedHost {
  readonly host: HostId;
  readonly actions: readonly HostAction[];
  readonly adapter: HostMutationAdapter;
  readonly request: HostInspectionRequest;
  readonly executableRevision: string;
  readonly baselineRevision: string;
}

interface PreparedReconciliation {
  readonly actionableHosts: readonly PreparedHost[];
  readonly initialJournal: ReconciliationJournalV1 | null;
}

interface ObservedHostState {
  readonly revision: string;
  readonly configuration: HostConfiguration;
}

interface LeaseLifecycle {
  lost: boolean;
}

interface JournalState {
  journal: ReconciliationJournalV1;
  revision: ReconciliationJournalRevisionSnapshot;
}

const LEASE_LOST = Object.freeze({ kind: "reconciliation-lease-lost" });
const RESTORED_FAILURE = Object.freeze({
  kind: "reconciliation-restored-failure",
});
const PRESERVED_UNOWNED = Object.freeze({
  kind: "reconciliation-preserved-unowned",
});
const OPAQUE_REVISION = /^[A-Za-z0-9._~:+@=-]{1,512}$/u;

function invalidPlan(): never {
  throw new HostError("invalid_reconciliation_plan");
}

function conflict(): never {
  throw new HostError("reconciliation_conflict");
}

function failed(): never {
  throw new HostError("reconciliation_failed");
}

function invalidJournal(): never {
  throw new HostError("invalid_reconciliation_journal");
}

function wipe(bytes: unknown): void {
  try {
    if (bytes instanceof Uint8Array) {
      Uint8Array.prototype.fill.call(bytes, 0);
    }
  } catch {
    // The owned buffer may already be detached.
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function isDeeplyFrozen(
  value: unknown,
  seen = new WeakSet<object>(),
): boolean {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return true;
  }
  try {
    if (!Object.isFrozen(value)) {
      return false;
    }
    seen.add(value);
    const keys = Object.keys(value);
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      return false;
    }
    for (const key of keys) {
      const child = (value as Readonly<Record<string, unknown>>)[key];
      if (!isDeeplyFrozen(child, seen)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function safeRevision(value: unknown): string {
  if (
    typeof value !== "string" ||
    !OPAQUE_REVISION.test(value) ||
    containsHostControlCharacter(value) ||
    containsHostSensitiveMaterial(value)
  ) {
    return failed();
  }
  return value;
}

function prepareAdapter(
  adapters: HostAdapterMap<HostMutationAdapter>,
  host: HostId,
): HostMutationAdapter {
  try {
    const adapter = adapters[host];
    if (
      adapter === null ||
      typeof adapter !== "object" ||
      typeof adapter.inspect !== "function" ||
      typeof adapter.apply !== "function" ||
      typeof adapter.rollback !== "function"
    ) {
      return invalidPlan();
    }
    return adapter;
  } catch {
    return invalidPlan();
  }
}

function prepareExcludedProjectDirectory(
  options: HostReconciliationOptions,
): string {
  try {
    const directory = options.excludedProjectDirectory;
    if (
      typeof directory !== "string" ||
      directory.length === 0 ||
      directory.length > 32_767 ||
      containsHostControlCharacter(directory) ||
      containsHostSensitiveMaterial(directory)
    ) {
      return invalidPlan();
    }
    return directory;
  } catch {
    return invalidPlan();
  }
}

function initialJournalFor(
  plan: ReconciliationPlan,
  actionable: readonly PreparedHost[],
): ReconciliationJournalV1 | null {
  if (actionable.length === 0) {
    return null;
  }
  try {
    return validateReconciliationJournalDocument({
      schema_version: RECONCILIATION_JOURNAL_SCHEMA_VERSION,
      kind: RECONCILIATION_JOURNAL_KIND,
      operation_id: plan.operationId,
      created_at: plan.createdAt,
      updated_at: plan.createdAt,
      stage: "apply",
      hosts: actionable.map((host) => ({
        host: host.host,
        stage: "pending",
        executable_revision: host.executableRevision,
        baseline_revision: host.baselineRevision,
        owned_state_revision: null,
        actions: host.actions.map((action) => ({
          action_id: action.id,
          kind: action.kind,
          stage: "pending",
          before: action.before,
          after: action.after,
          rollback: action.rollback,
        })),
      })),
    });
  } catch {
    return invalidPlan();
  }
}

function prepare(
  plan: ReconciliationPlan,
  adapters: HostAdapterMap<HostMutationAdapter>,
  options: HostReconciliationOptions,
): PreparedReconciliation {
  try {
    const excludedProjectDirectory =
      prepareExcludedProjectDirectory(options);
    if (
      !isDeeplyFrozen(plan) ||
      plan.schemaVersion !== 1 ||
      !Array.isArray(plan.hosts) ||
      plan.hosts.length === 0 ||
      plan.hosts.length > HOST_IDS.length
    ) {
      return invalidPlan();
    }
    validateReconciliationOperationId(plan.operationId);

    const expectedOrder = HOST_IDS.filter((host) =>
      plan.hosts.some((entry) => entry.host === host),
    );
    if (
      plan.hosts.some((host, index) => host.host !== expectedOrder[index]) ||
      new Set(plan.hosts.map((host) => host.host)).size !== plan.hosts.length
    ) {
      return invalidPlan();
    }

    const actionable: PreparedHost[] = [];
    for (const host of plan.hosts) {
      if (!host.automatic) {
        return invalidPlan();
      }
      if (host.executable === null || host.baseline === null) {
        return invalidPlan();
      }
      if (host.actions.length === 0) {
        if (
          host.classification !== "healthy" &&
          host.classification !== "healthy-newer"
        ) {
          return invalidPlan();
        }
        continue;
      }
      if (
        host.classification !== "needs-changes" ||
        !sameValue(host.baseline.configuration, host.actions[0]?.before) ||
        host.actions.some(
          (action: HostAction, index: number) =>
            action.host !== host.host ||
            (index > 0 &&
              !sameValue(host.actions[index - 1]?.after, action.before)),
        )
      ) {
        return invalidPlan();
      }
      const adapter = prepareAdapter(adapters, host.host);
      actionable.push(
        Object.freeze({
          host: host.host,
          actions: host.actions,
          adapter,
          request: Object.freeze({
            host: host.host,
            scope: "user",
            excludedProjectDirectory,
          }),
          executableRevision: safeRevision(host.executable.revision),
          baselineRevision: safeRevision(host.baseline.revision),
        }),
      );
    }

    const frozenActionable = Object.freeze(actionable);
    return Object.freeze({
      actionableHosts: frozenActionable,
      initialJournal: initialJournalFor(plan, frozenActionable),
    });
  } catch (error) {
    if (
      error instanceof HostError &&
      error.code === "invalid_reconciliation_plan"
    ) {
      throw error;
    }
    return invalidPlan();
  }
}

async function renew(
  lease: ReconciliationJournalLease,
  lifecycle: LeaseLifecycle,
): Promise<void> {
  let result;
  try {
    result = await lease.renew();
  } catch {
    return failed();
  }
  if (result?.status === "lost") {
    lifecycle.lost = true;
    throw LEASE_LOST;
  }
  if (result?.status !== "held") {
    return failed();
  }
}

async function observeJournal(
  lease: ReconciliationJournalLease,
  lifecycle: LeaseLifecycle,
): Promise<
  | Readonly<{
      status: "missing";
      revision: ReconciliationJournalRevisionSnapshot;
    }>
  | Readonly<{
      status: "present";
      revision: ReconciliationJournalRevisionSnapshot;
      journal: ReconciliationJournalV1;
    }>
> {
  await renew(lease, lifecycle);
  let observation;
  try {
    observation = await lease.observe();
  } catch {
    return failed();
  }
  if (observation?.status === "missing") {
    return Object.freeze({
      status: "missing",
      revision: observation.revision,
    });
  }
  if (observation?.status !== "present") {
    return failed();
  }

  const bytes: unknown = observation.bytes;
  try {
    if (!(bytes instanceof Uint8Array)) {
      return failed();
    }
    return Object.freeze({
      status: "present",
      revision: observation.revision,
      journal: parseReconciliationJournalDocumentBytes(bytes),
    });
  } finally {
    wipe(bytes);
  }
}

async function replaceJournal(
  lease: ReconciliationJournalLease,
  lifecycle: LeaseLifecycle,
  expected: ReconciliationJournalRevisionSnapshot,
  journal: ReconciliationJournalV1,
): Promise<ReconciliationJournalRevisionSnapshot> {
  let bytes: Uint8Array | undefined;
  try {
    bytes = serializeReconciliationJournalDocumentBytes(journal);
    await renew(lease, lifecycle);
    const result = await lease.replace(
      Object.freeze({ expected, bytes }),
    );
    if (result?.status === "conflict") {
      return conflict();
    }
    if (result?.status !== "replaced") {
      return failed();
    }
    return result.revision;
  } catch (error) {
    if (error === LEASE_LOST || error instanceof HostError) {
      throw error;
    }
    return failed();
  } finally {
    wipe(bytes);
  }
}

async function persist(
  lease: ReconciliationJournalLease,
  lifecycle: LeaseLifecycle,
  state: JournalState,
  next: ReconciliationJournalV1,
): Promise<void> {
  const revision = await replaceJournal(
    lease,
    lifecycle,
    state.revision,
    next,
  );
  state.journal = next;
  state.revision = revision;
}

async function removeJournal(
  lease: ReconciliationJournalLease,
  lifecycle: LeaseLifecycle,
  state: JournalState,
): Promise<void> {
  await renew(lease, lifecycle);
  let result;
  try {
    result = await lease.remove(
      Object.freeze({ expected: state.revision }),
    );
  } catch {
    return failed();
  }
  if (result?.status === "conflict") {
    return conflict();
  }
  if (result?.status !== "removed") {
    return failed();
  }
}

function staticJournalShape(journal: ReconciliationJournalV1): unknown {
  return {
    operation_id: journal.operation_id,
    created_at: journal.created_at,
    hosts: journal.hosts.map((host) => ({
      host: host.host,
      executable_revision: host.executable_revision,
      baseline_revision: host.baseline_revision,
      actions: host.actions.map((action) => ({
        action_id: action.action_id,
        kind: action.kind,
        before: action.before,
        after: action.after,
        rollback: action.rollback,
      })),
    })),
  };
}

function matchesExistingJournal(
  existing: ReconciliationJournalV1,
  expected: ReconciliationJournalV1 | null,
): boolean {
  return (
    expected !== null &&
    sameValue(staticJournalShape(existing), staticJournalShape(expected))
  );
}

function recoveryDisplay(kind: HostAction["kind"]): string {
  switch (kind) {
    case "add-marketplace":
      return "recover the Plurum marketplace change";
    case "install-plugin":
      return "recover the Plurum plugin installation";
    case "update-plugin":
      return "recover the Plurum plugin update";
    case "enable-plugin":
      return "recover the Plurum plugin enablement";
  }
}

function prepareHistoricalRecovery(
  journal: ReconciliationJournalV1,
  adapters: HostAdapterMap<HostMutationAdapter>,
  options: HostReconciliationOptions,
): PreparedReconciliation {
  const excludedProjectDirectory =
    prepareExcludedProjectDirectory(options);
  const hosts = journal.hosts.map((host) => {
    const adapter = prepareAdapter(adapters, host.host);
    const actions = Object.freeze(
      host.actions.map((action) =>
        Object.freeze({
          id: action.action_id,
          host: host.host,
          kind: action.kind,
          before: action.before,
          after: action.after,
          rollback: action.rollback,
          display: recoveryDisplay(action.kind),
        }),
      ),
    );
    return Object.freeze({
      host: host.host,
      actions,
      adapter,
      request: Object.freeze({
        host: host.host,
        scope: "user" as const,
        excludedProjectDirectory,
      }),
      executableRevision: safeRevision(host.executable_revision),
      baselineRevision: safeRevision(host.baseline_revision),
    });
  });
  return Object.freeze({
    actionableHosts: Object.freeze(hosts),
    initialJournal: journal,
  });
}

function evolveJournal(
  journal: ReconciliationJournalV1,
  options: Readonly<{
    operationStage?: ReconciliationOperationStage;
    host?: HostId;
    hostStage?: ReconciliationHostStage;
    actionId?: string;
    actionStage?: ReconciliationActionStage;
    ownedStateRevision?: string | null;
  }>,
): ReconciliationJournalV1 {
  try {
    return validateReconciliationJournalDocument({
      ...journal,
      stage: options.operationStage ?? journal.stage,
      hosts: journal.hosts.map((host) => {
        if (host.host !== options.host) {
          return host;
        }
        return {
          ...host,
          stage: options.hostStage ?? host.stage,
          owned_state_revision: Object.hasOwn(
            options,
            "ownedStateRevision",
          )
            ? (options.ownedStateRevision ?? null)
            : host.owned_state_revision,
          actions: host.actions.map((action) =>
            action.action_id === options.actionId
              ? {
                  ...action,
                  stage: options.actionStage ?? action.stage,
                }
              : action,
          ),
        };
      }),
    });
  } catch {
    return failed();
  }
}

function journalHost(
  state: JournalState,
  host: HostId,
): ReconciliationJournalV1["hosts"][number] {
  const found = state.journal.hosts.find((entry) => entry.host === host);
  return found ?? conflict();
}

function journalAction(
  state: JournalState,
  host: HostId,
  actionId: string,
): ReconciliationJournalV1["hosts"][number]["actions"][number] {
  const found = journalHost(state, host).actions.find(
    (entry) => entry.action_id === actionId,
  );
  return found ?? conflict();
}

function ownedStateRevision(
  state: JournalState,
  host: HostId,
): string | null {
  const revision = journalHost(state, host).owned_state_revision;
  return revision === null ? null : safeRevision(revision);
}

function expectedBeforeRevision(
  state: JournalState,
  prepared: PreparedHost,
  actionIndex: number,
): string {
  const owned = ownedStateRevision(state, prepared.host);
  if (actionIndex === 0) {
    if (owned !== null) {
      return invalidJournal();
    }
    return prepared.baselineRevision;
  }
  return owned ?? conflict();
}

async function inspectHost(
  prepared: PreparedHost,
  lease: ReconciliationJournalLease,
  lifecycle: LeaseLifecycle,
): Promise<ObservedHostState> {
  await renew(lease, lifecycle);
  let observed;
  try {
    observed = await prepared.adapter.inspect(prepared.request);
  } catch {
    return failed();
  }
  try {
    if (
      observed.host !== prepared.host ||
      observed.status === "absent" ||
      observed.status === "blocked"
    ) {
      return conflict();
    }
    if (observed.status !== "available") {
      return failed();
    }
    if (
      safeRevision(observed.executable.revision) !==
      prepared.executableRevision
    ) {
      return conflict();
    }
    return Object.freeze({
      revision: safeRevision(observed.state.revision),
      configuration: copyHostConfiguration(observed.state.configuration),
    });
  } catch (error) {
    if (error instanceof HostError) {
      if (
        error.code === "reconciliation_conflict" ||
        error.code === "reconciliation_failed"
      ) {
        throw error;
      }
      return failed();
    }
    return failed();
  }
}

function mutationResult(value: unknown): HostMutationResult | null {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !Object.hasOwn(value, "status")
    ) {
      return null;
    }
    const status = (value as { readonly status?: unknown }).status;
    if (status === "changed") {
      if (
        Object.keys(value).length !== 2 ||
        !Object.hasOwn(value, "stateRevision")
      ) {
        return null;
      }
      return Object.freeze({
        status,
        stateRevision: safeRevision(
          (value as { readonly stateRevision?: unknown }).stateRevision,
        ),
      });
    }
    if (
      (status === "precondition-failed" || status === "failed") &&
      Object.keys(value).length === 1
    ) {
      return Object.freeze({ status });
    }
    return null;
  } catch {
    return null;
  }
}

function beginRollbackJournal(
  journal: ReconciliationJournalV1,
  hostId: HostId,
): ReconciliationJournalV1 {
  const host = journal.hosts.find((entry) => entry.host === hostId);
  if (host === undefined || host.stage === "committed") {
    return conflict();
  }
  const alreadyReversing =
    host.stage === "rollback-started" ||
    host.stage === "rolled-back" ||
    host.stage === "failed" ||
    host.actions.some(
      (action) =>
        action.stage === "failed" ||
        action.stage === "rollback-started" ||
        action.stage === "rolled-back",
    );
  if (alreadyReversing) {
    return evolveJournal(journal, {
      operationStage: "rollback",
      host: hostId,
      hostStage: "rollback-started",
    });
  }

  let target = -1;
  for (let index = host.actions.length - 1; index >= 0; index -= 1) {
    if (host.actions[index]?.stage !== "pending") {
      target = index;
      break;
    }
  }
  if (target < 0) {
    return invalidJournal();
  }

  try {
    return validateReconciliationJournalDocument({
      ...journal,
      stage: "rollback",
      hosts: journal.hosts.map((candidate) =>
        candidate.host !== hostId
          ? candidate
          : {
              ...candidate,
              stage: "rollback-started",
              actions: candidate.actions.map((action, index) => ({
                ...action,
                stage:
                  index < target
                    ? "verified"
                    : index === target
                      ? "rollback-started"
                      : "pending",
              })),
            },
      ),
    });
  } catch {
    return invalidJournal();
  }
}

async function setProgress(
  lease: ReconciliationJournalLease,
  lifecycle: LeaseLifecycle,
  state: JournalState,
  host: HostId,
  hostStage: ReconciliationHostStage,
  operationStage: ReconciliationOperationStage,
  action?: Readonly<{
    id: string;
    stage: ReconciliationActionStage;
    ownedStateRevision?: string | null;
  }>,
): Promise<void> {
  await persist(
    lease,
    lifecycle,
    state,
    evolveJournal(state.journal, {
      operationStage,
      host,
      hostStage,
      ...(action === undefined
        ? {}
        : {
            actionId: action.id,
            actionStage: action.stage,
            ...(Object.hasOwn(action, "ownedStateRevision")
              ? {
                  ownedStateRevision:
                    action.ownedStateRevision ?? null,
                }
              : {}),
          }),
    }),
  );
}

async function rollbackHost(
  prepared: PreparedHost,
  lease: ReconciliationJournalLease,
  lifecycle: LeaseLifecycle,
  state: JournalState,
): Promise<void> {
  if (journalHost(state, prepared.host).stage === "committed") {
    return conflict();
  }
  await persist(
    lease,
    lifecycle,
    state,
    beginRollbackJournal(state.journal, prepared.host),
  );

  for (
    let index = prepared.actions.length - 1;
    index >= 0;
    index -= 1
  ) {
    const action = prepared.actions[index];
    if (action === undefined) {
      return failed();
    }
    const recorded = journalAction(state, prepared.host, action.id);
    if (recorded.stage === "pending") {
      continue;
    }
    const earlierRollbackProgressed = journalHost(
      state,
      prepared.host,
    ).actions
      .slice(0, index)
      .some(
        (candidate) =>
          candidate.stage === "rollback-started" ||
          candidate.stage === "rolled-back" ||
          candidate.stage === "failed",
      );
    if (earlierRollbackProgressed) {
      if (recorded.stage !== "rolled-back") {
        return invalidJournal();
      }
      continue;
    }
    const observed = await inspectHost(prepared, lease, lifecycle);
    const isBefore = sameValue(observed.configuration, action.before);
    const isAfter = sameValue(observed.configuration, action.after);
    const owned = ownedStateRevision(state, prepared.host);

    if (recorded.stage === "rolled-back") {
      if (
        !isBefore ||
        (owned === null
          ? index !== 0 ||
            observed.revision !== prepared.baselineRevision
          : observed.revision !== owned)
      ) {
        return conflict();
      }
      continue;
    }
    if (isBefore) {
      if (
        owned === null
          ? index !== 0 ||
            observed.revision !== prepared.baselineRevision
          : observed.revision !== owned
      ) {
        throw PRESERVED_UNOWNED;
      }
      await setProgress(
        lease,
        lifecycle,
        state,
        prepared.host,
        "rollback-started",
        "rollback",
        { id: action.id, stage: "rolled-back" },
      );
      continue;
    }
    if (!isAfter) {
      return conflict();
    }
    if (owned === null || observed.revision !== owned) {
      throw PRESERVED_UNOWNED;
    }

    await setProgress(
      lease,
      lifecycle,
      state,
      prepared.host,
      "rollback-started",
      "rollback",
      { id: action.id, stage: "rollback-started" },
    );
    await renew(lease, lifecycle);
    let result: HostMutationResult | null = null;
    try {
      result = mutationResult(
        await prepared.adapter.rollback(
          Object.freeze({
            host: prepared.host,
            executableRevision: prepared.executableRevision,
            expectedAfterRevision: owned,
            expectedAfter: action.after,
            action,
          }),
        ),
      );
    } catch {
      // Without a matching changed receipt, exact-before is not rollback-owned.
    }

    const afterRollback = await inspectHost(prepared, lease, lifecycle);
    if (sameValue(afterRollback.configuration, action.before)) {
      if (
        result?.status !== "changed" ||
        result.stateRevision !== afterRollback.revision ||
        result.stateRevision === owned
      ) {
        throw PRESERVED_UNOWNED;
      }
      await setProgress(
        lease,
        lifecycle,
        state,
        prepared.host,
        "rollback-started",
        "rollback",
        {
          id: action.id,
          stage: "rolled-back",
          ownedStateRevision: afterRollback.revision,
        },
      );
      continue;
    }
    if (!sameValue(afterRollback.configuration, action.after)) {
      return conflict();
    }
    if (afterRollback.revision !== owned) {
      throw PRESERVED_UNOWNED;
    }
    await setProgress(
      lease,
      lifecycle,
      state,
      prepared.host,
      "failed",
      "failed",
      { id: action.id, stage: "failed" },
    );
    return failed();
  }

  const restored = await inspectHost(prepared, lease, lifecycle);
  const baseline = prepared.actions[0]?.before;
  if (
    baseline === undefined ||
    !sameValue(restored.configuration, baseline) ||
    (ownedStateRevision(state, prepared.host) === null
      ? restored.revision !== prepared.baselineRevision
      : restored.revision !==
        ownedStateRevision(state, prepared.host))
  ) {
    return conflict();
  }
  await persist(
    lease,
    lifecycle,
    state,
    evolveJournal(state.journal, {
      operationStage: "failed",
      host: prepared.host,
      hostStage: "rolled-back",
      ownedStateRevision: null,
    }),
  );
}

async function applyAction(
  prepared: PreparedHost,
  action: HostAction,
  lease: ReconciliationJournalLease,
  lifecycle: LeaseLifecycle,
  state: JournalState,
  alreadyStarted: boolean,
  expectedBeforeRevision: string,
): Promise<void> {
  if (!alreadyStarted) {
    await setProgress(
      lease,
      lifecycle,
      state,
      prepared.host,
      "apply-started",
      "apply",
      { id: action.id, stage: "apply-started" },
    );
  }

  await renew(lease, lifecycle);
  let result: HostMutationResult | null = null;
  try {
    result = mutationResult(
      await prepared.adapter.apply(
        Object.freeze({
          host: prepared.host,
          executableRevision: prepared.executableRevision,
          expectedBeforeRevision,
          expectedBefore: action.before,
          action,
        }),
      ),
    );
  } catch {
    // Exact observed state below distinguishes a committed mutation from none.
  }

  const observed = await inspectHost(prepared, lease, lifecycle);
  if (sameValue(observed.configuration, action.after)) {
    if (
      result?.status !== "changed" ||
      result.stateRevision !== observed.revision ||
      result.stateRevision === expectedBeforeRevision
    ) {
      throw PRESERVED_UNOWNED;
    }
    await setProgress(
      lease,
      lifecycle,
      state,
      prepared.host,
      "apply-complete",
      "apply",
      {
        id: action.id,
        stage: "applied",
        ownedStateRevision: observed.revision,
      },
    );
    return;
  }
  if (!sameValue(observed.configuration, action.before)) {
    return conflict();
  }
  if (observed.revision !== expectedBeforeRevision) {
    throw PRESERVED_UNOWNED;
  }

  await setProgress(
    lease,
    lifecycle,
    state,
    prepared.host,
    "failed",
    "failed",
    { id: action.id, stage: "failed" },
  );
  await rollbackHost(prepared, lease, lifecycle, state);
  throw RESTORED_FAILURE;
}

async function verifyAction(
  prepared: PreparedHost,
  action: HostAction,
  lease: ReconciliationJournalLease,
  lifecycle: LeaseLifecycle,
  state: JournalState,
): Promise<void> {
  let stage = journalAction(state, prepared.host, action.id).stage;
  if (stage === "applied") {
    await setProgress(
      lease,
      lifecycle,
      state,
      prepared.host,
      "verify-started",
      "verify",
      { id: action.id, stage: "verify-started" },
    );
    stage = "verify-started";
  }
  if (stage !== "verify-started") {
    return;
  }

  const observed = await inspectHost(prepared, lease, lifecycle);
  const owned = ownedStateRevision(state, prepared.host);
  if (
    sameValue(observed.configuration, action.after) &&
    owned !== null &&
    observed.revision === owned
  ) {
    await setProgress(
      lease,
      lifecycle,
      state,
      prepared.host,
      "verify-complete",
      "verify",
      { id: action.id, stage: "verified" },
    );
    return;
  }
  if (!sameValue(observed.configuration, action.before)) {
    return conflict();
  }
  await setProgress(
    lease,
    lifecycle,
    state,
    prepared.host,
    "failed",
    "failed",
    { id: action.id, stage: "failed" },
  );
  await rollbackHost(prepared, lease, lifecycle, state);
  throw RESTORED_FAILURE;
}

async function commitHost(
  prepared: PreparedHost,
  lease: ReconciliationJournalLease,
  lifecycle: LeaseLifecycle,
  state: JournalState,
): Promise<void> {
  const finalConfiguration = prepared.actions.at(-1)?.after;
  if (finalConfiguration === undefined) {
    return failed();
  }
  const observed = await inspectHost(prepared, lease, lifecycle);
  const owned = ownedStateRevision(state, prepared.host);
  if (
    !sameValue(observed.configuration, finalConfiguration) ||
    owned === null ||
    observed.revision !== owned
  ) {
    return conflict();
  }

  await setProgress(
    lease,
    lifecycle,
    state,
    prepared.host,
    "commit-started",
    "commit",
  );
  for (const action of prepared.actions) {
    let stage = journalAction(state, prepared.host, action.id).stage;
    if (stage === "verified") {
      await setProgress(
        lease,
        lifecycle,
        state,
        prepared.host,
        "commit-started",
        "commit",
        { id: action.id, stage: "commit-started" },
      );
      stage = "commit-started";
    }
    if (stage === "commit-started") {
      await setProgress(
        lease,
        lifecycle,
        state,
        prepared.host,
        "commit-started",
        "commit",
        { id: action.id, stage: "committed" },
      );
      continue;
    }
    if (stage !== "committed") {
      return conflict();
    }
  }
  await setProgress(
    lease,
    lifecycle,
    state,
    prepared.host,
    "committed",
    "commit",
  );
}

function actionNeedsRollback(stage: ReconciliationActionStage): boolean {
  return (
    stage === "rollback-started" ||
    stage === "rolled-back" ||
    stage === "failed"
  );
}

async function reconcileHost(
  prepared: PreparedHost,
  lease: ReconciliationJournalLease,
  lifecycle: LeaseLifecycle,
  state: JournalState,
): Promise<void> {
  const recordedHost = journalHost(state, prepared.host);
  if (recordedHost.stage === "committed") {
    const finalConfiguration = prepared.actions.at(-1)?.after;
    if (finalConfiguration === undefined) {
      return failed();
    }
    const observed = await inspectHost(prepared, lease, lifecycle);
    const owned = ownedStateRevision(state, prepared.host);
    if (
      !sameValue(observed.configuration, finalConfiguration) ||
      owned === null
    ) {
      return conflict();
    }
    return;
  }
  if (
    recordedHost.stage === "rollback-started" ||
    recordedHost.stage === "rolled-back" ||
    recordedHost.stage === "failed" ||
    recordedHost.actions.some((action) =>
      actionNeedsRollback(action.stage),
    )
  ) {
    await rollbackHost(prepared, lease, lifecycle, state);
    throw RESTORED_FAILURE;
  }

  for (const [index, action] of prepared.actions.entries()) {
    let recorded = journalAction(state, prepared.host, action.id);
    const laterActionProgressed = journalHost(
      state,
      prepared.host,
    ).actions
      .slice(index + 1)
      .some((candidate) => candidate.stage !== "pending");
    if (laterActionProgressed) {
      if (
        recorded.stage !== "verified" &&
        recorded.stage !== "commit-started" &&
        recorded.stage !== "committed"
      ) {
        return invalidJournal();
      }
      continue;
    }
    let observed = await inspectHost(prepared, lease, lifecycle);
    const isBefore = sameValue(observed.configuration, action.before);
    const isAfter = sameValue(observed.configuration, action.after);

    if (recorded.stage === "pending") {
      const beforeRevision = expectedBeforeRevision(
        state,
        prepared,
        index,
      );
      if (
        !isBefore ||
        observed.revision !== beforeRevision
      ) {
        return conflict();
      }
      await applyAction(
        prepared,
        action,
        lease,
        lifecycle,
        state,
        false,
        beforeRevision,
      );
    } else if (recorded.stage === "apply-started") {
      if (isBefore) {
        const beforeRevision = expectedBeforeRevision(
          state,
          prepared,
          index,
        );
        if (
          observed.revision !== beforeRevision
        ) {
          throw PRESERVED_UNOWNED;
        }
        await applyAction(
          prepared,
          action,
          lease,
          lifecycle,
          state,
          true,
          beforeRevision,
        );
      } else if (isAfter) {
        /*
         * A crash or CAS failure can lose the adapter's changed receipt after
         * the mutation. Exact-after state alone cannot prove who created it,
         * so it is preserved and must be adopted by a fresh preflight.
         */
        throw PRESERVED_UNOWNED;
      } else {
        return conflict();
      }
    } else if (
      recorded.stage === "applied" ||
      recorded.stage === "verify-started" ||
      recorded.stage === "verified" ||
      recorded.stage === "commit-started" ||
      recorded.stage === "committed"
    ) {
      const owned = ownedStateRevision(state, prepared.host);
      if (
        !isAfter ||
        owned === null ||
        observed.revision !== owned
      ) {
        return conflict();
      }
    } else {
      await rollbackHost(prepared, lease, lifecycle, state);
      throw RESTORED_FAILURE;
    }

    await verifyAction(
      prepared,
      action,
      lease,
      lifecycle,
      state,
    );
    recorded = journalAction(state, prepared.host, action.id);
    if (
      recorded.stage !== "verified" &&
      recorded.stage !== "commit-started" &&
      recorded.stage !== "committed"
    ) {
      return conflict();
    }
  }

  await commitHost(prepared, lease, lifecycle, state);
}

async function recoverFailedOperation(
  prepared: PreparedReconciliation,
  lease: ReconciliationJournalLease,
  lifecycle: LeaseLifecycle,
  state: JournalState,
): Promise<never> {
  for (const host of prepared.actionableHosts) {
    const recorded = journalHost(state, host.host);
    if (recorded.stage === "committed") {
      const finalConfiguration = host.actions.at(-1)?.after;
      if (finalConfiguration === undefined) {
        return failed();
      }
      const observed = await inspectHost(host, lease, lifecycle);
      if (!sameValue(observed.configuration, finalConfiguration)) {
        return conflict();
      }
      continue;
    }
    if (recorded.stage === "rolled-back") {
      const baseline = host.actions[0]?.before;
      if (baseline === undefined) {
        return failed();
      }
      const observed = await inspectHost(host, lease, lifecycle);
      if (!sameValue(observed.configuration, baseline)) {
        return conflict();
      }
      continue;
    }
    if (
      recorded.stage !== "pending" ||
      recorded.actions.some((action) => action.stage !== "pending")
    ) {
      await rollbackHost(host, lease, lifecycle, state);
    }
  }
  await removeJournal(lease, lifecycle, state);
  return failed();
}

function committedHostIds(
  journal: ReconciliationJournalV1,
): readonly HostId[] {
  return Object.freeze(
    journal.hosts
      .filter((host) => host.stage === "committed")
      .map((host) => host.host),
  );
}

async function recoverHistoricalForReplan(
  prepared: PreparedReconciliation,
  lease: ReconciliationJournalLease,
  lifecycle: LeaseLifecycle,
  state: JournalState,
): Promise<HostReconciliationResult> {
  for (const host of prepared.actionableHosts) {
    const recorded = journalHost(state, host.host);
    if (recorded.stage === "committed") {
      const finalConfiguration = host.actions.at(-1)?.after;
      if (finalConfiguration === undefined) {
        return failed();
      }
      const observed = await inspectHost(host, lease, lifecycle);
      if (
        !sameValue(observed.configuration, finalConfiguration)
      ) {
        return conflict();
      }
      continue;
    }
    if (recorded.stage === "rolled-back") {
      const baseline = host.actions[0]?.before;
      if (baseline === undefined) {
        return failed();
      }
      const observed = await inspectHost(host, lease, lifecycle);
      if (!sameValue(observed.configuration, baseline)) {
        return conflict();
      }
      continue;
    }

    const progressed = recorded.actions.some(
      (action) => action.stage !== "pending",
    );
    if (!progressed) {
      /*
       * Pending historical intent owns no host state. Discard it even if the
       * user or host changed configuration after the old preflight; recovery
       * must neither adopt nor mutate that unrelated state.
       */
      continue;
    }

    try {
      await rollbackHost(host, lease, lifecycle, state);
    } catch (error) {
      if (error !== PRESERVED_UNOWNED) {
        throw error;
      }
      /*
       * Exact semantic state without a matching durable ownership revision is
       * preserved. A fresh preflight may adopt it, but this recovery operation
       * must never roll it back or execute later historical pending actions.
       */
    }
  }

  const committedHosts = committedHostIds(state.journal);
  await removeJournal(lease, lifecycle, state);
  return Object.freeze({
    status: "recovered",
    committedHosts,
    replanRequired: true,
  });
}

async function execute(
  plan: ReconciliationPlan,
  lease: ReconciliationJournalLease,
  lifecycle: LeaseLifecycle,
  adapters: HostAdapterMap<HostMutationAdapter>,
  options: HostReconciliationOptions,
): Promise<HostReconciliationResult> {
  const observed = await observeJournal(lease, lifecycle);
  if (observed.status === "missing") {
    const prepared = prepare(plan, adapters, options);
    if (prepared.initialJournal === null) {
      return Object.freeze({
        status: "no-op",
        committedHosts: Object.freeze([]) as readonly [],
      });
    }
    const revision = await replaceJournal(
      lease,
      lifecycle,
      observed.revision,
      prepared.initialJournal,
    );
    const state: JournalState = {
      journal: prepared.initialJournal,
      revision,
    };
    return executeJournal(prepared, lease, lifecycle, state);
  }

  let prepared: PreparedReconciliation | null = null;
  try {
    prepared = prepare(plan, adapters, options);
  } catch (error) {
    if (
      !(error instanceof HostError) ||
      error.code !== "invalid_reconciliation_plan"
    ) {
      throw error;
    }
  }
  if (
    prepared !== null &&
    matchesExistingJournal(observed.journal, prepared.initialJournal)
  ) {
    return executeJournal(
      prepared,
      lease,
      lifecycle,
      {
        journal: observed.journal,
        revision: observed.revision,
      },
    );
  }
  return recoverHistoricalForReplan(
    prepareHistoricalRecovery(observed.journal, adapters, options),
    lease,
    lifecycle,
    {
      journal: observed.journal,
      revision: observed.revision,
    },
  );
}

async function executeJournal(
  prepared: PreparedReconciliation,
  lease: ReconciliationJournalLease,
  lifecycle: LeaseLifecycle,
  state: JournalState,
): Promise<HostReconciliationResult> {
  try {
    if (
      state.journal.stage === "rollback" ||
      state.journal.stage === "failed"
    ) {
      return await recoverFailedOperation(
        prepared,
        lease,
        lifecycle,
        state,
      );
    }

    for (const host of prepared.actionableHosts) {
      await reconcileHost(host, lease, lifecycle, state);
    }
  } catch (error) {
    if (error === PRESERVED_UNOWNED) {
      const committedHosts = committedHostIds(state.journal);
      await removeJournal(lease, lifecycle, state);
      return Object.freeze({
        status: "recovered",
        committedHosts,
        replanRequired: true,
      });
    }
    if (error !== RESTORED_FAILURE) {
      throw error;
    }
    await removeJournal(lease, lifecycle, state);
    return failed();
  }

  await persist(
    lease,
    lifecycle,
    state,
    evolveJournal(state.journal, { operationStage: "complete" }),
  );
  await removeJournal(lease, lifecycle, state);
  return Object.freeze({
    status: "complete",
    committedHosts: Object.freeze(
      prepared.actionableHosts.map((host) => host.host),
    ),
  });
}

export async function reconcileHostPlan(
  plan: ReconciliationPlan,
  adapters: HostAdapterMap<HostMutationAdapter>,
  lease: ReconciliationJournalLease,
  options: HostReconciliationOptions,
): Promise<HostReconciliationResult> {
  const lifecycle: LeaseLifecycle = { lost: false };
  let operationError: unknown;
  let result: HostReconciliationResult | undefined;
  try {
    result = await execute(
      plan,
      lease,
      lifecycle,
      adapters,
      options,
    );
  } catch (error) {
    operationError = error;
  }

  try {
    if (lifecycle.lost) {
      await lease.abandon();
    } else {
      await lease.release();
    }
  } catch {
    operationError ??= new HostError("reconciliation_failed");
  }

  if (operationError !== undefined) {
    if (
      operationError === LEASE_LOST ||
      operationError === RESTORED_FAILURE
    ) {
      return failed();
    }
    if (operationError instanceof HostError) {
      throw operationError;
    }
    return failed();
  }
  return result ?? failed();
}

export async function acquireAndReconcileHostPlan(
  plan: ReconciliationPlan,
  adapters: HostAdapterMap<HostMutationAdapter>,
  store: ReconciliationJournalStoreAdapter,
  nonce: string,
  options: HostReconciliationOptions,
): Promise<HostReconciliationResult> {
  const validatedNonce = validateReconciliationJournalLeaseNonce(nonce);
  let acquired;
  try {
    acquired = await store.acquire(
      Object.freeze({ nonce: validatedNonce }),
    );
  } catch {
    return failed();
  }
  if (acquired?.status === "busy") {
    throw new HostError("reconciliation_busy");
  }
  if (
    acquired?.status !== "acquired" ||
    (acquired.priorLease !== "absent" &&
      acquired.priorLease !== "proven-abandoned") ||
    acquired.lease === null ||
    typeof acquired.lease !== "object"
  ) {
    return failed();
  }
  return reconcileHostPlan(plan, adapters, acquired.lease, options);
}
