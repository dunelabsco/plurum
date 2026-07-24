import type {
  McpAuthenticationBoundaryResult,
} from "../api/reachability.js";
import type { HostId } from "../hosts/contracts.js";
import type {
  RuntimePlatformSupportResult,
} from "../system/runtime-support.js";
import type {
  StatusJsonSuccessEnvelope,
  StatusReportV1,
} from "./status-contracts.js";
import type { ClientTarget } from "./types.js";

export const DOCTOR_REPORT_SCHEMA_VERSION = 1 as const;

export type DoctorOverall = "healthy" | "attention-required";

export const DOCTOR_FINDING_OUTCOMES = Object.freeze([
  "pass",
  "attention",
  "unknown",
  "not-checked",
] as const);

export type DoctorFindingOutcome =
  (typeof DOCTOR_FINDING_OUTCOMES)[number];

export const DOCTOR_CHECK_IDS = Object.freeze([
  "runtime-platform",
  "status",
  "api",
  "credential",
  "host",
  "plugin-configuration",
  "local-registration",
  "credential-projection",
  "mcp-authentication-boundary",
  "mcp-protocol",
] as const);

export type DoctorCheckId = (typeof DOCTOR_CHECK_IDS)[number];

export const DOCTOR_FINDING_REASONS = Object.freeze([
  "runtime-platform-supported",
  "runtime-version-unsupported",
  "platform-target-unsupported",
  "runtime-platform-observation-unavailable",
  "runtime-platform-observation-mismatched",
  "status-healthy",
  "status-attention-required",
  "status-not-checked",
  "api-healthy",
  "api-unhealthy",
  "api-unavailable",
  "api-origin-unknown",
  "credential-ready",
  "canonical-credential-missing",
  "credential-missing",
  "credential-pending",
  "credential-invalid",
  "credential-selection-required",
  "credential-mismatched",
  "credential-unsafe",
  "credential-unavailable",
  "host-supported",
  "host-not-installed",
  "host-version-unsupported",
  "host-executable-unsafe",
  "host-inspection-unavailable",
  "plugin-configuration-healthy",
  "plugin-newer-compatible",
  "plugin-not-installed",
  "plugin-disabled",
  "plugin-outdated",
  "plugin-configuration-incomplete",
  "plugin-configuration-mismatched",
  "plugin-configuration-unknown",
  "local-plugin-registration-healthy",
  "direct-registration-only",
  "duplicate-local-registration",
  "ambiguous-local-registration",
  "mismatched-local-registration",
  "local-registration-missing",
  "local-registration-unknown",
  "credential-projection-exact",
  "credential-projection-absent",
  "credential-projection-mismatched",
  "credential-projection-ambiguous",
  "credential-projection-unsafe",
  "credential-projection-unavailable",
  "credential-projection-not-applicable",
  "mcp-authentication-boundary-healthy",
  "mcp-authentication-boundary-unhealthy",
  "mcp-authentication-boundary-unavailable",
  "mcp-authentication-boundary-not-checked",
  "mcp-protocol-not-verified",
] as const);

export type DoctorFindingReason =
  (typeof DOCTOR_FINDING_REASONS)[number];

export const DOCTOR_GUIDANCE_CODES = Object.freeze([
  "update-runtime",
  "use-supported-platform",
  "retry-runtime-observation",
  "retry-connectivity",
  "run-setup",
  "resume-setup",
  "resolve-credential-selection",
  "review-credential-configuration",
  "secure-credential-source-manually",
  "install-host",
  "update-host",
  "review-host-installation",
  "install-plugin",
  "enable-plugin",
  "update-plugin-manually",
  "review-plugin-configuration",
  "review-direct-registration",
  "resolve-duplicate-local-registration",
  "resolve-ambiguous-local-registration",
  "review-local-registration",
  "review-codex-credential-projection",
] as const);

export type DoctorGuidanceCode =
  (typeof DOCTOR_GUIDANCE_CODES)[number];

export interface DoctorFinding {
  readonly check: DoctorCheckId;
  readonly outcome: DoctorFindingOutcome;
  readonly reason: DoctorFindingReason;
  readonly client: HostId | null;
  readonly guidance: readonly DoctorGuidanceCode[];
}

export type DoctorRuntimePlatformReport =
  | RuntimePlatformSupportResult
  | Readonly<{
      readonly status: "unavailable";
      readonly reason: "platform-observation-mismatch";
      readonly runtime: null;
      readonly version: null;
      readonly target: null;
    }>;

export interface DoctorReportV1 {
  readonly schemaVersion: typeof DOCTOR_REPORT_SCHEMA_VERSION;
  readonly overall: DoctorOverall;
  readonly requestedClient: ClientTarget;
  readonly selectedClients: readonly HostId[];
  readonly runtimePlatform: DoctorRuntimePlatformReport;
  readonly status: StatusReportV1 | null;
  readonly mcp: McpAuthenticationBoundaryResult | null;
  readonly findings: readonly DoctorFinding[];
}

export interface DoctorJsonSuccessEnvelope {
  readonly schema_version: typeof DOCTOR_REPORT_SCHEMA_VERSION;
  readonly ok: true;
  readonly command: "doctor";
  readonly result: Readonly<{
    readonly overall: DoctorOverall;
    readonly requested_client: ClientTarget;
    readonly selected_clients: readonly HostId[];
    readonly runtime_platform: DoctorRuntimePlatformReport;
    readonly status: StatusJsonSuccessEnvelope["result"] | null;
    readonly mcp: McpAuthenticationBoundaryResult | null;
    readonly findings: readonly Readonly<{
      readonly check: DoctorCheckId;
      readonly outcome: DoctorFindingOutcome;
      readonly reason: DoctorFindingReason;
      readonly client: HostId | null;
      readonly guidance: readonly DoctorGuidanceCode[];
    }>[];
  }>;
}
