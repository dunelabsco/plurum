import {
  probeMcpAuthenticationBoundary,
  type McpAuthenticationBoundaryResult,
} from "../api/reachability.js";
import {
  CLAUDE_CODE_PLUGIN_VERSION,
} from "../hosts/claude-code/configuration.js";
import {
  CODEX_PLUGIN_VERSION,
} from "../hosts/codex/configuration.js";
import { HOST_IDS, type HostId } from "../hosts/contracts.js";
import { compareCanonicalVersions } from "../hosts/version.js";
import type { DoctorCapabilities } from "../system/contracts.js";
import {
  observeRuntimePlatformSupport,
  type RuntimePlatformSupportResult,
  type RuntimeSupportObservationAdapter,
} from "../system/runtime-support.js";
import {
  DOCTOR_REPORT_SCHEMA_VERSION,
  type DoctorFinding,
  type DoctorFindingOutcome,
  type DoctorFindingReason,
  type DoctorGuidanceCode,
  type DoctorReportV1,
  type DoctorRuntimePlatformReport,
} from "./doctor-contracts.js";
import {
  observeStatus,
  type StatusObservationDependencies,
} from "./status-observation.js";
import type { StatusReportV1 } from "./status-contracts.js";
import type { DoctorOptions } from "./types.js";

export interface DoctorObservationDependencies
  extends StatusObservationDependencies {
  readonly runtimeSupport: RuntimeSupportObservationAdapter;
}

type StatusClient = StatusReportV1["clients"][number];

const TARGET_PLUGIN_VERSION: Readonly<Record<HostId, string>> = Object.freeze({
  "claude-code": CLAUDE_CODE_PLUGIN_VERSION,
  codex: CODEX_PLUGIN_VERSION,
});

const PLATFORM_MISMATCH = Object.freeze({
  status: "unavailable" as const,
  reason: "platform-observation-mismatch" as const,
  runtime: null,
  version: null,
  target: null,
});

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function selectedClients(target: DoctorOptions["client"]): readonly HostId[] {
  return Object.freeze(target === "all" ? [...HOST_IDS] : [target]);
}

function finding(
  check: DoctorFinding["check"],
  outcome: DoctorFindingOutcome,
  reason: DoctorFindingReason,
  guidance: readonly DoctorGuidanceCode[] = [],
  client: HostId | null = null,
): DoctorFinding {
  return deepFreeze({
    check,
    outcome,
    reason,
    client,
    guidance: [...guidance],
  });
}

function targetMatchesPlatform(
  target: NonNullable<
    Exclude<
      RuntimePlatformSupportResult,
      { readonly status: "unavailable" }
    >["target"]
  >,
  capabilities: DoctorCapabilities,
): boolean {
  const os = capabilities.platform.os;
  const arch = capabilities.platform.arch;
  if (arch !== "arm64" && arch !== "x64") {
    return false;
  }
  switch (os) {
    case "darwin":
      return target === `darwin-${arch}`;
    case "linux":
      return target === `linux-${arch}-gnu` || target === `linux-${arch}-musl`;
    case "win32":
      return target === `win32-${arch}-msvc`;
    case "unsupported":
      return false;
  }
}

function normalizeRuntimePlatform(
  result: RuntimePlatformSupportResult,
  capabilities: DoctorCapabilities,
): DoctorRuntimePlatformReport {
  return result.status !== "unavailable" &&
    result.target !== null &&
    !targetMatchesPlatform(result.target, capabilities)
    ? PLATFORM_MISMATCH
    : result;
}

function runtimeFinding(
  result: DoctorRuntimePlatformReport,
): DoctorFinding {
  if (result.status === "supported") {
    return finding(
      "runtime-platform",
      "pass",
      "runtime-platform-supported",
    );
  }
  if (result.reason === "node-version") {
    return finding(
      "runtime-platform",
      "attention",
      "runtime-version-unsupported",
      ["update-runtime"],
    );
  }
  if (result.reason === "platform-target") {
    return finding(
      "runtime-platform",
      "attention",
      "platform-target-unsupported",
      ["use-supported-platform"],
    );
  }
  return finding(
    "runtime-platform",
    "unknown",
    result.reason === "platform-observation-mismatch"
      ? "runtime-platform-observation-mismatched"
      : "runtime-platform-observation-unavailable",
    ["retry-runtime-observation"],
  );
}

