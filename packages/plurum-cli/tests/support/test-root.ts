import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyElevation,
  normalizeOs,
} from "../../src/adapters/node/platform.js";
import type {
  ElevationState,
  PathMetadata,
  SupportedOs,
} from "../../src/system/contracts.js";
import {
  TEST_SENTINEL_FILENAME,
  TestAccessBoundary,
  type BoundaryInspector,
} from "./test-boundary.js";

export interface IsolatedTestPaths {
  readonly root: string;
  readonly home: string;
  readonly config: string;
  readonly state: string;
  readonly appData: string;
  readonly localAppData: string;
  readonly userProfile: string;
  readonly codex: string;
  readonly claude: string;
  readonly plurum: string;
  readonly npmCache: string;
  readonly npmConfig: string;
  readonly temporary: string;
  readonly bin: string;
  readonly neutral: string;
  readonly fakeExecutable: string;
  readonly outsideCanary: string;
}

export interface IsolatedTestRoot {
  readonly runId: string;
  readonly paths: IsolatedTestPaths;
  readonly environment: Readonly<Record<string, string>>;
  readonly expectedProcessEnvironment: Readonly<Record<string, string>>;
  readonly allowedOrigin: string;
  readonly boundary: TestAccessBoundary;
  readonly inspector: BoundaryInspector;
  cleanup(): Promise<void>;
}

