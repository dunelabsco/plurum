import type {
  HostExecutableAttestation,
  HostExecutableCandidateAdapter,
} from "../contracts.js";
import type {
  SafeHostProcessRequest,
} from "../process-policy.js";

export const CLAUDE_CODE_READ_COMMANDS = [
  "version",
  "list-marketplaces",
  "list-plugins",
] as const;

export const CLAUDE_CODE_MUTATION_COMMANDS = [
  "add-marketplace",
  "remove-marketplace",
  "install-plugin",
  "uninstall-plugin",
  "update-plugin",
  "enable-plugin",
  "disable-plugin",
] as const;

export type ClaudeCodeReadCommand =
  (typeof CLAUDE_CODE_READ_COMMANDS)[number];
export type ClaudeCodeMutationCommand =
  (typeof CLAUDE_CODE_MUTATION_COMMANDS)[number];
export type ClaudeCodeCommand =
  | ClaudeCodeReadCommand
  | ClaudeCodeMutationCommand;

export type ClaudeCodeProcessExecutionResult =
  | Readonly<{
      status: "completed";
      /*
       * Ownership of these bounded buffers transfers to the semantic adapter.
       * The native runner must not retain aliases and must already have applied
       * streaming redaction before returning them.
       */
      exitCode: number;
      stdout: Uint8Array;
      stderr: Uint8Array;
      /*
       * Null for reads. A mutation result carries the native adapter's fresh
       * durable ownership revision, captured under its compare-and-swap
       * mutation authority; portable reinspection must match it exactly.
       */
      stateRevision: string | null;
    }>
  | Readonly<{ status: "timeout" }>
  | Readonly<{ status: "output-too-large" }>
  | Readonly<{ status: "precondition-failed" }>
  | Readonly<{ status: "failed" }>;

/*
 * The native runner must validate that `process` is the exact fixed request for
 * `command`, then re-attest the complete executable chain and every trusted
 * environment path against `executableRevision` immediately before direct
 * spawn. Portable pre-attestation is never treated as an atomic spawn grant.
 */
export interface ClaudeCodeNativeSpawnRequest {
  readonly kind: "claude-code-fixed-spawn";
  readonly command: ClaudeCodeCommand;
  readonly executable: HostExecutableAttestation;
  readonly executableRevision: string;
  readonly expectedStateRevision: string | null;
  readonly excludedProjectDirectory: string;
  readonly process: SafeHostProcessRequest;
}

export interface ClaudeCodeProcessAdapter {
  run(
    request: ClaudeCodeNativeSpawnRequest,
  ): Promise<ClaudeCodeProcessExecutionResult>;
}

export interface ClaudeCodeStateEvidenceRequest {
  readonly executable: HostExecutableAttestation;
  readonly executableRevision: string;
  readonly excludedProjectDirectory: string;
  readonly scope: "user";
}

export interface ClaudeCodeStateEvidence {
  /*
   * Native evidence must change for every relevant mutation and must not repeat
   * after delete/recreate. It brackets marketplace/plugin command reads and
   * covers user-scope marketplace, plugin, cached declaration/helper, and
   * direct-MCP state. It is not a content hash.
   */
  readonly revision: string;
  /*
   * `exact` plugin evidence attests the complete fixed v0.2 declaration:
   * canonical endpoint, static client header, constant headersHelper command,
   * and integrity-bound bundled helper. Plugin ID/version alone is not enough.
   * `mismatched` never carries the raw URL, command, path, or header data.
   */
  readonly pluginMcp: ClaudeCodeMcpEvidence;
  /*
   * Direct-MCP evidence similarly reports only whether the named entry is
   * absent, ambiguous, exact-canonical, or mismatched; raw config is private.
   */
  readonly directMcp: ClaudeCodeMcpEvidence;
}

export type ClaudeCodeMcpEvidence = Readonly<{
  readonly status: "absent" | "ambiguous" | "exact" | "mismatched";
}>;

/*
 * Direct MCP configuration and durable revision evidence have no documented
 * stable Claude JSON command today, so they remain behind a narrow native
 * semantic capability instead of parsing prose or private config here.
 */
export interface ClaudeCodeStateEvidenceAdapter {
  observe(
    request: ClaudeCodeStateEvidenceRequest,
  ): Promise<ClaudeCodeStateEvidence>;
}

/*
 * Discovery/re-attestation, fixed spawn, state bracketing, CAS, and mutation
 * ownership evidence must come from one native authority instance. Splitting
 * these capabilities would allow incomparable revision domains.
 */
export interface ClaudeCodeNativeAdapter
  extends HostExecutableCandidateAdapter,
    ClaudeCodeProcessAdapter,
    ClaudeCodeStateEvidenceAdapter {}

export interface ClaudeCodeAdapterDependencies {
  readonly native: ClaudeCodeNativeAdapter;
  readonly neutralWorkingDirectory: string;
}
