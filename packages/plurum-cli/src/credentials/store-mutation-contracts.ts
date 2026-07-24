import {
  CREDENTIAL_STORE_ENTRY,
  type CredentialFileAttestation,
  type CredentialFileReadHandle,
  type CredentialStoreWholePassEvidence,
  type PrivateDirectoryAttestation,
} from "./store-contracts.js";

export const CREDENTIAL_TRANSACTION_ENTRY =
  "credentials-transaction.json" as const;
export const CREDENTIAL_CANDIDATE_ENTRY_PREFIX =
  ".credentials-candidate-" as const;
export const CREDENTIAL_TRANSACTION_CANDIDATE_ENTRY_PREFIX =
  ".credentials-transaction-" as const;
export const CREDENTIAL_RECOVERY_CANDIDATE_ENTRY_PREFIX =
  ".credentials-recovery-" as const;
export const CREDENTIAL_TEMPORARY_ENTRY_SUFFIX = ".tmp" as const;

declare const credentialTransactionIdBrand: unique symbol;
declare const credentialSetupLeaseNonceBrand: unique symbol;

export type CredentialTransactionId = string & {
  readonly [credentialTransactionIdBrand]: true;
};

export type CredentialSetupLeaseNonce = string & {
  readonly [credentialSetupLeaseNonceBrand]: true;
};

export type CredentialCanonicalEntry =
  | Readonly<{
      kind: "canonical";
      role: "credential";
      name: typeof CREDENTIAL_STORE_ENTRY;
    }>
  | Readonly<{
      kind: "canonical";
      role: "transaction";
      name: typeof CREDENTIAL_TRANSACTION_ENTRY;
    }>;

export type CredentialTemporaryEntryRole =
  | "credential-candidate"
  | "transaction-candidate"
  | "recovery-candidate";

/*
 * Temporary names are not accepted as arbitrary strings. A native adapter
 * derives the basename from role + transactionId, independently verifies that
 * the identifier is a lowercase UUIDv4, and rejects every other spelling.
 */
export interface CredentialTemporaryEntry {
  readonly kind: "temporary";
  readonly role: CredentialTemporaryEntryRole;
  readonly transactionId: CredentialTransactionId;
}

export type CredentialManagedEntry =
  | CredentialCanonicalEntry
  | CredentialTemporaryEntry;

declare const missingEntrySnapshotBrand: unique symbol;
declare const presentEntrySnapshotBrand: unique symbol;

/*
 * Snapshots are adapter-minted, opaque compare-and-swap tokens. They bind the
 * observed directory identity, entry role/name, path binding, object identity,
 * content revision, and security evidence. Portable code may only retain and
 * return them to the same lease capability.
 */
export interface CredentialMissingEntrySnapshot {
  readonly [missingEntrySnapshotBrand]: true;
}

export interface CredentialPresentEntrySnapshot {
  readonly [presentEntrySnapshotBrand]: true;
}

export type CredentialEntrySnapshot =
  | CredentialMissingEntrySnapshot
  | CredentialPresentEntrySnapshot;

export type CredentialManagedEntryObservation =
  | Readonly<{
      status: "missing";
      snapshot: CredentialMissingEntrySnapshot;
    }>
  | Readonly<{
      status: "opened";
      snapshot: CredentialPresentEntrySnapshot;
      attestation: CredentialFileAttestation;
      file: CredentialFileReadHandle;
    }>;

export interface CredentialFileExclusiveWriteHandle {
  attest(): Promise<CredentialFileAttestation>;

  /*
   * Replace the complete contents of this newly and exclusively created file.
   * The adapter must consume an internal copy of bytes before yielding control;
   * partial, append, sparse, and caller-mutation-dependent writes are forbidden.
   */
  writeAll(bytes: Uint8Array): Promise<void>;

  /*
   * Flush both content and the file security metadata required by the native
   * platform. This does not replace the directory flush after a rename.
   */
  sync(): Promise<void>;
  close(): Promise<void>;
}

