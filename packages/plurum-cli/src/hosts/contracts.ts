export const HOST_IDS = ["claude-code", "codex"] as const;

export type HostId = (typeof HOST_IDS)[number];

export const HOST_ACTION_KINDS = [
  "add-marketplace",
  "install-plugin",
  "update-plugin",
  "enable-plugin",
] as const;

export type HostActionKind = (typeof HOST_ACTION_KINDS)[number];

export type HostExecutableOwner = "current-user" | "trusted-system";
export type HostExecutableLink =
  | "direct"
  | "resolved-link"
  | "approved-npm-shim";

/*
 * These are defensive, normalized copies of claims made by a native host
 * resolver. They are safe to display and journal, but are not an execution
 * grant: portable structural validation cannot prove ownership, access, or
 * freshness. Only the semantic native host adapter that minted `revision` may
 * re-attest that exact chain immediately before a direct spawn.
 */
export interface HostExecutableChainEntry {
  readonly path: string;
  readonly kind: "binary" | "script" | "shim";
  readonly owner: HostExecutableOwner;
  // Covers the object and every resolved ancestor from its trusted root.
  readonly access: "not-broadly-writable";
  readonly binding: "canonical";
  readonly link: HostExecutableLink;
  readonly revision: string;
}

export interface HostExecutableAttestation {
  readonly sourcePath: string;
  readonly resolvedPath: string;
  readonly revision: string;
  readonly chain: readonly HostExecutableChainEntry[];
  readonly launch: Readonly<{
    executable: string;
    argumentPrefix: readonly string[];
    shell: false;
  }>;
}

export type ObservedSlot<Value> =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "present"; value: Value }>
  | Readonly<{ status: "ambiguous" }>;

export interface HostMarketplaceDescriptor {
  readonly name: "plurum";
  readonly source: string;
}

export interface HostPluginDescriptor {
  readonly name: "plurum";
  readonly source: string;
  readonly version: string;
  readonly enabled: boolean;
}

export interface HostMcpDescriptor {
  readonly name: "plurum";
  readonly endpoint: string;
}

/*
 * Only normalized, user-scope state appears here. Adapters must not include raw
 * host output, arbitrary configuration bytes, project-local state, environment
 * snapshots, credentials, or key-derived values.
 */
export interface HostConfiguration {
  readonly marketplace: ObservedSlot<HostMarketplaceDescriptor>;
  readonly plugin: ObservedSlot<HostPluginDescriptor>;
  readonly pluginMcp: ObservedSlot<HostMcpDescriptor>;
  readonly directMcp: ObservedSlot<HostMcpDescriptor>;
}

export interface HostStateSnapshot {
  /*
   * This adapter-minted revision changes after every relevant host mutation,
   * even when another process later recreates byte-for-byte equivalent
   * semantic state. Reconciliation uses it as mutation-ownership evidence; it
   * must never be a content hash that can repeat after delete/recreate.
   */
  readonly revision: string;
  readonly configuration: HostConfiguration;
}

export interface HostMutationSupport {
  readonly addMarketplace: boolean;
  readonly removeMarketplace: boolean;
  readonly installPlugin: boolean;
  readonly removePlugin: boolean;
  readonly updatePlugin: boolean;
  readonly restorePlugin: boolean;
  readonly enablePlugin: boolean;
  readonly disablePlugin: boolean;
}

export type HostInspection =
  | Readonly<{
      host: HostId;
      status: "absent";
    }>
  | Readonly<{
      host: HostId;
      status: "blocked";
      reason:
        | "unsafe-path-entry"
        | "unsafe-shadow"
        | "unsafe-executable"
        | "ambiguous-executable"
        | "unsupported-shim"
        | "unverifiable-executable";
      candidatePath?: string;
    }>
  | Readonly<{
      host: HostId;
      status: "unavailable";
      reason:
        | "probe-failed"
        | "probe-timeout"
        | "probe-output-invalid"
        | "probe-output-too-large";
      executable: HostExecutableAttestation;
    }>
  | Readonly<{
      host: HostId;
      status: "available";
      executable: HostExecutableAttestation;
      version: string;
      state: HostStateSnapshot;
      mutationSupport: HostMutationSupport;
    }>;

export interface DesiredHostConfiguration {
  readonly host: HostId;
  readonly minimumHostVersion: string;
  readonly marketplace: HostMarketplaceDescriptor;
  readonly plugin: Readonly<{
    name: "plurum";
    source: string;
    version: string;
    compatibleMinimum: string;
    compatibleMaximumExclusive: string;
  }>;
  readonly mcp: HostMcpDescriptor;
}

