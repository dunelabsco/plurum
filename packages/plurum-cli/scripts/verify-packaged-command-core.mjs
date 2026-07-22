import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { createServer, request as requestHttp } from "node:http";
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseAst } from "rolldown/parseAst";

const runtimeProcess = process;
const verifierPath = fileURLToPath(import.meta.url);
const scriptsDirectory = dirname(verifierPath);
const packageRoot = dirname(scriptsDirectory);
const loaderPath = join(
  scriptsDirectory,
  "verify-packaged-command-core-loader.mjs",
);
const WORKER_MODE = "PLURUM_PACKAGED_COMMAND_CORE_WORKER";
const ALLOWED_MODULES_ENV = "PLURUM_VERIFY_ALLOWED_MODULES";
const WORKER_SUCCESS = "packaged command core verified\n";
const INSTALLED_ENTRY_MODULES = Object.freeze([
  "cli.js",
  "commands/setup.js",
  "commands/status.js",
  "commands/doctor.js",
  "credentials/schema.js",
  "hosts/claude-code/configuration.js",
  "hosts/codex/configuration.js",
]);
const WORKER_STAGES = new Set([
  "audit-installed",
  "bootstrap",
  "complete",
  "create-credential",
  "import-installed",
  "lock-ambient",
  "prepare-fixtures",
  "run-commands",
  "start-loopback",
  "validate-options",
  "validate-root",
  "verify-snapshots",
]);
let workerStage = "bootstrap";
const API_ORIGIN = "https://api.plurum.ai";
const MCP_ENDPOINT = "https://mcp.plurum.ai/mcp";
const AGENT_ID = "00000000-0000-4000-8000-000000000411";
const AGENT_NAME = "Packaged CLI";
const USERNAME = "packaged-cli-test";
const TIMESTAMP = "2026-07-22T12:00:00.000Z";
const MAX_SNAPSHOT_ENTRIES = 20_000;
const MAX_SNAPSHOT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_INSTALLED_MODULE_BYTES = 512 * 1024;
const HOST_INTRINSICS = Object.freeze([
  Buffer,
  Buffer.prototype,
  URL,
  URL.prototype,
  URLSearchParams,
  URLSearchParams.prototype,
  TextEncoder,
  TextEncoder.prototype,
  TextDecoder,
  TextDecoder.prototype,
  AbortController,
  AbortController.prototype,
  AbortSignal,
  AbortSignal.prototype,
  DOMException,
  DOMException.prototype,
  Atomics,
]);

function deepFreeze(value, seen = new WeakSet()) {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isWithin(parent, candidate) {
  const difference = relative(parent, candidate);
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference) &&
      !difference.startsWith("/") &&
      !difference.startsWith("\\"))
  );
}

function assertPrivateRegularFile(path, label) {
  const metadata = lstatSync(path);
  assert.equal(metadata.isSymbolicLink(), false, `${label} must not be a symlink`);
  assert.equal(metadata.isFile(), true, `${label} must be a regular file`);
  assert.equal(metadata.nlink, 1, `${label} must have one link`);
  if (runtimeProcess.platform !== "win32") {
    assert.equal(
      metadata.uid,
      runtimeProcess.getuid?.(),
      `${label} must be user-owned`,
    );
    assert.equal(metadata.mode & 0o077, 0, `${label} must be user-only`);
  }
  return metadata;
}

function snapshotFile(path) {
  const metadata = assertPrivateRegularFile(path, "snapshot file");
  assert.ok(
    metadata.size <= MAX_SNAPSHOT_FILE_BYTES,
    "snapshot file exceeded its byte limit",
  );
  const bytes = readFileSync(path);
  return Object.freeze({
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode,
    links: metadata.nlink,
    size: metadata.size,
    uid: metadata.uid,
    modified: metadata.mtimeMs,
    changed: metadata.ctimeMs,
    digest: digest(bytes),
  });
}

export function snapshotProtectedTrees(roots) {
  try {
    const entries = [];
    let totalBytes = 0;
    for (const root of roots) {
      const canonicalRoot = realpathSync(root);
      assert.equal(canonicalRoot, resolve(root), "snapshot root must be canonical");
      const visit = (path, display) => {
        assert.ok(entries.length < MAX_SNAPSHOT_ENTRIES, "snapshot entry limit exceeded");
        const metadata = lstatSync(path);
        if (runtimeProcess.platform !== "win32") {
          assert.equal(
            metadata.uid,
            runtimeProcess.getuid?.(),
            "snapshot entry must be user-owned",
          );
        }
        const pathDigest = digest(Buffer.from(display, "utf8"));
        if (metadata.isSymbolicLink()) {
          const target = readlinkSync(path);
          const resolvedTarget = realpathSync(path);
          assert.equal(
            isWithin(canonicalRoot, resolvedTarget),
            true,
            "snapshot symlink must remain within its root",
          );
          entries.push(
            Object.freeze({
              pathDigest,
              kind: "symbolic-link",
              targetDigest: digest(Buffer.from(target, "utf8")),
              resolvedDigest: digest(Buffer.from(resolvedTarget, "utf8")),
              device: metadata.dev,
              inode: metadata.ino,
              mode: metadata.mode,
              links: metadata.nlink,
              uid: metadata.uid,
              modified: metadata.mtimeMs,
              changed: metadata.ctimeMs,
            }),
          );
          return;
        }
        if (metadata.isDirectory()) {
          entries.push(
            Object.freeze({
              pathDigest,
              kind: "directory",
              device: metadata.dev,
              inode: metadata.ino,
              mode: metadata.mode,
              links: metadata.nlink,
              uid: metadata.uid,
              modified: metadata.mtimeMs,
              changed: metadata.ctimeMs,
            }),
          );
          for (const name of readdirSync(path).sort()) {
            visit(join(path, name), `${display}/${name}`);
          }
          return;
        }
        assert.equal(metadata.isFile(), true, "snapshot entry must be a file or directory");
        assert.equal(metadata.nlink, 1, "snapshot file must have one link");
        assert.ok(
          metadata.size <= MAX_SNAPSHOT_FILE_BYTES,
          "snapshot file exceeded its byte limit",
        );
        totalBytes += metadata.size;
        assert.ok(totalBytes <= MAX_SNAPSHOT_TOTAL_BYTES, "snapshot byte limit exceeded");
        entries.push(
          Object.freeze({
            pathDigest,
            kind: "file",
            device: metadata.dev,
            inode: metadata.ino,
            mode: metadata.mode,
            links: metadata.nlink,
            uid: metadata.uid,
            size: metadata.size,
            modified: metadata.mtimeMs,
            changed: metadata.ctimeMs,
            digest: digest(readFileSync(path)),
          }),
        );
      };
      visit(canonicalRoot, `root-${entries.length}`);
    }
    return Object.freeze(entries);
  } catch {
    throw new Error("protected tree snapshot failed");
  }
}

