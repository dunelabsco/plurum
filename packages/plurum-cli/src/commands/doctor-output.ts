import { ExitCode } from "../exit-codes.js";
import {
  CLAUDE_CODE_MINIMUM_VERSION,
  CLAUDE_CODE_PLUGIN_COMPATIBLE_MAXIMUM_EXCLUSIVE,
  CLAUDE_CODE_PLUGIN_VERSION,
} from "../hosts/claude-code/configuration.js";
import {
  CODEX_MINIMUM_VERSION,
  CODEX_PLUGIN_COMPATIBLE_MAXIMUM_EXCLUSIVE,
  CODEX_PLUGIN_VERSION,
} from "../hosts/codex/configuration.js";
import { compareCanonicalVersions } from "../hosts/version.js";
import type { DiagnosticRuntime } from "../runtime.js";
import {
  RECOGNIZED_RUNTIME_TARGETS,
  RELEASED_RUNTIME_TARGETS,
  type ReleasedRuntimePlatformTarget,
  type RuntimePlatformTarget,
} from "../system/runtime-support.js";
import {
  DOCTOR_CHECK_IDS,
  DOCTOR_FINDING_OUTCOMES,
  DOCTOR_FINDING_REASONS,
  DOCTOR_GUIDANCE_CODES,
  DOCTOR_REPORT_SCHEMA_VERSION,
  type DoctorCheckId,
  type DoctorFindingOutcome,
  type DoctorFindingReason,
  type DoctorGuidanceCode,
  type DoctorJsonSuccessEnvelope,
  type DoctorReportV1,
  type DoctorRuntimePlatformReport,
} from "./doctor-contracts.js";
import { createStatusJsonEnvelope } from "./status-output.js";

const CLIENT_VALUES = ["claude-code", "codex"] as const;
const REQUESTED_CLIENT_VALUES = [...CLIENT_VALUES, "all"] as const;
const OVERALL_VALUES = ["healthy", "attention-required"] as const;
const MCP_REACHABILITY_VALUES = ["reachable", "unavailable"] as const;
const MCP_HEALTH_VALUES = ["healthy", "unhealthy", "unknown"] as const;
const NODE_VERSION =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const MAX_OBJECT_PROPERTIES = 64;
const MAX_FINDINGS = 16;
const MAX_GUIDANCE_PER_FINDING = 4;
const MAX_PUBLIC_DATA_DEPTH = 8;
const MAX_PUBLIC_ARRAY_ITEMS = 32;
const MAX_PUBLIC_STRING_CHARACTERS = 4_096;
const MCP_ENDPOINT = "https://mcp.plurum.ai/mcp";
const TARGET_PLUGIN_VERSION = Object.freeze({
  "claude-code": CLAUDE_CODE_PLUGIN_VERSION,
  codex: CODEX_PLUGIN_VERSION,
});
const MINIMUM_HOST_VERSION = Object.freeze({
  "claude-code": CLAUDE_CODE_MINIMUM_VERSION,
  codex: CODEX_MINIMUM_VERSION,
});
const PLUGIN_COMPATIBLE_MAXIMUM_EXCLUSIVE = Object.freeze({
  "claude-code": CLAUDE_CODE_PLUGIN_COMPATIBLE_MAXIMUM_EXCLUSIVE,
  codex: CODEX_PLUGIN_COMPATIBLE_MAXIMUM_EXCLUSIVE,
});

type FindingPolicy = readonly [
  check: DoctorCheckId,
  outcome: DoctorFindingOutcome,
  guidance: readonly DoctorGuidanceCode[],
];

type SetupGuidanceCode = "run-setup" | "resume-setup" | "install-plugin";

type EmbeddedStatus = NonNullable<DoctorReportV1["status"]>;

