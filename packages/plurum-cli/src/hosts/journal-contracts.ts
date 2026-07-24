import type {
  HostActionKind,
  HostConfiguration,
  HostId,
  HostRollbackRecipe,
} from "./contracts.js";

export const RECONCILIATION_JOURNAL_SCHEMA_VERSION = 1 as const;
export const RECONCILIATION_JOURNAL_KIND = "host-reconciliation" as const;

export const RECONCILIATION_OPERATION_STAGES = [
  "apply",
  "verify",
  "commit",
  "rollback",
  "complete",
  "failed",
] as const;

export type ReconciliationOperationStage =
  (typeof RECONCILIATION_OPERATION_STAGES)[number];

export const RECONCILIATION_HOST_STAGES = [
  "pending",
  "apply-started",
  "apply-complete",
  "verify-started",
  "verify-complete",
  "commit-started",
  "committed",
  "rollback-started",
  "rolled-back",
  "failed",
] as const;

export type ReconciliationHostStage =
  (typeof RECONCILIATION_HOST_STAGES)[number];

export const RECONCILIATION_ACTION_STAGES = [
  "pending",
  "apply-started",
  "applied",
  "verify-started",
  "verified",
  "commit-started",
  "committed",
  "rollback-started",
  "rolled-back",
  "failed",
] as const;

export type ReconciliationActionStage =
  (typeof RECONCILIATION_ACTION_STAGES)[number];

declare const reconciliationOperationIdBrand: unique symbol;
declare const reconciliationActionIdBrand: unique symbol;
declare const reconciliationTimestampBrand: unique symbol;
declare const reconciliationJournalLeaseNonceBrand: unique symbol;
declare const reconciliationJournalRevisionSnapshotBrand: unique symbol;

export type ReconciliationOperationId = string & {
  readonly [reconciliationOperationIdBrand]: true;
};

export type ReconciliationActionId = string & {
  readonly [reconciliationActionIdBrand]: true;
};

export type ReconciliationTimestamp = string & {
  readonly [reconciliationTimestampBrand]: true;
};

export type ReconciliationJournalLeaseNonce = string & {
  readonly [reconciliationJournalLeaseNonceBrand]: true;
};

export interface ReconciliationJournalActionV1 {
  readonly action_id: ReconciliationActionId;
  readonly kind: HostActionKind;
  readonly stage: ReconciliationActionStage;
  readonly before: HostConfiguration;
  readonly after: HostConfiguration;
  readonly rollback: HostRollbackRecipe;
}

export interface ReconciliationJournalHostV1 {
  readonly host: HostId;
  readonly stage: ReconciliationHostStage;
  readonly executable_revision: string;
  readonly baseline_revision: string;
  /*
   * Revision of the host's current semantic state only when the last state
   * transition was positively acknowledged as changed by this CLI. `null`
   * means the current state is preexisting or mutation ownership is uncertain.
   */
  readonly owned_state_revision: string | null;
  readonly actions: readonly ReconciliationJournalActionV1[];
}

/*
 * This durable record intentionally contains only normalized, public semantic
 * state. It must never contain a credential, child-process output, environment
 * snapshot, command line, arbitrary host configuration, or filesystem path.
 */
export interface ReconciliationJournalV1 {
  readonly schema_version: typeof RECONCILIATION_JOURNAL_SCHEMA_VERSION;
  readonly kind: typeof RECONCILIATION_JOURNAL_KIND;
  readonly operation_id: ReconciliationOperationId;
  readonly created_at: ReconciliationTimestamp;
  readonly updated_at: ReconciliationTimestamp;
  readonly stage: ReconciliationOperationStage;
  readonly hosts: readonly ReconciliationJournalHostV1[];
}

/*
 * A native adapter mints this opaque token after observing the protected
 * journal slot. It binds the lease, slot identity, presence/absence, content
 * revision, and current security evidence. Portable code may only return it to
 * the same lease for compare-and-swap.
 */
export interface ReconciliationJournalRevisionSnapshot {
  readonly [reconciliationJournalRevisionSnapshotBrand]: true;
}

export type ReconciliationJournalObservation =
  | Readonly<{
      status: "missing";
      revision: ReconciliationJournalRevisionSnapshot;
    }>
  | Readonly<{
      status: "present";
      revision: ReconciliationJournalRevisionSnapshot;
      bytes: Uint8Array;
    }>;

export type ReconciliationJournalReplaceResult =
  | Readonly<{
      status: "replaced";
      revision: ReconciliationJournalRevisionSnapshot;
    }>
  | Readonly<{ status: "conflict" }>;

export type ReconciliationJournalRemoveResult =
  | Readonly<{ status: "removed" }>
  | Readonly<{ status: "conflict" }>;

export type ReconciliationJournalLeaseRenewResult =
  | Readonly<{ status: "held" }>
  | Readonly<{ status: "lost" }>;

/*
 * This capability has no path-string methods. The adapter owns the protected
 * user-scoped location, user-only access checks, no-follow/reparse defenses,
 * durable atomic replacement, and immediate compare-and-swap revalidation. As
 * with credential mutation, the held lease serializes cooperating Plurum
 * writers. General filesystems do not expose portable compare-inode-and-rename
 * or compare-inode-and-unlink operations; arbitrary hostile mutation by a
 * process already running as the same trusted OS user is outside this
 * boundary.
 */
export interface ReconciliationJournalLease {
  renew(): Promise<ReconciliationJournalLeaseRenewResult>;

  /*
   * A present observation returns an owned byte copy bounded by the journal
   * codec limit. The adapter must not expose a shared mutable backing buffer.
   */
  observe(): Promise<ReconciliationJournalObservation>;

  /*
   * The adapter consumes an internal copy before yielding, writes a protected
   * same-directory temporary object, durably replaces the journal only when
   * `expected` still matches, and returns the newly minted revision.
   */
  replace(options: Readonly<{
    expected: ReconciliationJournalRevisionSnapshot;
    bytes: Uint8Array;
  }>): Promise<ReconciliationJournalReplaceResult>;

  /*
   * Removal is the commit point and is conditional on the exact present
   * revision. A missing or changed slot is a conflict, never success.
   */
  remove(options: Readonly<{
    expected: ReconciliationJournalRevisionSnapshot;
  }>): Promise<ReconciliationJournalRemoveResult>;

  /*
   * Both operations are terminal. `release` conditionally releases this exact
   * native ownership record. `abandon` performs no ownership-record cleanup
   * after explicit lease-loss evidence. Callers must invoke exactly one.
   */
  release(): Promise<void>;
  abandon(): Promise<void>;
}

export type ReconciliationJournalLeaseAcquireResult =
  | Readonly<{ status: "busy" }>
  | Readonly<{
      status: "acquired";
      priorLease: "absent" | "proven-abandoned";
      lease: ReconciliationJournalLease;
    }>;

/*
 * Only native proof may classify an old lease as abandoned. Age or timestamp
 * alone never authorizes takeover. The nonce is a freshly generated lowercase
 * UUIDv4 and must be independently validated and bound by the adapter.
 */
export interface ReconciliationJournalStoreAdapter {
  acquire(
    options: Readonly<{
      nonce: ReconciliationJournalLeaseNonce;
    }>,
  ): Promise<ReconciliationJournalLeaseAcquireResult>;
}
