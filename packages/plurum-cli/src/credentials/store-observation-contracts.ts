import type { ApiOriginPolicy } from "./origin.js";
import type { CredentialV1 } from "./schema.js";
import type {
  CredentialFileAttestation,
  CredentialFileReadHandle,
  CredentialStoreWholePassEvidence,
  PrivateDirectoryAttestation,
} from "./store-contracts.js";
import type {
  CredentialManagedEntry,
  CredentialTemporaryEntry,
} from "./store-mutation-contracts.js";
import type { CredentialReplaceTransactionV1 } from "./store-transaction.js";

declare const credentialStoreObservationIdentityBrand: unique symbol;
declare const credentialStoreObservationEvidenceBrand: unique symbol;

/*
 * Minted by one semantic read adapter after a complete observation pass. The
 * native implementation binds this token to the resolved directory, its
 * before/after attestations, both canonical entry observations, and the exact
 * recognized managed-temporary set. It must expose no paths, revisions,
 * filesystem identities, bytes, or key-derived material.
 *
 * Portable code wraps this token again before returning anything to a caller.
 * A future mutation authority may redeem the wrapper only inside the same
 * factory/adapter authority and must revalidate the native state before use.
 */
/*
 * The directory handle is read-only. Its attestation binds the directory
 * identity, path binding, and security; it is not a digest of child content.
 * Per-entry attestations plus finishObservation's final native snapshot bind
 * both canonical entries and the recognized managed-temporary set. All entry
 * operations are relative, no-follow operations under this already-open
 * directory authority.
 */
export interface CredentialStoreObservationDirectoryHandle {
  attest(): Promise<PrivateDirectoryAttestation>;
  observeEntry(options: Readonly<{
    entry: CredentialManagedEntry;
    noFollow: true;
  }>): Promise<CredentialStoreObservationEntryResult>;
  /* At most 1,024 exact, frozen descriptors may be returned. */
  listTemporaryEntries(): Promise<readonly CredentialTemporaryEntry[]>;

  /*
   * This succeeds only after one complete pass performed through this handle:
   * credential, transaction, the exact listed temporary entries, and stable
   * directory attestations. It is observational and performs no mutation.
   */
  finishObservation(): Promise<CredentialStoreWholePassEvidence>;
  close(): Promise<void>;
}

export type CredentialStoreObservationEntryResult =
  | Readonly<{ status: "missing" }>
  | Readonly<{
      status: "opened";
      attestation: CredentialFileAttestation;
      file: CredentialFileReadHandle;
    }>;

export type CredentialStoreObservationDirectoryOpenResult =
  | Readonly<{
      status: "missing";
      evidence: CredentialStoreWholePassEvidence;
    }>
  | Readonly<{
      status: "opened";
      directory: CredentialStoreObservationDirectoryHandle;
    }>;

/*
 * This is intentionally not CredentialStoreMutationAdapter. It cannot create
 * the directory, acquire a lease, write, rename, remove, sync, use randomness,
 * read a clock, access a host, or perform network I/O.
 */
export interface CredentialStoreObservationAdapter {
  openPrivateDirectory(
    directory: string,
    options: Readonly<{ noFollow: true }>,
  ): Promise<CredentialStoreObservationDirectoryOpenResult>;
}

/*
 * Runtime representation is a frozen, property-free, non-serializable object.
 * It is bound to one authority instance, one exact directory string, and one
 * observation. Copies, lookalikes, and tokens from another authority fail.
 */
export interface CredentialStoreObservationIdentity {
  readonly [credentialStoreObservationIdentityBrand]: never;
}

/*
 * Returned only after private redemption. The raw native evidence remains in
 * the issuing authority's WeakMap; this wrapper is safe to retain beside an
 * approved plan and cannot survive JSON serialization or structured cloning.
 */
export interface CredentialStoreObservationEvidence {
  readonly [credentialStoreObservationEvidenceBrand]: never;
}

export type CredentialStoreCanonicalPublicState =
  | "missing"
  | "pending"
  | "active";

export type CredentialStoreTransactionPublicState =
  | "clean"
  | "recovery-required"
  | "unavailable";

export interface CredentialStoreObservationRequest {
  readonly directory: string;
}

export type CredentialStoreObservationResult =
  | Readonly<{
      status: "available";
      identity: CredentialStoreObservationIdentity;
      transaction: Exclude<
        CredentialStoreTransactionPublicState,
        "unavailable"
      >;
      canonical: CredentialStoreCanonicalPublicState;
    }>
  | Readonly<{
      status: "unavailable";
      transaction: "unavailable";
      canonical: "unavailable";
    }>;

export interface CredentialStoreObservationRedeemRequest {
  readonly identity: CredentialStoreObservationIdentity;
  readonly directory: string;
}

/*
 * This result contains credentials and must never enter a public plan,
 * renderer, diagnostic, or JSON response. Redemption is synchronous and
 * one-shot: possession of the public identity authorizes exactly one attempt.
 */
export type CredentialStoreObservationRedeemResult =
  | Readonly<{
      status: "redeemed";
      credential: CredentialV1 | null;
      transaction: CredentialReplaceTransactionV1 | null;
      evidence: CredentialStoreObservationEvidence;
    }>
  | Readonly<{ status: "precondition-failed" }>;

export interface CredentialStoreObservationAuthority {
  inspect(
    request: CredentialStoreObservationRequest,
  ): Promise<CredentialStoreObservationResult>;
  redeem(
    request: CredentialStoreObservationRedeemRequest,
  ): CredentialStoreObservationRedeemResult;
}

export interface CredentialStoreObservationOptions {
  readonly originPolicy?: ApiOriginPolicy;
}
