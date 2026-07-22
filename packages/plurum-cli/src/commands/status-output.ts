import { ExitCode } from "../exit-codes.js";
import {
  containsHostControlCharacter,
  containsHostSensitiveMaterial,
} from "../hosts/privacy.js";
import type { HostId } from "../hosts/contracts.js";
import type { DiagnosticRuntime } from "../runtime.js";
import {
  STATUS_REPORT_SCHEMA_VERSION,
  type StatusJsonSuccessEnvelope,
  type StatusReportV1,
} from "./status-contracts.js";

const FINGERPRINT = /^plurum-fp-v1:[0-9a-f]{12}$/u;
const AGENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const USERNAME = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u;
const PUBLIC_VERSION = /^[0-9A-Za-z](?:[0-9A-Za-z.+-]{0,126}[0-9A-Za-z])?$/u;
const MCP_ENDPOINT = "https://mcp.plurum.ai/mcp";
const UNSAFE_DISPLAY = /[\\/\p{Cf}\u2028\u2029]/u;
const ORIGIN_CONTROL = /[\u0000-\u001f\u007f]/u;
const PLURUM_KEY_MATERIAL = /plrm_(?:live|test)_[A-Za-z0-9_-]{10,200}/iu;
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
const OVERALL_VALUES = ["healthy", "attention-required"] as const;
const CLIENT_VALUES = ["claude-code", "codex"] as const;
const REQUESTED_CLIENT_VALUES = [...CLIENT_VALUES, "all"] as const;
const API_REACHABILITY_VALUES = [
  "reachable",
  "unavailable",
  "unknown",
] as const;
const API_HEALTH_VALUES = ["healthy", "unhealthy", "unknown"] as const;
const CREDENTIAL_STATE_VALUES = [
  "ready",
  "missing",
  "pending",
  "invalid",
  "selection-required",
  "mismatched",
  "unsafe",
  "unavailable",
] as const;
const CREDENTIAL_PERMISSION_VALUES = [
  "verified-user-only",
  "not-applicable",
  "unsafe",
  "unknown",
] as const;
const CREDENTIAL_SOURCE_VALUES = [
  "environment",
  "canonical",
  "hermes",
  "openclaw",
  "removed-cli",
] as const;
const AGENT_VERIFICATION_VALUES = [
  "verified",
  "not-configured",
  "pending",
  "invalid-credential",
  "selection-required",
  "mismatched",
  "unavailable",
] as const;
const HOST_STATUS_VALUES = [
  "absent",
  "healthy",
  "incomplete",
  "duplicated",
  "mismatched",
  "unknown",
  "restart-required",
] as const;
const HOST_REASON_VALUES = [
  "host-not-installed",
  "configuration-healthy",
  "newer-compatible-plugin",
  "configuration-incomplete",
  "direct-mcp-only",
  "unsupported-host-version",
  "automatic-repair-unavailable",
  "duplicate-configuration",
  "ambiguous-configuration",
  "configuration-mismatched",
  "unsafe-host-executable",
  "inspection-unavailable",
] as const;
const MCP_STATE_VALUES = [
  "plugin",
  "direct",
  "duplicated",
  "absent",
  "ambiguous",
  "mismatched",
  "unknown",
] as const;
const PROJECTION_VALUES = [
  "not-applicable",
  "exact",
  "absent",
  "mismatched",
  "ambiguous",
  "unsafe",
  "unavailable",
] as const;

class StatusOutputError extends Error {
  constructor() {
    super("The status report could not be rendered safely.");
    this.name = "StatusOutputError";
  }
}

function invalid(): never {
  throw new StatusOutputError();
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): Values[number] {
  return typeof value === "string" && values.includes(value)
    ? (value as Values[number])
    : invalid();
}

function publicVersion(value: unknown): string {
  if (typeof value !== "string" || !PUBLIC_VERSION.test(value)) {
    return invalid();
  }
  return value;
}

function containsPlurumKeyMaterial(value: string): boolean {
  try {
    return (
      PLURUM_KEY_MATERIAL.test(value) ||
      PLURUM_KEY_MATERIAL.test(
        value.normalize("NFKC").replace(DEFAULT_IGNORABLE, ""),
      )
    );
  } catch {
    return true;
  }
}

