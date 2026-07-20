import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { createPlatformPathAdapter } from "../src/adapters/node/platform.js";
import { runCli } from "../src/cli.js";
import {
  createSetupDryRunPreflight,
} from "../src/commands/setup-preflight.js";
import { renderSetupDryRunPreflight } from "../src/commands/setup-output.js";
import { ExitCode } from "../src/exit-codes.js";
import {
  type DesiredHostConfiguration,
  type HostConfiguration,
  type HostExecutableAttestation,
  type HostId,
  type HostInspection,
  type HostInspectionAdapter,
  type HostMutationAdapter,
} from "../src/hosts/contracts.js";
import {
  CLAUDE_CODE_DESIRED_CONFIGURATION,
  CLAUDE_CODE_MUTATION_SUPPORT,
} from "../src/hosts/claude-code/configuration.js";
import {
  CODEX_DESIRED_CONFIGURATION,
  CODEX_MUTATION_SUPPORT,
} from "../src/hosts/codex/configuration.js";
import type { CliRuntime } from "../src/runtime.js";
import { planningScope } from "../src/system/scopes.js";
import type {
  PlatformAdapter,
  SystemCapabilities,
} from "../src/system/contracts.js";
import { createTestSystem } from "./support/system.js";

const CANARY = "plrm_live_STEP_4_8_CANARY_DO_NOT_PRINT";

const DESIRED_BY_HOST: Readonly<
  Record<HostId, DesiredHostConfiguration>
> = {
  "claude-code": CLAUDE_CODE_DESIRED_CONFIGURATION,
  codex: CODEX_DESIRED_CONFIGURATION,
};

function absentConfiguration(): HostConfiguration {
  return {
    marketplace: { status: "absent" },
    plugin: { status: "absent" },
    pluginMcp: { status: "absent" },
    directMcp: { status: "absent" },
  };
}

function healthyConfiguration(host: HostId): HostConfiguration {
  const desired = DESIRED_BY_HOST[host];
  return {
    marketplace: {
      status: "present",
      value: { ...desired.marketplace },
    },
    plugin: {
      status: "present",
      value: {
        name: "plurum",
        source: desired.plugin.source,
        version: desired.plugin.version,
        enabled: true,
      },
    },
    pluginMcp: {
      status: "present",
      value: { ...desired.mcp },
    },
    directMcp: { status: "absent" },
  };
}

function executable(host: HostId): HostExecutableAttestation {
  const path =
    host === "claude-code"
      ? "/trusted/bin/claude"
      : "/trusted/bin/codex";
  return {
    sourcePath: path,
    resolvedPath: path,
    revision: `${host}-executable-revision`,
    chain: [
      {
        path,
        kind: "binary",
        owner: "current-user",
        access: "not-broadly-writable",
        binding: "canonical",
        link: "direct",
        revision: `${host}-chain-revision`,
      },
    ],
    launch: {
      executable: path,
      argumentPrefix: [],
      shell: false,
    },
  };
}

function available(
  host: HostId,
  configuration: HostConfiguration,
): HostInspection {
  const desired = DESIRED_BY_HOST[host];
  return {
    host,
    status: "available",
    executable: executable(host),
    version: desired.minimumHostVersion,
    state: {
      revision: `${host}-state-revision`,
      configuration,
    },
    mutationSupport:
      host === "claude-code"
        ? CLAUDE_CODE_MUTATION_SUPPORT
        : CODEX_MUTATION_SUPPORT,
  };
}

function inspectionAdapter(
  inspect: HostInspectionAdapter["inspect"],
): HostInspectionAdapter {
  return Object.freeze({ inspect });
}

function systemWithInspections(
  inspections: Readonly<Record<HostId, HostInspectionAdapter>>,
  platform?: PlatformAdapter,
): SystemCapabilities {
  const base = createTestSystem();
  return Object.freeze({
    ...base,
    ...(platform === undefined ? {} : { platform }),
    hosts: Object.freeze({
      inspection: Object.freeze(inspections),
      mutation: base.hosts.mutation,
    }),
  });
}

function expectDeepFrozen(
  value: unknown,
  seen = new WeakSet<object>(),
): void {
  if (
    typeof value !== "object" ||
    value === null ||
    seen.has(value)
  ) {
    return;
  }
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) {
    expectDeepFrozen(child, seen);
  }
}