function createPathAdapter(os) {
  const implementation = os === "win32" ? win32 : posix;
  return Object.freeze({
    separator: implementation.sep,
    isAbsolute: implementation.isAbsolute.bind(implementation),
    normalize: implementation.normalize.bind(implementation),
    join: implementation.join.bind(implementation),
    relative: implementation.relative.bind(implementation),
    root(path) {
      return implementation.parse(path).root;
    },
  });
}

function auditInstalledModuleGraph(installedPackage, entryModules) {
  const distRoot = realpathSync(join(installedPackage, "dist"));
  const pending = entryModules.map((entry) => resolve(distRoot, entry));
  const visited = new Set();
  const forbiddenGlobals = new Set([
    "Bun",
    "BroadcastChannel",
    "Deno",
    "EventSource",
    "Function",
    "Math",
    "Worker",
    "WebSocket",
    "WebTransport",
    "XMLHttpRequest",
    "console",
    "crypto",
    "eval",
    "fetch",
    "global",
    "globalThis",
    "navigator",
    "performance",
    "process",
    "queueMicrotask",
    "require",
    "setImmediate",
    "setInterval",
    "setTimeout",
    "AbortSignal",
  ]);

  const isNonComputedPropertyName = (parent, key) => {
    return (
      ((parent.type === "MemberExpression" ||
        parent.type === "OptionalMemberExpression") &&
        key === "property" &&
        parent.computed === false) ||
      ((parent.type === "Property" ||
        parent.type === "MethodDefinition" ||
        parent.type === "PropertyDefinition") &&
        key === "key" &&
        parent.computed === false)
    );
  };

  const isAllowedDateReference = (node, parent, key) =>
    (parent?.type === "NewExpression" &&
      key === "callee" &&
      parent.callee === node &&
      parent.arguments.length === 1) ||
    (parent?.type === "MemberExpression" &&
      key === "object" &&
      parent.object === node &&
      parent.computed === false &&
      parent.property?.type === "Identifier" &&
      parent.property.name === "parse");

  try {
    while (pending.length > 0) {
      const target = pending.pop();
      if (target === undefined || visited.has(target)) {
        continue;
      }
      assert.equal(isWithin(distRoot, target), true);
      assert.equal(target.endsWith(".js"), true);
      const metadata = lstatSync(target);
      assert.equal(metadata.isSymbolicLink(), false);
      assert.equal(metadata.isFile(), true);
      assert.equal(metadata.nlink, 1);
      assert.equal(realpathSync(target), target);
      assert.ok(metadata.size <= MAX_INSTALLED_MODULE_BYTES);
      const source = readFileSync(target, "utf8");
      const parsed = parseAst(source, { sourceType: "module" });
      const imports = [];
      const visit = (node, parent, key) => {
        if (typeof node !== "object" || node === null) {
          return;
        }
        if (
          node.type === "ImportDeclaration" ||
          ((node.type === "ExportNamedDeclaration" ||
            node.type === "ExportAllDeclaration") &&
            node.source !== null &&
            node.source !== undefined)
        ) {
          assert.equal(node.source?.type, "Literal");
          assert.equal(typeof node.source.value, "string");
          if (node.source.value === "node:util") {
            assert.equal(node.type, "ImportDeclaration");
            assert.equal(node.specifiers.length, 1);
            const [binding] = node.specifiers;
            assert.equal(binding?.type, "ImportSpecifier");
            assert.equal(binding.imported?.type, "Identifier");
            assert.equal(binding.imported.name, "parseArgs");
            assert.equal(binding.local?.type, "Identifier");
            assert.equal(binding.local.name, "parseArgs");
          }
          imports.push(node.source.value);
        }
        if (
          node.type === "ImportExpression" ||
          (node.type === "CallExpression" &&
            node.callee?.type === "Identifier" &&
            forbiddenGlobals.has(node.callee.name))
        ) {
          throw new Error("installed command graph contains dynamic authority");
        }
        if (
          node.type === "NewExpression" &&
          node.callee?.type === "Identifier" &&
          forbiddenGlobals.has(node.callee.name)
        ) {
          throw new Error("installed command graph contains dynamic authority");
        }
        if (
          node.type === "MetaProperty" ||
          (node.type === "Identifier" &&
            forbiddenGlobals.has(node.name) &&
            !isNonComputedPropertyName(parent, key)) ||
          ((parent?.type === "MemberExpression" ||
            parent?.type === "OptionalMemberExpression") &&
            key === "property" &&
            parent.computed === false &&
            node.type === "Identifier" &&
            node.name === "constructor")
        ) {
          throw new Error("installed command graph contains ambient authority");
        }
        if (
          node.type === "Identifier" &&
          node.name === "Date" &&
          !isNonComputedPropertyName(parent, key) &&
          !isAllowedDateReference(node, parent, key)
        ) {
          throw new Error("installed command graph contains ambient clock authority");
        }
        if (
          node.type === "MemberExpression" ||
          node.type === "OptionalMemberExpression"
        ) {
          const propertyName = node.computed
            ? node.property?.type === "Literal"
              ? node.property.value
              : undefined
            : node.property?.type === "Identifier"
              ? node.property.name
              : undefined;
          if (propertyName === "constructor" || propertyName === "__proto__") {
            throw new Error("installed command graph contains prototype recovery");
          }
        }
        if (node.type === "Property" && parent?.type === "ObjectPattern") {
          const propertyName =
            node.key?.type === "Identifier"
              ? node.key.name
              : node.key?.type === "Literal"
                ? node.key.value
                : undefined;
          if (propertyName === "constructor" || propertyName === "__proto__") {
            throw new Error("installed command graph contains prototype recovery");
          }
        }
        for (const [childKey, child] of Object.entries(node)) {
          if (childKey === "start" || childKey === "end" || childKey === "loc") {
            continue;
          }
          if (Array.isArray(child)) {
            for (const item of child) {
              visit(item, node, childKey);
            }
          } else {
            visit(child, node, childKey);
          }
        }
      };
      visit(parsed, undefined, undefined);

      for (const specifier of imports) {
        if (specifier === "node:util") {
          continue;
        }
        assert.equal(specifier.startsWith("."), true);
        assert.equal(specifier.includes("?"), false);
        assert.equal(specifier.includes("#"), false);
        const imported = resolve(dirname(target), specifier);
        assert.equal(isWithin(distRoot, imported), true);
        assert.equal(imported.endsWith(".js"), true);
        pending.push(imported);
      }
      visited.add(target);
      assert.ok(visited.size <= 256);
    }
    assert.ok(visited.size > 0);
    return Object.freeze([...visited].sort());
  } catch {
    throw new Error("installed command module graph failed its authority audit");
  }
}

