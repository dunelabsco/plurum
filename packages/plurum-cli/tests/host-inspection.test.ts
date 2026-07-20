import { describe, expect, it } from "vitest";

import { createPlatformPathAdapter } from "../src/adapters/node/platform.js";
import type {
  HostInspection,
  HostInspectionAdapter,
} from "../src/hosts/contracts.js";
import {
  inspectSelectedHosts,
  validateHostInspection,
} from "../src/hosts/inspection.js";
import { HostError } from "../src/hosts/errors.js";

const linuxPaths = createPlatformPathAdapter("linux");
const windowsPaths = createPlatformPathAdapter("win32");

function emptyConfiguration() {
  return {
    marketplace: { status: "absent" as const },
    plugin: { status: "absent" as const },
    pluginMcp: { status: "absent" as const },
    directMcp: { status: "absent" as const },
  };
}

function mutationSupport() {
  return {
    addMarketplace: true,
    removeMarketplace: true,
    installPlugin: true,
    removePlugin: true,
    updatePlugin: true,
    restorePlugin: true,
    enablePlugin: true,
    disablePlugin: true,
  };
}

function directExecutable(path = "/trusted/bin/claude") {
  return {
    sourcePath: path,
    resolvedPath: path,
    revision: "executable-r1",
    chain: [
      {
        path,
        kind: "binary" as const,
        owner: "trusted-system" as const,
        access: "not-broadly-writable" as const,
        binding: "canonical" as const,
        link: "direct" as const,
        revision: "chain-r1",
      },
    ],
    launch: {
      executable: path,
      argumentPrefix: [] as string[],
      shell: false as const,
    },
  };
}

function availableInspection(): Extract<
  HostInspection,
  { status: "available" }
> {
  return {
    host: "claude-code",
    status: "available",
    executable: directExecutable(),
    version: "2.1.210",
    state: {
      revision: "state-r1",
      configuration: emptyConfiguration(),
    },
    mutationSupport: mutationSupport(),
  };
}

const linuxRequest = Object.freeze({
  host: "claude-code" as const,
  scope: "user" as const,
  excludedProjectDirectory: "/work/project",
});

