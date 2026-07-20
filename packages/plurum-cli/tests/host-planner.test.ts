import { describe, expect, it, vi } from "vitest";

import type {
  DesiredHostConfiguration,
  HostConfiguration,
  HostId,
  HostInspection,
  HostMutationSupport,
  HostPlanClassification,
} from "../src/hosts/contracts.js";
import { HostError } from "../src/hosts/errors.js";
import {
  createHostPreflightPlan,
  createReconciliationPlan,
} from "../src/hosts/planner.js";

type AvailableInspection = Extract<HostInspection, { status: "available" }>;

const FULL_SUPPORT: HostMutationSupport = {
  addMarketplace: true,
  removeMarketplace: true,
  installPlugin: true,
  removePlugin: true,
  updatePlugin: true,
  restorePlugin: true,
  enablePlugin: true,
  disablePlugin: true,
};

function desired(host: HostId = "claude-code"): DesiredHostConfiguration {
  return {
    host,
    minimumHostVersion: "1.2.0",
    marketplace: {
      name: "plurum",
      source: "dunelabsco/plurum",
    },
    plugin: {
      name: "plurum",
      source: "plurum@plurum",
      version: "1.4.0",
      compatibleMinimum: "1.4.0",
      compatibleMaximumExclusive: "2.0.0",
    },
    mcp: {
      name: "plurum",
      endpoint: "https://mcp.plurum.ai/mcp",
    },
  };
}