const REASON_POLICIES = {
  "runtime-platform-supported": [["runtime-platform", "pass", []]],
  "runtime-version-unsupported": [[
    "runtime-platform",
    "attention",
    ["update-runtime"],
  ]],
  "platform-target-unsupported": [[
    "runtime-platform",
    "attention",
    ["use-supported-platform"],
  ]],
  "runtime-platform-observation-unavailable": [[
    "runtime-platform",
    "unknown",
    ["retry-runtime-observation"],
  ]],
  "runtime-platform-observation-mismatched": [[
    "runtime-platform",
    "unknown",
    ["retry-runtime-observation"],
  ]],
  "status-healthy": [["status", "pass", []]],
  "status-attention-required": [["status", "attention", []]],
  "status-not-checked": [["status", "not-checked", []]],
  "api-healthy": [["api", "pass", []]],
  "api-unhealthy": [["api", "attention", ["retry-connectivity"]]],
  "api-unavailable": [["api", "unknown", ["retry-connectivity"]]],
  "api-origin-unknown": [[
    "api",
    "unknown",
    ["review-credential-configuration"],
  ]],
  "credential-ready": [["credential", "pass", []]],
  "canonical-credential-missing": [["credential", "attention", ["run-setup"]]],
  "credential-missing": [["credential", "attention", ["run-setup"]]],
  "credential-pending": [["credential", "attention", ["resume-setup"]]],
  "credential-invalid": [[
    "credential",
    "attention",
    ["review-credential-configuration"],
  ]],
  "credential-selection-required": [[
    "credential",
    "attention",
    ["resolve-credential-selection"],
  ]],
  "credential-mismatched": [[
    "credential",
    "attention",
    ["review-credential-configuration"],
  ]],
  "credential-unsafe": [[
    "credential",
    "attention",
    ["secure-credential-source-manually"],
  ]],
  "credential-unavailable": [[
    "credential",
    "unknown",
    ["review-credential-configuration"],
  ]],
  "host-supported": [["host", "pass", []]],
  "host-not-installed": [["host", "not-checked", ["install-host"]]],
  "host-version-unsupported": [["host", "attention", ["update-host"]]],
  "host-executable-unsafe": [[
    "host",
    "attention",
    ["review-host-installation"],
  ]],
  "host-inspection-unavailable": [[
    "host",
    "unknown",
    ["review-host-installation"],
  ]],
  "plugin-configuration-healthy": [["plugin-configuration", "pass", []]],
  "plugin-newer-compatible": [["plugin-configuration", "pass", []]],
  "plugin-not-installed": [
    ["plugin-configuration", "not-checked", []],
    ["plugin-configuration", "attention", ["install-plugin"]],
  ],
  "plugin-disabled": [[
    "plugin-configuration",
    "attention",
    ["enable-plugin"],
  ]],
  "plugin-outdated": [[
    "plugin-configuration",
    "attention",
    ["update-plugin-manually"],
  ]],
  "plugin-configuration-incomplete": [[
    "plugin-configuration",
    "attention",
    ["review-plugin-configuration"],
  ]],
  "plugin-configuration-mismatched": [[
    "plugin-configuration",
    "attention",
    ["review-plugin-configuration"],
  ]],
  "plugin-configuration-unknown": [
    ["plugin-configuration", "unknown", ["review-plugin-configuration"]],
    ["plugin-configuration", "not-checked", []],
    [
      "plugin-configuration",
      "unknown",
      ["resolve-ambiguous-local-registration"],
    ],
  ],
  "local-plugin-registration-healthy": [["local-registration", "pass", []]],
  "direct-registration-only": [[
    "local-registration",
    "attention",
    ["review-direct-registration"],
  ]],
  "duplicate-local-registration": [[
    "local-registration",
    "attention",
    ["resolve-duplicate-local-registration"],
  ]],
  "ambiguous-local-registration": [[
    "local-registration",
    "attention",
    ["resolve-ambiguous-local-registration"],
  ]],
  "mismatched-local-registration": [[
    "local-registration",
    "attention",
    ["review-local-registration"],
  ]],
  "local-registration-missing": [
    ["local-registration", "not-checked", []],
    ["local-registration", "attention", ["run-setup"]],
  ],
  "local-registration-unknown": [[
    "local-registration",
    "unknown",
    ["review-local-registration"],
  ]],
  "credential-projection-exact": [["credential-projection", "pass", []]],
  "credential-projection-absent": [[
    "credential-projection",
    "attention",
    ["run-setup"],
  ]],
  "credential-projection-mismatched": [[
    "credential-projection",
    "attention",
    ["review-codex-credential-projection"],
  ]],
  "credential-projection-ambiguous": [[
    "credential-projection",
    "attention",
    ["review-codex-credential-projection"],
  ]],
  "credential-projection-unsafe": [[
    "credential-projection",
    "attention",
    ["secure-credential-source-manually"],
  ]],
  "credential-projection-unavailable": [[
    "credential-projection",
    "unknown",
    ["review-codex-credential-projection"],
  ]],
  "credential-projection-not-applicable": [[
    "credential-projection",
    "not-checked",
    [],
  ]],
  "mcp-authentication-boundary-healthy": [[
    "mcp-authentication-boundary",
    "pass",
    [],
  ]],
  "mcp-authentication-boundary-unhealthy": [[
    "mcp-authentication-boundary",
    "attention",
    ["retry-connectivity"],
  ]],
  "mcp-authentication-boundary-unavailable": [[
    "mcp-authentication-boundary",
    "unknown",
    ["retry-connectivity"],
  ]],
  "mcp-authentication-boundary-not-checked": [[
    "mcp-authentication-boundary",
    "not-checked",
    [],
  ]],
  "mcp-protocol-not-verified": [
    ["mcp-protocol", "not-checked", []],
  ],
} as const satisfies Readonly<
  Record<DoctorFindingReason, readonly FindingPolicy[]>
>;

const FIXED_GUIDANCE_TEXT: Readonly<
  Record<Exclude<DoctorGuidanceCode, SetupGuidanceCode>, string>
> =
  Object.freeze({
    "update-runtime":
      "Install Node.js 22.12+ within Node.js 22, or install Node.js 24, then rerun doctor.",
    "use-supported-platform":
      "Use a released Plurum build for this operating system, architecture, and libc.",
    "retry-runtime-observation":
      "Repair or reinstall the Plurum CLI runtime support, then rerun doctor.",
    "retry-connectivity":
      "Check network access to Plurum and rerun doctor.",
    "resolve-credential-selection":
      "Choose the intended Plurum credential through setup before continuing.",
    "review-credential-configuration":
      "Review the configured Plurum credential sources, then rerun doctor.",
    "secure-credential-source-manually":
      "Correct the credential source ownership, access, or link safety manually before setup.",
    "install-host": "Install the selected host, then rerun doctor.",
    "update-host": "Update the selected host to a supported version.",
    "review-host-installation":
      "Review the selected host installation and executable trust, then rerun doctor.",
    "enable-plugin": "Enable the Plurum plugin, then rerun doctor.",
    "update-plugin-manually":
      "Update the Plurum plugin through the host's supported plugin workflow.",
    "review-plugin-configuration":
      "Review the Plurum plugin configuration before running setup.",
    "review-direct-registration":
      "Review the direct Plurum MCP registration before switching to the plugin.",
    "resolve-duplicate-local-registration":
      "Keep one intended Plurum registration path and remove the duplicate manually.",
    "resolve-ambiguous-local-registration":
      "Resolve the ambiguous Plurum registration manually before setup.",
    "review-local-registration":
      "Review the existing Plurum-named registration before setup.",
    "review-codex-credential-projection":
      "Review the Codex credential projection before setup.",
  });