export type CredentialExclusiveCreateResult =
  | Readonly<{
      status: "created";
      file: CredentialFileExclusiveWriteHandle;
    }>
  | Readonly<{ status: "conflict" }>;

export type CredentialConditionalMoveResult =
  | Readonly<{ status: "moved" }>
  | Readonly<{ status: "conflict" }>;

export type CredentialConditionalRemoveResult =
  | Readonly<{ status: "removed" }>
  | Readonly<{ status: "conflict" }>;

export type CredentialLeaseRenewResult =
  | Readonly<{ status: "held" }>
  | Readonly<{ status: "lost" }>;

/*
 * This object is the sole portable mutation capability. Every operation is
 * relative to the identity-bound private directory acquired with the lease.
 * A native adapter must revalidate exclusive lease ownership, directory
 * binding, user ownership/access, and no-follow/reparse protections before
 * each mutation. It must also reject descriptor extensions and mismatched
 * canonical role/name pairs rather than treating caller objects as paths.
 * Losing any evidence must fail closed without mutation.
 */
export interface CredentialStoreMutationLease {
  attestDirectory(): Promise<PrivateDirectoryAttestation>;

  /*
   * A timestamp or heartbeat may aid diagnostics, but can never authorize
   * takeover. "held" must be backed by native exclusive-ownership evidence.
   */
  renew(): Promise<CredentialLeaseRenewResult>;

  /*
   * The returned snapshot and initial attestation describe the exact opened
   * object. The read handle supports a bounded exact-byte read and independent
   * re-attestation before/after that read. Opens are always no-follow.
   */
  observeEntry(
    entry: CredentialManagedEntry,
  ): Promise<CredentialManagedEntryObservation>;

  /*
   * Enumerate only exact, adapter-validated temporary basenames derived from
   * the three managed prefixes, a lowercase UUIDv4, and the fixed suffix. Every
   * exact basename match must be returned even when its object is later found
   * unsafe; observeEntry performs that security check. Unknown or malformed
   * directory entries remain invisible and untouched. The array and every
   * descriptor must be exact-shape and frozen.
   */
  listTemporaryEntries(): Promise<readonly CredentialTemporaryEntry[]>;

  /*
   * Atomically create a managed temporary entry only if it still matches the
   * adapter-minted missing snapshot. Creation is exclusive and can never open,
   * truncate, or overwrite an existing object. The file is created relative to
   * the held directory, with user-only protections and no links/reparse
   * traversal. Canonical entries cannot be created through this method.
   */
  createTemporaryExclusive(
    options: Readonly<{
      entry: CredentialTemporaryEntry;
      expected: CredentialMissingEntrySnapshot;
    }>,
  ): Promise<CredentialExclusiveCreateResult>;

  /*
   * Under the held native setup lease, replace destination with source only if
   * both still match their snapshots (including an observed-missing
   * destination). The adapter must serialize every cooperating Plurum writer,
   * revalidate immediately before the atomic same-directory rename without an
   * intervening yield, and verify the result. General filesystems do not offer a
   * portable compare-inode-and-rename syscall; arbitrary mutation by another
   * process already running as the same trusted user is outside this credential
   * isolation boundary and remains a native-adapter test/documentation gate.
   * A check followed by a later or unconditional rename is forbidden.
   */
  moveTemporaryConditionally(options: Readonly<{
    source: CredentialTemporaryEntry;
    expectedSource: CredentialPresentEntrySnapshot;
    destination: CredentialCanonicalEntry;
    expectedDestination: CredentialEntrySnapshot;
  }>): Promise<CredentialConditionalMoveResult>;