function executable(host: HostId = "claude-code") {
  const path =
    host === "claude-code" ? "/trusted/bin/claude" : "/trusted/bin/codex";
  return {
    sourcePath: path,
    resolvedPath: path,
    revision: `${host}-executable-revision`,
    chain: [
      {
        path,
        kind: "binary" as const,
        owner: "current-user" as const,
        access: "not-broadly-writable" as const,
        binding: "canonical" as const,
        link: "direct" as const,
        revision: `${host}-chain-revision`,
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
  configuration: HostConfiguration = healthyConfiguration(),
  host: HostId = "claude-code",
  version = "2.1.0",
  mutationSupport: HostMutationSupport = FULL_SUPPORT,
): AvailableInspection {
  return {
    host,
    status: "available",
    executable: executable(host),
    version,
    state: {
      revision: `${host}-state-revision`,
      configuration,
    },
    mutationSupport,
  };
}

function expectDeepFrozen(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return;
  }
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) {
    expectDeepFrozen(child, seen);
  }
}

describe("host preflight planner", () => {
  it("makes exact desired configuration an immutable no-op", () => {
    const observation = available();
    const target = desired();
    const plan = createHostPreflightPlan(observation, target);

    expect(plan).toMatchObject({
      host: "claude-code",
      classification: "healthy",
      automatic: true,
      detectedVersion: "2.1.0",
      minimumVersion: "1.2.0",
      actions: [],
    });
    expectDeepFrozen(plan);

    (
      observation.state.configuration.plugin as {
        status: "present";
        value: { version: string };
      }
    ).value.version = "9.9.9";
    (
      target.plugin as {
        source: string;
      }
    ).source = "changed";

    expect(
      plan.baseline?.configuration.plugin.status === "present" &&
        plan.baseline.configuration.plugin.value.version,
    ).toBe("1.4.0");
    expect(plan.desired.plugin.source).toBe("plurum@plurum");
  });

  it("keeps a newer plugin only inside the explicit compatibility range", () => {
    const compatible = createHostPreflightPlan(
      available(healthyConfiguration("1.9.99")),
      desired(),
    );
    expect(compatible.classification).toBe("healthy-newer");
    expect(compatible.actions).toEqual([]);

    const incompatible = createHostPreflightPlan(
      available(healthyConfiguration("2.0.0")),
      desired(),
    );
    expect(incompatible.classification).toBe("mismatched");
    expect(incompatible.automatic).toBe(false);
    expect(incompatible.actions).toEqual([]);
  });

  it("plans only ordered reversible actions with exact transitions", () => {
    const configuration: HostConfiguration = {
      ...healthyConfiguration("1.2.0", false),
      marketplace: { status: "absent" },
    };
    const plan = createHostPreflightPlan(available(configuration), desired());

    expect(plan.classification).toBe("needs-changes");
    expect(plan.actions.map(({ id, kind }) => ({ id, kind }))).toEqual([
      {
        id: "claude-code:01:add-marketplace",
        kind: "add-marketplace",
      },
      {
        id: "claude-code:02:update-plugin",
        kind: "update-plugin",
      },
      {
        id: "claude-code:03:enable-plugin",
        kind: "enable-plugin",
      },
    ]);
    expect(plan.actions[0]?.rollback).toEqual({
      kind: "remove-cli-created-marketplace",
    });
    expect(plan.actions[1]?.rollback).toEqual({
      kind: "restore-plugin-version",
      pluginVersion: "1.2.0",
    });
    expect(plan.actions[2]?.rollback).toEqual({
      kind: "restore-plugin-disabled",
    });
    expect(plan.actions[0]?.before.marketplace).toEqual({ status: "absent" });
    expect(plan.actions[0]?.after.marketplace).toEqual({
      status: "present",
      value: { name: "plurum", source: "dunelabsco/plurum" },
    });
    expect(plan.actions[1]?.before).toEqual(plan.actions[0]?.after);
    expect(
      plan.actions[1]?.after.plugin.status === "present" &&
        plan.actions[1].after.plugin.value,
    ).toEqual({
      name: "plurum",
      source: "plurum@plurum",
      version: "1.4.0",
      enabled: false,
    });
    expect(plan.actions[2]?.before).toEqual(plan.actions[1]?.after);
    expect(plan.actions[2]?.after).toEqual(healthyConfiguration());
    expectDeepFrozen(plan);
  });

  it("records install rollback only for CLI-created plugin state", () => {
    const plan = createHostPreflightPlan(
      available(absentConfiguration()),
      desired(),
    );

    expect(plan.actions.map((action) => action.kind)).toEqual([
      "add-marketplace",
      "install-plugin",
    ]);
    expect(plan.actions[1]?.before.plugin).toEqual({ status: "absent" });
    expect(plan.actions[1]?.after.plugin).toEqual({
      status: "present",
      value: {
        name: "plurum",
        source: "plurum@plurum",
        version: "1.4.0",
        enabled: true,
      },
    });
    expect(plan.actions[1]?.after.pluginMcp).toEqual({
      status: "present",
      value: {
        name: "plurum",
        endpoint: "https://mcp.plurum.ai/mcp",
      },
    });
    expect(plan.actions[1]?.rollback).toEqual({
      kind: "remove-cli-created-plugin",
    });
  });

  it("preserves a validated Windows npm shim launch chain", () => {
    const observation: AvailableInspection = {
      ...available(),
      executable: {
        sourcePath: "C:\\Trusted\\bin\\claude.cmd",
        resolvedPath: "C:\\Trusted\\lib\\claude.js",
        revision: "shim-r1",
        chain: [
          {
            path: "C:\\Trusted\\bin\\claude.cmd",
            kind: "shim",
            owner: "current-user",
            access: "not-broadly-writable",
            binding: "canonical",
            link: "approved-npm-shim",
            revision: "cmd-r1",
          },
          {
            path: "C:\\Trusted\\lib\\claude.js",
            kind: "script",
            owner: "current-user",
            access: "not-broadly-writable",
            binding: "canonical",
            link: "direct",
            revision: "script-r1",
          },
          {
            path: "C:\\Program Files\\nodejs\\node.exe",
            kind: "binary",
            owner: "trusted-system",
            access: "not-broadly-writable",
            binding: "canonical",
            link: "direct",
            revision: "node-r1",
          },
        ],
        launch: {
          executable: "C:\\Program Files\\nodejs\\node.exe",
          argumentPrefix: ["C:\\Trusted\\lib\\claude.js"],
          shell: false,
        },
      },
    };

    const plan = createHostPreflightPlan(observation, desired());
    expect(plan.classification).toBe("healthy");
    expect(plan.executable?.launch).toEqual({
      executable: "C:\\Program Files\\nodejs\\node.exe",
      argumentPrefix: ["C:\\Trusted\\lib\\claude.js"],
      shell: false,
    });
  });

  it("preserves a validated POSIX npm shim launch chain", () => {
    const observation: AvailableInspection = {
      ...available(),
      executable: {
        sourcePath: "/trusted/bin/claude",
        resolvedPath: "/trusted/lib/claude.js",
        revision: "shim-r1",
        chain: [
          {
            path: "/trusted/bin/claude",
            kind: "shim",
            owner: "current-user",
            access: "not-broadly-writable",
            binding: "canonical",
            link: "approved-npm-shim",
            revision: "shim-link-r1",
          },
          {
            path: "/trusted/lib/claude.js",
            kind: "script",
            owner: "current-user",
            access: "not-broadly-writable",
            binding: "canonical",
            link: "direct",
            revision: "script-r1",
          },
          {
            path: "/trusted/bin/node",
            kind: "binary",
            owner: "trusted-system",
            access: "not-broadly-writable",
            binding: "canonical",
            link: "direct",
            revision: "node-r1",
          },
        ],
        launch: {
          executable: "/trusted/bin/node",
          argumentPrefix: ["/trusted/lib/claude.js"],
          shell: false,
        },
      },
    };

    const plan = createHostPreflightPlan(observation, desired());
    expect(plan.classification).toBe("healthy");
    expect(plan.executable?.launch).toEqual({
      executable: "/trusted/bin/node",
      argumentPrefix: ["/trusted/lib/claude.js"],
      shell: false,
    });
  });

  it.each<
    readonly [HostInspection, HostPlanClassification]
  >([
    [
      { host: "claude-code", status: "absent" },
      "absent",
    ],
    [
      {
        host: "claude-code",
        status: "blocked",
        reason: "unsafe-shadow",
        candidatePath: "/untrusted/claude",
      },
      "unsafe",
    ],
    [
      {
        host: "claude-code",
        status: "unavailable",
        reason: "probe-timeout",
        executable: executable(),
      },
      "unavailable",
    ],
    [available(healthyConfiguration(), "claude-code", "1.1.99"), "unsupported-version"],
  ])(
    "classifies non-actionable host state as %s",
    (observation, classification) => {
      const plan = createHostPreflightPlan(
        observation as HostInspection,
        desired(),
      );
      expect(plan.classification).toBe(classification);
      expect(plan.automatic).toBe(false);
      expect(plan.actions).toEqual([]);
    },
  );

  it("blocks direct-only, duplicate, mismatched, and ambiguous state", () => {
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
    expect(
      createHostPreflightPlan(available(directOnly), desired()).classification,
    ).toBe("direct-only");

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
    expect(
      createHostPreflightPlan(available(duplicate), desired()).classification,
    ).toBe("duplicate");

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
    expect(
      createHostPreflightPlan(available(mismatched), desired()).classification,
    ).toBe("mismatched");

    const ambiguous: HostConfiguration = {
      ...absentConfiguration(),
      plugin: { status: "ambiguous" },
    };
    expect(
      createHostPreflightPlan(available(ambiguous), desired()).classification,
    ).toBe("ambiguous");
  });

  it("refuses a plan if any required mutation lacks its inverse", () => {
    const support = { ...FULL_SUPPORT, removePlugin: false };
    const plan = createHostPreflightPlan(
      available(absentConfiguration(), "claude-code", "2.1.0", support),
      desired(),
    );

    expect(plan.classification).toBe("irreversible");
    expect(plan.automatic).toBe(false);
    expect(plan.actions).toEqual([]);
  });

  it("rejects malformed accessor-backed observations without retaining them", () => {
    const getter = vi.fn(() => "available");
    const hostile = {
      host: "claude-code",
      get status() {
        return getter();
      },
    };

    expect(() =>
      createHostPreflightPlan(hostile as unknown as HostInspection, desired()),
    ).toThrowError(new HostError("invalid_host_observation"));
    expect(getter).toHaveBeenCalledOnce();
  });

  it.each([
    "PLURUM_API_KEY=plrm_live_abcdefghijkl",
    "plrm_live_x",
    "Bearer abcdefghijklmnop",
    "api_key: abcdefghijklmnop",
    "https://user:password@example.test/plugin",
  ])("rejects secret-like plan material without reflecting it", (source) => {
    const target: DesiredHostConfiguration = {
      ...desired(),
      marketplace: { name: "plurum", source },
    };

    let error: unknown;
    try {
      createHostPreflightPlan(available(), target);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HostError);
    expect(error).toMatchObject({ code: "invalid_reconciliation_plan" });
    expect(String(error)).not.toContain(source);
  });
});

describe("reconciliation plan", () => {
  it("validates metadata, orders hosts deterministically, and freezes the result", () => {
    const input = {
      operationId: "2f1a13ae-97e3-4eef-a129-5e63acaf9c17",
      createdAt: "2026-07-20T12:34:56.789Z",
      inspections: [
        available(healthyConfiguration(), "codex"),
        available(healthyConfiguration(), "claude-code"),
      ],
      desired: [desired("codex"), desired("claude-code")],
    };
    const first = createReconciliationPlan(input);
    const second = createReconciliationPlan(input);

    expect(first).toEqual(second);
    expect(first.hosts.map((host) => host.host)).toEqual([
      "claude-code",
      "codex",
    ]);
    expect(first.schemaVersion).toBe(1);
    expectDeepFrozen(first);
  });

  it.each([
    ["2F1A13AE-97E3-4EEF-A129-5E63ACAF9C17", "2026-07-20T12:34:56.789Z"],
    ["not-a-uuid", "2026-07-20T12:34:56.789Z"],
    ["2f1a13ae-97e3-0eef-a129-5e63acaf9c17", "2026-07-20T12:34:56.789Z"],
    ["2f1a13ae-97e3-1eef-a129-5e63acaf9c17", "2026-07-20T12:34:56.789Z"],
    ["2f1a13ae-97e3-4eef-a129-5e63acaf9c17", "2026-07-20T12:34:56Z"],
    ["2f1a13ae-97e3-4eef-a129-5e63acaf9c17", "2026-02-30T12:34:56.789Z"],
    ["2f1a13ae-97e3-4eef-a129-5e63acaf9c17", "2026-07-20T12:34:56.789+00:00"],
  ])("rejects invalid operation metadata", (operationId, createdAt) => {
    expect(() =>
      createReconciliationPlan({
        operationId,
        createdAt,
        inspections: [available()],
        desired: [desired()],
      }),
    ).toThrowError(new HostError("invalid_reconciliation_plan"));
  });

  it("rejects duplicate and unmatched host observations", () => {
    expect(() =>
      createReconciliationPlan({
        operationId: "2f1a13ae-97e3-4eef-a129-5e63acaf9c17",
        createdAt: "2026-07-20T12:34:56.789Z",
        inspections: [available(), available()],
        desired: [desired(), desired()],
      }),
    ).toThrowError(new HostError("invalid_reconciliation_plan"));

    expect(() =>
      createReconciliationPlan({
        operationId: "2f1a13ae-97e3-4eef-a129-5e63acaf9c17",
        createdAt: "2026-07-20T12:34:56.789Z",
        inspections: [available()],
        desired: [desired("codex")],
      }),
    ).toThrowError(new HostError("invalid_reconciliation_plan"));
  });
});