export type HostPlanClassification =
  | "absent"
  | "unsafe"
  | "unavailable"
  | "unsupported-version"
  | "healthy"
  | "healthy-newer"
  | "needs-changes"
  | "direct-only"
  | "duplicate"
  | "mismatched"
  | "ambiguous"
  | "irreversible";

export interface HostRollbackRecipe {
  readonly kind:
    | "remove-cli-created-marketplace"
    | "remove-cli-created-plugin"
    | "restore-plugin-version"
    | "restore-plugin-disabled";
  readonly pluginVersion?: string;
}

export interface HostAction {
  readonly id: string;
  readonly host: HostId;
  readonly kind: HostActionKind;
  readonly before: HostConfiguration;
  readonly after: HostConfiguration;
  readonly rollback: HostRollbackRecipe;
  readonly display: string;
}

export interface HostPreflightPlan {
  readonly host: HostId;
  readonly classification: HostPlanClassification;
  readonly automatic: boolean;
  readonly executable: HostExecutableAttestation | null;
  readonly detectedVersion: string | null;
  readonly minimumVersion: string;
  readonly baseline: HostStateSnapshot | null;
  readonly desired: DesiredHostConfiguration;
  readonly actions: readonly HostAction[];
  readonly explanation: string;
}

export interface ReconciliationPlan {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly createdAt: string;
  readonly hosts: readonly HostPreflightPlan[];
}

export interface HostInspectionRequest {
  readonly host: HostId;
  readonly scope: "user";
  readonly excludedProjectDirectory: string;
}

export interface HostExecutableCandidateRequest {
  readonly host: HostId;
  readonly candidatePath: string;
  readonly excludedProjectDirectory: string;
}

export type HostExecutableCandidateObservation =
  | Readonly<{ status: "missing" }>
  | Readonly<{
      status: "blocked";
      reason:
        | "unsafe-shadow"
        | "unsafe-executable"
        | "unsupported-shim"
        | "unverifiable-executable";
    }>
  | Readonly<{
      status: "verified";
      executable: HostExecutableAttestation;
    }>;

/*
 * This is the native filesystem/identity boundary beneath host adapters.
 * Inspection never executes the candidate. It attests the candidate and its
 * complete launch chain or fails closed.
 */
export interface HostExecutableCandidateAdapter {
  inspectCandidate(
    request: HostExecutableCandidateRequest,
  ): Promise<HostExecutableCandidateObservation>;
}

/*
 * Planning receives this semantic, read-only port instead of ProcessAdapter.
 * The host-specific implementation owns PATH-chain attestation, fixed official
 * read commands, absolute direct spawning, a neutral cwd, sanitized env,
 * bounded output, streaming redaction, strict decoding, and strict parsing.
 */
export interface HostInspectionAdapter {
  inspect(request: HostInspectionRequest): Promise<HostInspection>;
}

export interface HostApplyRequest {
  readonly host: HostId;
  readonly executableRevision: string;
  readonly expectedBeforeRevision: string;
  readonly expectedBefore: HostConfiguration;
  readonly action: HostAction;
}

export interface HostRollbackRequest {
  readonly host: HostId;
  readonly executableRevision: string;
  readonly expectedAfterRevision: string;
  readonly expectedAfter: HostConfiguration;
  readonly action: HostAction;
}

export type HostMutationResult =
  | Readonly<{
      status: "changed";
      /*
       * Exact post-mutation revision minted by the adapter after it verified
       * the requested semantic state. Portable reconciliation records this
       * before it may claim or later roll back the mutation.
       */
      stateRevision: string;
    }>
  | Readonly<{ status: "precondition-failed" }>
  | Readonly<{ status: "failed" }>;

/*
 * Mutation is also semantic: portable code cannot authorize process commands.
 * Implementations must re-attest the executable, every launch-chain object,
 * and every trusted child-environment path immediately before a direct spawn,
 * then fail if executableRevision no longer identifies that exact evidence.
 */
export interface HostMutationAdapter extends HostInspectionAdapter {
  apply(request: HostApplyRequest): Promise<HostMutationResult>;
  rollback(request: HostRollbackRequest): Promise<HostMutationResult>;
}

export type HostAdapterMap<Adapter> = Readonly<Record<HostId, Adapter>>;
