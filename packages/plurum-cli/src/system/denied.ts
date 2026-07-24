import type {
  ClockAdapter,
  CredentialEnvironmentAdapter,
  CredentialEnvironmentSnapshot,
  DirectoryHandleAdapter,
  FileSystemAdapter,
  HashAdapter,
  NetworkAdapter,
  NetworkResponse,
  PathMetadata,
  PlatformAdapter,
  ProcessAdapter,
  ProcessResult,
  RandomAdapter,
  ReadableFileHandleAdapter,
  SystemCapabilities,
  WritableFileHandleAdapter,
} from "./contracts.js";
import type {
  HostAdapterMap,
  HostInspectionAdapter,
  HostMutationAdapter,
} from "../hosts/contracts.js";
import { CapabilityUnavailableError, type CapabilityName } from "./errors.js";

function unavailable(capability: CapabilityName, operation: string): never {
  throw new CapabilityUnavailableError(capability, operation);
}

export const deniedFileSystem: FileSystemAdapter = Object.freeze<FileSystemAdapter>({
  async lstat(_path): Promise<PathMetadata | null> {
    return unavailable("filesystem", "lstat");
  },
  async realpath(_path): Promise<string> {
    return unavailable("filesystem", "realpath");
  },
  async readDirectory(_path): Promise<readonly string[]> {
    return unavailable("filesystem", "readDirectory");
  },
  async openReadOnly(_path): Promise<ReadableFileHandleAdapter> {
    return unavailable("filesystem", "openReadOnly");
  },
  async createDirectory(_path, _options): Promise<void> {
    return unavailable("filesystem", "createDirectory");
  },
  async open(_path, _options): Promise<WritableFileHandleAdapter> {
    return unavailable("filesystem", "open");
  },
  async rename(_source, _destination): Promise<void> {
    return unavailable("filesystem", "rename");
  },
  async unlink(_path): Promise<void> {
    return unavailable("filesystem", "unlink");
  },
  async openDirectory(_path): Promise<DirectoryHandleAdapter> {
    return unavailable("filesystem", "openDirectory");
  },
});

export const deniedProcesses: ProcessAdapter = Object.freeze<ProcessAdapter>({
  async run(_request): Promise<ProcessResult> {
    return unavailable("processes", "run");
  },
});

export const deniedNetwork: NetworkAdapter = Object.freeze<NetworkAdapter>({
  async request(_request): Promise<NetworkResponse> {
    return unavailable("network", "request");
  },
});

export const deniedCredentialEnvironment: CredentialEnvironmentAdapter =
  Object.freeze<CredentialEnvironmentAdapter>({
    read(): CredentialEnvironmentSnapshot {
      return unavailable("credential-environment", "read");
    },
  });

function deniedHostAdapter(): HostMutationAdapter {
  return Object.freeze({
    async inspect(): Promise<never> {
      return unavailable("hosts", "inspect");
    },
    async apply(): Promise<never> {
      return unavailable("hosts", "apply");
    },
    async rollback(): Promise<never> {
      return unavailable("hosts", "rollback");
    },
  });
}

const deniedClaudeHost = deniedHostAdapter();
const deniedCodexHost = deniedHostAdapter();

export const deniedHostInspection: HostAdapterMap<HostInspectionAdapter> =
  Object.freeze({
    "claude-code": deniedClaudeHost,
    codex: deniedCodexHost,
  });

export const deniedHostMutation: HostAdapterMap<HostMutationAdapter> =
  Object.freeze({
    "claude-code": deniedClaudeHost,
    codex: deniedCodexHost,
  });

export function createDenyByDefaultSystem(
  clock: ClockAdapter,
  random: RandomAdapter,
  hash: HashAdapter,
  platform: PlatformAdapter,
  credentialEnvironment: CredentialEnvironmentAdapter =
    deniedCredentialEnvironment,
): SystemCapabilities {
  return Object.freeze({
    filesystem: deniedFileSystem,
    processes: deniedProcesses,
    network: deniedNetwork,
    credentialEnvironment,
    clock,
    random,
    hash,
    platform,
    hosts: Object.freeze({
      inspection: deniedHostInspection,
      mutation: deniedHostMutation,
    }),
  });
}