function metadataFromStats(stats: Stats): PathMetadata {
  const kind = stats.isSymbolicLink()
    ? "symbolic-link"
    : stats.isFile()
      ? "file"
      : stats.isDirectory()
        ? "directory"
        : "other";
  return {
    kind,
    mode: stats.mode,
    size: stats.size,
    links: stats.nlink,
    device: stats.dev,
    inode: stats.ino,
    uid: stats.uid,
    gid: stats.gid,
  };
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

async function readBoundedText(target: string, maxBytes: number): Promise<string> {
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maxBytes) {
      throw new Error("Isolated test metadata exceeded its size bound.");
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) {
      throw new Error("Isolated test metadata exceeded its size bound.");
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export const nodeBoundaryInspector: BoundaryInspector =
  Object.freeze<BoundaryInspector>({
    async lstat(target): Promise<PathMetadata | null> {
      try {
        return metadataFromStats(await lstat(target));
      } catch (error) {
        if (isMissing(error)) {
          return null;
        }
        throw error;
      }
    },
    realpath,
    readText: readBoundedText,
    readDirectory: readdir,
  });

function currentTestElevation(): {
  readonly platform: SupportedOs;
  readonly elevation: ElevationState;
  readonly uid: number | undefined;
} {
  const platform = normalizeOs(process.platform);
  const groups = process.getgroups?.();
  return {
    platform,
    uid: process.getuid?.(),
    elevation: classifyElevation({
      os: platform,
      uid: process.getuid?.(),
      euid: process.geteuid?.(),
      gid: process.getgid?.(),
      egid: process.getegid?.(),
      rootGroupDetected: groups === undefined ? undefined : groups.includes(0),
      sudoDetected:
        process.env.SUDO_UID !== undefined || process.env.SUDO_USER !== undefined,
    }),
  };
}

export function isIsolatedTestEnvironmentSafe(): boolean {
  const state = currentTestElevation();
  return (
    (state.platform === "darwin" || state.platform === "linux") &&
    state.elevation === "standard" &&
    state.uid !== undefined &&
    state.uid !== 0
  );
}

async function createPrivateDirectory(target: string): Promise<void> {
  await mkdir(target, { mode: 0o700 });
  await chmod(target, 0o700);
}

async function writePrivateSentinel(
  root: string,
  content: string,
): Promise<void> {
  const sentinel = join(root, TEST_SENTINEL_FILENAME);
  await writeFile(sentinel, content, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await chmod(sentinel, 0o600);
}

async function validateOwnedRoot(
  root: string,
  expectedUid: number,
  sentinelContent: string,
): Promise<void> {
  const rootMetadata = await lstat(root);
  if (
    !rootMetadata.isDirectory() ||
    rootMetadata.isSymbolicLink() ||
    rootMetadata.uid !== expectedUid ||
    (rootMetadata.mode & 0o077) !== 0 ||
    (await realpath(root)) !== root
  ) {
    throw new Error("Isolated test root ownership validation failed.");
  }
  const sentinel = join(root, TEST_SENTINEL_FILENAME);
  const sentinelMetadata = await lstat(sentinel);
  if (
    !sentinelMetadata.isFile() ||
    sentinelMetadata.isSymbolicLink() ||
    sentinelMetadata.uid !== expectedUid ||
    sentinelMetadata.nlink !== 1 ||
    (sentinelMetadata.mode & 0o077) !== 0 ||
    (await realpath(sentinel)) !== sentinel ||
    (await readBoundedText(sentinel, 256)) !== sentinelContent
  ) {
    throw new Error("Isolated test sentinel validation failed.");
  }
}

async function removeOwnedRoot(
  root: string,
  expectedUid: number,
  sentinelContent: string,
): Promise<void> {
  await validateOwnedRoot(root, expectedUid, sentinelContent);
  await rm(root, { recursive: true, force: false });
  if ((await nodeBoundaryInspector.lstat(root)) !== null) {
    throw new Error("Isolated test root cleanup did not complete.");
  }
}

async function removeEmptyCreatedRoot(
  root: string,
  expectedUid: number,
): Promise<void> {
  const metadata = await lstat(root);
  if (
    !metadata.isDirectory() ||
    metadata.uid !== expectedUid ||
    (metadata.mode & 0o077) !== 0 ||
    (await realpath(root)) !== root ||
    (await readdir(root)).length !== 0
  ) {
    throw new Error("Empty isolated test root validation failed.");
  }
  await rmdir(root);
}

export async function createIsolatedTestRoot(): Promise<IsolatedTestRoot> {
  const execution = currentTestElevation();
  if (
    execution.elevation !== "standard" ||
    execution.uid === undefined ||
    execution.uid === 0 ||
    (execution.platform !== "darwin" && execution.platform !== "linux")
  ) {
    throw new Error(
      "Isolated filesystem tests require a verified non-elevated POSIX user.",
    );
  }
  const expectedUid = execution.uid;

  const trustedBase = await realpath(tmpdir());
  const runId = randomUUID();
  const outsideSentinelContent = `outside-${runId}`;
  let root: string | undefined;
  let outsideRoot: string | undefined;
  let rootSentinelCreated = false;
  let outsideSentinelCreated = false;

  try {
    root = await realpath(await mkdtemp(join(trustedBase, "plurum-step40-")));
    await chmod(root, 0o700);
    await writePrivateSentinel(root, runId);
    rootSentinelCreated = true;

    outsideRoot = await realpath(
      await mkdtemp(join(trustedBase, "plurum-step40-canary-")),
    );
    await chmod(outsideRoot, 0o700);
    await writePrivateSentinel(outsideRoot, outsideSentinelContent);
    outsideSentinelCreated = true;

    const home = join(root, "home");
    const config = join(root, "config");
    const state = join(root, "state");
    const appData = join(root, "appdata");
    const localAppData = join(root, "localappdata");
    const userProfile = join(root, "userprofile");
    const codex = join(root, "codex");
    const claude = join(root, "claude");
    const plurum = join(root, "plurum");
    const npmCache = join(root, "npm-cache");
    const npmDirectory = join(root, "npm-config");
    const npmConfig = join(npmDirectory, "npmrc");
    const temporary = join(root, "tmp");
    const bin = join(root, "bin");
    const neutral = join(root, "neutral");

    for (const directory of [
      home,
      config,
      state,
      appData,
      localAppData,
      userProfile,
      codex,
      claude,
      plurum,
      npmCache,
      npmDirectory,
      temporary,
      bin,
      neutral,
    ]) {
      await createPrivateDirectory(directory);
    }

    const fakeExecutable = join(bin, "fake-host");
    await writeFile(fakeExecutable, "controlled test executable\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o700,
    });
    await chmod(fakeExecutable, 0o700);

    const outsideCanary = join(outsideRoot, "outside-canary.txt");
    const outsideCanaryContent = `outside-canary-${runId}`;
    await writeFile(outsideCanary, outsideCanaryContent, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(outsideCanary, 0o600);
    const outsideCanaryStats = await lstat(outsideCanary);

    const environment = Object.freeze({
      HOME: home,
      PLURUM_HOME: plurum,
      XDG_CONFIG_HOME: config,
      XDG_STATE_HOME: state,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      USERPROFILE: userProfile,
      CODEX_HOME: codex,
      CLAUDE_CONFIG_DIR: claude,
      npm_config_cache: npmCache,
      npm_config_userconfig: npmConfig,
      TMPDIR: temporary,
      TEMP: temporary,
      TMP: temporary,
      PATH: bin,
      PLURUM_TEST_ROOT: root,
      PLURUM_TEST_RUN_ID: runId,
    });
    const expectedProcessEnvironment = Object.freeze({
      PATH: bin,
      HOME: home,
      PLURUM_HOME: plurum,
      TMPDIR: temporary,
      TEMP: temporary,
      TMP: temporary,
    });
    const allowedOrigin = "http://127.0.0.1:43197";

    const boundary = await TestAccessBoundary.create(
      {
        root,
        runId,
        platform: execution.platform,
        expectedUid,
        environment,
        trustedBase,
        forbiddenPaths: [homedir(), process.cwd(), outsideRoot],
        binDirectory: bin,
        allowedExecutable: fakeExecutable,
        neutralDirectory: neutral,
        temporaryDirectory: temporary,
        allowedOrigin,
        allowedRequests: [
          { method: "GET", path: "/health" },
          { method: "GET", path: "/api/v1/agents/me" },
          { method: "POST", path: "/mcp" },
        ],
        allowedHeaderNames: ["accept", "authorization", "content-type"],
        expectedProcessEnvironment,
        allowedProcessArguments: [["--version"]],
        allowProcessStdin: false,
      },
      nodeBoundaryInspector,
    );

    let rootRemoved = false;
    let outsideRemoved = false;
    const isolatedRoot = root;
    const isolatedOutsideRoot = outsideRoot;
    return {
      runId,
      paths: Object.freeze({
        root,
        home,
        config,
        state,
        appData,
        localAppData,
        userProfile,
        codex,
        claude,
        plurum,
        npmCache,
        npmConfig,
        temporary,
        bin,
        neutral,
        fakeExecutable,
        outsideCanary,
      }),
      environment,
      expectedProcessEnvironment,
      allowedOrigin,
      boundary,
      inspector: nodeBoundaryInspector,
      async cleanup(): Promise<void> {
        if (!rootRemoved) {
          await boundary.validateForCleanup();
          await validateOwnedRoot(
            isolatedOutsideRoot,
            expectedUid,
            outsideSentinelContent,
          );
          const currentCanaryStats = await lstat(outsideCanary);
          if (
            (await readFile(outsideCanary, "utf8")) !== outsideCanaryContent ||
            currentCanaryStats.size !== outsideCanaryStats.size ||
            currentCanaryStats.mode !== outsideCanaryStats.mode ||
            currentCanaryStats.nlink !== outsideCanaryStats.nlink ||
            currentCanaryStats.mtimeMs !== outsideCanaryStats.mtimeMs
          ) {
            throw new Error("Outside-root canary validation failed; cleanup refused.");
          }
          await removeOwnedRoot(isolatedRoot, expectedUid, runId);
          rootRemoved = true;
        }
        if (!outsideRemoved) {
          await validateOwnedRoot(
            isolatedOutsideRoot,
            expectedUid,
            outsideSentinelContent,
          );
          await removeOwnedRoot(
            isolatedOutsideRoot,
            expectedUid,
            outsideSentinelContent,
          );
          outsideRemoved = true;
        }
      },
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const candidate of [
      { path: root, sentinel: runId, created: rootSentinelCreated },
      {
        path: outsideRoot,
        sentinel: outsideSentinelContent,
        created: outsideSentinelCreated,
      },
    ]) {
      if (candidate.path === undefined) {
        continue;
      }
      try {
        if (candidate.created) {
          await removeOwnedRoot(candidate.path, expectedUid, candidate.sentinel);
        } else {
          await removeEmptyCreatedRoot(candidate.path, expectedUid);
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Isolated test setup failed and safe cleanup was incomplete.",
      );
    }
    throw error;
  }
}
