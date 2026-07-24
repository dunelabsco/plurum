import type { ClientTarget } from "./types.js";
import type { HostId } from "../hosts/contracts.js";
import type {
  PublicHostStatusProjection as StatusHostReport,
} from "../hosts/status.js";

export const STATUS_REPORT_SCHEMA_VERSION = 1 as const;

export type StatusCredentialSource =
  | "environment"
  | "canonical"
  | "hermes"
  | "openclaw"
  | "removed-cli";

export type StatusOverall = "healthy" | "attention-required";

export type StatusApiReachability =
  | "reachable"
  | "unavailable"
  | "unknown";

export type StatusApiHealth = "healthy" | "unhealthy" | "unknown";

export type StatusCredentialState =
  | "ready"
  | "missing"
  | "pending"
  | "invalid"
  | "selection-required"
  | "mismatched"
  | "unsafe"
  | "unavailable";

export type StatusCredentialPermissions =
  | "verified-user-only"
  | "not-applicable"
  | "unsafe"
  | "unknown";

export type StatusAgentVerification =
  | "verified"
  | "not-configured"
  | "pending"
  | "invalid-credential"
  | "selection-required"
  | "mismatched"
  | "unavailable";

export type StatusCredentialProjection =
  | "not-applicable"
  | "exact"
  | "absent"
  | "mismatched"
  | "ambiguous"
  | "unsafe"
  | "unavailable";

export interface StatusCredentialReport {
  readonly state: StatusCredentialState;
  readonly sources: readonly StatusCredentialSource[];
  readonly permissions: StatusCredentialPermissions;
  readonly fingerprint: string | null;
  readonly candidateCount: number;
}

export interface StatusAgentReport {
  readonly verification: StatusAgentVerification;
  readonly id: string | null;
  readonly displayName: string | null;
  readonly username: string | null;
  /*
   * `/agents/me` proves only the active case. A 401/403 cannot distinguish an
   * unknown key from a deactivated agent, so status must never invent false.
   */
  readonly active: true | null;
}

export interface StatusClientReport extends StatusHostReport {
  readonly credentialProjection: StatusCredentialProjection;
}

export interface StatusReportV1 {
  readonly schemaVersion: typeof STATUS_REPORT_SCHEMA_VERSION;
  readonly overall: StatusOverall;
  readonly requestedClient: ClientTarget;
  readonly selectedClients: readonly HostId[];
  readonly cli: Readonly<{
    version: string;
  }>;
  readonly api: Readonly<{
    origin: string | null;
    reachability: StatusApiReachability;
    health: StatusApiHealth;
  }>;
  readonly credential: StatusCredentialReport;
  readonly agent: StatusAgentReport;
  readonly clients: readonly StatusClientReport[];
}

export interface StatusJsonSuccessEnvelope {
  readonly schema_version: typeof STATUS_REPORT_SCHEMA_VERSION;
  readonly ok: true;
  readonly command: "status";
  readonly result: Readonly<{
    overall: StatusOverall;
    requested_client: ClientTarget;
    selected_clients: readonly HostId[];
    cli: Readonly<{
      version: string;
    }>;
    api: Readonly<{
      origin: string | null;
      reachability: StatusApiReachability;
      health: StatusApiHealth;
    }>;
    credential: Readonly<{
      state: StatusCredentialState;
      sources: readonly StatusCredentialSource[];
      permissions: StatusCredentialPermissions;
      fingerprint: string | null;
      candidate_count: number;
    }>;
    agent: Readonly<{
      verification: StatusAgentVerification;
      id: string | null;
      display_name: string | null;
      username: string | null;
      active: true | null;
    }>;
    clients: readonly Readonly<{
      client: HostId;
      status: StatusHostReport["status"];
      reason: StatusHostReport["reason"];
      host_version: string | null;
      plugin_version: string | null;
      plugin_enabled: boolean | null;
      credential_projection: StatusCredentialProjection;
      mcp: Readonly<{
        state: StatusHostReport["mcp"]["state"];
        endpoint: string | null;
      }>;
    }>[];
  }>;
}