function shortCircuitFindings(
  runtime: DoctorRuntimePlatformReport,
): readonly DoctorFinding[] {
  return Object.freeze([
    runtimeFinding(runtime),
    finding("status", "not-checked", "status-not-checked"),
    finding(
      "mcp-authentication-boundary",
      "not-checked",
      "mcp-authentication-boundary-not-checked",
    ),
    finding("mcp-protocol", "not-checked", "mcp-protocol-not-verified"),
  ]);
}

function statusFinding(status: StatusReportV1): DoctorFinding {
  return status.overall === "healthy"
    ? finding("status", "pass", "status-healthy")
    : finding("status", "attention", "status-attention-required");
}

function apiFinding(status: StatusReportV1): DoctorFinding {
  if (
    status.api.reachability === "reachable" &&
    status.api.health === "healthy"
  ) {
    return finding("api", "pass", "api-healthy");
  }
  if (
    status.api.reachability === "reachable" &&
    status.api.health === "unhealthy"
  ) {
    return finding("api", "attention", "api-unhealthy", [
      "retry-connectivity",
    ]);
  }
  if (status.api.reachability === "unavailable") {
    return finding("api", "unknown", "api-unavailable", [
      "retry-connectivity",
    ]);
  }
  return finding("api", "unknown", "api-origin-unknown", [
    "review-credential-configuration",
  ]);
}

function credentialFinding(status: StatusReportV1): DoctorFinding {
  const credential = status.credential;
  switch (credential.state) {
    case "ready":
      if (!credential.sources.includes("canonical")) {
        return finding(
          "credential",
          "attention",
          "canonical-credential-missing",
          ["run-setup"],
        );
      }
      return credential.permissions === "verified-user-only"
        ? finding("credential", "pass", "credential-ready")
        : finding(
            "credential",
            "unknown",
            "credential-unavailable",
            ["review-credential-configuration"],
          );
    case "missing":
      return finding("credential", "attention", "credential-missing", [
        "run-setup",
      ]);
    case "pending":
      return finding("credential", "attention", "credential-pending", [
        "resume-setup",
      ]);
    case "invalid":
      return finding("credential", "attention", "credential-invalid", [
        "review-credential-configuration",
      ]);
    case "selection-required":
      return finding(
        "credential",
        "attention",
        "credential-selection-required",
        ["resolve-credential-selection"],
      );
    case "mismatched":
      return finding("credential", "attention", "credential-mismatched", [
        "review-credential-configuration",
      ]);
    case "unsafe":
      return finding("credential", "attention", "credential-unsafe", [
        "secure-credential-source-manually",
      ]);
    case "unavailable":
      return finding("credential", "unknown", "credential-unavailable", [
        "review-credential-configuration",
      ]);
  }
}

function hostFinding(client: StatusClient): DoctorFinding {
  if (client.status === "absent") {
    return finding(
      "host",
      "not-checked",
      "host-not-installed",
      ["install-host"],
      client.client,
    );
  }
  if (client.reason === "unsupported-host-version") {
    return finding(
      "host",
      "attention",
      "host-version-unsupported",
      ["update-host"],
      client.client,
    );
  }
  if (client.reason === "unsafe-host-executable") {
    return finding(
      "host",
      "attention",
      "host-executable-unsafe",
      ["review-host-installation"],
      client.client,
    );
  }
  if (client.hostVersion === null) {
    return finding(
      "host",
      "unknown",
      "host-inspection-unavailable",
      ["review-host-installation"],
      client.client,
    );
  }
  return finding("host", "pass", "host-supported", [], client.client);
}

function isOutdatedPlugin(client: StatusClient): boolean {
  if (client.pluginVersion === null) {
    return false;
  }
  try {
    return compareCanonicalVersions(
      client.pluginVersion,
      TARGET_PLUGIN_VERSION[client.client],
    ) < 0;
  } catch {
    return false;
  }
}