function lockAmbientAuthority() {
  const ambient = globalThis;
  for (const intrinsic of HOST_INTRINSICS) {
    Object.freeze(intrinsic);
  }
  for (const name of [
    "BroadcastChannel",
    "Bun",
    "Deno",
    "EventSource",
    "WebSocket",
    "WebTransport",
    "Worker",
    "XMLHttpRequest",
    "console",
    "crypto",
    "fetch",
    "global",
    "globalThis",
    "localStorage",
    "module",
    "navigator",
    "process",
    "require",
    "sessionStorage",
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(ambient, name);
    if (descriptor === undefined) {
      continue;
    }
    if (name === "globalThis" && descriptor.configurable === false) {
      assert.equal(descriptor.enumerable, false);
      assert.equal(descriptor.writable, false);
      assert.equal(descriptor.value, ambient);
      continue;
    }
    assert.equal(
      descriptor.configurable,
      true,
      "worker ambient authority must be removable",
    );
    assert.equal(
      Reflect.deleteProperty(ambient, name),
      true,
      "worker ambient authority removal failed",
    );
  }
  Object.freeze(ambient);
  assert.equal(
    Object.isFrozen(ambient),
    true,
    "worker global object must be frozen",
  );
}

function assertIntrinsicLockdown() {
  for (const intrinsic of [
    Object,
    Object.prototype,
    Function,
    Function.prototype,
    Array,
    Array.prototype,
    JSON,
    Reflect,
    Map,
    Map.prototype,
    Set,
    Set.prototype,
    Promise,
    Promise.prototype,
    Uint8Array,
    Uint8Array.prototype,
    Date,
    Date.prototype,
    RegExp,
    RegExp.prototype,
    Error,
    Error.prototype,
    ...HOST_INTRINSICS,
  ]) {
    assert.equal(
      Object.isFrozen(intrinsic),
      true,
      "worker JavaScript intrinsics must be frozen",
    );
  }
}

function assertStringCodeGenerationDenied() {
  let denied = false;
  try {
    Function("return 1");
  } catch {
    denied = true;
  }
  assert.equal(
    denied,
    true,
    "worker string-based code generation must be disabled",
  );
}

function responseBody(value) {
  return Buffer.from(JSON.stringify(value), "utf8");
}

async function startLoopbackServer(apiKey) {
  const counters = {
    health: 0,
    agent: 0,
    mcp: 0,
    authenticatedAgent: 0,
  };
  const server = createServer((request, response) => {
    try {
      assert.equal(request.socket.remoteAddress, "127.0.0.1");
      assert.equal(request.method, "GET");
      const authorization = request.headers.authorization;
      if (request.url === "/health") {
        counters.health += 1;
        assert.equal(
          authorization === undefined,
          true,
          "health request must not carry authorization",
        );
        response.writeHead(200, { "content-type": "application/json" });
        response.end(responseBody({ status: "healthy", version: "0.2.0" }));
        return;
      }
      if (request.url === "/api/v1/agents/me") {
        counters.agent += 1;
        const matches = authorization === `Bearer ${apiKey}`;
        assert.equal(matches, true, "agent request must carry the exact canary");
        counters.authenticatedAgent += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          responseBody({
            id: AGENT_ID,
            name: AGENT_NAME,
            username: USERNAME,
            is_active: true,
          }),
        );
        return;
      }
      if (request.url === "/mcp") {
        counters.mcp += 1;
        assert.equal(
          authorization === undefined,
          true,
          "MCP challenge request must not carry authorization",
        );
        response.writeHead(401, {
          "content-type": "text/plain",
          "www-authenticate": 'Bearer realm="plurum"',
        });
        response.end("authentication required");
        return;
      }
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
    } catch {
      response.destroy();
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  assert.equal(address.address, "127.0.0.1");
  return Object.freeze({
    port: address.port,
    counters,
    async close() {
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error === undefined) {
            resolveClose();
          } else {
            rejectClose(error);
          }
        });
      });
    },
  });
}

