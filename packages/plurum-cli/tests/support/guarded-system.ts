import type {
  FileSystemAdapter,
  HashAdapter,
  NetworkAdapter,
  NetworkRequest,
  ProcessAdapter,
  ProcessRequest,
  SystemCapabilities,
} from "../../src/system/contracts.js";
import type { TestAccessBoundary } from "./test-boundary.js";

function copyNetworkRequest(request: NetworkRequest): NetworkRequest {
  return Object.freeze({
    url: request.url,
    method: request.method,
    headers: Object.freeze({ ...request.headers }),
    ...(request.body === undefined ? {} : { body: request.body.slice() }),
    timeoutMs: request.timeoutMs,
    maxResponseBytes: request.maxResponseBytes,
    redirect: request.redirect,
  });
}

function copyProcessRequest(request: ProcessRequest): ProcessRequest {
  return Object.freeze({
    executable: request.executable,
    args: Object.freeze([...request.args]),
    cwd: request.cwd,
    env: Object.freeze({ ...request.env }),
    ...(request.stdin === undefined ? {} : { stdin: request.stdin.slice() }),
    timeoutMs: request.timeoutMs,
    maxOutputBytes: request.maxOutputBytes,
  });
}

function guardFileSystem(
  boundary: TestAccessBoundary,
  delegate: FileSystemAdapter,
): FileSystemAdapter {
  return Object.freeze<FileSystemAdapter>({
    async lstat(target) {
      return delegate.lstat(await boundary.assertPath(target, "read"));
    },
    async realpath(target) {
      return delegate.realpath(await boundary.assertPath(target, "read"));
    },
    async readDirectory(target) {
      return delegate.readDirectory(await boundary.assertPath(target, "read"));
    },
    async openReadOnly(target) {
      return delegate.openReadOnly(await boundary.assertPath(target, "read"));
    },
    async createDirectory(target, options) {
      const copiedOptions = Object.freeze({ ...options });
      return delegate.createDirectory(
        await boundary.assertPath(target, "write"),
        copiedOptions,
      );
    },
    async open(target, options) {
      const copiedOptions = Object.freeze({ ...options });
      return delegate.open(
        await boundary.assertPath(target, "write"),
        copiedOptions,
      );
    },
    async rename(source, destination) {
      const [resolvedSource, resolvedDestination] = await boundary.assertRename(
        source,
        destination,
      );
      return delegate.rename(resolvedSource, resolvedDestination);
    },
    async unlink(target) {
      return delegate.unlink(await boundary.assertPath(target, "delete"));
    },
    async openDirectory(target) {
      return delegate.openDirectory(await boundary.assertPath(target, "write"));
    },
  });
}

function guardNetwork(
  boundary: TestAccessBoundary,
  delegate: NetworkAdapter,
): NetworkAdapter {
  return Object.freeze<NetworkAdapter>({
    async request(request) {
      const copiedRequest = copyNetworkRequest(request);
      await boundary.assertNetwork(copiedRequest);
      return delegate.request(copiedRequest);
    },
  });
}

function guardProcesses(
  boundary: TestAccessBoundary,
  delegate: ProcessAdapter,
): ProcessAdapter {
  return Object.freeze<ProcessAdapter>({
    async run(request) {
      const copiedRequest = copyProcessRequest(request);
      await boundary.assertProcess(copiedRequest);
      return delegate.run(copiedRequest);
    },
  });
}

function guardHash(delegate: HashAdapter): HashAdapter {
  return Object.freeze<HashAdapter>({
    sha256(data): Uint8Array {
      const copiedInput = Uint8Array.prototype.slice.call(data) as Uint8Array;
      try {
        const output = delegate.sha256(copiedInput);
        return Uint8Array.prototype.slice.call(output) as Uint8Array;
      } finally {
        copiedInput.fill(0);
      }
    },
  });
}

export function createGuardedFakeSystem(
  boundary: TestAccessBoundary,
  delegate: SystemCapabilities,
): SystemCapabilities {
  return Object.freeze({
    filesystem: guardFileSystem(boundary, delegate.filesystem),
    network: guardNetwork(boundary, delegate.network),
    processes: guardProcesses(boundary, delegate.processes),
    clock: delegate.clock,
    random: delegate.random,
    hash: guardHash(delegate.hash),
    platform: delegate.platform,
  });
}