function guidanceText(
  code: DoctorGuidanceCode,
  finding: DoctorJsonSuccessEnvelope["result"]["findings"][number],
  requestedClient: (typeof REQUESTED_CLIENT_VALUES)[number],
): string {
  const target = finding.client ?? requestedClient;
  switch (code) {
    case "run-setup":
      return `Run plurum setup --client ${target} after reviewing its exact plan.`;
    case "resume-setup":
      return `Run plurum setup --client ${target} to resume the pending setup safely.`;
    case "install-plugin":
      return `Run plurum setup --client ${target} to install the Plurum plugin.`;
    default:
      return FIXED_GUIDANCE_TEXT[code];
  }
}

class DoctorOutputError extends Error {
  constructor() {
    super("The doctor report could not be rendered safely.");
    this.name = "DoctorOutputError";
  }
}

interface DataSnapshot {
  readonly names: readonly string[];
  readonly values: Readonly<Record<string, unknown>>;
}

function invalid(): never {
  throw new DoctorOutputError();
}

function snapshotDataObject(value: unknown): DataSnapshot {
  try {
    const prototype =
      value !== null && typeof value === "object"
        ? Object.getPrototypeOf(value)
        : undefined;
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (prototype !== Object.prototype && prototype !== null)
    ) {
      return invalid();
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length > MAX_OBJECT_PROPERTIES ||
      keys.some((key) => typeof key !== "string")
    ) {
      return invalid();
    }
    const names = keys as string[];
    const copied: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        return invalid();
      }
      copied[name] = descriptor.value;
    }
    return Object.freeze({
      names: Object.freeze([...names]),
      values: Object.freeze(copied),
    });
  } catch (error) {
    if (error instanceof DoctorOutputError) {
      throw error;
    }
    return invalid();
  }
}

function exactSnapshot(
  snapshot: DataSnapshot,
  expectedNames: readonly string[],
): Readonly<Record<string, unknown>> {
  if (
    snapshot.names.length !== expectedNames.length ||
    snapshot.names.some((name) => !expectedNames.includes(name)) ||
    expectedNames.some((name) => !snapshot.names.includes(name))
  ) {
    return invalid();
  }
  return snapshot.values;
}

function exactObject(
  value: unknown,
  expectedNames: readonly string[],
): Readonly<Record<string, unknown>> {
  return exactSnapshot(snapshotDataObject(value), expectedNames);
}

function snapshotArray(value: unknown, maximum: number): readonly unknown[] {
  try {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      return invalid();
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length = lengthDescriptor?.value;
    if (
      lengthDescriptor === undefined ||
      !Object.hasOwn(lengthDescriptor, "value") ||
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > maximum ||
      lengthDescriptor.enumerable !== false ||
      lengthDescriptor.get !== undefined ||
      lengthDescriptor.set !== undefined
    ) {
      return invalid();
    }
    const keys = Reflect.ownKeys(value);
    const expected = [
      ...Array.from({ length }, (_entry, index) => String(index)),
      "length",
    ];
    if (
      keys.length !== expected.length ||
      keys.some((key) => typeof key !== "string" || !expected.includes(key))
    ) {
      return invalid();
    }
    const copied: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        return invalid();
      }
      copied.push(descriptor.value);
    }
    return Object.freeze(copied);
  } catch (error) {
    if (error instanceof DoctorOutputError) {
      throw error;
    }
    return invalid();
  }
}

function snapshotPublicData(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" &&
      value.length <= MAX_PUBLIC_STRING_CHARACTERS)
  ) {
    return value;
  }
  if (
    depth >= MAX_PUBLIC_DATA_DEPTH ||
    value === null ||
    typeof value !== "object" ||
    seen.has(value)
  ) {
    return invalid();
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return Object.freeze(
      snapshotArray(value, MAX_PUBLIC_ARRAY_ITEMS).map((entry) =>
        snapshotPublicData(entry, depth + 1, seen),
      ),
    );
  }
  const snapshot = snapshotDataObject(value);
  const copied: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const name of snapshot.names) {
    copied[name] = snapshotPublicData(
      snapshot.values[name],
      depth + 1,
      seen,
    );
  }
  return Object.freeze(copied);
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): Values[number] {
  return typeof value === "string" && values.includes(value)
    ? (value as Values[number])
    : invalid();
}

function projectSelectedClients(
  value: unknown,
  requested: (typeof REQUESTED_CLIENT_VALUES)[number],
): readonly (typeof CLIENT_VALUES)[number][] {
  const selected = Object.freeze(
    snapshotArray(value, CLIENT_VALUES.length).map((client) =>
      enumValue(client, CLIENT_VALUES),
    ),
  );
  if (
    (requested === "all" &&
      (selected.length !== 2 ||
        selected[0] !== "claude-code" ||
        selected[1] !== "codex")) ||
    (requested !== "all" &&
      (selected.length !== 1 || selected[0] !== requested))
  ) {
    return invalid();
  }
  return selected;
}

function publicNodeVersion(value: unknown): string {
  return typeof value === "string" &&
    value.length <= 128 &&
    NODE_VERSION.test(value)
    ? value
    : invalid();
}

function identifierAtLeast(value: string, minimum: string): boolean {
  return value.length > minimum.length ||
    (value.length === minimum.length && value >= minimum);
}

function supportedNodeVersion(version: string): boolean {
  const match = NODE_VERSION.exec(version);
  if (match === null) {
    return false;
  }
  const major = match[1];
  const minor = match[2];
  return major === "24" ||
    (major === "22" && minor !== undefined && identifierAtLeast(minor, "12"));
}

function recognizedTarget(value: unknown): RuntimePlatformTarget | null {
  if (value === null) {
    return null;
  }
  return typeof value === "string" &&
    RECOGNIZED_RUNTIME_TARGETS.includes(value as RuntimePlatformTarget)
    ? (value as RuntimePlatformTarget)
    : invalid();
}

