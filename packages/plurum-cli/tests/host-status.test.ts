import { describe, expect, it, vi } from "vitest";

import type {
  DesiredHostConfiguration,
  HostConfiguration,
  HostId,
  HostInspection,
  HostMutationSupport,
  HostPlanClassification,
} from "../src/hosts/contracts.js";
import { createHostPreflightPlan } from "../src/hosts/planner.js";
import {
  projectHostStatus,
  type PublicHostMcpState,
  type PublicHostStatus,
  type PublicHostStatusReason,
} from "../src/hosts/status.js";

type AvailableInspection = Extract<HostInspection, { status: "available" }>;

const FULL_SUPPORT: HostMutationSupport = Object.freeze({
  addMarketplace: true,
  removeMarketplace: true,
  installPlugin: true,
  removePlugin: true,
  updatePlugin: true,
  restorePlugin: true,
  enablePlugin: true,
  disablePlugin: true,
});

function desired(host: HostId = "claude-code"): DesiredHostConfiguration {
  return {
    host,
    minimumHostVersion: "1.2.0",
    marketplace: { name: "plurum", source: "dunelabsco/plurum" },
    plugin: {
      name: "plurum",
      source: "plurum@plurum",
      version: "1.4.0",
      compatibleMinimum: "1.4.0",
      compatibleMaximumExclusive: "2.0.0",
    },
    mcp: { name: "plurum", endpoint: "https://mcp.plurum.ai/mcp" },
  };
}

function executable(
  host: HostId = "claude-code",
  path = host === "claude-code"
    ? "/trusted/bin/claude"
    : "/trusted/bin/codex",
  revision = `${host}-executable-revision`,
) {
  return {
    sourcePath: path,
    resolvedPath: path,
    revision,
    chain: [
      {
        path,
        kind: "binary" as const,
        owner: "current-user" as const,
        access: "not-broadly-writable" as const,
        binding: "canonical" as const,
        link: "direct" as const,
        revision: `${revision}-chain`,
      },
    ],
    launch: {
      executable: path,
      argumentPrefix: [] as string[],
      shell: false as const,
    },
  };
}

function absentConfiguration(): HostConfiguration {
  return {
    marketplace: { status: "absent" },
    plugin: { status: "absent" },
    pluginMcp: { status: "absent" },
    directMcp: { status: "absent" },
  };
}

function healthyConfiguration(
  version = "1.4.0",
  enabled = true,
): HostConfiguration {
  return {
    marketplace: {
      status: "present",
      value: { name: "plurum", source: "dunelabsco/plurum" },
    },
    plugin: {
      status: "present",
      value: {
        name: "plurum",
        source: "plurum@plurum",
        version,
        enabled,
      },
    },
    pluginMcp: enabled
      ? {
          status: "present",
          value: {
            name: "plurum",
            endpoint: "https://mcp.plurum.ai/mcp",
          },
        }
      : { status: "absent" },
    directMcp: { status: "absent" },
  };
}

function available(
  configuration: HostConfiguration,
  options: Readonly<{
    host?: HostId;
    version?: string;
    mutationSupport?: HostMutationSupport;
    executablePath?: string;
    executableRevision?: string;
    stateRevision?: string;
  }> = {},
): AvailableInspection {
  const host = options.host ?? "claude-code";
  return {
    host,
    status: "available",
    executable: executable(
      host,
      options.executablePath,
      options.executableRevision,
    ),
    version: options.version ?? "2.1.0",
    state: {
      revision: options.stateRevision ?? `${host}-state-revision`,
      configuration,
    },
    mutationSupport: options.mutationSupport ?? FULL_SUPPORT,
  };
}

interface ClassificationCase {
  readonly classification: HostPlanClassification;
  readonly inspection: HostInspection;
  readonly status: Exclude<PublicHostStatus, "restart-required">;
  readonly reason: PublicHostStatusReason;
  readonly hostVersion: string | null;
  readonly pluginVersion: string | null;
  readonly pluginEnabled: boolean | null;
  readonly mcpState: PublicHostMcpState;
  readonly mcpEndpoint: string | null;
}

