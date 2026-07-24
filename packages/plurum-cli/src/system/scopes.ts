import type {
  CredentialEnvironmentAdapter,
  CredentialEnvironmentSnapshot,
  DoctorCapabilities,
  PlanningCapabilities,
  ProcessAdapter,
  ProcessRequest,
  ReadOnlyFileSystemAdapter,
  ReadOnlyNetworkAdapter,
  ReadOnlyNetworkRequest,
  SetupCapabilities,
  SetupPreflightCapabilities,
  StatusCapabilities,
  SystemCapabilities,
} from "./contracts.js";
import type {
  HostAdapterMap,
  HostApplyRequest,
  HostInspectionAdapter,
  HostInspectionRequest,
  HostMutationAdapter,
  HostRollbackRequest,
} from "../hosts/contracts.js";
import { HOST_IDS } from "../hosts/contracts.js";
import { validateHostInspection } from "../hosts/inspection.js";
import {
  snapshotHostApplyRequest,
  snapshotHostMutationResult,
  snapshotHostRollbackRequest,
} from "./host-mutation-boundary.js";
import {
  copyCredentialEnvironmentSnapshot,
} from "./credential-environment.js";
import { CapabilityPolicyError } from "./errors.js";
import { snapshotPlatformAdapter } from "./platform-snapshot.js";

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

function scopedHostInspectionAdapter(
  adapter: HostInspectionAdapter,
  host: (typeof HOST_IDS)[number],
  platform: SystemCapabilities["platform"],
): HostInspectionAdapter {
  return Object.freeze({
    async inspect(request: HostInspectionRequest) {
      let copiedRequest: HostInspectionRequest;
      try {
        if (
          request.host !== host ||
          request.scope !== "user" ||
          request.excludedProjectDirectory !== platform.cwd ||
          Object.keys(request).length !== 3 ||
          Object.getOwnPropertySymbols(request).length !== 0
        ) {
          throw new CapabilityPolicyError("hosts", "inspectRequest");
        }
        copiedRequest = Object.freeze({
          host,
          scope: "user",
          excludedProjectDirectory: platform.cwd,
        });
      } catch (error) {
        if (error instanceof CapabilityPolicyError) {
          throw error;
        }
        throw new CapabilityPolicyError("hosts", "inspectRequest");
      }
      const result = await adapter.inspect(copiedRequest);
      return validateHostInspection(
        result,
        copiedRequest,
        platform.paths,
        platform.os,
      );
    },
  });
}

function scopedHostInspection(
  system: SystemCapabilities,
  platform: SystemCapabilities["platform"],
): HostAdapterMap<HostInspectionAdapter> {
  const entries = HOST_IDS.map((host) => {
    const scoped = scopedHostInspectionAdapter(
      system.hosts.inspection[host],
      host,
      platform,
    );
    return [host, scoped] as const;
  });
  return Object.freeze(Object.fromEntries(entries)) as HostAdapterMap<
    HostInspectionAdapter
  >;
}

function inspectionOnlyHostMap(
  adapters: HostAdapterMap<HostInspectionAdapter>,
): HostAdapterMap<HostInspectionAdapter> {
  const entries = HOST_IDS.map((host) => {
    const adapter = adapters[host];
    const scoped: HostInspectionAdapter = Object.freeze({
      inspect: adapter.inspect.bind(adapter),
    });
    return [host, scoped] as const;
  });
  return Object.freeze(Object.fromEntries(entries)) as HostAdapterMap<
    HostInspectionAdapter
  >;
}

function scopedHostMutation(
  system: SystemCapabilities,
  platform: SystemCapabilities["platform"],
): HostAdapterMap<HostMutationAdapter> {
  const entries = HOST_IDS.map((host) => {
    const adapter = system.hosts.mutation[host];
    const inspection = scopedHostInspectionAdapter(adapter, host, platform);
    const scoped: HostMutationAdapter = Object.freeze({
      inspect: inspection.inspect,
      async apply(request: HostApplyRequest) {
        /*
         * This policy snapshots portable semantic intent. The native adapter
         * remains responsible for final executable and filesystem
         * re-attestation immediately before mutation.
         */
        const copied = snapshotHostApplyRequest(request, host);
        let result;
        try {
          result = await adapter.apply(copied);
        } catch {
          throw new CapabilityPolicyError("hosts", "applyResult");
        }
        return snapshotHostMutationResult(result, "applyResult");
      },
      async rollback(request: HostRollbackRequest) {
        const copied = snapshotHostRollbackRequest(request, host);
        let result;
        try {
          result = await adapter.rollback(copied);
        } catch {
          throw new CapabilityPolicyError("hosts", "rollbackResult");
        }
        return snapshotHostMutationResult(result, "rollbackResult");
      },
    });
    return [host, scoped] as const;
  });
  return Object.freeze(Object.fromEntries(entries)) as HostAdapterMap<
    HostMutationAdapter
  >;
}

export function planningScope(system: SystemCapabilities): PlanningCapabilities {
  const platform = snapshotPlatformAdapter(system.platform);
  return Object.freeze({
    platform,
    hosts: Object.freeze({
      inspection: scopedHostInspection(system, platform),
    }),
  }) as PlanningCapabilities;
}

export function setupPreflightScope(
  system: SystemCapabilities,
): SetupPreflightCapabilities {
  /*
   * Apply preflight must observe through the exact authority that would later
   * mutate, while exposing only its inspect method. No adapter object carrying
   * apply/rollback crosses this scope.
   */
  const platform = snapshotPlatformAdapter(system.platform);
  const mutationAuthority = scopedHostMutation(system, platform);
  return Object.freeze({
    platform,
    hosts: Object.freeze({
      inspection: inspectionOnlyHostMap(mutationAuthority),
    }),
  }) as SetupPreflightCapabilities;
}

export function setupScope(system: SystemCapabilities): SetupCapabilities {
  /*
   * Setup planning and mutation must share one attestation authority. Reusing
   * the scoped mutation adapters for read-only setup inspection prevents a
   * separately composed inspection map from approving evidence that the
   * mutation side did not mint.
   */
  const platform = snapshotPlatformAdapter(system.platform);
  const mutation = scopedHostMutation(system, platform);
  return Object.freeze({
    ...system,
    platform,
    processes: setupProcesses(system.processes),
    credentialEnvironment: credentialEnvironment(
      system.credentialEnvironment,
    ),
    hosts: Object.freeze({
      inspection: mutation,
      mutation,
    }),
  });
}

export function statusScope(system: SystemCapabilities): StatusCapabilities {
  const platform = snapshotPlatformAdapter(system.platform);
  return Object.freeze({
    filesystem: readOnlyFileSystem(system.filesystem),
    network: readOnlyNetwork(system.network),
    credentialEnvironment: credentialEnvironment(
      system.credentialEnvironment,
    ),
    clock: system.clock,
    hash: system.hash,
    platform,
    hosts: Object.freeze({
      inspection: scopedHostInspection(system, platform),
    }),
  });
}

export function doctorScope(system: SystemCapabilities): DoctorCapabilities {
  const platform = snapshotPlatformAdapter(system.platform);
  return Object.freeze({
    filesystem: readOnlyFileSystem(system.filesystem),
    network: readOnlyNetwork(system.network),
    credentialEnvironment: credentialEnvironment(
      system.credentialEnvironment,
    ),
    clock: system.clock,
    hash: system.hash,
    platform,
    hosts: Object.freeze({
      inspection: scopedHostInspection(system, platform),
    }),
  });
}
