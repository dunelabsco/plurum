import path from "node:path";

import type {
  NetworkRequest,
  PathMetadata,
  ProcessRequest,
  SupportedOs,
} from "../../src/system/contracts.js";
import { TestBoundaryViolationError } from "../../src/system/errors.js";

export const TEST_SENTINEL_FILENAME = ".plurum-test-root";

const DIRECTORY_ENVIRONMENT_KEYS = [
  "HOME",
  "PLURUM_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "npm_config_cache",
  "TMPDIR",
  "TEMP",
  "TMP",
] as const;

const PROCESS_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "PLURUM_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "TMPDIR",
  "TEMP",
  "TMP",
] as const;

const TEST_ENVIRONMENT_KEYS = new Set<string>([
  ...DIRECTORY_ENVIRONMENT_KEYS,
  "PATH",
  "PLURUM_TEST_ROOT",
  "PLURUM_TEST_RUN_ID",
  "npm_config_userconfig",
]);

export interface AllowedNetworkRequest {
  readonly method: "GET" | "POST";
  readonly path: string;
}

export type FileBoundaryOperation =
  | "read"
  | "write"
  | "temporary"
  | "rename-source"
  | "rename-destination"
  | "delete"
  | "execute";

export type BoundaryOperation =
  | {
      readonly kind: "filesystem";
      readonly operation: FileBoundaryOperation;
      readonly target: string;
    }
  | {
      readonly kind: "network";
      readonly operation: "GET" | "POST";
      readonly target: string;
    }
  | {
      readonly kind: "process";
      readonly operation: "run";
      readonly target: string;
    };

export interface BoundaryInspector {
  lstat(target: string): Promise<PathMetadata | null>;
  realpath(target: string): Promise<string>;
  readText(target: string, maxBytes: number): Promise<string>;
  readDirectory(target: string): Promise<readonly string[]>;
}

export interface TestBoundaryConfig {
  readonly root: string;
  readonly runId: string;
  readonly platform: SupportedOs;
  readonly expectedUid?: number;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly trustedBase: string;
  readonly forbiddenPaths: readonly string[];
  readonly binDirectory: string;
  readonly allowedExecutable: string;
  readonly neutralDirectory: string;
  readonly temporaryDirectory: string;
  readonly allowedOrigin: string;
  readonly allowedRequests: readonly AllowedNetworkRequest[];
  readonly allowedHeaderNames: readonly string[];
  readonly expectedProcessEnvironment: Readonly<Record<string, string>>;
  readonly allowedProcessArguments: readonly (readonly string[])[];
  readonly allowProcessStdin: boolean;
}

type PathApi = typeof path.posix;

function pathApiFor(platform: SupportedOs): PathApi {
  return platform === "win32" ? path.win32 : path.posix;
}

function comparable(value: string, platform: SupportedOs): string {
  return platform === "win32" ? value.toLowerCase() : value;
}