function normalizeResponseHeaders(headers) {
  const normalized = Object.create(null);
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    normalized[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return Object.freeze(normalized);
}

function createLoopbackNetwork(port, apiKey) {
  const allowed = new Map([
    [`${API_ORIGIN}/health`, "/health"],
    [`${API_ORIGIN}/api/v1/agents/me`, "/api/v1/agents/me"],
    [MCP_ENDPOINT, "/mcp"],
  ]);
  const observations = [];
  return Object.freeze({
    observations,
    adapter: Object.freeze({
      async request(request) {
        const physicalPath = allowed.get(request.url);
        assert.ok(physicalPath !== undefined, "logical network request is not allowlisted");
        assert.equal(request.method, "GET");
        assert.equal(request.redirect, "error");
        assert.equal("body" in request, false);
        assert.ok(request.timeoutMs > 0 && request.timeoutMs <= 120_000);
        assert.ok(request.maxResponseBytes > 0 && request.maxResponseBytes <= 5 * 1024 * 1024);

        const headers = Object.create(null);
        let acceptCount = 0;
        let authorizationCount = 0;
        for (const [name, value] of Object.entries(request.headers)) {
          assert.equal(typeof value, "string");
          const normalizedName = name.toLowerCase();
          assert.ok(
            normalizedName === "accept" || normalizedName === "authorization",
            "logical request contains an unexpected header",
          );
          if (normalizedName === "accept") {
            acceptCount += 1;
            assert.equal(
              value,
              "application/json",
              "logical request must use the exact accepted media type",
            );
          }
          if (normalizedName === "authorization") {
            authorizationCount += 1;
            assert.equal(
              value === `Bearer ${apiKey}`,
              physicalPath === "/api/v1/agents/me",
              "authorization must be confined to agent validation",
            );
          }
          if (headers[normalizedName] !== undefined) {
            throw new Error("logical request contains a duplicate header");
          }
          headers[normalizedName] = value;
        }
        assert.equal(acceptCount, 1);
        assert.equal(
          authorizationCount,
          physicalPath === "/api/v1/agents/me" ? 1 : 0,
        );
        assert.equal(
          Object.keys(headers).length,
          physicalPath === "/api/v1/agents/me" ? 2 : 1,
        );
        observations.push(
          Object.freeze({
            logicalPath: physicalPath,
            authenticated: authorizationCount === 1,
          }),
        );

        return await new Promise((resolveRequest, rejectRequest) => {
          const outgoing = requestHttp(
            {
              hostname: "127.0.0.1",
              port,
              path: physicalPath,
              method: "GET",
              headers,
              timeout: request.timeoutMs,
              agent: false,
            },
            (incoming) => {
              const chunks = [];
              let length = 0;
              incoming.on("data", (chunk) => {
                length += chunk.length;
                if (length > request.maxResponseBytes) {
                  incoming.destroy(new Error("loopback response exceeded its bound"));
                  return;
                }
                chunks.push(chunk);
              });
              incoming.once("error", rejectRequest);
              incoming.once("end", () => {
                resolveRequest(
                  Object.freeze({
                    status: incoming.statusCode ?? 0,
                    headers: normalizeResponseHeaders(incoming.headers),
                    body: Uint8Array.from(Buffer.concat(chunks, length)),
                  }),
                );
              });
            },
          );
          outgoing.once("timeout", () => {
            outgoing.destroy(new Error("loopback request timed out"));
          });
          outgoing.once("error", rejectRequest);
          outgoing.end();
        });
      },
    }),
  });
}

function createCanonicalCredentialStore(bytes, expectedDirectory) {
  const directoryIdentity = Object.freeze({
    volume: "packaged-volume",
    object: "packaged-directory",
  });
  const fileIdentity = Object.freeze({
    volume: "packaged-volume",
    object: "packaged-credential",
  });
  const directoryAttestation = deepFreeze({
    kind: "directory",
    identity: directoryIdentity,
    revision: "packaged-directory-revision",
    binding: "canonical-current",
    owner: "current-user",
    access: "user-only",
    link: "direct",
  });
  const fileAttestation = deepFreeze({
    kind: "regular-file",
    identity: fileIdentity,
    parentIdentity: directoryIdentity,
    revision: "packaged-file-revision",
    binding: "canonical-current",
    owner: "current-user",
    access: "user-only",
    link: "direct",
    links: 1,
    size: bytes.byteLength,
  });
  return Object.freeze({
    async openPrivateDirectory(directory, options) {
      assert.equal(directory, expectedDirectory);
      assert.deepEqual(options, { noFollow: true });
      return Object.freeze({
        status: "opened",
        directory: Object.freeze({
          async attest() {
            return directoryAttestation;
          },
          async openCredentialReadOnly(options) {
            assert.deepEqual(options, {
              entry: "credentials.json",
              noFollow: true,
            });
            return Object.freeze({
              status: "opened",
              file: Object.freeze({
                async attest() {
                  return fileAttestation;
                },
                async readBounded(options) {
                  assert.ok(options.maxBytes >= bytes.byteLength);
                  return Object.freeze({
                    bytes: Uint8Array.from(bytes),
                    endOfFile: true,
                  });
                },
                async close() {},
              }),
            });
          },
          async close() {},
        }),
      });
    },
  });
}

function healthyConfiguration(host, desired) {
  return deepFreeze({
    marketplace: { status: "present", value: { ...desired.marketplace } },
    plugin: {
      status: "present",
      value: {
        name: "plurum",
        source: desired.plugin.source,
        version: desired.plugin.version,
        enabled: true,
      },
    },
    pluginMcp: { status: "present", value: { ...desired.mcp } },
    directMcp: { status: "absent" },
  });
}

function healthyInspection(host, desired, executable, mutationSupport) {
  return deepFreeze({
    host,
    status: "available",
    executable: {
      sourcePath: executable,
      resolvedPath: executable,
      revision: `${host}-executable-revision`,
      chain: [
        {
          path: executable,
          kind: "binary",
          owner: "current-user",
          access: "not-broadly-writable",
          binding: "canonical",
          link: "direct",
          revision: `${host}-chain-revision`,
        },
      ],
      launch: { executable, argumentPrefix: [], shell: false },
    },
    version: desired.minimumHostVersion,
    state: {
      revision: `${host}-state-revision`,
      configuration: healthyConfiguration(host, desired),
    },
    mutationSupport,
  });
}

function runtimeTarget() {
  assert.ok(runtimeProcess.arch === "arm64" || runtimeProcess.arch === "x64");
  if (runtimeProcess.platform === "darwin") {
    return `darwin-${runtimeProcess.arch}`;
  }
  if (runtimeProcess.platform === "linux") {
    // This is fixed semantic fixture evidence, not production libc detection.
    // The separate native CI matrix is the authority for released targets.
    return `linux-${runtimeProcess.arch}-gnu`;
  }
  if (runtimeProcess.platform === "win32") {
    return `win32-${runtimeProcess.arch}-msvc`;
  }
  throw new Error("packaged command-core verification requires a released platform");
}

function assertNoCanary(texts, apiKey) {
  const prefix = "plrm_live_";
  assert.equal(apiKey.startsWith(prefix), true);
  const material = apiKey.slice(prefix.length);
  assert.match(material, /^[A-Za-z0-9_-]{24,}$/u);
  let exposed = false;
  const windowLength = 8;
  for (let index = 0; index <= material.length - windowLength; index += 1) {
    const fragment = material.slice(index, index + windowLength);
    for (const text of texts) {
      if (text.includes(fragment)) {
        exposed = true;
      }
    }
  }
  assert.equal(exposed, false, "credential canary material appeared in command output");
}

function expectedCredentialFingerprint(apiKey) {
  const domain = Buffer.from(
    "plurum.ai/credential-key-fingerprint/sha256/v1",
    "utf8",
  );
  const origin = Buffer.from(API_ORIGIN, "utf8");
  const key = Buffer.from(apiKey, "utf8");
  const preimage = Buffer.alloc(
    domain.byteLength + 1 + 4 + origin.byteLength + 4 + key.byteLength,
  );
  let hash;
  try {
    let offset = 0;
    domain.copy(preimage, offset);
    offset += domain.byteLength;
    preimage[offset] = 0;
    offset += 1;
    preimage.writeUInt32BE(origin.byteLength, offset);
    offset += 4;
    origin.copy(preimage, offset);
    offset += origin.byteLength;
    preimage.writeUInt32BE(key.byteLength, offset);
    offset += 4;
    key.copy(preimage, offset);
    hash = createHash("sha256").update(preimage).digest();
    return `plurum-fp-v1:${hash.subarray(0, 6).toString("hex")}`;
  } finally {
    domain.fill(0);
    origin.fill(0);
    key.fill(0);
    preimage.fill(0);
    hash?.fill(0);
  }
}

function expectedStatusEnvelope(apiKey) {
  return {
    schema_version: 1,
    ok: true,
    command: "status",
    result: {
      overall: "healthy",
      requested_client: "all",
      selected_clients: ["claude-code", "codex"],
      cli: { version: "0.0.0-development" },
      api: {
        origin: API_ORIGIN,
        reachability: "reachable",
        health: "healthy",
      },
      credential: {
        state: "ready",
        sources: ["canonical"],
        permissions: "verified-user-only",
        fingerprint: expectedCredentialFingerprint(apiKey),
        candidate_count: 1,
      },
      agent: {
        verification: "verified",
        id: AGENT_ID,
        display_name: AGENT_NAME,
        username: USERNAME,
        active: true,
      },
      clients: [
        {
          client: "claude-code",
          status: "healthy",
          reason: "configuration-healthy",
          host_version: "2.1.212",
          plugin_version: "0.2.0",
          plugin_enabled: true,
          credential_projection: "not-applicable",
          mcp: { state: "plugin", endpoint: MCP_ENDPOINT },
        },
        {
          client: "codex",
          status: "healthy",
          reason: "configuration-healthy",
          host_version: "0.144.5",
          plugin_version: "0.1.0",
          plugin_enabled: true,
          credential_projection: "exact",
          mcp: { state: "plugin", endpoint: MCP_ENDPOINT },
        },
      ],
    },
  };
}

function expectedFinding(check, outcome, reason, client = null) {
  return { check, outcome, reason, client, guidance: [] };
}

function expectedDoctorEnvelope(apiKey) {
  const status = expectedStatusEnvelope(apiKey).result;
  return {
    schema_version: 1,
    ok: true,
    command: "doctor",
    result: {
      overall: "healthy",
      requested_client: "all",
      selected_clients: ["claude-code", "codex"],
      runtime_platform: {
        status: "supported",
        runtime: "node",
        version: runtimeProcess.versions.node,
        target: runtimeTarget(),
      },
      status,
      mcp: { reachability: "reachable", health: "healthy" },
      findings: [
        expectedFinding(
          "runtime-platform",
          "pass",
          "runtime-platform-supported",
        ),
        expectedFinding("status", "pass", "status-healthy"),
        expectedFinding("api", "pass", "api-healthy"),
        expectedFinding("credential", "pass", "credential-ready"),
        expectedFinding("host", "pass", "host-supported", "claude-code"),
        expectedFinding(
          "plugin-configuration",
          "pass",
          "plugin-configuration-healthy",
          "claude-code",
        ),
        expectedFinding(
          "local-registration",
          "pass",
          "local-plugin-registration-healthy",
          "claude-code",
        ),
        expectedFinding("host", "pass", "host-supported", "codex"),
        expectedFinding(
          "plugin-configuration",
          "pass",
          "plugin-configuration-healthy",
          "codex",
        ),
        expectedFinding(
          "local-registration",
          "pass",
          "local-plugin-registration-healthy",
          "codex",
        ),
        expectedFinding(
          "credential-projection",
          "pass",
          "credential-projection-exact",
          "codex",
        ),
        expectedFinding(
          "mcp-authentication-boundary",
          "pass",
          "mcp-authentication-boundary-healthy",
        ),
        expectedFinding(
          "mcp-protocol",
          "not-checked",
          "mcp-protocol-not-verified",
        ),
      ],
    },
  };
}

function expectedDryRunOutput(
  plurumDirectory,
  claudeExecutable,
  codexExecutable,
) {
  const quoted = (value) => JSON.stringify(value);
  const hostLines = (
    host,
    executable,
    hostVersion,
    marketplace,
    pluginVersion,
    compatibleMaximum,
  ) => [
    `  ${host}:`,
    "    status: healthy",
    `    detected version: ${quoted(hostVersion)}`,
    `    minimum version: ${quoted(hostVersion)}`,
    `    discovered path: ${quoted(executable)}`,
    `    resolved path: ${quoted(executable)}`,
    `    launch executable: ${quoted(executable)}`,
    "    launch argument prefix: []",
    "    shell: false",
    `    marketplace: ${quoted(marketplace)}`,
    '    plugin: "plurum@plurum"',
    `    plugin version: ${quoted(pluginVersion)}`,
    `    compatible plugin range: ${quoted(
      `${pluginVersion} <= version < ${compatibleMaximum}`,
    )}`,
    `    plugin MCP: ${quoted(MCP_ENDPOINT)}`,
    '    explanation: "The host already matches the desired Plurum configuration."',
    "    mutations: none",
  ];
  return [
    "Plurum setup preflight",
    "",
    "mode: dry-run",
    'requested client: "all"',
    'selected clients: ["claude-code","codex"]',
    `api origin: ${quoted(API_ORIGIN)}`,
    `mcp endpoint: ${quoted(MCP_ENDPOINT)}`,
    "credential: not inspected (dry-run)",
    "",
    "credential destinations for a future confirmed setup:",
    `  - credential-directory (may-create): ${quoted(plurumDirectory)}`,
    `  - canonical-credential (may-create-or-replace): ${quoted(
      join(plurumDirectory, "credentials.json"),
    )}`,
    `  - setup-lock (may-create): ${quoted(join(plurumDirectory, "setup.lock"))}`,
    `  - credential-transaction (may-create): ${quoted(
      join(plurumDirectory, "credentials-transaction.json"),
    )}`,
    "",
    "clients:",
    ...hostLines(
      "claude-code",
      claudeExecutable,
      "2.1.212",
      "dunelabsco/plurum",
      "0.2.0",
      "0.3.0",
    ),
    ...hostLines(
      "codex",
      codexExecutable,
      "0.144.5",
      "https://github.com/dunelabsco/plurum.git",
      "0.1.0",
      "0.2.0",
    ),
    "",
    "readiness: no-op",
    "confirmation: not requested for dry-run; apply requires confirmation",
    "No changes were made.",
    "",
  ].join("\n");
}

async function invoke(runCli, handlers, system, args) {
  let stdinReads = 0;
  const stdout = [];
  const stderr = [];
  const stdin = new Proxy(Object.create(null), {
    get() {
      stdinReads += 1;
      throw new Error("packaged diagnostic command attempted to read stdin");
    },
  });
  let exitCode;
  try {
    exitCode = await runCli(
      args,
      Object.freeze({
        stdin,
        stdout: Object.freeze({ write: (text) => stdout.push(text) }),
        stderr: Object.freeze({ write: (text) => stderr.push(text) }),
        system,
      }),
      handlers,
    );
  } catch {
    throw new Error("packaged command-core invocation failed");
  }
  return Object.freeze({
    exitCode,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    stdinReads,
  });
}

async function runPackagedCommandCoreWorker(options) {
  workerStage = "validate-root";
  const testRoot = realpathSync(options.testRoot);
  const installedPackage = realpathSync(options.installedPackage);
  const neutralDirectory = realpathSync(options.neutralDirectory);
  const homeDirectory = realpathSync(options.homeDirectory);
  const configDirectory = realpathSync(options.configDirectory);
  const sentinelPath = resolve(options.sentinelPath);
  assert.equal(testRoot, resolve(options.testRoot));
  assert.ok(isWithin(testRoot, installedPackage));
  assert.ok(isWithin(testRoot, neutralDirectory));
  assert.ok(isWithin(testRoot, homeDirectory));
  assert.ok(isWithin(testRoot, configDirectory));
  assert.ok(isWithin(testRoot, sentinelPath));
  assert.equal(
    isWithin(testRoot, realpathSync(dirname(options.outsideCanaryPath))),
    false,
    "outside canary must remain outside the package test root",
  );
  const sentinelBefore = snapshotFile(sentinelPath);
  const expectedSentinel = Buffer.from(options.runId, "utf8");
  assert.equal(
    sentinelBefore.size === expectedSentinel.byteLength &&
      sentinelBefore.digest === digest(expectedSentinel),
    true,
    "package test sentinel is invalid",
  );
  const outsideBefore = snapshotFile(options.outsideCanaryPath);

  workerStage = "prepare-fixtures";
  const fakeBin = join(testRoot, "fake-host-bin");
  assert.equal(realpathSync(fakeBin), fakeBin);
  const fakeBinMetadata = lstatSync(fakeBin);
  assert.equal(fakeBinMetadata.isDirectory(), true);
  assert.equal(fakeBinMetadata.isSymbolicLink(), false);
  const claudeExecutable = join(fakeBin, "claude");
  const codexExecutable = join(fakeBin, "codex");
  const expectedExecutable = Buffer.from(
    "inert packaged-command-core host\n",
    "utf8",
  );
  for (const executable of [claudeExecutable, codexExecutable]) {
    const snapshot = snapshotFile(executable);
    assert.equal(
      snapshot.size === expectedExecutable.byteLength &&
        snapshot.digest === digest(expectedExecutable),
      true,
      "fake host executable is invalid",
    );
  }

  const rootBefore = snapshotProtectedTrees([testRoot]);
  workerStage = "audit-installed";
  auditInstalledModuleGraph(installedPackage, INSTALLED_ENTRY_MODULES);
  assert.equal(runtimeProcess.env[WORKER_MODE], "1");
  workerStage = "lock-ambient";
  lockAmbientAuthority();
  assertIntrinsicLockdown();
  assertStringCodeGenerationDenied();

  const moduleUrl = (path) => {
    const target = resolve(installedPackage, "dist", path);
    assert.ok(isWithin(installedPackage, target));
    const metadata = lstatSync(target);
    assert.equal(metadata.isSymbolicLink(), false);
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.nlink, 1);
    assert.equal(realpathSync(target), target);
    return pathToFileURL(target).href;
  };
  workerStage = "import-installed";
  const [
    { runCli },
    { runSetup },
    { createStatusCommand },
    { createDoctorCommand },
    { serializeCredentialDocument, validateCredentialDocument },
    {
      CLAUDE_CODE_DESIRED_CONFIGURATION,
      CLAUDE_CODE_MUTATION_SUPPORT,
    },
    { CODEX_DESIRED_CONFIGURATION, CODEX_MUTATION_SUPPORT },
  ] = await Promise.all([
    import(moduleUrl("cli.js")),
    import(moduleUrl("commands/setup.js")),
    import(moduleUrl("commands/status.js")),
    import(moduleUrl("commands/doctor.js")),
    import(moduleUrl("credentials/schema.js")),
    import(moduleUrl("hosts/claude-code/configuration.js")),
    import(moduleUrl("hosts/codex/configuration.js")),
  ]);
  assertIntrinsicLockdown();
  assertStringCodeGenerationDenied();

  workerStage = "create-credential";
  const apiKey = `plrm_live_${randomBytes(24).toString("base64url")}`;
  const credential = validateCredentialDocument({
    schema_version: 1,
    state: "active",
    api_origin: API_ORIGIN,
    api_key: apiKey,
    agent_id: AGENT_ID,
    agent_name: AGENT_NAME,
    username: USERNAME,
    registration_request_id: null,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
    activated_at: TIMESTAMP,
  });
  const credentialBytes = Buffer.from(
    serializeCredentialDocument(credential),
    "utf8",
  );
  workerStage = "start-loopback";
  const loopback = await startLoopbackServer(apiKey);
  try {
    const network = createLoopbackNetwork(loopback.port, apiKey);
    const desired = Object.freeze({
      "claude-code": CLAUDE_CODE_DESIRED_CONFIGURATION,
      codex: CODEX_DESIRED_CONFIGURATION,
    });
    const inspections = deepFreeze({
      "claude-code": healthyInspection(
        "claude-code",
        desired["claude-code"],
        claudeExecutable,
        CLAUDE_CODE_MUTATION_SUPPORT,
      ),
      codex: healthyInspection(
        "codex",
        desired.codex,
        codexExecutable,
        CODEX_MUTATION_SUPPORT,
      ),
    });
    const inspection = Object.freeze({
      "claude-code": Object.freeze({
        async inspect() {
          return inspections["claude-code"];
        },
      }),
      codex: Object.freeze({
        async inspect() {
          return inspections.codex;
        },
      }),
    });
    const rejectMutation = async () => {
      throw new Error("packaged diagnostic core attempted a mutation");
    };
    const mutation = Object.freeze({
      "claude-code": Object.freeze({
        inspect: inspection["claude-code"].inspect,
        apply: rejectMutation,
        rollback: rejectMutation,
      }),
      codex: Object.freeze({
        inspect: inspection.codex.inspect,
        apply: rejectMutation,
        rollback: rejectMutation,
      }),
    });
    const rejectCapability = async () => {
      throw new Error("packaged diagnostic core used a forbidden capability");
    };
    const os = runtimeProcess.platform;
    assert.ok(os === "darwin" || os === "linux" || os === "win32");
    const platformPaths = createPathAdapter(os);
    const system = deepFreeze({
      filesystem: {
        lstat: rejectCapability,
        realpath: rejectCapability,
        readDirectory: rejectCapability,
        openReadOnly: rejectCapability,
        createDirectory: rejectCapability,
        open: rejectCapability,
        rename: rejectCapability,
        unlink: rejectCapability,
        openDirectory: rejectCapability,
      },
      processes: { run: rejectCapability },
      network: network.adapter,
      credentialEnvironment: { read: () => Object.freeze({}) },
      clock: { now: () => Date.parse(TIMESTAMP) },
      random: {
        bytes: () => {
          throw new Error("packaged diagnostic core used randomness");
        },
        uuid: () => {
          throw new Error("packaged diagnostic core used randomness");
        },
      },
      hash: {
        sha256(data) {
          return Uint8Array.from(createHash("sha256").update(data).digest());
        },
      },
      platform: {
        os,
        arch: runtimeProcess.arch,
        cwd: neutralDirectory,
        environment: {
          HOME: homeDirectory,
          XDG_CONFIG_HOME: configDirectory,
          XDG_STATE_HOME: configDirectory,
          APPDATA: configDirectory,
          LOCALAPPDATA: configDirectory,
          USERPROFILE: homeDirectory,
          CODEX_HOME: join(configDirectory, "codex"),
          CLAUDE_CONFIG_DIR: join(configDirectory, "claude"),
          PLURUM_HOME: join(configDirectory, "plurum"),
          PLURUM_TEST_ROOT: testRoot,
          PLURUM_TEST_RUN_ID: options.runId,
          TMPDIR: testRoot,
          TEMP: testRoot,
          TMP: testRoot,
          PATH: fakeBin,
        },
        elevation: "standard",
        paths: platformPaths,
      },
      hosts: { inspection, mutation },
    });
    const sharedDependencies = Object.freeze({
      canonicalStore: createCanonicalCredentialStore(
        credentialBytes,
        join(configDirectory, "plurum"),
      ),
      legacyStore: Object.freeze({
        async read() {
          return Object.freeze({ status: "missing" });
        },
      }),
      codexProjection: Object.freeze({
        async observe() {
          return Object.freeze({ status: "exact" });
        },
      }),
    });
    const handlers = Object.freeze({
      setup: runSetup,
      status: createStatusCommand(sharedDependencies),
      doctor: createDoctorCommand(
        Object.freeze({
          ...sharedDependencies,
          runtimeSupport: Object.freeze({
            async observe() {
              return Object.freeze({
                status: "available",
                runtime: "node",
                version: runtimeProcess.versions.node,
                target: runtimeTarget(),
              });
            },
          }),
        }),
      ),
    });
    const invokeProtected = async (args) => {
      const result = await invoke(runCli, handlers, system, args);
      assert.deepEqual(
        snapshotProtectedTrees([testRoot]),
        rootBefore,
        "packaged command changed the protected test root",
      );
      return result;
    };

    workerStage = "run-commands";
    const dryRunOne = await invokeProtected(["setup", "--dry-run"]);
    const dryRunTwo = await invokeProtected(["setup", "--dry-run"]);
    const statusOne = await invokeProtected(["status", "--json"]);
    const statusTwo = await invokeProtected(["status", "--json"]);
    const doctorOne = await invokeProtected(["doctor", "--json"]);
    const doctorTwo = await invokeProtected(["doctor", "--json"]);
    const unavailableApply = await invokeProtected(["setup", "--yes"]);
    const unavailableStdinApply = await invokeProtected([
      "setup",
      "--api-key-stdin",
      "--yes",
    ]);

    const results = [
      dryRunOne,
      dryRunTwo,
      statusOne,
      statusTwo,
      doctorOne,
      doctorTwo,
      unavailableApply,
      unavailableStdinApply,
    ];
    assertNoCanary(results.flatMap(({ stdout, stderr }) => [stdout, stderr]), apiKey);
    assert.deepEqual(dryRunTwo, dryRunOne);
    assert.deepEqual(statusTwo, statusOne);
    assert.deepEqual(doctorTwo, doctorOne);
    assert.equal(dryRunOne.exitCode, 0);
    assert.equal(dryRunOne.stdinReads, 0);
    assert.equal(dryRunOne.stderr, "");
    assert.equal(
      dryRunOne.stdout,
      expectedDryRunOutput(
        join(configDirectory, "plurum"),
        claudeExecutable,
        codexExecutable,
      ),
    );
    assert.equal(statusOne.exitCode, 0);
    assert.equal(statusOne.stdinReads, 0);
    assert.equal(statusOne.stderr, "");
    assert.equal(
      statusOne.stdout,
      `${JSON.stringify(expectedStatusEnvelope(apiKey))}\n`,
    );
    assert.equal(doctorOne.exitCode, 0);
    assert.equal(doctorOne.stdinReads, 0);
    assert.equal(doctorOne.stderr, "");
    assert.equal(
      doctorOne.stdout,
      `${JSON.stringify(expectedDoctorEnvelope(apiKey))}\n`,
    );
    assert.equal(unavailableApply.exitCode, 3);
    assert.equal(unavailableApply.stdinReads, 0);
    assert.equal(unavailableApply.stdout, "");
    assert.equal(
      unavailableApply.stderr,
      "plurum setup: This command is not available in the private development build.\n",
    );
    assert.equal(unavailableStdinApply.exitCode, 3);
    assert.equal(unavailableStdinApply.stdinReads, 0);
    assert.equal(unavailableStdinApply.stdout, "");
    assert.equal(unavailableStdinApply.stderr, unavailableApply.stderr);
    workerStage = "verify-snapshots";
    assert.deepEqual(snapshotProtectedTrees([testRoot]), rootBefore);

    const logicalCounts = Object.fromEntries(
      ["/health", "/api/v1/agents/me", "/mcp"].map((path) => [
        path,
        network.observations.filter(({ logicalPath }) => logicalPath === path).length,
      ]),
    );
    assert.deepEqual(logicalCounts, {
      "/health": 4,
      "/api/v1/agents/me": 4,
      "/mcp": 2,
    });
    assert.equal(
      network.observations.filter(({ authenticated }) => authenticated).length,
      4,
    );
    assert.deepEqual(loopback.counters, {
      health: 4,
      agent: 4,
      mcp: 2,
      authenticatedAgent: 4,
    });
  } finally {
    credentialBytes.fill(0);
    await loopback.close();
  }

  assert.deepEqual(snapshotFile(sentinelPath), sentinelBefore);
  assert.deepEqual(snapshotFile(options.outsideCanaryPath), outsideBefore);
  workerStage = "complete";
}