describe("host inspection boundary", () => {
  it("returns a defensive deeply frozen semantic snapshot", () => {
    const input = availableInspection();
    const result = validateHostInspection(
      input,
      linuxRequest,
      linuxPaths,
      "linux",
    );

    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status !== "available") {
      throw new Error("expected available host");
    }
    expect(Object.isFrozen(result.executable)).toBe(true);
    expect(Object.isFrozen(result.executable.chain)).toBe(true);
    expect(Object.isFrozen(result.executable.chain[0])).toBe(true);
    expect(Object.isFrozen(result.state.configuration)).toBe(true);
    expect(Object.isFrozen(result.mutationSupport)).toBe(true);

    (
      input.executable.chain as unknown as Array<{ path: string }>
    )[0]!.path = "/work/project/lookalike";
    expect(result.executable.chain[0]?.path).toBe("/trusted/bin/claude");
  });

  it.each([
    {
      label: "project-local executable",
      mutate(value: any) {
        value.executable = directExecutable("/work/project/bin/claude");
      },
    },
    {
      label: "relative executable",
      mutate(value: any) {
        value.executable = directExecutable("bin/claude");
      },
    },
    {
      label: "duplicate chain",
      mutate(value: any) {
        value.executable.chain = [
          ...value.executable.chain,
          { ...value.executable.chain[0]! },
        ];
      },
    },
    {
      label: "foreign owner",
      mutate(value: any) {
        value.executable.chain[0]!.owner = "foreign";
      },
    },
    {
      label: "coercible chain kind",
      mutate(value: any) {
        value.executable.chain[0]!.kind = {
          toString() {
            return "binary";
          },
        };
      },
    },
    {
      label: "coercible chain owner",
      mutate(value: any) {
        value.executable.chain[0]!.owner = {
          toString() {
            return "trusted-system";
          },
        };
      },
    },
    {
      label: "coercible chain link",
      mutate(value: any) {
        value.executable.chain[0]!.link = {
          toString() {
            return "direct";
          },
        };
      },
    },
    {
      label: "broad write access",
      mutate(value: any) {
        value.executable.chain[0]!.access = "group-writable";
      },
    },
    {
      label: "shell launch",
      mutate(value: any) {
        value.executable.launch.shell = true;
      },
    },
    {
      label: "secret-bearing semantic state",
      mutate(value: any) {
        value.state.configuration.marketplace = {
          status: "present",
          value: {
            name: "plurum",
            source: "plrm_live_NEVER_ALLOWED_IN_HOST_STATE",
          },
        };
      },
    },
    {
      label: "test-key-bearing semantic state",
      mutate(value: any) {
        value.state.configuration.marketplace = {
          status: "present",
          value: {
            name: "plurum",
            source: "plrm_test_NEVER_ALLOWED_IN_HOST_STATE",
          },
        };
      },
    },
    {
      label: "bearer-bearing semantic state",
      mutate(value: any) {
        value.state.configuration.marketplace = {
          status: "present",
          value: {
            name: "plurum",
            source: "Bearer NEVER_ALLOWED_IN_HOST_STATE",
          },
        };
      },
    },
    {
      label: "secret-assignment-bearing semantic state",
      mutate(value: any) {
        value.state.configuration.marketplace = {
          status: "present",
          value: {
            name: "plurum",
            source: "access_token=NEVER_ALLOWED_IN_HOST_STATE",
          },
        };
      },
    },
    {
      label: "URL-userinfo-bearing semantic state",
      mutate(value: any) {
        value.state.configuration.marketplace = {
          status: "present",
          value: {
            name: "plurum",
            source: "https://user@example.invalid/plurum.git",
          },
        };
      },
    },
    {
      label: "private-key-bearing semantic state",
      mutate(value: any) {
        value.state.configuration.marketplace = {
          status: "present",
          value: {
            name: "plurum",
            source: "-----BEGIN OPENSSH PRIVATE KEY-----",
          },
        };
      },
    },
    {
      label: "path-bearing executable revision",
      mutate(value: any) {
        value.executable.revision = "revision:/Users/example/private";
      },
    },
    {
      label: "non-string blocked reason",
      mutate(value: any) {
        value.status = "blocked";
        delete value.executable;
        delete value.version;
        delete value.state;
        delete value.mutationSupport;
        value.reason = {
          toString() {
            return "unsafe-executable";
          },
        };
      },
    },
  ])("rejects $label", ({ mutate }) => {
    const value: any = structuredClone(availableInspection());
    mutate(value);
    expect(() =>
      validateHostInspection(value, linuxRequest, linuxPaths, "linux"),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_host_observation" }),
    );
  });

  it("accepts an unsafe shadow result without trying a later executable", () => {
    const blocked = validateHostInspection(
      {
        host: "claude-code",
        status: "blocked",
        reason: "unsafe-shadow",
        candidatePath: "/work/project/node_modules/.bin/claude",
      },
      linuxRequest,
      linuxPaths,
      "linux",
    );

    expect(blocked).toEqual({
      host: "claude-code",
      status: "blocked",
      reason: "unsafe-shadow",
      candidatePath: "/work/project/node_modules/.bin/claude",
    });
  });

  it("accepts a Windows npm shim only as node plus the exact script argument", () => {
    const input = {
      ...availableInspection(),
      executable: {
        sourcePath: "C:\\Trusted\\bin\\codex.cmd",
        resolvedPath: "C:\\Trusted\\lib\\codex.js",
        revision: "shim-r1",
        chain: [
          {
            path: "C:\\Trusted\\bin\\codex.cmd",
            kind: "shim",
            owner: "current-user",
            access: "not-broadly-writable",
            binding: "canonical",
            link: "approved-npm-shim",
            revision: "cmd-r1",
          },
          {
            path: "C:\\Trusted\\lib\\codex.js",
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
          argumentPrefix: ["C:\\Trusted\\lib\\codex.js"],
          shell: false,
        },
      },
    };
    const result = validateHostInspection(
      input,
      {
        host: "claude-code",
        scope: "user",
        excludedProjectDirectory: "C:\\Work\\Project",
      },
      windowsPaths,
      "win32",
    );
    expect(result.status).toBe("available");
    if (result.status === "available") {
      expect(result.executable.launch).toEqual({
        executable: "C:\\Program Files\\nodejs\\node.exe",
        argumentPrefix: ["C:\\Trusted\\lib\\codex.js"],
        shell: false,
      });
    }
  });

  it("accepts a POSIX npm shim only as node plus the exact script argument", () => {
    const input = {
      ...availableInspection(),
      executable: {
        sourcePath: "/trusted/bin/codex",
        resolvedPath: "/trusted/lib/codex.js",
        revision: "shim-r1",
        chain: [
          {
            path: "/trusted/bin/codex",
            kind: "shim",
            owner: "current-user",
            access: "not-broadly-writable",
            binding: "canonical",
            link: "approved-npm-shim",
            revision: "shim-link-r1",
          },
          {
            path: "/trusted/lib/codex.js",
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
          argumentPrefix: ["/trusted/lib/codex.js"],
          shell: false,
        },
      },
    };
    const result = validateHostInspection(
      input,
      linuxRequest,
      linuxPaths,
      "linux",
    );
    expect(result.status).toBe("available");
    if (result.status === "available") {
      expect(result.executable.launch).toEqual({
        executable: "/trusted/bin/node",
        argumentPrefix: ["/trusted/lib/codex.js"],
        shell: false,
      });
    }
  });

  it("rejects direct POSIX script execution through a shebang", () => {
    const executable = {
      sourcePath: "/trusted/bin/codex",
      resolvedPath: "/trusted/bin/codex",
      revision: "script-r1",
      chain: [
        {
          path: "/trusted/bin/codex",
          kind: "script",
          owner: "current-user",
          access: "not-broadly-writable",
          binding: "canonical",
          link: "direct",
          revision: "script-chain-r1",
        },
      ],
      launch: {
        executable: "/trusted/bin/codex",
        argumentPrefix: [],
        shell: false,
      },
    };
    expect(() =>
      validateHostInspection(
        {
          ...availableInspection(),
          executable,
        },
        linuxRequest,
        linuxPaths,
        "linux",
      ),
    ).toThrow(HostError);
  });

  it("rejects direct Windows command-shim execution", () => {
    const executable = directExecutable("C:\\Trusted\\bin\\claude.cmd");
    expect(() =>
      validateHostInspection(
        {
          ...availableInspection(),
          executable,
        },
        {
          host: "claude-code",
          scope: "user",
          excludedProjectDirectory: "C:\\Work\\Project",
        },
        windowsPaths,
        "win32",
      ),
    ).toThrow(HostError);
  });

  it("invokes only selected semantic adapters at user scope", async () => {
    const calls: unknown[] = [];
    const claude: HostInspectionAdapter = {
      async inspect(request) {
        calls.push(request);
        return availableInspection();
      },
    };
    const codex: HostInspectionAdapter = {
      async inspect() {
        throw new Error("unselected adapter must not run");
      },
    };

    const result = await inspectSelectedHosts(
      ["claude-code"],
      { "claude-code": claude, codex },
      "/work/project",
      linuxPaths,
      "linux",
    );
    expect(result).toHaveLength(1);
    expect(calls).toEqual([
      {
        host: "claude-code",
        scope: "user",
        excludedProjectDirectory: "/work/project",
      },
    ]);
    expect(Object.isFrozen(calls[0])).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });
});