export function isPathWithin(
  root: string,
  candidate: string,
  platform: SupportedOs,
): boolean {
  const api = pathApiFor(platform);
  const relative = api.relative(
    comparable(api.resolve(root), platform),
    comparable(api.resolve(candidate), platform),
  );
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${api.sep}`) &&
      !api.isAbsolute(relative))
  );
}

function pathHasParentSegment(value: string): boolean {
  return value
    .split(/[\\/]/u)
    .some((component) => component === "." || component === "..");
}

function samePath(
  left: string,
  right: string,
  platform: SupportedOs,
): boolean {
  const api = pathApiFor(platform);
  return comparable(api.resolve(left), platform) === comparable(api.resolve(right), platform);
}

function validateRequestBounds(timeoutMs: number, maxBytes: number): boolean {
  return (
    Number.isSafeInteger(timeoutMs) &&
    timeoutMs > 0 &&
    timeoutMs <= 120_000 &&
    Number.isSafeInteger(maxBytes) &&
    maxBytes > 0 &&
    maxBytes <= 5 * 1024 * 1024
  );
}

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
  readonly size: number;
  readonly uid: number | undefined;
}

function fileIdentity(metadata: PathMetadata): FileIdentity | undefined {
  if (metadata.device === undefined || metadata.inode === undefined) {
    return undefined;
  }
  return Object.freeze({
    device: metadata.device,
    inode: metadata.inode,
    mode: metadata.mode,
    size: metadata.size,
    uid: metadata.uid,
  });
}

function sameIdentity(
  metadata: PathMetadata,
  expected: FileIdentity,
): boolean {
  return (
    metadata.device === expected.device &&
    metadata.inode === expected.inode &&
    metadata.mode === expected.mode &&
    metadata.size === expected.size &&
    metadata.uid === expected.uid
  );
}

function sameNodeIdentity(
  metadata: PathMetadata,
  expected: FileIdentity,
): boolean {
  return (
    metadata.device === expected.device &&
    metadata.inode === expected.inode &&
    metadata.uid === expected.uid
  );
}

function freezeConfig(config: TestBoundaryConfig): TestBoundaryConfig {
  return Object.freeze({
    ...config,
    environment: Object.freeze({ ...config.environment }),
    forbiddenPaths: Object.freeze([...config.forbiddenPaths]),
    allowedRequests: Object.freeze(
      config.allowedRequests.map((request) => Object.freeze({ ...request })),
    ),
    allowedHeaderNames: Object.freeze([...config.allowedHeaderNames]),
    expectedProcessEnvironment: Object.freeze({
      ...config.expectedProcessEnvironment,
    }),
    allowedProcessArguments: Object.freeze(
      config.allowedProcessArguments.map((args) => Object.freeze([...args])),
    ),
  });
}

export class TestAccessBoundary {
  readonly #api: PathApi;
  readonly #canonicalRoot: string;
  readonly #rootIdentity: FileIdentity;
  readonly #allowedOrigin: string;
  readonly #allowedRequests: ReadonlySet<string>;
  readonly #allowedHeaderNames: ReadonlySet<string>;
  readonly #allowedProcessArguments: ReadonlySet<string>;
  readonly #operations: BoundaryOperation[] = [];
  #sentinelIdentity: FileIdentity | undefined;
  #executableIdentity: FileIdentity | undefined;
  readonly config: TestBoundaryConfig;
  readonly inspector: BoundaryInspector;

  private constructor(
    config: TestBoundaryConfig,
    inspector: BoundaryInspector,
    canonicalRoot: string,
    allowedOrigin: string,
    rootIdentity: FileIdentity,
  ) {
    this.config = freezeConfig(config);
    this.inspector = Object.freeze({
      lstat: inspector.lstat.bind(inspector),
      realpath: inspector.realpath.bind(inspector),
      readText: inspector.readText.bind(inspector),
      readDirectory: inspector.readDirectory.bind(inspector),
    });
    this.#api = pathApiFor(this.config.platform);
    this.#canonicalRoot = canonicalRoot;
    this.#rootIdentity = rootIdentity;
    this.#allowedOrigin = allowedOrigin;
    this.#allowedRequests = new Set(
      this.config.allowedRequests.map(({ method, path: requestPath }) =>
        JSON.stringify([method, requestPath]),
      ),
    );
    this.#allowedHeaderNames = new Set(this.config.allowedHeaderNames);
    this.#allowedProcessArguments = new Set(
      this.config.allowedProcessArguments.map((args) => JSON.stringify(args)),
    );
  }

  static async create(
    config: TestBoundaryConfig,
    inspector: BoundaryInspector,
  ): Promise<TestAccessBoundary> {
    const api = pathApiFor(config.platform);
    if (
      (config.platform !== "darwin" && config.platform !== "linux") ||
      config.expectedUid === undefined ||
      config.expectedUid === 0 ||
      config.runId.length < 16 ||
      config.runId.length > 200 ||
      config.runId.includes("\0") ||
      !api.isAbsolute(config.root) ||
      pathHasParentSegment(config.root)
    ) {
      throw new TestBoundaryViolationError("invalid_root");
    }

    const resolvedRoot = api.resolve(config.root);
    if (samePath(resolvedRoot, api.parse(resolvedRoot).root, config.platform)) {
      throw new TestBoundaryViolationError("invalid_root");
    }

    let rootMetadata: PathMetadata | null;
    try {
      rootMetadata = await inspector.lstat(resolvedRoot);
    } catch {
      throw new TestBoundaryViolationError("invalid_root");
    }
    if (rootMetadata?.kind !== "directory") {
      throw new TestBoundaryViolationError("invalid_root");
    }
    if (
      (rootMetadata.mode & 0o077) !== 0 ||
      rootMetadata.uid !== config.expectedUid
    ) {
      throw new TestBoundaryViolationError("invalid_root");
    }

    const rootIdentity = fileIdentity(rootMetadata);
    if (rootIdentity === undefined) {
      throw new TestBoundaryViolationError("invalid_root");
    }

    let canonicalRoot: string;
    try {
      canonicalRoot = await inspector.realpath(resolvedRoot);
    } catch {
      throw new TestBoundaryViolationError("invalid_root");
    }
    if (!samePath(canonicalRoot, resolvedRoot, config.platform)) {
      throw new TestBoundaryViolationError("invalid_root");
    }
    if (
      !api.isAbsolute(config.trustedBase) ||
      pathHasParentSegment(config.trustedBase)
    ) {
      throw new TestBoundaryViolationError("invalid_root");
    }
    let canonicalTrustedBase: string;
    try {
      canonicalTrustedBase = await inspector.realpath(config.trustedBase);
    } catch {
      throw new TestBoundaryViolationError("invalid_root");
    }
    if (
      !samePath(canonicalTrustedBase, config.trustedBase, config.platform) ||
      samePath(canonicalRoot, canonicalTrustedBase, config.platform) ||
      !isPathWithin(canonicalTrustedBase, canonicalRoot, config.platform)
    ) {
      throw new TestBoundaryViolationError("invalid_root");
    }
    for (const forbidden of config.forbiddenPaths) {
      if (!api.isAbsolute(forbidden)) {
        throw new TestBoundaryViolationError("invalid_root");
      }
      if (
        samePath(canonicalRoot, forbidden, config.platform) ||
        isPathWithin(canonicalRoot, forbidden, config.platform) ||
        isPathWithin(forbidden, canonicalRoot, config.platform)
      ) {
        throw new TestBoundaryViolationError("invalid_root");
      }
    }

    let allowedUrl: URL;
    try {
      allowedUrl = new URL(config.allowedOrigin);
    } catch {
      throw new TestBoundaryViolationError("network_rejected");
    }
    if (
      allowedUrl.protocol !== "http:" ||
      !["127.0.0.1", "[::1]"].includes(allowedUrl.hostname) ||
      allowedUrl.port === "" ||
      allowedUrl.pathname !== "/" ||
      allowedUrl.username !== "" ||
      allowedUrl.password !== "" ||
      allowedUrl.search !== "" ||
      allowedUrl.hash !== ""
    ) {
      throw new TestBoundaryViolationError("network_rejected");
    }
    if (
      config.allowedRequests.length === 0 ||
      config.allowedRequests.some(
        ({ path: allowedPath }) =>
          !allowedPath.startsWith("/") ||
          allowedPath.includes("?") ||
          allowedPath.includes("#") ||
          allowedPath.includes("\\") ||
          new URL(allowedPath, allowedUrl.origin).pathname !== allowedPath,
      ) ||
      new Set(
        config.allowedRequests.map(({ method, path: allowedPath }) =>
          JSON.stringify([method, allowedPath]),
        ),
      ).size !== config.allowedRequests.length ||
      config.allowedHeaderNames.some(
        (header) =>
          header !== header.toLowerCase() ||
          !/^[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(header),
      ) ||
      new Set(config.allowedHeaderNames).size !== config.allowedHeaderNames.length ||
      config.allowedProcessArguments.length === 0 ||
      config.allowedProcessArguments.some((args) =>
        args.some((argument) => argument.includes("\0")),
      )
    ) {
      throw new TestBoundaryViolationError("network_rejected");
    }

    const boundary = new TestAccessBoundary(
      config,
      inspector,
      canonicalRoot,
      allowedUrl.origin,
      rootIdentity,
    );
    await boundary.#validateSentinel(true);
    await boundary.#validateEnvironment();
    return boundary;
  }

  get operations(): readonly BoundaryOperation[] {
    return Object.freeze(
      this.#operations.map((operation) => Object.freeze({ ...operation })),
    );
  }

  async assertPath(
    target: string,
    operation: FileBoundaryOperation,
  ): Promise<string> {
    await this.#validateSentinel();
    const resolved = await this.#inspectPath(target, operation);
    this.#operations.push(
      Object.freeze({ kind: "filesystem", operation, target: resolved }),
    );
    return resolved;
  }

  async assertRename(
    source: string,
    destination: string,
  ): Promise<readonly [string, string]> {
    await this.#validateSentinel();
    const resolvedSource = await this.#inspectPath(source, "rename-source");
    const resolvedDestination = await this.#inspectPath(
      destination,
      "rename-destination",
    );
    this.#operations.push(
      Object.freeze({
        kind: "filesystem",
        operation: "rename-source",
        target: resolvedSource,
      }),
      Object.freeze({
        kind: "filesystem",
        operation: "rename-destination",
        target: resolvedDestination,
      }),
    );
    return Object.freeze([resolvedSource, resolvedDestination] as const);
  }

  async assertNetwork(request: NetworkRequest): Promise<void> {
    await this.#validateSentinel();
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      throw new TestBoundaryViolationError("network_rejected");
    }
    if (
      url.origin !== this.#allowedOrigin ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      !this.#allowedRequests.has(
        JSON.stringify([request.method, url.pathname]),
      ) ||
      request.redirect !== "error" ||
      !validateRequestBounds(request.timeoutMs, request.maxResponseBytes) ||
      (request.body?.byteLength ?? 0) > 1024 * 1024
    ) {
      throw new TestBoundaryViolationError("network_rejected");
    }

    const seenHeaders = new Set<string>();
    for (const [name, value] of Object.entries(request.headers)) {
      const normalizedName = name.toLowerCase();
      if (
        seenHeaders.has(normalizedName) ||
        !this.#allowedHeaderNames.has(normalizedName) ||
        name.includes("\0") ||
        /[\r\n\0]/u.test(value)
      ) {
        throw new TestBoundaryViolationError("network_rejected");
      }
      seenHeaders.add(normalizedName);
    }
    this.#operations.push(
      Object.freeze({
        kind: "network",
        operation: request.method,
        target: `${url.origin}${url.pathname}`,
      }),
    );
  }

  async assertProcess(request: ProcessRequest): Promise<void> {
    await this.#validateSentinel();
    let executable: string;
    let cwd: string;
    try {
      executable = await this.#inspectPath(request.executable, "execute");
      cwd = await this.#inspectPath(request.cwd, "read");
    } catch {
      throw new TestBoundaryViolationError("process_rejected");
    }
    const executableMetadata = await this.inspector.lstat(executable);
    if (
      executableMetadata?.kind !== "file" ||
      !samePath(executable, this.config.allowedExecutable, this.config.platform) ||
      this.#executableIdentity === undefined ||
      !sameIdentity(executableMetadata, this.#executableIdentity) ||
      executableMetadata.links !== 1
    ) {
      throw new TestBoundaryViolationError("process_rejected");
    }

    if (!samePath(cwd, this.config.neutralDirectory, this.config.platform)) {
      throw new TestBoundaryViolationError("process_rejected");
    }
    if (
      !this.#allowedProcessArguments.has(JSON.stringify(request.args)) ||
      (!this.config.allowProcessStdin && request.stdin !== undefined) ||
      (request.stdin?.byteLength ?? 0) > 1024 * 1024 ||
      !validateRequestBounds(request.timeoutMs, request.maxOutputBytes)
    ) {
      throw new TestBoundaryViolationError("process_rejected");
    }

    try {
      for (const value of Object.values(request.env)) {
        const resolved = await this.#inspectPath(value, "read");
        if ((await this.inspector.lstat(resolved))?.kind !== "directory") {
          throw new TestBoundaryViolationError("process_rejected");
        }
      }
      if ((await this.inspector.readDirectory(cwd)).length !== 0) {
        throw new TestBoundaryViolationError("process_rejected");
      }
    } catch {
      throw new TestBoundaryViolationError("process_rejected");
    }

    const expectedEntries = Object.entries(this.config.expectedProcessEnvironment).sort();
    const actualEntries = Object.entries(request.env).sort();
    const processPath = request.env.PATH;
    if (
      processPath === undefined ||
      JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries) ||
      !samePath(processPath, this.config.binDirectory, this.config.platform)
    ) {
      throw new TestBoundaryViolationError("process_rejected");
    }

    this.#operations.push(
      Object.freeze({ kind: "process", operation: "run", target: executable }),
    );
  }

  async validateForCleanup(): Promise<void> {
    await this.#validateRoot();
    await this.#validateSentinel();
  }

  async #validateRoot(): Promise<void> {
    let metadata: PathMetadata | null;
    let canonicalRoot: string;
    try {
      metadata = await this.inspector.lstat(this.config.root);
      canonicalRoot = await this.inspector.realpath(this.config.root);
    } catch {
      throw new TestBoundaryViolationError("invalid_root");
    }
    if (
      metadata?.kind !== "directory" ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.uid !== this.config.expectedUid ||
      !sameNodeIdentity(metadata, this.#rootIdentity) ||
      !samePath(canonicalRoot, this.#canonicalRoot, this.config.platform)
    ) {
      throw new TestBoundaryViolationError("invalid_root");
    }
  }

  async #validateSentinel(captureIdentity = false): Promise<void> {
    await this.#validateRoot();
    const sentinel = this.#api.join(this.#canonicalRoot, TEST_SENTINEL_FILENAME);
    let metadata: PathMetadata | null;
    let canonicalSentinel: string;
    let sentinelContent: string;
    try {
      metadata = await this.inspector.lstat(sentinel);
      canonicalSentinel = await this.inspector.realpath(sentinel);
      sentinelContent = await this.inspector.readText(sentinel, 256);
    } catch {
      throw new TestBoundaryViolationError("invalid_sentinel");
    }
    if (
      metadata?.kind !== "file" ||
      metadata.links !== 1 ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.uid !== this.config.expectedUid
    ) {
      throw new TestBoundaryViolationError("invalid_sentinel");
    }
    if (
      !samePath(canonicalSentinel, sentinel, this.config.platform) ||
      sentinelContent !== this.config.runId
    ) {
      throw new TestBoundaryViolationError("invalid_sentinel");
    }
    const identity = fileIdentity(metadata);
    if (identity === undefined) {
      throw new TestBoundaryViolationError("invalid_sentinel");
    }
    if (captureIdentity) {
      this.#sentinelIdentity = identity;
    } else if (
      this.#sentinelIdentity === undefined ||
      !sameIdentity(metadata, this.#sentinelIdentity)
    ) {
      throw new TestBoundaryViolationError("invalid_sentinel");
    }
  }

  async #validateEnvironment(): Promise<void> {
    const configuredKeys = Object.keys(this.config.environment);
    if (
      configuredKeys.length !== TEST_ENVIRONMENT_KEYS.size ||
      configuredKeys.some((key) => !TEST_ENVIRONMENT_KEYS.has(key))
    ) {
      throw new TestBoundaryViolationError("invalid_environment");
    }
    const configuredRoot = this.config.environment.PLURUM_TEST_ROOT;
    const configuredPath = this.config.environment.PATH;
    if (
      configuredRoot === undefined ||
      configuredPath === undefined ||
      !samePath(configuredRoot, this.#canonicalRoot, this.config.platform) ||
      this.config.environment.PLURUM_TEST_RUN_ID !== this.config.runId ||
      !samePath(configuredPath, this.config.binDirectory, this.config.platform)
    ) {
      throw new TestBoundaryViolationError("invalid_environment");
    }

    for (const key of DIRECTORY_ENVIRONMENT_KEYS) {
      const value = this.config.environment[key];
      if (value === undefined) {
        throw new TestBoundaryViolationError("invalid_environment");
      }
      const resolved = await this.#inspectPath(value, "read");
      if ((await this.inspector.lstat(resolved))?.kind !== "directory") {
        throw new TestBoundaryViolationError("invalid_environment");
      }
    }

    const npmConfig = this.config.environment.npm_config_userconfig;
    if (npmConfig === undefined) {
      throw new TestBoundaryViolationError("invalid_environment");
    }
    const resolvedNpmConfig = await this.#inspectPath(npmConfig, "read");
    const npmConfigMetadata = await this.inspector.lstat(resolvedNpmConfig);
    if (npmConfigMetadata !== null && npmConfigMetadata.kind !== "file") {
      throw new TestBoundaryViolationError("invalid_environment");
    }

    for (const directory of [
      this.config.binDirectory,
      this.config.neutralDirectory,
      this.config.temporaryDirectory,
    ]) {
      const resolved = await this.#inspectPath(directory, "read");
      if ((await this.inspector.lstat(resolved))?.kind !== "directory") {
        throw new TestBoundaryViolationError("invalid_environment");
      }
    }

    const allowedExecutable = await this.#inspectPath(
      this.config.allowedExecutable,
      "execute",
    );
    const executableMetadata = await this.inspector.lstat(allowedExecutable);
    if (
      executableMetadata?.kind !== "file" ||
      !isPathWithin(
        this.config.binDirectory,
        allowedExecutable,
        this.config.platform,
      ) ||
      (this.config.platform !== "win32" &&
        (executableMetadata.mode & 0o111) === 0)
    ) {
      throw new TestBoundaryViolationError("invalid_environment");
    }
    const executableIdentity = fileIdentity(executableMetadata);
    if (
      executableMetadata.links !== 1 ||
      executableIdentity === undefined ||
      executableMetadata.uid !== this.config.expectedUid ||
      (executableMetadata.mode & 0o022) !== 0
    ) {
      throw new TestBoundaryViolationError("invalid_environment");
    }
    this.#executableIdentity = executableIdentity;

    const allowedProcessKeys = new Set<string>(PROCESS_ENVIRONMENT_KEYS);
    for (const [key, value] of Object.entries(
      this.config.expectedProcessEnvironment,
    )) {
      if (!allowedProcessKeys.has(key)) {
        throw new TestBoundaryViolationError("invalid_environment");
      }
      const resolved = await this.#inspectPath(value, "read");
      if ((await this.inspector.lstat(resolved))?.kind !== "directory") {
        throw new TestBoundaryViolationError("invalid_environment");
      }
    }

    const tmpdir = this.config.environment.TMPDIR;
    const temp = this.config.environment.TEMP;
    const tmp = this.config.environment.TMP;
    if (
      tmpdir === undefined ||
      temp === undefined ||
      tmp === undefined ||
      !samePath(tmpdir, this.config.temporaryDirectory, this.config.platform) ||
      !samePath(temp, this.config.temporaryDirectory, this.config.platform) ||
      !samePath(tmp, this.config.temporaryDirectory, this.config.platform) ||
      (await this.inspector.readDirectory(this.config.neutralDirectory)).length !== 0
    ) {
      throw new TestBoundaryViolationError("invalid_environment");
    }
  }

  async #inspectPath(
    target: string,
    operation: FileBoundaryOperation,
  ): Promise<string> {
    await this.#validateRoot();
    if (
      target.includes("\0") ||
      pathHasParentSegment(target) ||
      !this.#api.isAbsolute(target) ||
      (this.config.platform === "win32" && target.startsWith("\\\\"))
    ) {
      throw new TestBoundaryViolationError("path_escape");
    }

    const resolved = this.#api.resolve(target);
    if (!isPathWithin(this.#canonicalRoot, resolved, this.config.platform)) {
      throw new TestBoundaryViolationError("path_escape");
    }
    const sentinel = this.#api.join(
      this.#canonicalRoot,
      TEST_SENTINEL_FILENAME,
    );
    if (
      samePath(resolved, sentinel, this.config.platform) ||
      (samePath(resolved, this.#canonicalRoot, this.config.platform) &&
        operation !== "read")
    ) {
      throw new TestBoundaryViolationError("path_escape");
    }
    if (
      operation === "temporary" &&
      !isPathWithin(this.config.temporaryDirectory, resolved, this.config.platform)
    ) {
      throw new TestBoundaryViolationError("path_escape");
    }

    const relative = this.#api.relative(this.#canonicalRoot, resolved);
    let current = this.#canonicalRoot;
    for (const component of relative === "" ? [] : relative.split(this.#api.sep)) {
      current = this.#api.join(current, component);
      let metadata: PathMetadata | null;
      try {
        metadata = await this.inspector.lstat(current);
      } catch {
        throw new TestBoundaryViolationError("path_escape");
      }
      if (metadata === null) {
        break;
      }
      if (metadata.kind === "symbolic-link") {
        throw new TestBoundaryViolationError("link_rejected");
      }
      if (metadata.uid !== this.config.expectedUid) {
        throw new TestBoundaryViolationError("path_escape");
      }
      if (metadata.kind === "file" && metadata.links !== 1) {
        throw new TestBoundaryViolationError("link_rejected");
      }
      let canonical: string;
      try {
        canonical = await this.inspector.realpath(current);
      } catch {
        throw new TestBoundaryViolationError("path_escape");
      }
      if (!isPathWithin(this.#canonicalRoot, canonical, this.config.platform)) {
        throw new TestBoundaryViolationError("path_escape");
      }
    }
    return resolved;
  }
}
