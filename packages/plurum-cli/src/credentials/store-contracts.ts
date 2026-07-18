export const CREDENTIAL_STORE_ENTRY = "credentials.json" as const;

export interface CredentialObjectIdentity {
  readonly volume: string;
  readonly object: string;
}

export type CredentialOwnerAttestation =
  | "current-user"
  | "other-user"
  | "unknown";

export type CredentialAccessAttestation =
  | "user-only"
  | "broader"
  | "unknown";

export type CredentialLinkAttestation =
  | "direct"
  | "symbolic-link"
  | "reparse-point"
  | "unknown";

export type CredentialBindingAttestation =
  | "canonical-current"
  | "detached"
  | "unknown";

export interface PrivateDirectoryAttestation {
  readonly kind: "directory";
  readonly identity: CredentialObjectIdentity;
  // Stable across reads/atime; never reused after identity, binding, or security changes.
  readonly revision: string;
  readonly binding: CredentialBindingAttestation;
  readonly owner: CredentialOwnerAttestation;
  readonly access: CredentialAccessAttestation;
  readonly link: CredentialLinkAttestation;
}

export interface CredentialFileAttestation {
  readonly kind: "regular-file";
  readonly identity: CredentialObjectIdentity;
  readonly parentIdentity: CredentialObjectIdentity;
  // Stable across reads/atime; never reused after content (including same-size),
  // identity, binding, or security changes.
  readonly revision: string;
  readonly binding: CredentialBindingAttestation;
  readonly owner: CredentialOwnerAttestation;
  readonly access: CredentialAccessAttestation;
  readonly link: CredentialLinkAttestation;
  readonly links: number;
  readonly size: number;
}

export interface BoundedCredentialRead {
  /*
   * The adapter retains ownership of this buffer. Portable code copies it
   * synchronously before the next await and never mutates or claims to wipe the
   * adapter's storage. Native handles may return a fresh buffer and wipe it on
   * close, but callers cannot require that from an external implementation.
   */
  readonly bytes: Uint8Array;
  readonly endOfFile: boolean;
}

export interface CredentialFileReadHandle {
  attest(): Promise<CredentialFileAttestation>;
  readBounded(options: {
    readonly maxBytes: number;
  }): Promise<BoundedCredentialRead>;
  close(): Promise<void>;
}

export type CredentialFileOpenResult =
  | Readonly<{ status: "missing" }>
  | Readonly<{
      status: "opened";
      file: CredentialFileReadHandle;
    }>;

/*
 * Operations are relative to the already-open directory identity. A native
 * adapter must enforce no-follow opens and recompute current path binding and
 * platform security evidence on every attestation.
 */
export interface PrivateCredentialDirectoryHandle {
  attest(): Promise<PrivateDirectoryAttestation>;
  openCredentialReadOnly(options: {
    readonly entry: typeof CREDENTIAL_STORE_ENTRY;
    readonly noFollow: true;
  }): Promise<CredentialFileOpenResult>;
  close(): Promise<void>;
}

export type PrivateCredentialDirectoryOpenResult =
  | Readonly<{ status: "missing" }>
  | Readonly<{
      status: "opened";
      directory: PrivateCredentialDirectoryHandle;
    }>;

/*
 * This portable port does not itself claim POSIX mode/nofollow or Windows
 * ACL/reparse enforcement. Those guarantees belong to a future native adapter.
 */
export interface CredentialStoreReadAdapter {
  openPrivateDirectory(
    directory: string,
    options: { readonly noFollow: true },
  ): Promise<PrivateCredentialDirectoryOpenResult>;
}
