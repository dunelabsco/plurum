import type {
  HostExecutableAttestation,
  HostExecutableCandidateAdapter,
} from "../contracts.js";
import type {
  SafeHostProcessRequest,
} from "../process-policy.js";

export const CODEX_MUTATION_COMMANDS = [
  "add-marketplace",
  "remove-marketplace",
  "install-plugin",
  "uninstall-plugin",
] as const;

export type CodexMutationCommand =
  (typeof CODEX_MUTATION_COMMANDS)[number];
export type CodexCommand = CodexMutationCommand;

export type CodexProcessExecutionResult =
  | Readonly<{
      status: "completed";
      /*
       * The native authority contains and redacts bounded command output.
       * Only a successful mutation's fresh durable ownership revision crosses
       * this semantic boundary.
       */
      stateRevision: string;
    }>
  | Readonly<{ status: "timeout" }>
  | Readonly<{ status: "output-too-large" }>
  | Readonly<{ status: "precondition-failed" }>
  | Readonly<{ status: "failed" }>;

/*
 * The native runner validates the exact fixed request for `command`, then
 * re-attests the executable chain and trusted environment paths immediately
 * before direct spawn. Portable pre-attestation is not an atomic spawn grant.
 */
export interface CodexNativeSpawnRequest {
  readonly kind: "codex-fixed-spawn";
  readonly command: CodexCommand;
  readonly executable: HostExecutableAttestation;
  readonly executableRevision: string;
  readonly expectedStateRevision: string;
  readonly excludedProjectDirectory: string;
  readonly process: SafeHostProcessRequest;
}

export interface CodexProcessAdapter {
  run(request: CodexNativeSpawnRequest): Promise<CodexProcessExecutionResult>;
}

export interface CodexStateEvidenceRequest {
  readonly executable: HostExecutableAttestation;
  readonly executableRevision: string;
  readonly excludedProjectDirectory: string;
  readonly scope: "user";
}

export type CodexSlotEvidence = Readonly<{
  readonly status: "absent" | "ambiguous" | "exact" | "mismatched";
}>;

export type CodexPluginEvidence =
  | Readonly<{ readonly status: "absent" | "ambiguous" }>
  | Readonly<{
      readonly status: "exact" | "mismatched";
      readonly version: string;
      readonly enabled: boolean;
    }>;

export interface CodexStateEvidence {
  /*
   * One native authority produces this coherent, locally non-mutating semantic
   * snapshot without invoking the normal Codex CLI. Its revision changes after
   * every relevant user marketplace/plugin/direct-MCP mutation and never
   * repeats after delete/recreate; it is not a content hash.
   */
  readonly revision: string;
  readonly version: string;
  readonly marketplace: CodexSlotEvidence;
  readonly plugin: CodexPluginEvidence;
  /*
   * `exact` attests the complete bundled v0.1 declaration: canonical endpoint,
   * PLURUM_API_KEY bearer-token environment reference, the fixed Codex client
   * header, no static authorization material, and the integrity-bound cache.
   * Raw paths, TOML, environment values, and headers never cross this port.
   */
  readonly pluginMcp: CodexSlotEvidence;
  /*
   * Direct-MCP evidence is independent so duplicate configuration fails
   * closed without exposing private Codex configuration.
   */
  readonly directMcp: CodexSlotEvidence;
}

/*
 * Official Codex JSON parsers remain conformance-test utilities. Production
 * inspection uses this native read-only semantic capability because normal
 * Codex CLI startup mutates CODEX_HOME even for list/version commands.
 */
export interface CodexStateEvidenceAdapter {
  observe(request: CodexStateEvidenceRequest): Promise<CodexStateEvidence>;
}

/*
 * Candidate discovery, spawn re-attestation, state bracketing, CAS, and
 * ownership receipts must share one native authority and revision domain.
 */
export interface CodexNativeAdapter
  extends HostExecutableCandidateAdapter,
    CodexProcessAdapter,
    CodexStateEvidenceAdapter {}

export interface CodexAdapterDependencies {
  readonly native: CodexNativeAdapter;
  readonly neutralWorkingDirectory: string;
}