function projectRuntimePlatform(
  value: unknown,
): DoctorRuntimePlatformReport {
  const snapshot = snapshotDataObject(value);
  const status = snapshot.values.status;
  if (status === "supported") {
    const object = exactSnapshot(snapshot, [
      "status",
      "runtime",
      "version",
      "target",
    ]);
    const target = recognizedTarget(object.target);
    const version = publicNodeVersion(object.version);
    if (
      object.runtime !== "node" ||
      !supportedNodeVersion(version) ||
      target === null ||
      !RELEASED_RUNTIME_TARGETS.includes(
        target as ReleasedRuntimePlatformTarget,
      )
    ) {
      return invalid();
    }
    return Object.freeze({
      status: "supported" as const,
      runtime: "node" as const,
      version,
      target: target as ReleasedRuntimePlatformTarget,
    });
  }
  if (status === "unsupported") {
    const object = exactSnapshot(snapshot, [
      "status",
      "reason",
      "runtime",
      "version",
      "target",
    ]);
    if (
      object.runtime !== "node" ||
      (object.reason !== "node-version" &&
        object.reason !== "platform-target")
    ) {
      return invalid();
    }
    const version = publicNodeVersion(object.version);
    const target = recognizedTarget(object.target);
    const versionSupported = supportedNodeVersion(version);
    const targetReleased = target !== null &&
      RELEASED_RUNTIME_TARGETS.includes(
        target as ReleasedRuntimePlatformTarget,
      );
    if (
      (object.reason === "node-version" && versionSupported) ||
      (object.reason === "platform-target" &&
        (!versionSupported || targetReleased))
    ) {
      return invalid();
    }
    return Object.freeze({
      status: "unsupported" as const,
      reason: object.reason,
      runtime: "node" as const,
      version,
      target,
    });
  }
  if (status === "unavailable") {
    const object = exactSnapshot(snapshot, [
      "status",
      "reason",
      "runtime",
      "version",
      "target",
    ]);
    if (
      (object.reason !== "observation-unavailable" &&
        object.reason !== "platform-observation-mismatch") ||
      object.runtime !== null ||
      object.version !== null ||
      object.target !== null
    ) {
      return invalid();
    }
    return Object.freeze({
      status: "unavailable" as const,
      reason: object.reason,
      runtime: null,
      version: null,
      target: null,
    });
  }
  return invalid();
}

function projectMcp(
  value: unknown,
): DoctorJsonSuccessEnvelope["result"]["mcp"] {
  if (value === null) {
    return null;
  }
  const object = exactObject(value, ["reachability", "health"]);
  const reachability = enumValue(
    object.reachability,
    MCP_REACHABILITY_VALUES,
  );
  const health = enumValue(object.health, MCP_HEALTH_VALUES);
  if (
    (reachability === "reachable" && health === "unknown") ||
    (reachability === "unavailable" && health !== "unknown")
  ) {
    return invalid();
  }
  if (reachability === "unavailable") {
    return Object.freeze({
      reachability: "unavailable" as const,
      health: "unknown" as const,
    });
  }
  if (health !== "healthy" && health !== "unhealthy") {
    return invalid();
  }
  return Object.freeze({ reachability: "reachable" as const, health });
}

function sameGuidance(
  left: readonly DoctorGuidanceCode[],
  right: readonly DoctorGuidanceCode[],
): boolean {
  return left.length === right.length &&
    left.every((entry, index) => entry === right[index]);
}

function projectFinding(value: unknown): DoctorJsonSuccessEnvelope["result"]["findings"][number] {
  const object = exactObject(value, [
    "check",
    "outcome",
    "reason",
    "client",
    "guidance",
  ]);
  const check = enumValue(object.check, DOCTOR_CHECK_IDS);
  const outcome = enumValue(object.outcome, DOCTOR_FINDING_OUTCOMES);
  const reason = enumValue(object.reason, DOCTOR_FINDING_REASONS);
  const client = object.client === null
    ? null
    : enumValue(object.client, CLIENT_VALUES);
  const guidance = Object.freeze(
    snapshotArray(object.guidance, MAX_GUIDANCE_PER_FINDING).map((code) =>
      enumValue(code, DOCTOR_GUIDANCE_CODES),
    ),
  );
  if (new Set(guidance).size !== guidance.length) {
    return invalid();
  }

  const clientCheck =
    check === "host" ||
    check === "plugin-configuration" ||
    check === "local-registration" ||
    check === "credential-projection";
  if (
    clientCheck !== (client !== null) ||
    (check === "credential-projection" && client !== "codex") ||
    !REASON_POLICIES[reason].some(
      ([expectedCheck, expectedOutcome, expectedGuidance]) =>
        expectedCheck === check &&
        expectedOutcome === outcome &&
        sameGuidance(guidance, expectedGuidance),
    )
  ) {
    return invalid();
  }
  return Object.freeze({ check, outcome, reason, client, guidance });
}

function expectedFindingKeys(
  selected: readonly (typeof CLIENT_VALUES)[number][],
  runtimeSupported: boolean,
): readonly string[] {
  if (!runtimeSupported) {
    return Object.freeze([
      "runtime-platform:",
      "status:",
      "mcp-authentication-boundary:",
      "mcp-protocol:",
    ]);
  }
  const keys = ["runtime-platform:", "status:", "api:", "credential:"];
  for (const client of selected) {
    keys.push(
      `host:${client}`,
      `plugin-configuration:${client}`,
      `local-registration:${client}`,
    );
    if (client === "codex") {
      keys.push(`credential-projection:${client}`);
    }
  }
  keys.push("mcp-authentication-boundary:", "mcp-protocol:");
  return Object.freeze(keys);
}

function validateFindingInventory(
  findings: DoctorJsonSuccessEnvelope["result"]["findings"],
  expected: readonly string[],
): void {
  const actual = findings.map(
    (finding) => `${finding.check}:${finding.client ?? ""}`,
  );
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    return invalid();
  }
}