function classificationCases(): readonly ClassificationCase[] {
  const directOnly: HostConfiguration = {
    ...absentConfiguration(),
    directMcp: {
      status: "present",
      value: {
        name: "plurum",
        endpoint: "https://mcp.plurum.ai/mcp",
      },
    },
  };
  const duplicate: HostConfiguration = {
    ...healthyConfiguration(),
    directMcp: {
      status: "present",
      value: {
        name: "plurum",
        endpoint: "https://mcp.plurum.ai/mcp",
      },
    },
  };
  const mismatched: HostConfiguration = {
    ...healthyConfiguration(),
    pluginMcp: {
      status: "present",
      value: {
        name: "plurum",
        endpoint: "https://different.example/mcp",
      },
    },
  };
  const ambiguous: HostConfiguration = {
    ...absentConfiguration(),
    plugin: { status: "ambiguous" },
  };
  return Object.freeze([
    {
      classification: "absent",
      inspection: { host: "claude-code", status: "absent" },
      status: "absent",
      reason: "host-not-installed",
      hostVersion: null,
      pluginVersion: null,
      pluginEnabled: null,
      mcpState: "absent",
      mcpEndpoint: null,
    },
    {
      classification: "unsafe",
      inspection: {
        host: "claude-code",
        status: "blocked",
        reason: "unsafe-executable",
        candidatePath: "/untrusted/bin/claude",
      },
      status: "unknown",
      reason: "unsafe-host-executable",
      hostVersion: null,
      pluginVersion: null,
      pluginEnabled: null,
      mcpState: "unknown",
      mcpEndpoint: null,
    },
    {
      classification: "unavailable",
      inspection: {
        host: "claude-code",
        status: "unavailable",
        reason: "probe-timeout",
        executable: executable(),
      },
      status: "unknown",
      reason: "inspection-unavailable",
      hostVersion: null,
      pluginVersion: null,
      pluginEnabled: null,
      mcpState: "unknown",
      mcpEndpoint: null,
    },
    {
      classification: "unsupported-version",
      inspection: available(healthyConfiguration(), { version: "1.1.9" }),
      status: "incomplete",
      reason: "unsupported-host-version",
      hostVersion: "1.1.9",
      pluginVersion: "1.4.0",
      pluginEnabled: true,
      mcpState: "plugin",
      mcpEndpoint: "https://mcp.plurum.ai/mcp",
    },
    {
      classification: "healthy",
      inspection: available(healthyConfiguration()),
      status: "healthy",
      reason: "configuration-healthy",
      hostVersion: "2.1.0",
      pluginVersion: "1.4.0",
      pluginEnabled: true,
      mcpState: "plugin",
      mcpEndpoint: "https://mcp.plurum.ai/mcp",
    },
    {
      classification: "healthy-newer",
      inspection: available(healthyConfiguration("1.9.0")),
      status: "healthy",
      reason: "newer-compatible-plugin",
      hostVersion: "2.1.0",
      pluginVersion: "1.9.0",
      pluginEnabled: true,
      mcpState: "plugin",
      mcpEndpoint: "https://mcp.plurum.ai/mcp",
    },
    {
      classification: "needs-changes",
      inspection: available(absentConfiguration()),
      status: "incomplete",
      reason: "configuration-incomplete",
      hostVersion: "2.1.0",
      pluginVersion: null,
      pluginEnabled: null,
      mcpState: "absent",
      mcpEndpoint: null,
    },
    {
      classification: "direct-only",
      inspection: available(directOnly),
      status: "incomplete",
      reason: "direct-mcp-only",
      hostVersion: "2.1.0",
      pluginVersion: null,
      pluginEnabled: null,
      mcpState: "direct",
      mcpEndpoint: "https://mcp.plurum.ai/mcp",
    },
    {
      classification: "duplicate",
      inspection: available(duplicate),
      status: "duplicated",
      reason: "duplicate-configuration",
      hostVersion: "2.1.0",
      pluginVersion: "1.4.0",
      pluginEnabled: true,
      mcpState: "duplicated",
      mcpEndpoint: "https://mcp.plurum.ai/mcp",
    },
    {
      classification: "mismatched",
      inspection: available(mismatched),
      status: "mismatched",
      reason: "configuration-mismatched",
      hostVersion: "2.1.0",
      pluginVersion: "1.4.0",
      pluginEnabled: true,
      mcpState: "mismatched",
      mcpEndpoint: null,
    },
    {
      classification: "ambiguous",
      inspection: available(ambiguous),
      status: "duplicated",
      reason: "ambiguous-configuration",
      hostVersion: "2.1.0",
      pluginVersion: null,
      pluginEnabled: null,
      mcpState: "absent",
      mcpEndpoint: null,
    },
    {
      classification: "irreversible",
      inspection: available(absentConfiguration(), {
        mutationSupport: { ...FULL_SUPPORT, removePlugin: false },
      }),
      status: "incomplete",
      reason: "automatic-repair-unavailable",
      hostVersion: "2.1.0",
      pluginVersion: null,
      pluginEnabled: null,
      mcpState: "absent",
      mcpEndpoint: null,
    },
  ]);
}

function expectDeepFrozen(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return;
  }
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.getOwnPropertySymbols(value)).toEqual([]);
  for (const child of Object.values(value)) {
    expectDeepFrozen(child, seen);
  }
}