function publicDisplay(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 510 ||
    containsHostControlCharacter(value) ||
    containsHostSensitiveMaterial(value) ||
    containsPlurumKeyMaterial(value) ||
    UNSAFE_DISPLAY.test(value)
  ) {
    return invalid();
  }
  return value;
}

function publicAgentId(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return typeof value === "string" && AGENT_ID.test(value)
    ? value
    : invalid();
}

function publicUsername(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return typeof value === "string" &&
    value.length >= 3 &&
    value.length <= 50 &&
    USERNAME.test(value) &&
    !containsHostSensitiveMaterial(value) &&
    !containsPlurumKeyMaterial(value)
    ? value
    : invalid();
}

function publicEndpoint(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return value === MCP_ENDPOINT ? MCP_ENDPOINT : invalid();
}

function publicOrigin(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return invalid();
  }
  if (
    value.length === 0 ||
    value.length > 2_048 ||
    value !== value.trim() ||
    ORIGIN_CONTROL.test(value) ||
    containsHostSensitiveMaterial(value) ||
    containsPlurumKeyMaterial(value) ||
    value.includes("\\") ||
    value.includes("%") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return invalid();
  }
  try {
    const parsed = new URL(value);
    const loopback =
      parsed.hostname === "[::1]" ||
      /^127\.(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})$/u.test(
        parsed.hostname,
      );
    if (
      parsed.origin !== value ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.hostname.endsWith(".") ||
      parsed.port === "0" ||
      parsed.origin === "null" ||
      (parsed.protocol !== "https:" &&
        !(parsed.protocol === "http:" && loopback))
    ) {
      return invalid();
    }
    return value;
  } catch {
    return invalid();
  }
}

function selectedClients(value: readonly HostId[]): readonly HostId[] {
  const copied = [...value];
  if (
    copied.length === 0 ||
    copied.length > 2 ||
    new Set(copied).size !== copied.length ||
    copied.some((client) => client !== "claude-code" && client !== "codex")
  ) {
    return invalid();
  }
  return Object.freeze(copied);
}

function successEnvelope(report: StatusReportV1): StatusJsonSuccessEnvelope {
  const selected = selectedClients(report.selectedClients);
  if (
    report.schemaVersion !== STATUS_REPORT_SCHEMA_VERSION ||
    report.clients.length !== selected.length ||
    report.clients.some((client, index) => client.client !== selected[index]) ||
    (report.requestedClient !== "all" &&
      (selected.length !== 1 || selected[0] !== report.requestedClient)) ||
    (report.requestedClient === "all" &&
      (selected.length !== 2 ||
        selected[0] !== "claude-code" ||
        selected[1] !== "codex"))
  ) {
    return invalid();
  }

  const fingerprint = report.credential.fingerprint;
  if (fingerprint !== null && !FINGERPRINT.test(fingerprint)) {
    return invalid();
  }
  if (
    !Number.isInteger(report.credential.candidateCount) ||
    report.credential.candidateCount < 0 ||
    report.credential.candidateCount > 32
  ) {
    return invalid();
  }

  const credentialSources = Object.freeze(
    report.credential.sources.map((source) =>
      enumValue(source, CREDENTIAL_SOURCE_VALUES),
    ),
  );
  if (new Set(credentialSources).size !== credentialSources.length) {
    return invalid();
  }

  const clients = Object.freeze(
    report.clients.map((client) =>
      Object.freeze({
        client: enumValue(client.client, CLIENT_VALUES),
        status: enumValue(client.status, HOST_STATUS_VALUES),
        reason: enumValue(client.reason, HOST_REASON_VALUES),
        host_version:
          client.hostVersion === null
            ? null
            : publicVersion(client.hostVersion),
        plugin_version:
          client.pluginVersion === null
            ? null
            : publicVersion(client.pluginVersion),
        plugin_enabled:
          client.pluginEnabled === null ||
          typeof client.pluginEnabled === "boolean"
            ? client.pluginEnabled
            : invalid(),
        credential_projection: enumValue(
          client.credentialProjection,
          PROJECTION_VALUES,
        ),
        mcp: Object.freeze({
          state: enumValue(client.mcp.state, MCP_STATE_VALUES),
          endpoint: publicEndpoint(client.mcp.endpoint),
        }),
      }),
    ),
  );

  return Object.freeze({
    schema_version: STATUS_REPORT_SCHEMA_VERSION,
    ok: true,
    command: "status",
    result: Object.freeze({
      overall: enumValue(report.overall, OVERALL_VALUES),
      requested_client: enumValue(
        report.requestedClient,
        REQUESTED_CLIENT_VALUES,
      ),
      selected_clients: selected,
      cli: Object.freeze({ version: publicVersion(report.cli.version) }),
      api: Object.freeze({
        origin: publicOrigin(report.api.origin),
        reachability: enumValue(
          report.api.reachability,
          API_REACHABILITY_VALUES,
        ),
        health: enumValue(report.api.health, API_HEALTH_VALUES),
      }),
      credential: Object.freeze({
        state: enumValue(
          report.credential.state,
          CREDENTIAL_STATE_VALUES,
        ),
        sources: credentialSources,
        permissions: enumValue(
          report.credential.permissions,
          CREDENTIAL_PERMISSION_VALUES,
        ),
        fingerprint,
        candidate_count: report.credential.candidateCount,
      }),
      agent: Object.freeze({
        verification: enumValue(
          report.agent.verification,
          AGENT_VERIFICATION_VALUES,
        ),
        id: publicAgentId(report.agent.id),
        display_name: publicDisplay(report.agent.displayName),
        username: publicUsername(report.agent.username),
        active:
          report.agent.active === true || report.agent.active === null
            ? report.agent.active
            : invalid(),
      }),
      clients,
    }),
  });
}