function validateGlobalFindings(
  findings: DoctorJsonSuccessEnvelope["result"]["findings"],
  runtime: DoctorRuntimePlatformReport,
  status: DoctorJsonSuccessEnvelope["result"]["status"],
  mcp: DoctorJsonSuccessEnvelope["result"]["mcp"],
): void {
  const byCheck = new Map(
    findings
      .filter((finding) => finding.client === null)
      .map((finding) => [finding.check, finding] as const),
  );
  const runtimeReason = runtime.status === "supported"
    ? "runtime-platform-supported"
    : runtime.reason === "node-version"
      ? "runtime-version-unsupported"
      : runtime.reason === "platform-target"
        ? "platform-target-unsupported"
        : runtime.reason === "platform-observation-mismatch"
          ? "runtime-platform-observation-mismatched"
          : "runtime-platform-observation-unavailable";
  const statusReason = status === null
    ? "status-not-checked"
    : status.overall === "healthy"
      ? "status-healthy"
      : "status-attention-required";
  const mcpReason = mcp === null
    ? "mcp-authentication-boundary-not-checked"
    : mcp.reachability === "reachable" && mcp.health === "healthy"
      ? "mcp-authentication-boundary-healthy"
      : mcp.reachability === "reachable"
        ? "mcp-authentication-boundary-unhealthy"
        : "mcp-authentication-boundary-unavailable";
  if (
    byCheck.get("runtime-platform")?.reason !== runtimeReason ||
    byCheck.get("status")?.reason !== statusReason ||
    byCheck.get("mcp-authentication-boundary")?.reason !== mcpReason ||
    byCheck.get("mcp-protocol")?.reason !== "mcp-protocol-not-verified" ||
    byCheck.get("mcp-protocol")?.outcome !== "not-checked"
  ) {
    return invalid();
  }
}

type PublicFinding =
  DoctorJsonSuccessEnvelope["result"]["findings"][number];
type PublicStatus = NonNullable<
  DoctorJsonSuccessEnvelope["result"]["status"]
>;
type PublicClient = PublicStatus["clients"][number];

function versionComparison(left: string, right: string): number | null {
  try {
    return compareCanonicalVersions(left, right);
  } catch {
    return null;
  }
}

function absentClientCoherent(client: PublicClient): boolean {
  return client.status === "absent" &&
    client.reason === "host-not-installed" &&
    client.host_version === null &&
    client.plugin_version === null &&
    client.plugin_enabled === null &&
    client.credential_projection === "not-applicable" &&
    client.mcp.state === "absent" &&
    client.mcp.endpoint === null;
}

function healthyClientCoherent(client: PublicClient): boolean {
  if (
    client.status !== "healthy" ||
    (client.reason !== "configuration-healthy" &&
      client.reason !== "newer-compatible-plugin") ||
    client.host_version === null ||
    client.plugin_version === null ||
    client.plugin_enabled !== true ||
    client.mcp.state !== "plugin" ||
    client.mcp.endpoint !== MCP_ENDPOINT ||
    (client.client === "claude-code"
      ? client.credential_projection !== "not-applicable"
      : client.credential_projection !== "exact")
  ) {
    return false;
  }
  const hostComparison = versionComparison(
    client.host_version,
    MINIMUM_HOST_VERSION[client.client],
  );
  const pluginComparison = versionComparison(
    client.plugin_version,
    TARGET_PLUGIN_VERSION[client.client],
  );
  const pluginMaximumComparison = versionComparison(
    client.plugin_version,
    PLUGIN_COMPATIBLE_MAXIMUM_EXCLUSIVE[client.client],
  );
  if (
    hostComparison === null ||
    hostComparison < 0 ||
    pluginComparison === null ||
    pluginMaximumComparison === null ||
    pluginMaximumComparison >= 0
  ) {
    return false;
  }
  return client.reason === "configuration-healthy"
    ? pluginComparison === 0
    : pluginComparison > 0;
}

function validateEmbeddedStatusOverall(status: PublicStatus): void {
  const canonicalReady =
    status.credential.state === "ready" &&
    status.credential.sources.includes("canonical") &&
    status.credential.permissions === "verified-user-only" &&
    status.credential.fingerprint !== null &&
    status.credential.candidate_count === 1;
  const hostPolicyHealthy =
    status.requested_client === "all"
      ? status.clients.some(healthyClientCoherent) &&
        status.clients.every(
          (client) =>
            healthyClientCoherent(client) || absentClientCoherent(client),
        )
      : status.clients.length === 1 &&
        status.clients[0] !== undefined &&
        healthyClientCoherent(status.clients[0]);
  const healthy =
    status.api.origin !== null &&
    status.api.reachability === "reachable" &&
    status.api.health === "healthy" &&
    canonicalReady &&
    status.agent.verification === "verified" &&
    status.agent.id !== null &&
    status.agent.username !== null &&
    status.agent.active === true &&
    hostPolicyHealthy;
  if (status.overall !== (healthy ? "healthy" : "attention-required")) {
    return invalid();
  }
}

function expectedFinding(
  check: DoctorCheckId,
  outcome: DoctorFindingOutcome,
  reason: DoctorFindingReason,
  guidance: readonly DoctorGuidanceCode[] = [],
  client: (typeof CLIENT_VALUES)[number] | null = null,
): PublicFinding {
  return Object.freeze({
    check,
    outcome,
    reason,
    client,
    guidance: Object.freeze([...guidance]),
  });
}

function expectedRuntimeFinding(
  runtime: DoctorRuntimePlatformReport,
): PublicFinding {
  if (runtime.status === "supported") {
    return expectedFinding(
      "runtime-platform",
      "pass",
      "runtime-platform-supported",
    );
  }
  if (runtime.reason === "node-version") {
    return expectedFinding(
      "runtime-platform",
      "attention",
      "runtime-version-unsupported",
      ["update-runtime"],
    );
  }
  if (runtime.reason === "platform-target") {
    return expectedFinding(
      "runtime-platform",
      "attention",
      "platform-target-unsupported",
      ["use-supported-platform"],
    );
  }
  return expectedFinding(
    "runtime-platform",
    "unknown",
    runtime.reason === "platform-observation-mismatch"
      ? "runtime-platform-observation-mismatched"
      : "runtime-platform-observation-unavailable",
    ["retry-runtime-observation"],
  );
}