function pluginFinding(client: StatusClient): DoctorFinding {
  if (client.status === "absent") {
    return finding(
      "plugin-configuration",
      "not-checked",
      "plugin-not-installed",
      [],
      client.client,
    );
  }
  if (client.reason === "unsupported-host-version") {
    return finding(
      "plugin-configuration",
      "not-checked",
      "plugin-configuration-unknown",
      [],
      client.client,
    );
  }
  if (
    client.reason === "unsafe-host-executable" ||
    client.reason === "inspection-unavailable"
  ) {
    return finding(
      "plugin-configuration",
      "unknown",
      "plugin-configuration-unknown",
      ["review-plugin-configuration"],
      client.client,
    );
  }
  if (
    client.reason === "ambiguous-configuration" ||
    client.mcp.state === "ambiguous"
  ) {
    return finding(
      "plugin-configuration",
      "unknown",
      "plugin-configuration-unknown",
      ["review-plugin-configuration"],
      client.client,
    );
  }
  if (client.status === "mismatched") {
    return finding(
      "plugin-configuration",
      "attention",
      "plugin-configuration-mismatched",
      ["review-plugin-configuration"],
      client.client,
    );
  }
  if (
    client.reason === "direct-mcp-only" ||
    client.reason === "duplicate-configuration" ||
    client.reason === "automatic-repair-unavailable"
  ) {
    return finding(
      "plugin-configuration",
      "attention",
      "plugin-configuration-incomplete",
      ["review-plugin-configuration"],
      client.client,
    );
  }
  if (client.pluginVersion === null) {
    return finding(
      "plugin-configuration",
      "attention",
      "plugin-not-installed",
      ["install-plugin"],
      client.client,
    );
  }
  if (client.pluginEnabled === false) {
    return finding(
      "plugin-configuration",
      "attention",
      "plugin-disabled",
      ["enable-plugin"],
      client.client,
    );
  }
  if (isOutdatedPlugin(client)) {
    return finding(
      "plugin-configuration",
      "attention",
      "plugin-outdated",
      ["update-plugin-manually"],
      client.client,
    );
  }
  if (client.reason === "newer-compatible-plugin") {
    return finding(
      "plugin-configuration",
      "pass",
      "plugin-newer-compatible",
      [],
      client.client,
    );
  }
  if (client.status === "healthy") {
    return finding(
      "plugin-configuration",
      "pass",
      "plugin-configuration-healthy",
      [],
      client.client,
    );
  }
  return finding(
    "plugin-configuration",
    "attention",
    "plugin-configuration-incomplete",
    ["review-plugin-configuration"],
    client.client,
  );
}

function localRegistrationFinding(client: StatusClient): DoctorFinding {
  if (client.status === "absent") {
    return finding(
      "local-registration",
      "not-checked",
      "local-registration-missing",
      [],
      client.client,
    );
  }
  switch (client.mcp.state) {
    case "plugin":
      return finding(
        "local-registration",
        "pass",
        "local-plugin-registration-healthy",
        [],
        client.client,
      );
    case "direct":
      return finding(
        "local-registration",
        "attention",
        "direct-registration-only",
        ["review-direct-registration"],
        client.client,
      );
    case "duplicated":
      return finding(
        "local-registration",
        "attention",
        "duplicate-local-registration",
        ["resolve-duplicate-local-registration"],
        client.client,
      );
    case "ambiguous":
      return finding(
        "local-registration",
        "attention",
        "ambiguous-local-registration",
        ["resolve-ambiguous-local-registration"],
        client.client,
      );
    case "mismatched":
      return finding(
        "local-registration",
        "attention",
        "mismatched-local-registration",
        ["review-local-registration"],
        client.client,
      );
    case "absent":
      return finding(
        "local-registration",
        "attention",
        "local-registration-missing",
        ["run-setup"],
        client.client,
      );
    case "unknown":
      return finding(
        "local-registration",
        "unknown",
        "local-registration-unknown",
        ["review-local-registration"],
        client.client,
      );
  }
}