function outputRuntime(system: SystemCapabilities): {
  readonly runtime: CliRuntime;
  stdout(): string;
  stderr(): string;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    runtime: {
      stdin: Readable.from([]),
      stdout: { write: (value) => stdout.push(value) },
      stderr: { write: (value) => stderr.push(value) },
      system,
    },
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  };
}

describe("setup dry-run preflight", () => {
  it("renders exact ordered reversible commands without internal evidence", async () => {
    const requests: HostId[] = [];
    const system = systemWithInspections({
      "claude-code": inspectionAdapter(async (request) => {
        requests.push(request.host);
        return available("claude-code", absentConfiguration());
      }),
      codex: inspectionAdapter(async (request) => {
        requests.push(request.host);
        return available("codex", absentConfiguration());
      }),
    });

    const result = await createSetupDryRunPreflight(
      "all",
      planningScope(system),
    );

    expect(requests).toEqual(["claude-code", "codex"]);
    expect(result).toMatchObject({
      schemaVersion: 1,
      mode: "dry-run",
      requestedTarget: "all",
      selectedClients: ["claude-code", "codex"],
      readiness: "ready",
      services: {
        apiOrigin: "https://api.plurum.ai",
        mcpEndpoint: "https://mcp.plurum.ai/mcp",
      },
      credential: { status: "not-inspected" },
      confirmation: "not-requested",
    });
    expect(result.destinations).toEqual([
      {
        kind: "credential-directory",
        path: "/isolated/plurum",
        futureEffect: "may-create",
      },
      {
        kind: "canonical-credential",
        path: "/isolated/plurum/credentials.json",
        futureEffect: "may-create-or-replace",
      },
      {
        kind: "setup-lock",
        path: "/isolated/plurum/setup.lock",
        futureEffect: "may-create",
      },
      {
        kind: "credential-transaction",
        path: "/isolated/plurum/credentials-transaction.json",
        futureEffect: "may-create",
      },
    ]);
    expect(
      result.mutations.map(({ id, kind }) => ({ id, kind })),
    ).toEqual([
      {
        id: "claude-code:01:add-marketplace",
        kind: "add-marketplace",
      },
      {
        id: "claude-code:02:install-plugin",
        kind: "install-plugin",
      },
      {
        id: "codex:01:add-marketplace",
        kind: "add-marketplace",
      },
      {
        id: "codex:02:install-plugin",
        kind: "install-plugin",
      },
    ]);
    expect(result.mutations[0]).toMatchObject({
      apply: {
        executable: "/trusted/bin/claude",
        arguments: [
          "plugin",
          "marketplace",
          "add",
          "dunelabsco/plurum",
          "--scope",
          "user",
        ],
        shell: false,
        scope: "user",
      },
      rollback: {
        executable: "/trusted/bin/claude",
        arguments: [
          "plugin",
          "marketplace",
          "remove",
          "plurum",
          "--scope",
          "user",
        ],
        shell: false,
        scope: "user",
      },
    });
    expect(result.mutations[3]).toMatchObject({
      apply: {
        executable: "/trusted/bin/codex",
        arguments: [
          "plugin",
          "add",
          "plurum@plurum",
          "--json",
        ],
        shell: false,
        scope: "user",
      },
      rollback: {
        executable: "/trusted/bin/codex",
        arguments: [
          "plugin",
          "remove",
          "plurum@plurum",
          "--json",
        ],
        shell: false,
        scope: "user",
      },
    });

    const serialized = JSON.stringify(result);
    for (const excluded of [
      "state-revision",
      "chain-revision",
      "executable-revision",
      "\"chain\"",
      "\"before\"",
      "\"after\"",
      "\"environment\"",
    ]) {
      expect(serialized).not.toContain(excluded);
    }
    const rendered = renderSetupDryRunPreflight(result);
    expect(rendered).toContain("Plurum setup preflight");
    expect(rendered).toContain('"shell":false');
    expect(rendered).toContain("No changes were made.");
    expectDeepFrozen(result);
  });

  it("treats an absent client as informational when another selected client is healthy", async () => {
    const system = systemWithInspections({
      "claude-code": inspectionAdapter(async () =>
        available(
          "claude-code",
          healthyConfiguration("claude-code"),
        ),
      ),
      codex: inspectionAdapter(async () => ({
        host: "codex",
        status: "absent",
      })),
    });

    const all = await createSetupDryRunPreflight(
      "all",
      planningScope(system),
    );
    expect(all.readiness).toBe("no-op");
    expect(all.mutations).toEqual([]);

    const codex = await createSetupDryRunPreflight(
      "codex",
      planningScope(system),
    );
    expect(codex.readiness).toBe("blocked");
    expect(codex.hosts[0]?.classification).toBe("absent");
  });

  it("contains a failed inspection, continues, and never reflects its error", async () => {
    const inspected: HostId[] = [];
    const system = systemWithInspections({
      "claude-code": inspectionAdapter(async (request) => {
        inspected.push(request.host);
        throw new Error(`host output contained ${CANARY}`);
      }),
      codex: inspectionAdapter(async (request) => {
        inspected.push(request.host);
        return available("codex", healthyConfiguration("codex"));
      }),
    });

    const result = await createSetupDryRunPreflight(
      "all",
      planningScope(system),
    );
    const output = `${JSON.stringify(result)}${renderSetupDryRunPreflight(result)}`;

    expect(inspected).toEqual(["claude-code", "codex"]);
    expect(result.readiness).toBe("unavailable");
    expect(result.hosts[0]).toMatchObject({
      client: "claude-code",
      classification: "inspection-failed",
      executable: null,
      explanation: "The host state could not be inspected safely.",
    });
    expect(result.hosts[1]?.classification).toBe("healthy");
    expect(output).not.toContain(CANARY);
  });

  it.each([
    ["right-to-left override", "\u202e"],
    ["zero-width space", "\u200b"],
    ["Arabic letter mark", "\u061c"],
  ])("contains a %s in host data to that client", async (_label, control) => {
    const inspected: HostId[] = [];
    const hostilePath = `/trusted/bin/${control}claude`;
    const hostile = available(
      "claude-code",
      absentConfiguration(),
    );
    if (hostile.status !== "available") {
      throw new Error("test inspection must be available");
    }
    const hostileExecutable: HostExecutableAttestation = {
      sourcePath: hostilePath,
      resolvedPath: hostilePath,
      revision: hostile.executable.revision,
      chain: [
        {
          ...hostile.executable.chain[0]!,
          path: hostilePath,
        },
      ],
      launch: {
        executable: hostilePath,
        argumentPrefix: [],
        shell: false,
      },
    };
    const system = systemWithInspections({
      "claude-code": inspectionAdapter(async (request) => {
        inspected.push(request.host);
        return {
          ...hostile,
          executable: hostileExecutable,
        };
      }),
      codex: inspectionAdapter(async (request) => {
        inspected.push(request.host);
        return available("codex", healthyConfiguration("codex"));
      }),
    });

    const result = await createSetupDryRunPreflight(
      "all",
      planningScope(system),
    );
    const output = renderSetupDryRunPreflight(result);

    expect(inspected).toEqual(["claude-code", "codex"]);
    expect(result.hosts.map(({ classification }) => classification)).toEqual([
      "inspection-failed",
      "healthy",
    ]);
    expect(result.readiness).toBe("unavailable");
    expect(output).not.toContain(control);
  });

  it("rejects a secret-shaped destination before inspecting a host", async () => {
    const inspect = vi.fn(async (): Promise<HostInspection> => ({
      host: "claude-code",
      status: "absent",
    }));
    const base = createTestSystem();
    const platform = Object.freeze({
      ...base.platform,
      environment: Object.freeze({
        ...base.platform.environment,
        PLURUM_HOME: `/isolated/${CANARY}/plurum`,
        PLURUM_TEST_ROOT: `/isolated/${CANARY}`,
      }),
      paths: createPlatformPathAdapter("linux"),
    });
    const system = systemWithInspections(
      {
        "claude-code": inspectionAdapter(inspect),
        codex: inspectionAdapter(async () => ({
          host: "codex",
          status: "absent",
        })),
      },
      platform,
    );

    const harness = outputRuntime(system);
    expect(
      await runCli(
        ["setup", "--client", "claude-code", "--dry-run"],
        harness.runtime,
      ),
    ).toBe(ExitCode.OperationalFailure);
    expect(inspect).not.toHaveBeenCalled();
    expect(harness.stdout()).toBe("");
    expect(harness.stderr()).toBe(
      "Plurum could not complete the command.\n",
    );
    expect(harness.stderr()).not.toContain(CANARY);
  });

  it("uses only selected host inspection and no other runtime capability", async () => {
    const base = createTestSystem();
    const touched = {
      filesystem: 0,
      network: 0,
      process: 0,
      credentialEnvironment: 0,
      clock: 0,
      random: 0,
      hash: 0,
      mutation: 0,
      stdin: 0,
    };
    const unavailable = (capability: keyof typeof touched): never => {
      touched[capability] += 1;
      throw new Error(`${capability} unexpectedly used with ${CANARY}`);
    };
    const filesystem = Object.freeze({
      lstat: async () => unavailable("filesystem"),
      realpath: async () => unavailable("filesystem"),
      readDirectory: async () => unavailable("filesystem"),
      openReadOnly: async () => unavailable("filesystem"),
      createDirectory: async () => unavailable("filesystem"),
      open: async () => unavailable("filesystem"),
      rename: async () => unavailable("filesystem"),
      unlink: async () => unavailable("filesystem"),
      openDirectory: async () => unavailable("filesystem"),
    });
    const mutationAdapter = Object.freeze<HostMutationAdapter>({
      inspect: async () => unavailable("mutation"),
      apply: async () => unavailable("mutation"),
      rollback: async () => unavailable("mutation"),
    });
    const claudeInspect = vi.fn(
      async (): Promise<HostInspection> =>
        available("claude-code", absentConfiguration()),
    );
    const codexInspect = vi.fn(
      async (): Promise<HostInspection> =>
        unavailable("mutation"),
    );
    const system = Object.freeze<SystemCapabilities>({
      filesystem,
      processes: Object.freeze({
        run: async () => unavailable("process"),
      }),
      network: Object.freeze({
        request: async () => unavailable("network"),
      }),
      credentialEnvironment: Object.freeze({
        read: () => unavailable("credentialEnvironment"),
      }),
      clock: Object.freeze({
        now: () => unavailable("clock"),
      }),
      random: Object.freeze({
        bytes: () => unavailable("random"),
        uuid: () => unavailable("random"),
      }),
      hash: Object.freeze({
        sha256: () => unavailable("hash"),
      }),
      platform: base.platform,
      hosts: Object.freeze({
        inspection: Object.freeze({
          "claude-code": inspectionAdapter(claudeInspect),
          codex: inspectionAdapter(codexInspect),
        }),
        mutation: Object.freeze({
          "claude-code": mutationAdapter,
          codex: mutationAdapter,
        }),
      }),
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const runtime = {
      stdout: { write: (value: string) => stdout.push(value) },
      stderr: { write: (value: string) => stderr.push(value) },
      system,
    } as unknown as CliRuntime;
    Object.defineProperty(runtime, "stdin", {
      enumerable: true,
      get() {
        touched.stdin += 1;
        throw new Error(`stdin unexpectedly accessed with ${CANARY}`);
      },
    });

    expect(
      await runCli(
        ["setup", "--client", "claude-code", "--dry-run"],
        runtime,
      ),
    ).toBe(ExitCode.Success);
    expect(claudeInspect).toHaveBeenCalledTimes(1);
    expect(codexInspect).not.toHaveBeenCalled();
    expect(touched).toEqual({
      filesystem: 0,
      network: 0,
      process: 0,
      credentialEnvironment: 0,
      clock: 0,
      random: 0,
      hash: 0,
      mutation: 0,
      stdin: 0,
    });
    expect(stdout.join("")).toContain("No changes were made.");
    expect(`${stdout.join("")}${stderr.join("")}`).not.toContain(
      CANARY,
    );
    expect(stderr.join("")).toBe("");
  });

  it("keeps apply mode unavailable while dry-run is activated", async () => {
    const system = systemWithInspections({
      "claude-code": inspectionAdapter(async () => ({
        host: "claude-code",
        status: "absent",
      })),
      codex: inspectionAdapter(async () => ({
        host: "codex",
        status: "absent",
      })),
    });
    const apply = outputRuntime(system);

    expect(await runCli(["setup"], apply.runtime)).toBe(
      ExitCode.Unavailable,
    );
    expect(apply.stdout()).toBe("");
    expect(apply.stderr()).toContain("private development build");
  });
});
