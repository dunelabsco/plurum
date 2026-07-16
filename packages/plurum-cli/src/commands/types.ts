import type { CliRuntime } from "../runtime.js";
import type { ExitCode } from "../exit-codes.js";

export const CLIENT_TARGETS = ["claude-code", "codex", "all"] as const;

export type ClientTarget = (typeof CLIENT_TARGETS)[number];

export interface SetupOptions {
  readonly client: ClientTarget;
  readonly apiKeyStdin: boolean;
  readonly dryRun: boolean;
}

export interface StatusOptions {
  readonly client: ClientTarget;
  readonly json: boolean;
}

export interface DoctorOptions {
  readonly client: ClientTarget;
  readonly json: boolean;
}

export type CommandResult = ExitCode | Promise<ExitCode>;

export interface CommandHandlers {
  setup(options: SetupOptions, runtime: CliRuntime): CommandResult;
  status(options: StatusOptions, runtime: CliRuntime): CommandResult;
  doctor(options: DoctorOptions, runtime: CliRuntime): CommandResult;
}
