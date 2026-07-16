import {
  chmod,
  link,
  mkdir,
  readFile,
  rename,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  classifyElevation,
  normalizeOs,
} from "../src/adapters/node/platform.js";
import { nodeRandom } from "../src/adapters/node/random.js";
import {
  CapabilityPolicyError,
  CapabilityUnavailableError,
} from "../src/system/errors.js";
import type {
  ReadOnlyNetworkRequest,
  SystemCapabilities,
} from "../src/system/contracts.js";
import {
  doctorScope,
  planningScope,
  setupScope,
  statusScope,
} from "../src/system/scopes.js";
import {
  TEST_SENTINEL_FILENAME,
  TestAccessBoundary,
  isPathWithin,
} from "./support/test-boundary.js";
import {
  createIsolatedTestRoot,
  isIsolatedTestEnvironmentSafe,
  type IsolatedTestRoot,
} from "./support/test-root.js";
import { createTestSystem } from "./support/system.js";
import { createGuardedFakeSystem } from "./support/guarded-system.js";

const CANARY = "plrm_live_STEP_4_0_BOUNDARY_CANARY";

function networkRequest(url: string) {
  return {
    url,
    method: "GET" as const,
    headers: Object.freeze({ Accept: "application/json" }),
    timeoutMs: 1_000,
    maxResponseBytes: 4_096,
    redirect: "error" as const,
  };
}

describe("deny-by-default production ports", () => {
  it("denies filesystem, network, and process operations without reflecting inputs", async () => {
    const system = createTestSystem();
    const attempts = [
      () => system.filesystem.lstat(`/outside/${CANARY}`),
      () => system.network.request(networkRequest(`https://${CANARY}.invalid/`)),
      () =>
        system.processes.run({
          executable: `/outside/${CANARY}`,
          args: [CANARY],
          cwd: "/outside",
          env: Object.freeze({ PLURUM_API_KEY: CANARY }),
          timeoutMs: 1_000,
          maxOutputBytes: 1_024,
        }),
    ];

    for (const attempt of attempts) {
      try {
        await attempt();
        throw new Error("denied capability unexpectedly succeeded");
      } catch (error) {
        expect(error).toBeInstanceOf(CapabilityUnavailableError);
        expect(String(error)).not.toContain(CANARY);
      }
    }
  });

  it("removes mutation and process capabilities from read-only command scopes", () => {
    const system = createTestSystem();
    const planning = planningScope(system);
    const status = statusScope(system);
    const doctor = doctorScope(system);
    const setup = setupScope(system);

    for (const scoped of [planning, status, doctor]) {
      expect("processes" in scoped).toBe(false);
      expect("random" in scoped).toBe(false);
      expect("createDirectory" in scoped.filesystem).toBe(false);
      expect("open" in scoped.filesystem).toBe(false);
      expect("rename" in scoped.filesystem).toBe(false);
      expect("unlink" in scoped.filesystem).toBe(false);
    }
    expect("openReadOnly" in planning.filesystem).toBe(false);
    expect("openReadOnly" in status.filesystem).toBe(true);
    expect("openReadOnly" in doctor.filesystem).toBe(true);
    expect("network" in planning).toBe(false);
    expect("network" in status).toBe(true);
    expect("network" in doctor).toBe(true);
    expect("processes" in setup).toBe(true);
    expect("random" in setup).toBe(true);
    expect("rename" in setup.filesystem).toBe(true);
  });

  it("rejects POST or body-bearing requests from read-only commands", async () => {
    const system = createTestSystem();
    for (const scoped of [statusScope(system), doctorScope(system)]) {
      for (const request of [
        { ...networkRequest("https://example.invalid/"), method: "POST" },
        { ...networkRequest("https://example.invalid/"), body: new Uint8Array() },
      ]) {
        await expect(
          scoped.network.request(
            request as unknown as ReadOnlyNetworkRequest,
          ),
        ).rejects.toBeInstanceOf(CapabilityPolicyError);
      }
    }
  });

  it("delegates an immutable snapshot of read-only network requests", async () => {
    const base = createTestSystem();
    let delegatedRequest:
      | Parameters<SystemCapabilities["network"]["request"]>[0]
      | undefined;
    const system: SystemCapabilities = Object.freeze({
      ...base,
      network: Object.freeze({
        async request(
          request: Parameters<SystemCapabilities["network"]["request"]>[0],
        ) {
          delegatedRequest = request;
          return {
            status: 204,
            headers: Object.freeze({}),
            body: new Uint8Array(),
          };
        },
      }),
    });
    const request = {
      ...networkRequest("https://example.invalid/health"),
      headers: { Accept: "application/json" },
    };

    const response = statusScope(system).network.request(request);
    request.url = "https://example.invalid/mutated";
    request.headers.Accept = "text/plain";
    (request as unknown as { method: string }).method = "POST";

    await expect(response).resolves.toMatchObject({ status: 204 });
    expect(delegatedRequest).toEqual(
      networkRequest("https://example.invalid/health"),
    );
    expect(delegatedRequest).not.toBe(request);
    expect(Object.isFrozen(delegatedRequest)).toBe(true);
    expect(Object.isFrozen(delegatedRequest?.headers)).toBe(true);
  });
});