function expectedApiFinding(status: PublicStatus): PublicFinding {
  if (
    status.api.reachability === "reachable" &&
    status.api.health === "healthy"
  ) {
    return expectedFinding("api", "pass", "api-healthy");
  }
  if (
    status.api.reachability === "reachable" &&
    status.api.health === "unhealthy"
  ) {
    return expectedFinding("api", "attention", "api-unhealthy", [
      "retry-connectivity",
    ]);
  }
  if (status.api.reachability === "unavailable") {
    return expectedFinding("api", "unknown", "api-unavailable", [
      "retry-connectivity",
    ]);
  }
  return expectedFinding("api", "unknown", "api-origin-unknown", [
    "review-credential-configuration",
  ]);
}

function expectedCredentialFinding(status: PublicStatus): PublicFinding {
  const credential = status.credential;
  switch (credential.state) {
    case "ready":
      if (!credential.sources.includes("canonical")) {
        return expectedFinding(
          "credential",
          "attention",
          "canonical-credential-missing",
          ["run-setup"],
        );
      }
      return credential.permissions === "verified-user-only"
        ? expectedFinding("credential", "pass", "credential-ready")
        : expectedFinding(
            "credential",
            "unknown",
            "credential-unavailable",
            ["review-credential-configuration"],
          );
    case "missing":
      return expectedFinding(
        "credential",
        "attention",
        "credential-missing",
        ["run-setup"],
      );
    case "pending":
      return expectedFinding(
        "credential",
        "attention",
        "credential-pending",
        ["resume-setup"],
      );
    case "invalid":
      return expectedFinding(
        "credential",
        "attention",
        "credential-invalid",
        ["review-credential-configuration"],
      );
    case "selection-required":
      return expectedFinding(
        "credential",
        "attention",
        "credential-selection-required",
        ["resolve-credential-selection"],
      );
    case "mismatched":
      return expectedFinding(
        "credential",
        "attention",
        "credential-mismatched",
        ["review-credential-configuration"],
      );
    case "unsafe":
      return expectedFinding(
        "credential",
        "attention",
        "credential-unsafe",
        ["secure-credential-source-manually"],
      );
    case "unavailable":
      return expectedFinding(
        "credential",
        "unknown",
        "credential-unavailable",
        ["review-credential-configuration"],
      );
  }
}

function expectedHostFinding(client: PublicClient): PublicFinding {
  if (client.status === "absent") {
    return expectedFinding(
      "host",
      "not-checked",
      "host-not-installed",
      ["install-host"],
      client.client,
    );
  }
  if (client.reason === "unsupported-host-version") {
    return expectedFinding(
      "host",
      "attention",
      "host-version-unsupported",
      ["update-host"],
      client.client,
    );
  }
  if (client.reason === "unsafe-host-executable") {
    return expectedFinding(
      "host",
      "attention",
      "host-executable-unsafe",
      ["review-host-installation"],
      client.client,
    );
  }
  if (client.host_version === null) {
    return expectedFinding(
      "host",
      "unknown",
      "host-inspection-unavailable",
      ["review-host-installation"],
      client.client,
    );
  }
  return expectedFinding("host", "pass", "host-supported", [], client.client);
}

function pluginIsOutdated(client: PublicClient): boolean {
  if (client.plugin_version === null) {
    return false;
  }
  try {
    return compareCanonicalVersions(
      client.plugin_version,
      TARGET_PLUGIN_VERSION[client.client],
    ) < 0;
  } catch {
    return invalid();
  }
}