function credentialProjectionFinding(client: StatusClient): DoctorFinding {
  const projection = client.credentialProjection;
  switch (projection) {
    case "exact":
      return finding(
        "credential-projection",
        "pass",
        "credential-projection-exact",
        [],
        client.client,
      );
    case "absent":
      return finding(
        "credential-projection",
        "attention",
        "credential-projection-absent",
        ["run-setup"],
        client.client,
      );
    case "mismatched":
      return finding(
        "credential-projection",
        "attention",
        "credential-projection-mismatched",
        ["review-codex-credential-projection"],
        client.client,
      );
    case "ambiguous":
      return finding(
        "credential-projection",
        "attention",
        "credential-projection-ambiguous",
        ["review-codex-credential-projection"],
        client.client,
      );
    case "unsafe":
      return finding(
        "credential-projection",
        "attention",
        "credential-projection-unsafe",
        ["secure-credential-source-manually"],
        client.client,
      );
    case "unavailable":
      return finding(
        "credential-projection",
        "unknown",
        "credential-projection-unavailable",
        ["review-codex-credential-projection"],
        client.client,
      );
    case "not-applicable":
      return finding(
        "credential-projection",
        "not-checked",
        "credential-projection-not-applicable",
        [],
        client.client,
      );
  }
}

function mcpFinding(mcp: McpAuthenticationBoundaryResult): DoctorFinding {
  if (mcp.reachability === "reachable" && mcp.health === "healthy") {
    return finding(
      "mcp-authentication-boundary",
      "pass",
      "mcp-authentication-boundary-healthy",
    );
  }
  if (mcp.reachability === "reachable") {
    return finding(
      "mcp-authentication-boundary",
      "attention",
      "mcp-authentication-boundary-unhealthy",
      ["retry-connectivity"],
    );
  }
  return finding(
    "mcp-authentication-boundary",
    "unknown",
    "mcp-authentication-boundary-unavailable",
    ["retry-connectivity"],
  );
}

function checkedFindings(
  runtime: DoctorRuntimePlatformReport,
  status: StatusReportV1,
  mcp: McpAuthenticationBoundaryResult,
): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [
    runtimeFinding(runtime),
    statusFinding(status),
    apiFinding(status),
    credentialFinding(status),
  ];
  for (const client of status.clients) {
    findings.push(
      hostFinding(client),
      pluginFinding(client),
      localRegistrationFinding(client),
    );
    if (client.client === "codex") {
      findings.push(credentialProjectionFinding(client));
    }
  }
  findings.push(
    mcpFinding(mcp),
    finding("mcp-protocol", "not-checked", "mcp-protocol-not-verified"),
  );
  return Object.freeze(findings);
}

function mcpHealthy(mcp: McpAuthenticationBoundaryResult): boolean {
  return mcp.reachability === "reachable" && mcp.health === "healthy";
}

export async function observeDoctor(
  options: DoctorOptions,
  capabilities: DoctorCapabilities,
  dependencies: DoctorObservationDependencies,
): Promise<DoctorReportV1> {
  const observedRuntime = await observeRuntimePlatformSupport(
    dependencies.runtimeSupport,
  );
  const runtimePlatform = normalizeRuntimePlatform(
    observedRuntime,
    capabilities,
  );
  const selected = selectedClients(options.client);

  if (runtimePlatform.status !== "supported") {
    return deepFreeze({
      schemaVersion: DOCTOR_REPORT_SCHEMA_VERSION,
      overall: "attention-required" as const,
      requestedClient: options.client,
      selectedClients: selected,
      runtimePlatform,
      status: null,
      mcp: null,
      findings: shortCircuitFindings(runtimePlatform),
    });
  }

  const status = await observeStatus(options, capabilities, dependencies);
  const mcp = await probeMcpAuthenticationBoundary(capabilities.network);
  const findings = checkedFindings(runtimePlatform, status, mcp);
  const healthy =
    status.overall === "healthy" &&
    mcpHealthy(mcp) &&
    !findings.some(
      (entry) => entry.outcome === "attention" || entry.outcome === "unknown",
    );

  return deepFreeze({
    schemaVersion: DOCTOR_REPORT_SCHEMA_VERSION,
    overall: healthy ? ("healthy" as const) : ("attention-required" as const),
    requestedClient: options.client,
    selectedClients: selected,
    runtimePlatform,
    status,
    mcp,
    findings,
  });
}
