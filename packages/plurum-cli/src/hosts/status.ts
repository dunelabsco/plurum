import {
  HOST_IDS,
  type DesiredHostConfiguration,
  type HostConfiguration,
  type HostId,
  type HostInspection,
  type HostPlanClassification,
  type HostPreflightPlan,
  type ObservedSlot,
} from "./contracts.js";
import { createHostPreflightPlan } from "./planner.js";

export type PublicHostStatus =
  | "absent"
  | "healthy"
  | "incomplete"
  | "duplicated"
  | "mismatched"
  | "unknown"
  // Reserved for future trustworthy host-activation evidence. Configuration
  // inspection alone must never infer this state.
  | "restart-required";

export type PublicHostStatusReason =
  | "host-not-installed"
  | "configuration-healthy"
  | "newer-compatible-plugin"
  | "configuration-incomplete"
  | "direct-mcp-only"
  | "unsupported-host-version"
  | "automatic-repair-unavailable"
  | "duplicate-configuration"
  | "ambiguous-configuration"
  | "configuration-mismatched"
  | "unsafe-host-executable"
  | "inspection-unavailable";

export type PublicHostMcpState =
  | "plugin"
  | "direct"
  | "duplicated"
  | "absent"
  | "ambiguous"
  | "mismatched"
  | "unknown";

export interface PublicHostStatusMcp {
  readonly state: PublicHostMcpState;
  readonly endpoint: string | null;
}

export interface PublicHostStatusProjection {
  readonly client: HostId;
  readonly status: PublicHostStatus;
  readonly reason: PublicHostStatusReason;
  readonly hostVersion: string | null;
  readonly pluginVersion: string | null;
  readonly pluginEnabled: boolean | null;
  readonly mcp: PublicHostStatusMcp;
}

type PublicClassification = Readonly<{
  status: Exclude<PublicHostStatus, "restart-required">;
  reason: PublicHostStatusReason;
}>;

const PUBLIC_CLASSIFICATION: Readonly<
  Record<HostPlanClassification, PublicClassification>
> = Object.freeze({
  absent: Object.freeze({
    status: "absent",
    reason: "host-not-installed",
  }),
  unsafe: Object.freeze({
    status: "unknown",
    reason: "unsafe-host-executable",
  }),
  unavailable: Object.freeze({
    status: "unknown",
    reason: "inspection-unavailable",
  }),
  "unsupported-version": Object.freeze({
    status: "incomplete",
    reason: "unsupported-host-version",
  }),
  healthy: Object.freeze({
    status: "healthy",
    reason: "configuration-healthy",
  }),
  "healthy-newer": Object.freeze({
    status: "healthy",
    reason: "newer-compatible-plugin",
  }),
  "needs-changes": Object.freeze({
    status: "incomplete",
    reason: "configuration-incomplete",
  }),
  "direct-only": Object.freeze({
    status: "incomplete",
    reason: "direct-mcp-only",
  }),
  duplicate: Object.freeze({
    status: "duplicated",
    reason: "duplicate-configuration",
  }),
  mismatched: Object.freeze({
    status: "mismatched",
    reason: "configuration-mismatched",
  }),
  ambiguous: Object.freeze({
    status: "duplicated",
    reason: "ambiguous-configuration",
  }),
  irreversible: Object.freeze({
    status: "incomplete",
    reason: "automatic-repair-unavailable",
  }),
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

function desiredHost(value: unknown): HostId | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const host = (value as Readonly<{ host?: unknown }>).host;
    if (typeof host !== "string" || !HOST_IDS.includes(host as HostId)) {
      return null;
    }
    return host as HostId;
  } catch {
    return null;
  }
}

function unknownProjection(client: HostId): PublicHostStatusProjection {
  return deepFreeze({
    client,
    status: "unknown" as const,
    reason: "inspection-unavailable" as const,
    hostVersion: null,
    pluginVersion: null,
    pluginEnabled: null,
    mcp: {
      state: "unknown" as const,
      endpoint: null,
    },
  });
}

function exactEndpoint<Value extends { readonly endpoint: string }>(
  slot: ObservedSlot<Value>,
  desiredEndpoint: string,
): boolean {
  return (
    slot.status === "present" &&
    slot.value.endpoint === desiredEndpoint
  );
}

function mcpProjection(
  configuration: HostConfiguration | null,
  desiredEndpoint: string,
  absentHost: boolean,
): PublicHostStatusMcp {
  if (configuration === null) {
    return deepFreeze({
      state: absentHost ? ("absent" as const) : ("unknown" as const),
      endpoint: null,
    });
  }

  const plugin = configuration.pluginMcp;
  const direct = configuration.directMcp;
  if (plugin.status === "ambiguous" || direct.status === "ambiguous") {
    return deepFreeze({ state: "ambiguous" as const, endpoint: null });
  }

  const pluginPresent = plugin.status === "present";
  const directPresent = direct.status === "present";
  const pluginExact = exactEndpoint(plugin, desiredEndpoint);
  const directExact = exactEndpoint(direct, desiredEndpoint);

  if (pluginPresent && directPresent) {
    return pluginExact && directExact
      ? deepFreeze({
          state: "duplicated" as const,
          endpoint: desiredEndpoint,
        })
      : deepFreeze({ state: "mismatched" as const, endpoint: null });
  }
  if (pluginPresent) {
    return pluginExact
      ? deepFreeze({ state: "plugin" as const, endpoint: desiredEndpoint })
      : deepFreeze({ state: "mismatched" as const, endpoint: null });
  }
  if (directPresent) {
    return directExact
      ? deepFreeze({ state: "direct" as const, endpoint: desiredEndpoint })
      : deepFreeze({ state: "mismatched" as const, endpoint: null });
  }
  return deepFreeze({ state: "absent" as const, endpoint: null });
}

function pluginProjection(
  configuration: HostConfiguration | null,
): Readonly<{
  pluginVersion: string | null;
  pluginEnabled: boolean | null;
}> {
  if (configuration?.plugin.status !== "present") {
    return Object.freeze({ pluginVersion: null, pluginEnabled: null });
  }
  return Object.freeze({
    pluginVersion: configuration.plugin.value.version,
    pluginEnabled: configuration.plugin.value.enabled,
  });
}

function projectPlan(plan: HostPreflightPlan): PublicHostStatusProjection {
  const classification = PUBLIC_CLASSIFICATION[plan.classification];
  const plugin = pluginProjection(plan.baseline?.configuration ?? null);
  return deepFreeze({
    client: plan.host,
    status: classification.status,
    reason: classification.reason,
    hostVersion: plan.detectedVersion,
    pluginVersion: plugin.pluginVersion,
    pluginEnabled: plugin.pluginEnabled,
    mcp: mcpProjection(
      plan.baseline?.configuration ?? null,
      plan.desired.mcp.endpoint,
      plan.classification === "absent",
    ),
  });
}

/*
 * Project one already-scoped semantic inspection into a deliberately small
 * public DTO. Executable paths, revisions, sources, planner explanations, and
 * noncanonical endpoint values never cross this boundary.
 */
export function projectHostStatus(
  inspection: HostInspection,
  desired: DesiredHostConfiguration,
): PublicHostStatusProjection {
  const client = desiredHost(desired);
  if (client === null) {
    throw new Error("The host status request is invalid.");
  }
  try {
    return projectPlan(createHostPreflightPlan(inspection, desired));
  } catch {
    return unknownProjection(client);
  }
}
