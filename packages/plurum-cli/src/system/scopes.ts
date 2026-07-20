import type {
  CredentialEnvironmentAdapter,
  CredentialEnvironmentSnapshot,
  DoctorCapabilities,
  MetadataFileSystemAdapter,
  PlanningCapabilities,
  ProcessAdapter,
  ProcessRequest,
  ReadOnlyFileSystemAdapter,
  ReadOnlyNetworkAdapter,
  ReadOnlyNetworkRequest,
  SetupCapabilities,
  StatusCapabilities,
  SystemCapabilities,
} from "./contracts.js";
import {
  copyCredentialEnvironmentSnapshot,
} from "./credential-environment.js";
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
      let copiedRequest: ReadOnlyNetworkRequest;
      try {
        const untrustedRequest = request as ReadOnlyNetworkRequest & {
          readonly body?: Uint8Array;
          readonly method: string;
        };
        const method = untrustedRequest.method;
        const hasBody = "body" in untrustedRequest;
        if (method !== "GET" || hasBody) {
          throw new CapabilityPolicyError("network", "readOnlyRequest");
        }
        const copiedHeaders: Record<string, string> = {};
        for (const [name, value] of Object.entries(
          untrustedRequest.headers,
        )) {
          if (typeof value !== "string") {
            throw new CapabilityPolicyError(
              "network",
              "readOnlyRequest",
            );
          }
          copiedHeaders[name] = value;
        }
        copiedRequest = Object.freeze({
          url: untrustedRequest.url,
          method: "GET",
          headers: Object.freeze(copiedHeaders),
          timeoutMs: untrustedRequest.timeoutMs,
          maxResponseBytes: untrustedRequest.maxResponseBytes,
          redirect: untrustedRequest.redirect,
        });
      } catch (error) {
        if (error instanceof CapabilityPolicyError) {
          throw error;
        }
        throw new CapabilityPolicyError("network", "requestSnapshot");
      }
      return network.request(copiedRequest);
    },
  });
}

function credentialEnvironment(
  adapter: CredentialEnvironmentAdapter,
): CredentialEnvironmentAdapter {
  return Object.freeze({
    read(): CredentialEnvironmentSnapshot {
      try {
        return copyCredentialEnvironmentSnapshot(adapter.read());
      } catch {
        throw new CapabilityPolicyError(
          "credential-environment",
          "readSnapshot",
        );
      }
    },
  });
}

function setupProcesses(processes: ProcessAdapter): ProcessAdapter {
  return Object.freeze({
    async run(request: ProcessRequest) {
      let copiedRequest: ProcessRequest;
      try {
        const copiedEnvironment: Record<string, string> = {};
        for (const [name, value] of Object.entries(request.env)) {
          if (
            name.toUpperCase() === "PLURUM_API_KEY" ||
            typeof value !== "string"
          ) {
            throw new CapabilityPolicyError(
              "processes",
              "credentialEnvironmentPropagation",
            );
          }
          copiedEnvironment[name] = value;
        }
        const stdin = request.stdin;
        copiedRequest = Object.freeze({
          executable: request.executable,
          args: Object.freeze([...request.args]),
          cwd: request.cwd,
          env: Object.freeze(copiedEnvironment),
          ...(stdin === undefined
            ? {}
            : { stdin: stdin.slice() }),
          timeoutMs: request.timeoutMs,
          maxOutputBytes: request.maxOutputBytes,
        });
      } catch (error) {
        if (error instanceof CapabilityPolicyError) {
          throw error;
        }
        throw new CapabilityPolicyError(
          "processes",
          "requestSnapshot",
        );
      }
      return processes.run(copiedRequest);
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
  return Object.freeze({
    ...system,
    processes: setupProcesses(system.processes),
    credentialEnvironment: credentialEnvironment(
      system.credentialEnvironment,
    ),
  });
}

export function statusScope(system: SystemCapabilities): StatusCapabilities {
  return Object.freeze({
    filesystem: readOnlyFileSystem(system.filesystem),
    network: readOnlyNetwork(system.network),
    credentialEnvironment: credentialEnvironment(
      system.credentialEnvironment,
    ),
    clock: system.clock,
    hash: system.hash,
    platform: system.platform,
  });
}

export function doctorScope(system: SystemCapabilities): DoctorCapabilities {
  return Object.freeze({
    filesystem: readOnlyFileSystem(system.filesystem),
    network: readOnlyNetwork(system.network),
    credentialEnvironment: credentialEnvironment(
      system.credentialEnvironment,
    ),
    clock: system.clock,
    hash: system.hash,
    platform: system.platform,
  });
}
