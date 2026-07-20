import { describe, expect, it } from "vitest";

import { createPlatformPathAdapter } from "../src/adapters/node/platform.js";
import type {
  HostExecutableCandidateAdapter,
  HostExecutableCandidateObservation,
} from "../src/hosts/contracts.js";
import { discoverHostExecutable } from "../src/hosts/discovery.js";
import { HostError } from "../src/hosts/errors.js";

const linuxPaths = createPlatformPathAdapter("linux");
const windowsPaths = createPlatformPathAdapter("win32");

function directExecutable(path: string) {
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

function adapter(
  inspect: HostExecutableCandidateAdapter["inspectCandidate"],
): HostExecutableCandidateAdapter {
  return Object.freeze({ inspectCandidate: inspect });
}

describe("host executable discovery", () => {
  it("checks PATH in precedence order and returns the first attested executable", async () => {
    const candidates: string[] = [];
    const result = await discoverHostExecutable(
      {
        host: "claude-code",
        executableName: "claude",
        path: "/missing/bin:/trusted/bin:/later/bin",
        excludedProjectDirectory: "/work/project",
      },
      adapter(async (request) => {
        candidates.push(request.candidatePath);
        return request.candidatePath === "/trusted/bin/claude"
          ? {
              status: "verified",
              executable: directExecutable(request.candidatePath),
            }
          : { status: "missing" };
      }),
      linuxPaths,
      "linux",
    );

    expect(result.status).toBe("verified");
    expect(candidates).toEqual([
      "/missing/bin/claude",
      "/trusted/bin/claude",
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status === "verified") {
      expect(result.executable.resolvedPath).toBe("/trusted/bin/claude");
    }
  });

  it("blocks an unsafe earlier shadow instead of silently using a later binary", async () => {
    const candidates: string[] = [];
    const result = await discoverHostExecutable(
      {
        host: "codex",
        executableName: "codex",
        path: "/unsafe/bin:/trusted/bin",
        excludedProjectDirectory: "/work/project",
      },
      adapter(async (request) => {
        candidates.push(request.candidatePath);
        return request.candidatePath === "/unsafe/bin/codex"
          ? { status: "blocked", reason: "unsafe-executable" }
          : {
              status: "verified",
              executable: directExecutable(request.candidatePath),
            };
      }),
      linuxPaths,
      "linux",
    );

    expect(result).toEqual({
      host: "codex",
      status: "blocked",
      reason: "unsafe-executable",
      candidatePath: "/unsafe/bin/codex",
    });
    expect(candidates).toEqual(["/unsafe/bin/codex"]);
  });

  it("does not let an irrelevant later PATH entry override a trusted earlier match", async () => {
    const result = await discoverHostExecutable(
      {
        host: "claude-code",
        executableName: "claude",
        path: "/trusted/bin:./irrelevant-later-entry",
        excludedProjectDirectory: "/work/project",
      },
      adapter(async (request) => ({
        status: "verified",
        executable: directExecutable(request.candidatePath),
      })),
      linuxPaths,
      "linux",
    );
    expect(result.status).toBe("verified");
  });

  it.each([
    "",
    ":/trusted/bin",
    "./bin:/trusted/bin",
    "../bin:/trusted/bin",
    "/work/project/bin:/trusted/bin",
  ])("blocks unsafe PATH spelling %j before candidate inspection", async (path) => {
    let inspected = false;
    const result = await discoverHostExecutable(
      {
        host: "claude-code",
        executableName: "claude",
        path,
        excludedProjectDirectory: "/work/project",
      },
      adapter(async () => {
        inspected = true;
        return { status: "missing" };
      }),
      linuxPaths,
      "linux",
    );

    expect(result.status).toBe("blocked");
    expect(inspected).toBe(false);
  });

  it("checks an earlier safe PATH entry before a trailing unsafe entry", async () => {
    const candidates: string[] = [];
    const result = await discoverHostExecutable(
      {
        host: "claude-code",
        executableName: "claude",
        path: "/trusted/bin:",
        excludedProjectDirectory: "/work/project",
      },
      adapter(async (request) => {
        candidates.push(request.candidatePath);
        return { status: "missing" };
      }),
      linuxPaths,
      "linux",
    );

    expect(result.status).toBe("blocked");
    expect(candidates).toEqual(["/trusted/bin/claude"]);
  });

  it("models Windows PATHEXT order and accepts only an attested npm command shim", async () => {
    const candidates: string[] = [];
    const result = await discoverHostExecutable(
      {
        host: "codex",
        executableName: "codex",
        path: "C:\\Trusted\\bin;C:\\Later\\bin",
        pathExt: ".com;.EXE;.Bat;.CMD",
        excludedProjectDirectory: "C:\\Work\\Project",
      },
      adapter(async (request) => {
        candidates.push(request.candidatePath);
        if (!request.candidatePath.toLowerCase().endsWith(".cmd")) {
          return { status: "missing" };
        }
        return {
          status: "verified",
          executable: {
            sourcePath: request.candidatePath,
            resolvedPath: "C:\\Trusted\\lib\\codex.js",
            revision: "shim-r1",
            chain: [
              {
                path: request.candidatePath,
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
      }),
      windowsPaths,
      "win32",
    );

    expect(result.status).toBe("verified");
    expect(candidates).toEqual([
      "C:\\Trusted\\bin\\codex.com",
      "C:\\Trusted\\bin\\codex.exe",
      "C:\\Trusted\\bin\\codex.bat",
      "C:\\Trusted\\bin\\codex.cmd",
    ]);
    if (result.status === "verified") {
      expect(result.executable.launch).toEqual({
        executable: "C:\\Program Files\\nodejs\\node.exe",
        argumentPrefix: ["C:\\Trusted\\lib\\codex.js"],
        shell: false,
      });
    }
  });

  it("fails closed if the attested source does not match the PATH candidate", async () => {
    const result = await discoverHostExecutable(
      {
        host: "claude-code",
        executableName: "claude",
        path: "/trusted/bin",
        excludedProjectDirectory: "/work/project",
      },
      adapter(async () => ({
        status: "verified",
        executable: directExecutable("/different/bin/claude"),
      })),
      linuxPaths,
      "linux",
    );
    expect(result).toEqual({
      host: "claude-code",
      status: "blocked",
      reason: "unverifiable-executable",
      candidatePath: "/trusted/bin/claude",
    });
  });

  it("converts adapter failures into a fixed unverifiable result", async () => {
    const result = await discoverHostExecutable(
      {
        host: "codex",
        executableName: "codex",
        path: "/trusted/bin",
        excludedProjectDirectory: "/work/project",
      },
      adapter(async () => {
        throw new Error("hostile path detail");
      }),
      linuxPaths,
      "linux",
    );
    expect(result).toEqual({
      host: "codex",
      status: "blocked",
      reason: "unverifiable-executable",
      candidatePath: "/trusted/bin/codex",
    });
    expect(JSON.stringify(result)).not.toContain("hostile path detail");
  });

  it.each([
    {
      label: "extra fields",
      observation: {
        status: "missing",
        detail: "/private/hostile-path",
      },
    },
    {
      label: "unknown status",
      observation: {
        status: "maybe",
      },
    },
    {
      label: "throwing getter",
      observation: Object.defineProperty({}, "status", {
        enumerable: true,
        get() {
          throw new Error("/private/hostile-path");
        },
      }),
    },
  ])("fails closed on candidate observations with $label", async ({ observation }) => {
    const result = await discoverHostExecutable(
      {
        host: "codex",
        executableName: "codex",
        path: "/trusted/bin",
        excludedProjectDirectory: "/work/project",
      },
      adapter(async () =>
        observation as HostExecutableCandidateObservation
      ),
      linuxPaths,
      "linux",
    );

    expect(result).toEqual({
      host: "codex",
      status: "blocked",
      reason: "unverifiable-executable",
      candidatePath: "/trusted/bin/codex",
    });
    expect(JSON.stringify(result)).not.toContain("hostile-path");
  });

  it("rejects host/executable mismatches and malformed PATHEXT", async () => {
    const missing = adapter(
      async (): Promise<HostExecutableCandidateObservation> => ({
        status: "missing",
      }),
    );
    await expect(
      discoverHostExecutable(
        {
          host: "codex",
          executableName: "claude",
          path: "/trusted/bin",
          excludedProjectDirectory: "/work/project",
        },
        missing,
        linuxPaths,
        "linux",
      ),
    ).rejects.toBeInstanceOf(HostError);

    const malformed = await discoverHostExecutable(
      {
        host: "codex",
        executableName: "codex",
        path: "C:\\Trusted\\bin",
        pathExt: ".EXE;;.CMD",
        excludedProjectDirectory: "C:\\Work\\Project",
      },
      missing,
      windowsPaths,
      "win32",
    );
    expect(malformed).toMatchObject({
      status: "blocked",
      reason: "unsafe-path-entry",
    });
  });
});
