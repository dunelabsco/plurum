export interface TextSink {
  write(text: string): void;
}

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
  "TMPDIR",
  "TEMP",
  "TMP",
] as const;

export type RuntimeEnvironmentKey = (typeof RUNTIME_ENVIRONMENT_KEYS)[number];
export type RuntimeEnvironment = Readonly<
  Partial<Record<RuntimeEnvironmentKey, string>>
>;

export interface CliRuntime {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: TextSink;
  readonly stderr: TextSink;
  readonly env: RuntimeEnvironment;
  readonly platform: NodeJS.Platform;
  readonly cwd: string;
}

export function selectRuntimeEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
): RuntimeEnvironment {
  const selected: Partial<Record<RuntimeEnvironmentKey, string>> = {};
  for (const key of RUNTIME_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) {
      selected[key] = value;
    }
  }
  return Object.freeze(selected);
}

export function createProcessRuntime(): CliRuntime {
  return {
    stdin: process.stdin,
    stdout: {
      write(text) {
        process.stdout.write(text);
      },
    },
    stderr: {
      write(text) {
        process.stderr.write(text);
      },
    },
    env: selectRuntimeEnvironment(process.env),
    platform: process.platform,
    cwd: process.cwd(),
  };
}
