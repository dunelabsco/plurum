import type { CommandRuntime } from "../runtime.js";
import type { ExitCode } from "../exit-codes.js";
import type {
  DoctorCapabilities,
  PlanningCapabilities,
  SetupPreflightCapabilities,
  StatusCapabilities,
} from "../system/contracts.js";

export const CLIENT_TARGETS = ["claude-code", "codex", "all"] as const;

export type ClientTarget = (typeof CLIENT_TARGETS)[number];

interface SetupBaseOptions {
  readonly client: ClientTarget;
}

export interface SetupDryRunOptions extends SetupBaseOptions {
  readonly apiKeyStdin: false;
  readonly dryRun: true;
  readonly yes: false;
}

export type SetupApplyOptions =
  | (SetupBaseOptions &
      Readonly<{
        readonly apiKeyStdin: false;
        readonly dryRun: false;
        readonly yes: boolean;
      }>)
  | (SetupBaseOptions &
      Readonly<{
        readonly apiKeyStdin: true;
        readonly dryRun: false;
        readonly yes: true;
      }>);

export type SetupOptions = SetupDryRunOptions | SetupApplyOptions;

export interface StatusOptions {
  readonly client: ClientTarget;
  readonly json: boolean;
}

export interface DoctorOptions {
  readonly client: ClientTarget;
  readonly json: boolean;
}

export type CommandResult = ExitCode | Promise<ExitCode>;

export type SetupInvocation =
  | {
      readonly options: SetupDryRunOptions;
      readonly runtime: CommandRuntime<PlanningCapabilities>;
    }
  | {
      readonly options: SetupApplyOptions;
      readonly runtime: CommandRuntime<SetupPreflightCapabilities>;
    };

export interface StatusInvocation {
  readonly options: StatusOptions;
  readonly runtime: CommandRuntime<StatusCapabilities>;
}

export interface DoctorInvocation {
  readonly options: DoctorOptions;
  readonly runtime: CommandRuntime<DoctorCapabilities>;
}

export interface CommandHandlers {
  setup(invocation: SetupInvocation): CommandResult;
  status(invocation: StatusInvocation): CommandResult;
  doctor(invocation: DoctorInvocation): CommandResult;
}