describe("host status projection", () => {
  it.each(classificationCases())(
    "maps planner classification $classification to $status",
    (testCase) => {
      expect(
        createHostPreflightPlan(testCase.inspection, desired()).classification,
      ).toBe(testCase.classification);

      const result = projectHostStatus(testCase.inspection, desired());

      expect(result).toEqual({
        client: "claude-code",
        status: testCase.status,
        reason: testCase.reason,
        hostVersion: testCase.hostVersion,
        pluginVersion: testCase.pluginVersion,
        pluginEnabled: testCase.pluginEnabled,
        mcp: {
          state: testCase.mcpState,
          endpoint: testCase.mcpEndpoint,
        },
      });
      expect(result.status).not.toBe("restart-required");
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(result.mcp)).toBe(Object.prototype);
      expectDeepFrozen(result);
    },
  );

  it("uses the selected desired client without exposing executable evidence", () => {
    const privatePath = "/Users/private/CANARY_HOST_EXECUTABLE";
    const privateRevision = "CANARY-PRIVATE-REVISION";
    const privateSource = "https://private.example.invalid/CANARY_SOURCE";
    const privateEndpoint = "https://private.example.invalid/CANARY_MCP";
    const configuration: HostConfiguration = {
      ...healthyConfiguration(),
      marketplace: {
        status: "present",
        value: { name: "plurum", source: privateSource },
      },
      pluginMcp: {
        status: "present",
        value: { name: "plurum", endpoint: privateEndpoint },
      },
    };
    const inspection = available(configuration, {
      host: "codex",
      executablePath: privatePath,
      executableRevision: privateRevision,
      stateRevision: `${privateRevision}-state`,
    });

    const result = projectHostStatus(inspection, desired("codex"));
    const serialized = JSON.stringify(result);

    expect(result).toEqual({
      client: "codex",
      status: "mismatched",
      reason: "configuration-mismatched",
      hostVersion: "2.1.0",
      pluginVersion: "1.4.0",
      pluginEnabled: true,
      mcp: { state: "mismatched", endpoint: null },
    });
    for (const canary of [
      privatePath,
      privateRevision,
      privateSource,
      privateEndpoint,
    ]) {
      expect(serialized).not.toContain(canary);
    }
    expect(serialized).not.toContain("explanation");
    expect(serialized).not.toContain("revision");
    expect(serialized).not.toContain("sourcePath");
  });

  it("emits only the canonical endpoint when another host field mismatches", () => {
    const privateSource = "https://private.example.invalid/not-public";
    const configuration: HostConfiguration = {
      ...healthyConfiguration(),
      marketplace: {
        status: "present",
        value: { name: "plurum", source: privateSource },
      },
    };

    const result = projectHostStatus(available(configuration), desired());

    expect(result.status).toBe("mismatched");
    expect(result.mcp).toEqual({
      state: "plugin",
      endpoint: "https://mcp.plurum.ai/mcp",
    });
    expect(JSON.stringify(result)).not.toContain(privateSource);
  });

  it("withholds an endpoint when duplicated declarations do not both match", () => {
    const privateEndpoint = "https://private.example.invalid/not-public";
    const configuration: HostConfiguration = {
      ...healthyConfiguration(),
      directMcp: {
        status: "present",
        value: { name: "plurum", endpoint: privateEndpoint },
      },
    };

    const result = projectHostStatus(available(configuration), desired());

    expect(result.status).toBe("mismatched");
    expect(result.mcp).toEqual({ state: "mismatched", endpoint: null });
    expect(JSON.stringify(result)).not.toContain(privateEndpoint);
  });

  it("reports ambiguous MCP evidence without selecting another exact entry", () => {
    const configuration: HostConfiguration = {
      ...healthyConfiguration(),
      pluginMcp: { status: "ambiguous" },
      directMcp: {
        status: "present",
        value: {
          name: "plurum",
          endpoint: "https://mcp.plurum.ai/mcp",
        },
      },
    };

    const result = projectHostStatus(available(configuration), desired());

    expect(result.status).toBe("duplicated");
    expect(result.reason).toBe("ambiguous-configuration");
    expect(result.mcp).toEqual({ state: "ambiguous", endpoint: null });
  });

  it("fails hostile observations closed without reflecting accessors or keys", () => {
    const secret = "plrm_live_HOST_STATUS_CANARY";
    const getter = vi.fn(() => {
      throw new Error(secret);
    });
    const hostile = {
      host: "claude-code",
      get status() {
        return getter();
      },
    } as unknown as HostInspection;

    const result = projectHostStatus(hostile, desired());

    expect(result).toEqual({
      client: "claude-code",
      status: "unknown",
      reason: "inspection-unavailable",
      hostVersion: null,
      pluginVersion: null,
      pluginEnabled: null,
      mcp: { state: "unknown", endpoint: null },
    });
    expect(getter).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(secret);
    expectDeepFrozen(result);
  });

  it("does not reflect a secret-shaped blocked candidate path", () => {
    const secret = "plrm_live_HOST_STATUS_BLOCKED_CANARY";
    const inspection: HostInspection = {
      host: "claude-code",
      status: "blocked",
      reason: "unsafe-executable",
      candidatePath: `/untrusted/${secret}`,
    };

    const result = projectHostStatus(inspection, desired());

    expect(result.status).toBe("unknown");
    expect(result.reason).toBe("inspection-unavailable");
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