function expectedPluginFinding(client: PublicClient): PublicFinding {
  if (client.status === "absent") {
    return expectedFinding(
      "plugin-configuration",
      "not-checked",
      "plugin-not-installed",
      [],
      client.client,
    );
  }
  if (client.reason === "unsupported-host-version") {
    return expectedFinding(
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
    return expectedFinding(
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
    return expectedFinding(
      "plugin-configuration",
      "unknown",
      "plugin-configuration-unknown",
      ["review-plugin-configuration"],
      client.client,
    );
  }
  if (client.status === "mismatched") {
    return expectedFinding(
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
    return expectedFinding(
      "plugin-configuration",
      "attention",
      "plugin-configuration-incomplete",
      ["review-plugin-configuration"],
      client.client,
    );
  }
  if (client.plugin_version === null) {
    return expectedFinding(
      "plugin-configuration",
      "attention",
      "plugin-not-installed",
      ["install-plugin"],
      client.client,
    );
  }
  if (client.plugin_enabled === false) {
    return expectedFinding(
      "plugin-configuration",
      "attention",
      "plugin-disabled",
      ["enable-plugin"],
      client.client,
    );
  }
  if (pluginIsOutdated(client)) {
    return expectedFinding(
      "plugin-configuration",
      "attention",
      "plugin-outdated",
      ["update-plugin-manually"],
      client.client,
    );
  }
  if (client.reason === "newer-compatible-plugin") {
    return expectedFinding(
      "plugin-configuration",
      "pass",
      "plugin-newer-compatible",
      [],
      client.client,
    );
  }
  if (client.status === "healthy") {
    return expectedFinding(
      "plugin-configuration",
      "pass",
      "plugin-configuration-healthy",
      [],
      client.client,
    );
  }
  return expectedFinding(
    "plugin-configuration",
    "attention",
    "plugin-configuration-incomplete",
    ["review-plugin-configuration"],
    client.client,
  );
}

function expectedLocalRegistrationFinding(
  client: PublicClient,
): PublicFinding {
  if (client.status === "absent") {
    return expectedFinding(
      "local-registration",
      "not-checked",
      "local-registration-missing",
      [],
      client.client,
    );
  }
  switch (client.mcp.state) {
    case "plugin":
      return expectedFinding(
        "local-registration",
        "pass",
        "local-plugin-registration-healthy",
        [],
        client.client,
      );
    case "direct":
      return expectedFinding(
        "local-registration",
        "attention",
        "direct-registration-only",
        ["review-direct-registration"],
        client.client,
      );
    case "duplicated":
      return expectedFinding(
        "local-registration",
        "attention",
        "duplicate-local-registration",
        ["resolve-duplicate-local-registration"],
        client.client,
      );
    case "ambiguous":
      return expectedFinding(
        "local-registration",
        "attention",
        "ambiguous-local-registration",
        ["resolve-ambiguous-local-registration"],
        client.client,
      );
    case "mismatched":
      return expectedFinding(
        "local-registration",
        "attention",
        "mismatched-local-registration",
        ["review-local-registration"],
        client.client,
      );
    case "absent":
      return expectedFinding(
        "local-registration",
        "attention",
        "local-registration-missing",
        ["run-setup"],
        client.client,
      );
    case "unknown":
      return expectedFinding(
        "local-registration",
        "unknown",
        "local-registration-unknown",
        ["review-local-registration"],
        client.client,
      );
  }
}

function expectedCredentialProjectionFinding(
  client: PublicClient,
): PublicFinding {
  switch (client.credential_projection) {
    case "exact":
      return expectedFinding(
        "credential-projection",
        "pass",
        "credential-projection-exact",
        [],
        client.client,
      );
    case "absent":
      return expectedFinding(
        "credential-projection",
        "attention",
        "credential-projection-absent",
        ["run-setup"],
        client.client,
      );
    case "mismatched":
      return expectedFinding(
        "credential-projection",
        "attention",
        "credential-projection-mismatched",
        ["review-codex-credential-projection"],
        client.client,
      );
    case "ambiguous":
      return expectedFinding(
        "credential-projection",
        "attention",
        "credential-projection-ambiguous",
        ["review-codex-credential-projection"],
        client.client,
      );
    case "unsafe":
      return expectedFinding(
        "credential-projection",
        "attention",
        "credential-projection-unsafe",
        ["secure-credential-source-manually"],
        client.client,
      );
    case "unavailable":
      return expectedFinding(
        "credential-projection",
        "unknown",
        "credential-projection-unavailable",
        ["review-codex-credential-projection"],
        client.client,
      );
    case "not-applicable":
      return expectedFinding(
        "credential-projection",
        "not-checked",
        "credential-projection-not-applicable",
        [],
        client.client,
      );
  }
}

function expectedMcpFinding(
  mcp: NonNullable<DoctorJsonSuccessEnvelope["result"]["mcp"]>,
): PublicFinding {
  if (mcp.reachability === "reachable" && mcp.health === "healthy") {
    return expectedFinding(
      "mcp-authentication-boundary",
      "pass",
      "mcp-authentication-boundary-healthy",
    );
  }
  if (mcp.reachability === "reachable") {
    return expectedFinding(
      "mcp-authentication-boundary",
      "attention",
      "mcp-authentication-boundary-unhealthy",
      ["retry-connectivity"],
    );
  }
  return expectedFinding(
    "mcp-authentication-boundary",
    "unknown",
    "mcp-authentication-boundary-unavailable",
    ["retry-connectivity"],
  );
}

function sameFinding(left: PublicFinding, right: PublicFinding): boolean {
  return left.check === right.check &&
    left.outcome === right.outcome &&
    left.reason === right.reason &&
    left.client === right.client &&
    sameGuidance(left.guidance, right.guidance);
}

function validateFindingSemantics(
  findings: DoctorJsonSuccessEnvelope["result"]["findings"],
  runtime: DoctorRuntimePlatformReport,
  status: DoctorJsonSuccessEnvelope["result"]["status"],
  mcp: DoctorJsonSuccessEnvelope["result"]["mcp"],
): void {
  const expected: PublicFinding[] = [expectedRuntimeFinding(runtime)];
  if (status === null || mcp === null) {
    expected.push(
      expectedFinding("status", "not-checked", "status-not-checked"),
      expectedFinding(
        "mcp-authentication-boundary",
        "not-checked",
        "mcp-authentication-boundary-not-checked",
      ),
      expectedFinding(
        "mcp-protocol",
        "not-checked",
        "mcp-protocol-not-verified",
      ),
    );
  } else {
    expected.push(
      status.overall === "healthy"
        ? expectedFinding("status", "pass", "status-healthy")
        : expectedFinding(
            "status",
            "attention",
            "status-attention-required",
          ),
      expectedApiFinding(status),
      expectedCredentialFinding(status),
    );
    for (const client of status.clients) {
      expected.push(
        expectedHostFinding(client),
        expectedPluginFinding(client),
        expectedLocalRegistrationFinding(client),
      );
      if (client.client === "codex") {
        expected.push(expectedCredentialProjectionFinding(client));
      }
    }
    expected.push(
      expectedMcpFinding(mcp),
      expectedFinding(
        "mcp-protocol",
        "not-checked",
        "mcp-protocol-not-verified",
      ),
    );
  }
  if (
    findings.length !== expected.length ||
    findings.some((finding, index) => {
      const expectedFindingAtIndex = expected[index];
      return expectedFindingAtIndex === undefined ||
        !sameFinding(finding, expectedFindingAtIndex);
    })
  ) {
    return invalid();
  }
}

export function createDoctorJsonEnvelope(
  report: DoctorReportV1,
): DoctorJsonSuccessEnvelope {
  const object = exactObject(report, [
    "schemaVersion",
    "overall",
    "requestedClient",
    "selectedClients",
    "runtimePlatform",
    "status",
    "mcp",
    "findings",
  ]);
  if (object.schemaVersion !== DOCTOR_REPORT_SCHEMA_VERSION) {
    return invalid();
  }
  const overall = enumValue(object.overall, OVERALL_VALUES);
  const requestedClient = enumValue(
    object.requestedClient,
    REQUESTED_CLIENT_VALUES,
  );
  const selectedClients = projectSelectedClients(
    object.selectedClients,
    requestedClient,
  );
  const runtimePlatform = projectRuntimePlatform(object.runtimePlatform);
  const runtimeSupported = runtimePlatform.status === "supported";

  let status: DoctorJsonSuccessEnvelope["result"]["status"] = null;
  if (object.status !== null) {
    try {
      status = createStatusJsonEnvelope(
        snapshotPublicData(object.status) as EmbeddedStatus,
      ).result;
    } catch {
      return invalid();
    }
  }
  const mcp = projectMcp(object.mcp);
  if (
    runtimeSupported !== (status !== null) ||
    runtimeSupported !== (mcp !== null) ||
    (status !== null &&
      (status.requested_client !== requestedClient ||
        status.selected_clients.length !== selectedClients.length ||
        status.selected_clients.some(
          (client, index) => client !== selectedClients[index],
        )))
  ) {
    return invalid();
  }
  if (status !== null) {
    validateEmbeddedStatusOverall(status);
  }

  const findings = Object.freeze(
    snapshotArray(object.findings, MAX_FINDINGS).map(projectFinding),
  );
  validateFindingInventory(
    findings,
    expectedFindingKeys(selectedClients, runtimeSupported),
  );
  validateGlobalFindings(findings, runtimePlatform, status, mcp);
  validateFindingSemantics(findings, runtimePlatform, status, mcp);

  const expectedOverall =
    runtimeSupported &&
    status?.overall === "healthy" &&
    mcp?.reachability === "reachable" &&
    mcp.health === "healthy" &&
    !findings.some(
      (finding) =>
        finding.outcome === "attention" || finding.outcome === "unknown",
    )
      ? "healthy"
      : "attention-required";
  if (overall !== expectedOverall) {
    return invalid();
  }

  return Object.freeze({
    schema_version: DOCTOR_REPORT_SCHEMA_VERSION,
    ok: true as const,
    command: "doctor" as const,
    result: Object.freeze({
      overall,
      requested_client: requestedClient,
      selected_clients: selectedClients,
      runtime_platform: runtimePlatform,
      status,
      mcp,
      findings,
    }),
  });
}

function shown(value: string | number | boolean | null): string {
  return value === null ? "not available" : JSON.stringify(value);
}

function renderDoctorEnvelopeText(envelope: DoctorJsonSuccessEnvelope): string {
  const result = envelope.result;
  const runtime = result.runtime_platform;
  const lines = [
    "Plurum doctor",
    `overall: ${result.overall}`,
    `requested client: ${result.requested_client}`,
    `selected clients: ${result.selected_clients.join(", ")}`,
    `runtime/platform status: ${runtime.status}`,
    `runtime: ${shown(runtime.runtime)}`,
    `runtime version: ${shown(runtime.version)}`,
    `platform target: ${shown(runtime.target)}`,
  ];
  if (runtime.status !== "supported") {
    lines.push(`runtime/platform reason: ${runtime.reason}`);
  }

  if (result.status === null) {
    lines.push("status observation: not checked");
  } else {
    lines.push(
      `status observation: ${result.status.overall}`,
      `api reachability: ${result.status.api.reachability}`,
      `api health: ${result.status.api.health}`,
      `credential state: ${result.status.credential.state}`,
      `credential permissions: ${result.status.credential.permissions}`,
      "clients:",
    );
    for (const client of result.status.clients) {
      lines.push(
        `  ${client.client}: ${client.status}`,
        `    reason: ${client.reason}`,
        `    host version: ${shown(client.host_version)}`,
        `    plugin version: ${shown(client.plugin_version)}`,
        `    plugin enabled: ${shown(client.plugin_enabled)}`,
        `    local MCP registration: ${client.mcp.state}`,
        `    credential projection: ${client.credential_projection}`,
      );
    }
  }

  lines.push(
    result.mcp === null
      ? "MCP authentication boundary: not checked"
      : `MCP authentication boundary: ${result.mcp.reachability}/${result.mcp.health}`,
    "findings:",
  );
  for (const finding of result.findings) {
    const scope = finding.client === null
      ? finding.check
      : `${finding.client}/${finding.check}`;
    lines.push(`  ${scope}: ${finding.outcome} (${finding.reason})`);
  }

  const guided = result.findings.filter(
    (finding) => finding.guidance.length !== 0,
  );
  lines.push("repair guidance:");
  if (guided.length === 0) {
    lines.push("  none");
  } else {
    for (const finding of guided) {
      const scope = finding.client === null
        ? finding.check
        : `${finding.client}/${finding.check}`;
      for (const code of finding.guidance) {
        lines.push(
          `  ${scope} — ${code}: ${guidanceText(
            code,
            finding,
            result.requested_client,
          )}`,
        );
      }
    }
  }
  lines.push(
    "MCP protocol initialization and tool inventory were not checked.",
    "Repair guidance was not executed.",
    "No local configuration changes were made.",
  );
  return `${lines.join("\n")}\n`;
}

export function renderDoctorJson(report: DoctorReportV1): string {
  return `${JSON.stringify(createDoctorJsonEnvelope(report))}\n`;
}

export function renderDoctorText(report: DoctorReportV1): string {
  return renderDoctorEnvelopeText(createDoctorJsonEnvelope(report));
}

export function writeDoctorReport(
  report: DoctorReportV1,
  json: boolean,
  runtime: DiagnosticRuntime,
): ExitCode {
  const envelope = createDoctorJsonEnvelope(report);
  runtime.stdout.write(
    json
      ? `${JSON.stringify(envelope)}\n`
      : renderDoctorEnvelopeText(envelope),
  );
  return envelope.result.overall === "healthy"
    ? ExitCode.Success
    : ExitCode.OperationalFailure;
}
