export const RUNTIME_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "PLURUM_HOME",
  "PLURUM_TEST_ROOT",
  "PLURUM_TEST_RUN_ID",
  "TMPDIR",
  "TEMP",
  "TMP",
] as const;

export type RuntimeEnvironmentKey = (typeof RUNTIME_ENVIRONMENT_KEYS)[number];
export type RuntimeEnvironment = Readonly<
  Partial<Record<RuntimeEnvironmentKey, string>>
>;

export interface CredentialEnvironmentSnapshot {
  readonly PLURUM_API_KEY?: string;
  readonly PLURUM_API_URL?: string;
  readonly HERMES_HOME?: string;
  readonly OPENCLAW_HOME?: string;
}

export interface CredentialEnvironmentAdapter {
  read(): CredentialEnvironmentSnapshot;
}

export type SupportedOs = "darwin" | "linux" | "win32" | "unsupported";
export type ElevationState = "standard" | "elevated" | "unknown";
export type PathKind = "file" | "directory" | "symbolic-link" | "other";

export interface PathMetadata {
  readonly kind: PathKind;
  readonly mode: number;
  readonly size: number;
  readonly links: number;
  readonly device?: number;
  readonly inode?: number;
  readonly uid?: number;
  readonly gid?: number;
}

export interface ReadableFileHandleAdapter {
  stat(): Promise<PathMetadata>;
  read(maxBytes: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface WritableFileHandleAdapter extends ReadableFileHandleAdapter {
  writeAll(data: Uint8Array): Promise<void>;
  setMode(mode: number): Promise<void>;
  sync(): Promise<void>;
}

export interface DirectoryHandleAdapter {
  sync(): Promise<void>;
  close(): Promise<void>;
}

export type SecureOpenOptions =
  | {
      readonly access: "read-write";
      readonly create: "never";
      readonly noFollow: true;
    }
  | {
      readonly access: "write" | "read-write";
      readonly create: "exclusive";
      readonly mode: number;
      readonly noFollow: true;
    };

export interface ReadOnlyFileSystemAdapter {
  lstat(path: string): Promise<PathMetadata | null>;
  realpath(path: string): Promise<string>;
  readDirectory(path: string): Promise<readonly string[]>;
  openReadOnly(path: string): Promise<ReadableFileHandleAdapter>;
}

export type MetadataFileSystemAdapter = Pick<
  ReadOnlyFileSystemAdapter,
  "lstat" | "realpath" | "readDirectory"
>;

export interface FileSystemAdapter extends ReadOnlyFileSystemAdapter {
  createDirectory(
    path: string,
    options: { readonly mode: number; readonly exclusive: boolean },
  ): Promise<void>;
  open(path: string, options: SecureOpenOptions): Promise<WritableFileHandleAdapter>;
  rename(source: string, destination: string): Promise<void>;
  unlink(path: string): Promise<void>;
  openDirectory(path: string): Promise<DirectoryHandleAdapter>;
}

export interface ProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: Uint8Array;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export interface ProcessAdapter {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

export interface NetworkRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly redirect: "error";
}

export interface NetworkResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface NetworkAdapter {
  request(request: NetworkRequest): Promise<NetworkResponse>;
}

export type ReadOnlyNetworkRequest = Omit<
  NetworkRequest,
  "method" | "body"
> & {
  readonly method: "GET";
};

export interface ReadOnlyNetworkAdapter {
  request(request: ReadOnlyNetworkRequest): Promise<NetworkResponse>;
}

export interface ClockAdapter {
  now(): number;
}

export interface RandomAdapter {
  bytes(length: number): Uint8Array;
  uuid(): string;
}

export interface HashAdapter {
  sha256(data: Uint8Array): Uint8Array;
}

export interface PlatformPathAdapter {
  readonly separator: "/" | "\\";
  isAbsolute(path: string): boolean;
  normalize(path: string): string;
  join(...parts: readonly string[]): string;
  relative(from: string, to: string): string;
  root(path: string): string;
}

export interface PlatformAdapter {
  readonly os: SupportedOs;
  readonly arch: string;
  readonly cwd: string;
  readonly environment: RuntimeEnvironment;
  readonly elevation: ElevationState;
  readonly paths: PlatformPathAdapter;
}

export interface SystemCapabilities {
  readonly filesystem: FileSystemAdapter;
  readonly processes: ProcessAdapter;
  readonly network: NetworkAdapter;
  readonly credentialEnvironment: CredentialEnvironmentAdapter;
  readonly clock: ClockAdapter;
  readonly random: RandomAdapter;
  readonly hash: HashAdapter;
  readonly platform: PlatformAdapter;
}

export interface PlanningCapabilities {
  readonly filesystem: MetadataFileSystemAdapter;
  readonly clock: ClockAdapter;
  readonly platform: PlatformAdapter;
}

export interface SetupCapabilities extends SystemCapabilities {}

export interface StatusCapabilities {
  readonly filesystem: ReadOnlyFileSystemAdapter;
  readonly network: ReadOnlyNetworkAdapter;
  readonly credentialEnvironment: CredentialEnvironmentAdapter;
  readonly clock: ClockAdapter;
  readonly hash: HashAdapter;
  readonly platform: PlatformAdapter;
}

export interface DoctorCapabilities extends StatusCapabilities {}