function exactWorkerOptions(options) {
  assert.equal(typeof options.runId, "string");
  assert.match(
    options.runId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  return Object.freeze({
    testRoot: realpathSync(options.testRoot),
    installedPackage: realpathSync(options.installedPackage),
    neutralDirectory: realpathSync(options.neutralDirectory),
    homeDirectory: realpathSync(options.homeDirectory),
    configDirectory: realpathSync(options.configDirectory),
    sentinelPath: realpathSync(options.sentinelPath),
    runId: options.runId,
    outsideCanaryPath: realpathSync(options.outsideCanaryPath),
  });
}

function encodeAllowedModules(installedPackage, auditedModules) {
  const modules = auditedModules.map((modulePath) => {
    const moduleRelativePath = relative(installedPackage, modulePath)
      .split(sep)
      .join("/");
    assert.match(moduleRelativePath, /^dist\/[a-z0-9][a-z0-9./-]*\.js$/u);
    return moduleRelativePath;
  });
  assert.deepEqual([...modules].sort(), modules);
  assert.equal(new Set(modules).size, modules.length);
  assert.ok(modules.length > 0 && modules.length <= 256);
  const encoded = Buffer.from(JSON.stringify(modules), "utf8").toString(
    "base64url",
  );
  assert.ok(encoded.length > 0 && encoded.length <= 32 * 1024);
  return encoded;
}

function sanitizedWorkerEnvironment(options, allowedModules) {
  const environment = {
    PATH: dirname(runtimeProcess.execPath),
    HOME: options.homeDirectory,
    USERPROFILE: options.homeDirectory,
    XDG_CONFIG_HOME: options.configDirectory,
    XDG_STATE_HOME: options.configDirectory,
    APPDATA: options.configDirectory,
    LOCALAPPDATA: options.configDirectory,
    CODEX_HOME: join(options.configDirectory, "codex"),
    CLAUDE_CONFIG_DIR: join(options.configDirectory, "claude"),
    PLURUM_HOME: join(options.configDirectory, "plurum"),
    PLURUM_TEST_ROOT: options.testRoot,
    PLURUM_TEST_RUN_ID: options.runId,
    PLURUM_VERIFY_INSTALLED_ROOT: options.installedPackage,
    [ALLOWED_MODULES_ENV]: allowedModules,
    [WORKER_MODE]: "1",
    TMPDIR: options.testRoot,
    TEMP: options.testRoot,
    TMP: options.testRoot,
    CI: "true",
    NO_COLOR: "1",
    NODE_NO_WARNINGS: "1",
  };
  for (const name of ["ComSpec", "PATHEXT", "SystemRoot", "WINDIR"]) {
    const value = runtimeProcess.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return Object.freeze(environment);
}

function permissionModelFlag() {
  const flags = runtimeProcess.allowedNodeEnvironmentFlags;
  if (flags.has("--permission")) {
    return "--permission";
  }
  if (flags.has("--experimental-permission")) {
    return "--experimental-permission";
  }
  throw new Error("runtime does not expose a supported permission model flag");
}

export async function verifyPackagedCommandCore(options) {
  const workerOptions = exactWorkerOptions(options);
  const auditedModules = auditInstalledModuleGraph(
    workerOptions.installedPackage,
    INSTALLED_ENTRY_MODULES,
  );
  const allowedModules = encodeAllowedModules(
    workerOptions.installedPackage,
    auditedModules,
  );
  const payload = Buffer.from(JSON.stringify(workerOptions), "utf8").toString(
    "base64url",
  );
  assert.ok(payload.length > 0 && payload.length <= 16 * 1024);
  const outsideRoot = dirname(workerOptions.outsideCanaryPath);
  const loaderUrl = pathToFileURL(loaderPath);
  assert.equal(loaderUrl.protocol, "file:");
  assert.equal(fileURLToPath(loaderUrl), loaderPath);
  const result = spawnSync(
    runtimeProcess.execPath,
    [
      "--frozen-intrinsics",
      "--disallow-code-generation-from-strings",
      permissionModelFlag(),
      "--allow-addons",
      "--allow-worker",
      `--allow-fs-read=${scriptsDirectory}`,
      `--allow-fs-read=${join(packageRoot, "package.json")}`,
      `--allow-fs-read=${join(packageRoot, "node_modules")}`,
      `--allow-fs-read=${workerOptions.testRoot}`,
      `--allow-fs-read=${outsideRoot}`,
      `--allow-fs-write=${workerOptions.testRoot}`,
      "--experimental-loader",
      loaderUrl.href,
      verifierPath,
      payload,
    ],
    {
      cwd: workerOptions.neutralDirectory,
      env: sanitizedWorkerEnvironment(workerOptions, allowedModules),
      encoding: "utf8",
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      shell: false,
      timeout: 120_000,
    },
  );
  if (result.error !== undefined) {
    throw new Error("packaged command-core worker did not start");
  }
  if (result.signal !== null) {
    throw new Error("packaged command-core worker was interrupted");
  }
  if (result.status !== 0) {
    const match =
      /^packaged command core worker failed at ([a-z-]+)\n$/u.exec(
        result.stderr,
      );
    const stage = match?.[1];
    if (stage === undefined || !WORKER_STAGES.has(stage)) {
      throw new Error(
        "packaged command-core worker failed before reporting a safe stage",
      );
    }
    throw new Error(`packaged command-core worker failed at ${stage}`);
  }
  assert.equal(
    result.stdout === WORKER_SUCCESS && result.stderr === "",
    true,
    "packaged command-core worker emitted unexpected output",
  );
}

if (runtimeProcess.env[WORKER_MODE] === "1") {
  try {
    workerStage = "validate-options";
    assert.equal(runtimeProcess.argv.length, 3);
    const payload = runtimeProcess.argv[2];
    assert.ok(payload !== undefined && payload.length <= 16 * 1024);
    const decoded = Buffer.from(payload, "base64url");
    assert.ok(decoded.byteLength > 0 && decoded.byteLength <= 16 * 1024);
    const options = JSON.parse(decoded.toString("utf8"));
    await runPackagedCommandCoreWorker(exactWorkerOptions(options));
    runtimeProcess.stdout.write(WORKER_SUCCESS);
  } catch {
    runtimeProcess.stderr.write(
      `packaged command core worker failed at ${workerStage}\n`,
    );
    runtimeProcess.exitCode = 1;
  }
}