function shown(value: string | number | boolean | null): string {
  return value === null ? "not available" : JSON.stringify(value);
}

export function renderStatusJson(report: StatusReportV1): string {
  return `${JSON.stringify(successEnvelope(report))}\n`;
}

export function renderStatusText(report: StatusReportV1): string {
  const envelope = successEnvelope(report);
  const result = envelope.result;
  const lines = [
    "Plurum status",
    `overall: ${result.overall}`,
    `requested client: ${result.requested_client}`,
    `selected clients: ${result.selected_clients.join(", ")}`,
    `cli version: ${shown(result.cli.version)}`,
    `api origin: ${shown(result.api.origin)}`,
    `api reachability: ${result.api.reachability}`,
    `api health: ${result.api.health}`,
    `credential state: ${result.credential.state}`,
    `credential sources: ${
      result.credential.sources.length === 0
        ? "none"
        : result.credential.sources.join(", ")
    }`,
    `credential permissions: ${result.credential.permissions}`,
    `credential fingerprint: ${shown(result.credential.fingerprint)}`,
    `credential candidates: ${result.credential.candidate_count}`,
    `agent verification: ${result.agent.verification}`,
    `agent id: ${shown(result.agent.id)}`,
    `agent display name: ${shown(result.agent.display_name)}`,
    `agent username: ${shown(result.agent.username)}`,
    `agent active: ${shown(result.agent.active)}`,
    "clients:",
  ];

  for (const client of result.clients) {
    lines.push(
      `  ${client.client}: ${client.status}`,
      `    reason: ${client.reason}`,
      `    host version: ${shown(client.host_version)}`,
      `    plugin version: ${shown(client.plugin_version)}`,
      `    plugin enabled: ${shown(client.plugin_enabled)}`,
      `    credential projection: ${client.credential_projection}`,
      `    MCP state: ${client.mcp.state}`,
      `    MCP endpoint: ${shown(client.mcp.endpoint)}`,
    );
  }
  lines.push("No changes were made.");
  return `${lines.join("\n")}\n`;
}

export function writeStatusReport(
  report: StatusReportV1,
  json: boolean,
  runtime: DiagnosticRuntime,
): ExitCode {
  const output = json ? renderStatusJson(report) : renderStatusText(report);
  runtime.stdout.write(output);
  return report.overall === "healthy"
    ? ExitCode.Success
    : ExitCode.OperationalFailure;
}
