import type {
  DoctorCapabilities,
  MetadataFileSystemAdapter,
  PlanningCapabilities,
  ReadOnlyNetworkAdapter,
  ReadOnlyNetworkRequest,
  ReadOnlyFileSystemAdapter,
  SetupCapabilities,
  StatusCapabilities,
  SystemCapabilities,
} from "./contracts.js";
import { CapabilityPolicyError } from "./errors.js";

function metadataFileSystem(
  filesystem: SystemCapabilities["filesystem"],
): MetadataFileSystemAdapter {
  return Object.freeze({
    lstat: filesystem.lstat.bind(filesystem),
    realpath: filesystem.realpath.bind(filesystem),
    readDirectory: filesystem.readDirectory.bind(filesystem),
  });
}

function readOnlyFileSystem(
  filesystem: SystemCapabilities["filesystem"],
): ReadOnlyFileSystemAdapter {
  return Object.freeze({
    lstat: filesystem.lstat.bind(filesystem),
    realpath: filesystem.realpath.bind(filesystem),
    readDirectory: filesystem.readDirectory.bind(filesystem),
    openReadOnly: filesystem.openReadOnly.bind(filesystem),
  });
}

function readOnlyNetwork(
  network: SystemCapabilities["network"],
): ReadOnlyNetworkAdapter {
  return Object.freeze({
    async request(request: ReadOnlyNetworkRequest) {
      const untrustedRequest = request as ReadOnlyNetworkRequest & {
        readonly body?: Uint8Array;
        readonly method: string;
      };
      if (untrustedRequest.method !== "GET" || "body" in untrustedRequest) {
        throw new CapabilityPolicyError("network", "readOnlyRequest");
      }
      const copiedRequest: ReadOnlyNetworkRequest = Object.freeze({
        url: untrustedRequest.url,
        method: "GET",
        headers: Object.freeze({ ...untrustedRequest.headers }),
        timeoutMs: untrustedRequest.timeoutMs,
        maxResponseBytes: untrustedRequest.maxResponseBytes,
        redirect: untrustedRequest.redirect,
      });
      return network.request(copiedRequest);
    },
  });
}

export function planningScope(system: SystemCapabilities): PlanningCapabilities {
  return Object.freeze({
    filesystem: metadataFileSystem(system.filesystem),
    clock: system.clock,
    platform: system.platform,
  });
}

export function setupScope(system: SystemCapabilities): SetupCapabilities {
  return Object.freeze({ ...system });
}

export function statusScope(system: SystemCapabilities): StatusCapabilities {
  return Object.freeze({
    filesystem: readOnlyFileSystem(system.filesystem),
    network: readOnlyNetwork(system.network),
    clock: system.clock,
    hash: system.hash,
    platform: system.platform,
  });
}

export function doctorScope(system: SystemCapabilities): DoctorCapabilities {
  return Object.freeze({
    filesystem: readOnlyFileSystem(system.filesystem),
    network: readOnlyNetwork(system.network),
    clock: system.clock,
    hash: system.hash,
    platform: system.platform,
  });
}
