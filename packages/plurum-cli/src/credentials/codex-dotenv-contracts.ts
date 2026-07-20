export const CODEX_DOTENV_ENTRY = ".env" as const;
export const CODEX_DOTENV_API_ORIGIN = "https://api.plurum.ai" as const;

export const CODEX_DOTENV_PROJECTION_STATUSES = Object.freeze([
  "absent",
  "exact",
  "mismatched",
  "ambiguous",
  "unsafe",
  "credential-unavailable",
] as const);

export type CodexDotenvProjectionStatus =
  (typeof CODEX_DOTENV_PROJECTION_STATUSES)[number];

export interface CodexDotenvNativeEvidence {
  /*
   * Native evidence binds the canonical active Plurum credential, the resolved
   * user CODEX_HOME directory, and the exact .env object/security/content
   * state. It must change after every relevant mutation and never repeat,
   * including after delete/recreate or content/security-state reversion. It
   * must not expose a path, key, key-derived value, raw bytes, or filesystem
   * identity.
   */
  readonly revision: string;
  readonly status: CodexDotenvProjectionStatus;
}

declare const codexDotenvProjectionIdentityBrand: unique symbol;

/*
 * Portable callers receive identity, never a native revision. Identity is an
 * in-memory, adapter-bound, one-use capability. Its runtime representation is
 * deliberately opaque and cannot survive serialization or cloning.
 */
export interface CodexDotenvProjectionIdentity {
  readonly [codexDotenvProjectionIdentityBrand]: never;
}

export interface CodexDotenvProjectionEvidence {
  readonly identity: CodexDotenvProjectionIdentity;
  readonly status: CodexDotenvProjectionStatus;
}

export interface CodexDotenvObserveRequest {
  readonly kind: "codex-dotenv-observe";
  readonly scope: "user";
  readonly apiOrigin: typeof CODEX_DOTENV_API_ORIGIN;
  readonly excludedProjectDirectory: string;
}

export interface CodexDotenvSynchronizeRequest {
  readonly kind: "codex-dotenv-synchronize";
  readonly scope: "user";
  readonly apiOrigin: typeof CODEX_DOTENV_API_ORIGIN;
  readonly expectedRevision: string;
  readonly expectedStatus: "absent" | "exact" | "mismatched";
  readonly excludedProjectDirectory: string;
}

export type CodexDotenvNativeMutationResult =
  | Readonly<{
      status: "completed";
      disposition: "changed" | "unchanged";
      stateRevision: string;
    }>
  | Readonly<{ status: "precondition-failed" }>
  | Readonly<{ status: "failed" }>;

/*
 * This is deliberately separate from HostMutationAdapter. The projection
 * contains a credential and therefore must never enter the non-secret host
 * plan or journal. One native authority owns observation, no-follow security
 * checks, canonical-credential access, compare-and-swap replacement, and the
 * final durable revision.
 */
export interface CodexDotenvNativeAdapter {
  observe(
    request: CodexDotenvObserveRequest,
  ): Promise<CodexDotenvNativeEvidence>;
  synchronize(
    request: CodexDotenvSynchronizeRequest,
  ): Promise<CodexDotenvNativeMutationResult>;
}

export interface CodexDotenvInspectionRequest {
  readonly excludedProjectDirectory: string;
}

export type CodexDotenvInspection =
  | Readonly<{
      status: "available";
      state: CodexDotenvProjectionEvidence;
    }>
  | Readonly<{ status: "unavailable" }>;

export interface CodexDotenvApplyRequest {
  readonly expectedIdentity: CodexDotenvProjectionIdentity;
  readonly excludedProjectDirectory: string;
}

export type CodexDotenvApplyResult =
  | Readonly<{
      status: "changed" | "unchanged";
      state: CodexDotenvProjectionEvidence;
    }>
  | Readonly<{
      status: "converged-unowned";
      state: CodexDotenvProjectionEvidence;
    }>
  | Readonly<{ status: "blocked" }>
  | Readonly<{ status: "precondition-failed" }>
  | Readonly<{ status: "indeterminate" }>
  | Readonly<{ status: "failed" }>;

export interface CodexDotenvProjectionAdapter {
  inspect(
    request: CodexDotenvInspectionRequest,
  ): Promise<CodexDotenvInspection>;
  apply(request: CodexDotenvApplyRequest): Promise<CodexDotenvApplyResult>;
}