  /*
   * Under the held native setup lease, remove only the object represented by
   * expected. The adapter must serialize cooperating Plurum writers,
   * immediately revalidate without yielding, unlink relative to the bound
   * directory, and verify the result. The same trusted-current-user boundary
   * described for conditional move applies because general filesystems do not
   * expose a portable compare-inode-and-unlink syscall.
   */
  removeConditionally(options: Readonly<{
    entry: CredentialManagedEntry;
    expected: CredentialPresentEntrySnapshot;
  }>): Promise<CredentialConditionalRemoveResult>;

  /*
   * Flush directory metadata after every create, move, or remove boundary for
   * which the portable recovery protocol requires durability.
   */
  syncDirectory(): Promise<void>;

  /*
   * Both methods are terminal and must invalidate every handle/snapshot minted
   * by this lease. release conditionally removes only this exact lease ownership
   * record and durably flushes that removal. Whether cleanup succeeds or throws,
   * it must relinquish native exclusion exactly once; a failed cleanup preserves
   * enough record evidence for later native abandonment proof. release remains
   * safe after an operation or renewal exception because cleanup is conditional
   * on the exact nonce/ownership record and uncertainty preserves it. abandon
   * is the alternative terminal path after an explicit native "lost" result,
   * or before a malformed acquired lease can support normal release, and
   * performs no ownership-record cleanup. The caller must never invoke both
   * terminal methods. Neither operation may use age alone as proof.
   */
  release(): Promise<void>;
  abandon(): Promise<void>;
}

export type CredentialSetupLeaseAcquireResult =
  | Readonly<{ status: "busy" }>
  | Readonly<{
      status: "acquired";
      priorLease: "absent" | "proven-abandoned";
      directory: "created" | "existing";
      lease: CredentialStoreMutationLease;
    }>;

/*
 * The adapter owns all platform-specific claims: safe directory creation/open,
 * POSIX ownership/mode and no-follow operations, Windows SID/DACL and reparse
 * handling, native exclusive lease proof, lease-scoped revalidation around
 * atomic same-directory replacement/removal, and durable file/directory
 * flushes. The method-level current-user/cooperating-writer scope applies.
 *
 * A live lease, an unverifiable lease, malformed lock evidence, or ambiguous
 * abandonment must not be replaced. Only native proof may produce the
 * "proven-abandoned" disposition; timestamps are never sufficient.
 */
export interface CredentialStoreMutationAdapter {
  acquireSetupLease(
    directory: string,
    options: Readonly<{
      noFollow: true;
      createDirectory: true;
      /*
       * The portable core supplies a freshly generated lowercase UUIDv4. The
       * adapter validates it independently and binds its lease record and
       * terminal conditional release to this exact nonce.
       */
      nonce: CredentialSetupLeaseNonce;
    }>,
  ): Promise<CredentialSetupLeaseAcquireResult>;
}

export type CredentialObservedSetupLeaseAcquireResult =
  | Readonly<{ status: "busy" }>
  | Readonly<{ status: "precondition-failed" }>
  | Readonly<{
      status: "acquired";
      priorLease: "absent" | "proven-abandoned";
      directory: "created" | "existing";
      lease: CredentialStoreMutationLease;
    }>;

/*
 * This extension is the only mutation entrypoint that may consume whole-pass
 * observation evidence. The adapter must burn `evidence`, acquire native
 * exclusion, and revalidate the complete observed state under that exclusion
 * before returning `acquired`. A mismatch returns `precondition-failed`
 * without creating a directory, repairing state, or performing any other
 * credential mutation.
 *
 * Lease ownership entropy is native-owned for this operation so portable
 * registration randomness remains untouched until observation revalidation
 * has succeeded.
 */
export interface CredentialStoreObservedMutationAdapter
  extends CredentialStoreMutationAdapter {
  acquireObservedSetupLease(
    directory: string,
    options: Readonly<{
      noFollow: true;
      createDirectory: true;
      evidence: CredentialStoreWholePassEvidence;
    }>,
  ): Promise<CredentialObservedSetupLeaseAcquireResult>;
}