describe("platform and randomness adapters", () => {
  it.each([
    ["linux", 501, 501, 20, 20, false, false, "standard"],
    ["darwin", 501, 0, 20, 20, false, false, "elevated"],
    ["linux", 0, 0, 20, 20, false, false, "elevated"],
    ["linux", 501, 502, 20, 20, false, false, "elevated"],
    ["linux", 501, 501, 0, 0, false, false, "elevated"],
    ["linux", 501, 501, 20, 21, false, false, "elevated"],
    ["linux", 501, 501, 20, 20, true, false, "elevated"],
    ["linux", 501, 501, 20, 20, false, true, "elevated"],
    ["win32", undefined, undefined, undefined, undefined, undefined, false, "unknown"],
    ["unsupported", undefined, undefined, undefined, undefined, undefined, false, "unknown"],
  ] as const)(
    "classifies %s privilege state without optimistic fallbacks",
    (os, uid, euid, gid, egid, rootGroupDetected, sudoDetected, expected) => {
      expect(
        classifyElevation({
          os,
          uid,
          euid,
          gid,
          egid,
          rootGroupDetected,
          sudoDetected,
        }),
      ).toBe(expected);
    },
  );

  it("uses a cryptographic adapter with explicit size validation", () => {
    expect(nodeRandom.bytes(32)).toHaveLength(32);
    expect(nodeRandom.uuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(() => nodeRandom.bytes(0)).toThrow(RangeError);
  });
});

describe.runIf(isIsolatedTestEnvironmentSafe())(
  "isolated test access boundary",
  () => {
  it("automatically mediates fake filesystem, network, and process ports", async () => {
    const isolated = await createIsolatedTestRoot();
    try {
      const delegated: string[] = [];
      const base = createTestSystem();
      const delegate: SystemCapabilities = Object.freeze({
        ...base,
        filesystem: Object.freeze({
          ...base.filesystem,
          async lstat(target: string) {
            delegated.push(`filesystem:${target}`);
            return null;
          },
        }),
        network: Object.freeze({
          async request(request: Parameters<SystemCapabilities["network"]["request"]>[0]) {
            expect(Object.isFrozen(request)).toBe(true);
            expect(Object.isFrozen(request.headers)).toBe(true);
            delegated.push(`network:${new URL(request.url).pathname}`);
            return {
              status: 204,
              headers: Object.freeze({}),
              body: new Uint8Array(),
            };
          },
        }),
        processes: Object.freeze({
          async run(request: Parameters<SystemCapabilities["processes"]["run"]>[0]) {
            expect(Object.isFrozen(request)).toBe(true);
            expect(Object.isFrozen(request.args)).toBe(true);
            expect(Object.isFrozen(request.env)).toBe(true);
            delegated.push(`process:${request.executable}`);
            return {
              exitCode: 0,
              stdout: new Uint8Array(),
              stderr: new Uint8Array(),
            };
          },
        }),
      });
      const guarded = createGuardedFakeSystem(isolated.boundary, delegate);
      const safeTarget = join(isolated.paths.plurum, "missing.json");

      await expect(guarded.filesystem.lstat(safeTarget)).resolves.toBeNull();
      await expect(
        guarded.network.request(
          networkRequest(`${isolated.allowedOrigin}/health`),
        ),
      ).resolves.toMatchObject({ status: 204 });
      await expect(
        guarded.processes.run({
          executable: isolated.paths.fakeExecutable,
          args: ["--version"],
          cwd: isolated.paths.neutral,
          env: isolated.expectedProcessEnvironment,
          timeoutMs: 1_000,
          maxOutputBytes: 4_096,
        }),
      ).resolves.toMatchObject({ exitCode: 0 });
      expect(delegated).toEqual([
        `filesystem:${safeTarget}`,
        "network:/health",
        `process:${isolated.paths.fakeExecutable}`,
      ]);

      await expect(
        guarded.filesystem.createDirectory(isolated.paths.outsideCanary, {
          mode: 0o700,
          exclusive: true,
        }),
      ).rejects.toMatchObject({ code: "path_escape" });
      await expect(
        guarded.network.request(networkRequest("https://api.plurum.ai/health")),
      ).rejects.toMatchObject({ code: "network_rejected" });
      await expect(
        guarded.processes.run({
          executable: isolated.paths.outsideCanary,
          args: ["--version"],
          cwd: isolated.paths.neutral,
          env: isolated.expectedProcessEnvironment,
          timeoutMs: 1_000,
          maxOutputBytes: 4_096,
        }),
      ).rejects.toMatchObject({ code: "process_rejected" });
      expect(delegated).toHaveLength(3);
    } finally {
      await isolated.cleanup();
    }
  });

  it("accepts only internal paths, one stub origin, and the controlled fake process", async () => {
    const isolated = await createIsolatedTestRoot();
    try {
      const writeTarget = join(isolated.paths.plurum, "credentials.json");
      const temporaryTarget = join(isolated.paths.temporary, "pending.tmp");

      await expect(isolated.boundary.assertPath(writeTarget, "write")).resolves.toBe(
        writeTarget,
      );
      await expect(
        isolated.boundary.assertPath(temporaryTarget, "temporary"),
      ).resolves.toBe(temporaryTarget);
      await expect(
        isolated.boundary.assertNetwork(
          networkRequest(`${isolated.allowedOrigin}/health`),
        ),
      ).resolves.toBeUndefined();
      await expect(
        isolated.boundary.assertProcess({
          executable: isolated.paths.fakeExecutable,
          args: ["--version"],
          cwd: isolated.paths.neutral,
          env: isolated.expectedProcessEnvironment,
          timeoutMs: 1_000,
          maxOutputBytes: 4_096,
        }),
      ).resolves.toBeUndefined();

      expect(isolated.boundary.operations.map(({ kind }) => kind)).toEqual([
        "filesystem",
        "filesystem",
        "network",
        "process",
      ]);
      expect(JSON.stringify(isolated.boundary.operations)).not.toContain(CANARY);
    } finally {
      await isolated.cleanup();
    }
  });

  it("rejects lexical escapes, sibling-prefix paths, and misplaced temporary files", async () => {
    const isolated = await createIsolatedTestRoot();
    try {
      for (const target of [
        "relative/path",
        `${isolated.paths.root}/home/../plurum/file`,
        `${isolated.paths.root}/home/./file`,
        `${isolated.paths.root}-evil/file`,
        isolated.paths.outsideCanary,
        `${isolated.paths.root}/bad\0path`,
      ]) {
        await expect(isolated.boundary.assertPath(target, "read")).rejects.toMatchObject({
          code: "path_escape",
        });
      }
      await expect(
        isolated.boundary.assertPath(
          join(isolated.paths.plurum, "not-temporary"),
          "temporary",
        ),
      ).rejects.toMatchObject({ code: "path_escape" });
      expect(isolated.boundary.operations).toEqual([]);
    } finally {
      await isolated.cleanup();
    }
  });

  it("rejects ordinary symlink escapes without following them", async () => {
    const isolated = await createIsolatedTestRoot();
    try {
      if (process.platform === "win32") {
        return;
      }
      const fileLink = join(isolated.paths.root, "outside-file-link");
      const directoryLink = join(isolated.paths.root, "outside-directory-link");
      await symlink(isolated.paths.outsideCanary, fileLink);
      await symlink(dirname(isolated.paths.outsideCanary), directoryLink, "dir");

      await expect(isolated.boundary.assertPath(fileLink, "read")).rejects.toMatchObject({
        code: "link_rejected",
      });
      await expect(
        isolated.boundary.assertPath(join(directoryLink, "child"), "read"),
      ).rejects.toMatchObject({ code: "link_rejected" });
    } finally {
      await isolated.cleanup();
    }
  });

  it("rejects hard links to files outside the isolated root", async () => {
    const isolated = await createIsolatedTestRoot();
    const hardLink = join(isolated.paths.root, "outside-hard-link");
    try {
      await link(isolated.paths.outsideCanary, hardLink);
      await expect(
        isolated.boundary.assertPath(hardLink, "read"),
      ).rejects.toMatchObject({ code: "link_rejected" });
    } finally {
      await unlink(hardLink).catch(() => undefined);
      await isolated.cleanup();
    }
  });

  it("reserves the root and sentinel from mutating capability calls", async () => {
    const isolated = await createIsolatedTestRoot();
    const sentinel = join(isolated.paths.root, TEST_SENTINEL_FILENAME);
    try {
      await expect(
        isolated.boundary.assertPath(isolated.paths.root, "delete"),
      ).rejects.toMatchObject({ code: "path_escape" });
      await expect(
        isolated.boundary.assertPath(sentinel, "read"),
      ).rejects.toMatchObject({ code: "path_escape" });
      await expect(
        isolated.boundary.assertRename(isolated.paths.fakeExecutable, sentinel),
      ).rejects.toMatchObject({ code: "path_escape" });
    } finally {
      await isolated.cleanup();
    }
  });

  it("validates both sides of a rename before recording either side", async () => {
    const isolated = await createIsolatedTestRoot();
    try {
      await expect(
        isolated.boundary.assertRename(
          isolated.paths.fakeExecutable,
          isolated.paths.outsideCanary,
        ),
      ).rejects.toMatchObject({ code: "path_escape" });
      expect(isolated.boundary.operations).toEqual([]);
    } finally {
      await isolated.cleanup();
    }
  });

  it.each([
    "https://plurum.ai/health",
    "https://api.plurum.ai/api/v1/agents/me",
    "http://localhost:41234/health",
    "http://127.0.0.1:1/health",
    "http://user:password@127.0.0.1:41234/health",
    "http://127.0.0.1:41234/health?query=1",
    "http://127.0.0.1:41234/health#fragment",
    "http://127.0.0.1:41234/unapproved",
  ])("rejects network destination %s", async (candidate) => {
    const isolated = await createIsolatedTestRoot();
    try {
      const allowedPort = new URL(isolated.allowedOrigin).port;
      const normalizedCandidate = candidate.replace("41234", allowedPort);
      await expect(
        isolated.boundary.assertNetwork(networkRequest(normalizedCandidate)),
      ).rejects.toMatchObject({ code: "network_rejected" });
    } finally {
      await isolated.cleanup();
    }
  });

  it("rejects unexpected network methods, headers, bodies, and bounds", async () => {
    const isolated = await createIsolatedTestRoot();
    try {
      const valid = networkRequest(`${isolated.allowedOrigin}/health`);
      const attempts = [
        { ...valid, method: "POST" as const },
        { ...valid, headers: { "Proxy-Authorization": CANARY } },
        { ...valid, headers: { Accept: `application/json\r\n${CANARY}` } },
        { ...valid, body: new Uint8Array(1024 * 1024 + 1) },
        { ...valid, timeoutMs: 0 },
        { ...valid, maxResponseBytes: 6 * 1024 * 1024 },
        { ...valid, redirect: "follow" as "error" },
      ];

      for (const attempt of attempts) {
        await expect(
          isolated.boundary.assertNetwork(attempt),
        ).rejects.toMatchObject({ code: "network_rejected" });
      }
      expect(JSON.stringify(isolated.boundary.operations)).not.toContain(CANARY);
    } finally {
      await isolated.cleanup();
    }
  });

  it("rejects process executable, cwd, environment, and bounds mismatches", async () => {
    const isolated = await createIsolatedTestRoot();
    try {
      const unapprovedExecutable = join(isolated.paths.bin, "unapproved-host");
      await writeFile(unapprovedExecutable, "not allowlisted\n", "utf8");
      const valid = {
        executable: isolated.paths.fakeExecutable,
        args: ["--version"],
        cwd: isolated.paths.neutral,
        env: isolated.expectedProcessEnvironment,
        timeoutMs: 1_000,
        maxOutputBytes: 4_096,
      };
      const attempts = [
        { ...valid, executable: isolated.paths.outsideCanary },
        { ...valid, executable: unapprovedExecutable },
        { ...valid, cwd: isolated.paths.home },
        {
          ...valid,
          env: { ...isolated.expectedProcessEnvironment, PLURUM_API_KEY: CANARY },
        },
        { ...valid, env: { ...isolated.expectedProcessEnvironment, PATH: "/usr/bin" } },
        { ...valid, args: ["--help"] },
        { ...valid, args: ["bad\0argument"] },
        { ...valid, stdin: new Uint8Array([1]) },
        { ...valid, stdin: new Uint8Array(1024 * 1024 + 1) },
        { ...valid, maxOutputBytes: 6 * 1024 * 1024 },
      ];

      for (const attempt of attempts) {
        await expect(isolated.boundary.assertProcess(attempt)).rejects.toMatchObject({
          code: "process_rejected",
        });
      }
      expect(JSON.stringify(isolated.boundary.operations)).not.toContain(CANARY);
    } finally {
      await isolated.cleanup();
    }
  });

  it("revalidates the neutral cwd and environment paths before every process", async () => {
    const isolated = await createIsolatedTestRoot();
    const valid = {
      executable: isolated.paths.fakeExecutable,
      args: ["--version"],
      cwd: isolated.paths.neutral,
      env: isolated.expectedProcessEnvironment,
      timeoutMs: 1_000,
      maxOutputBytes: 4_096,
    };
    const neutralMarker = join(isolated.paths.neutral, "unexpected-file");
    try {
      await writeFile(neutralMarker, "unexpected", "utf8");
      await expect(isolated.boundary.assertProcess(valid)).rejects.toMatchObject({
        code: "process_rejected",
      });
      await unlink(neutralMarker);

      await rmdir(isolated.paths.home);
      try {
        await symlink(dirname(isolated.paths.outsideCanary), isolated.paths.home, "dir");
        await expect(isolated.boundary.assertProcess(valid)).rejects.toMatchObject({
          code: "process_rejected",
        });
      } finally {
        await unlink(isolated.paths.home).catch(() => undefined);
        await mkdir(isolated.paths.home, { mode: 0o700 });
        await chmod(isolated.paths.home, 0o700);
      }
    } finally {
      await unlink(neutralMarker).catch(() => undefined);
      await isolated.cleanup();
    }
  });

  it("rejects replacement of the allowlisted executable", async () => {
    const isolated = await createIsolatedTestRoot();
    const backup = join(isolated.paths.bin, "fake-host.original");
    try {
      await rename(isolated.paths.fakeExecutable, backup);
      try {
        await writeFile(
          isolated.paths.fakeExecutable,
          "controlled test executable\n",
          { encoding: "utf8", flag: "wx", mode: 0o700 },
        );
        await chmod(isolated.paths.fakeExecutable, 0o700);
        await expect(
          isolated.boundary.assertProcess({
            executable: isolated.paths.fakeExecutable,
            args: ["--version"],
            cwd: isolated.paths.neutral,
            env: isolated.expectedProcessEnvironment,
            timeoutMs: 1_000,
            maxOutputBytes: 4_096,
          }),
        ).rejects.toMatchObject({ code: "process_rejected" });
      } finally {
        await unlink(isolated.paths.fakeExecutable).catch(() => undefined);
        await rename(backup, isolated.paths.fakeExecutable);
      }
    } finally {
      await isolated.cleanup();
    }
  });

  it("requires the matching sentinel and refuses unsafe cleanup", async () => {
    const isolated = await createIsolatedTestRoot();
    const sentinel = join(isolated.paths.root, TEST_SENTINEL_FILENAME);
    try {
      try {
        await writeFile(sentinel, "wrong-run-id", "utf8");
        await expect(isolated.boundary.validateForCleanup()).rejects.toMatchObject({
          code: "invalid_sentinel",
        });
        await expect(readFile(isolated.paths.outsideCanary, "utf8")).resolves.toBe(
          `outside-canary-${isolated.runId}`,
        );
      } finally {
        await writeFile(sentinel, isolated.runId, "utf8");
      }
    } finally {
      await isolated.cleanup();
    }
  });

  it("detects unsafe root or sentinel permission changes", async () => {
    const isolated = await createIsolatedTestRoot();
    const sentinel = join(isolated.paths.root, TEST_SENTINEL_FILENAME);
    try {
      try {
        await chmod(isolated.paths.root, 0o755);
        await expect(isolated.boundary.validateForCleanup()).rejects.toMatchObject({
          code: "invalid_root",
        });
      } finally {
        await chmod(isolated.paths.root, 0o700);
      }

      try {
        await chmod(sentinel, 0o644);
        await expect(isolated.boundary.validateForCleanup()).rejects.toMatchObject({
          code: "invalid_sentinel",
        });
      } finally {
        await chmod(sentinel, 0o600);
      }
    } finally {
      await isolated.cleanup();
    }
  });

  it("detects replacement of the sentinel even with matching content", async () => {
    const isolated = await createIsolatedTestRoot();
    const sentinel = join(isolated.paths.root, TEST_SENTINEL_FILENAME);
    const backup = join(isolated.paths.root, ".plurum-test-root.original");
    try {
      await rename(sentinel, backup);
      try {
        await writeFile(sentinel, isolated.runId, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        await chmod(sentinel, 0o600);
        await expect(isolated.boundary.validateForCleanup()).rejects.toMatchObject({
          code: "invalid_sentinel",
        });
      } finally {
        await unlink(sentinel).catch(() => undefined);
        await rename(backup, sentinel);
      }
    } finally {
      await isolated.cleanup();
    }
  });

  it("rejects a mismatched environment and run identifier", async () => {
    const isolated = await createIsolatedTestRoot();
    try {
      await expect(
        TestAccessBoundary.create(
          {
            ...isolated.boundary.config,
            environment: {
              ...isolated.environment,
              PATH: isolated.paths.home,
            },
          },
          isolated.inspector,
        ),
      ).rejects.toMatchObject({ code: "invalid_environment" });
      await expect(
        TestAccessBoundary.create(
          {
            ...isolated.boundary.config,
            runId: "00000000-0000-4000-8000-000000000099",
          },
          isolated.inspector,
        ),
      ).rejects.toMatchObject({ code: "invalid_sentinel" });
      await expect(
        TestAccessBoundary.create(
          {
            ...isolated.boundary.config,
            environment: {
              ...isolated.environment,
              PLURUM_API_KEY: CANARY,
            },
          },
          isolated.inspector,
        ),
      ).rejects.toMatchObject({ code: "invalid_environment" });
      await expect(
        TestAccessBoundary.create(
          {
            ...isolated.boundary.config,
            forbiddenPaths: [dirname(isolated.paths.root)],
          },
          isolated.inspector,
        ),
      ).rejects.toMatchObject({ code: "invalid_root" });
    } finally {
      await isolated.cleanup();
    }
  });

  it("copies and deeply freezes boundary policy before using it", async () => {
    const isolated = await createIsolatedTestRoot();
    try {
      const mutableEnvironment = { ...isolated.environment };
      const mutableProcessEnvironment: Record<string, string> = {
        ...isolated.expectedProcessEnvironment,
      };
      const mutableConfig = {
        ...isolated.boundary.config,
        environment: mutableEnvironment,
        expectedProcessEnvironment: mutableProcessEnvironment,
        allowedProcessArguments: [["--version"]],
      };
      const copied = await TestAccessBoundary.create(
        mutableConfig,
        isolated.inspector,
      );

      mutableEnvironment.PLURUM_TEST_ROOT = isolated.paths.outsideCanary;
      mutableProcessEnvironment.PLURUM_API_KEY = CANARY;
      mutableConfig.allowedExecutable = isolated.paths.outsideCanary;
      mutableConfig.allowedProcessArguments[0]?.push(CANARY);

      expect(Object.isFrozen(copied.config)).toBe(true);
      expect(Object.isFrozen(copied.config.environment)).toBe(true);
      expect(Object.isFrozen(copied.config.expectedProcessEnvironment)).toBe(true);
      expect(Object.isFrozen(copied.config.allowedProcessArguments)).toBe(true);
      expect(Object.isFrozen(copied.config.allowedProcessArguments[0])).toBe(true);
      await expect(
        copied.assertProcess({
          executable: isolated.paths.fakeExecutable,
          args: ["--version"],
          cwd: isolated.paths.neutral,
          env: isolated.expectedProcessEnvironment,
          timeoutMs: 1_000,
          maxOutputBytes: 4_096,
        }),
      ).resolves.toBeUndefined();
      expect(JSON.stringify(copied.operations)).not.toContain(CANARY);
    } finally {
      await isolated.cleanup();
    }
  });

  it("creates unique parallel roots and removes both safely", async () => {
    const created: IsolatedTestRoot[] = [];
    async function capture(
      pending: Promise<IsolatedTestRoot>,
    ): Promise<IsolatedTestRoot> {
      const isolated = await pending;
      created.push(isolated);
      return isolated;
    }
    try {
      const [first, second] = await Promise.all([
        capture(createIsolatedTestRoot()),
        capture(createIsolatedTestRoot()),
      ]);
      expect(first.paths.root).not.toBe(second.paths.root);
      expect(first.runId).not.toBe(second.runId);
    } finally {
      await Promise.all(created.map(async (isolated) => isolated.cleanup()));
    }
  });

  },
);

describe("portable path policy", () => {
  it("uses component-aware containment on POSIX and Windows path syntax", () => {
    expect(isPathWithin("/safe/root", "/safe/root/child", "linux")).toBe(true);
    expect(isPathWithin("/safe/root", "/safe/root-evil", "linux")).toBe(false);
    expect(isPathWithin("C:\\safe\\root", "C:\\safe\\root\\child", "win32")).toBe(
      true,
    );
    expect(isPathWithin("C:\\safe\\root", "C:\\safe\\root-evil", "win32")).toBe(
      false,
    );
    expect(normalizeOs("aix")).toBe("unsupported");
  });
});
