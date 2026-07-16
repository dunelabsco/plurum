import type { DiagnosticRuntime } from "./runtime.js";

export const COMMAND_JSON_SCHEMA_VERSION = 1 as const;

export type ReadOnlyCommand = "status" | "doctor";
export type CommandJsonErrorCode =
  | "command_unavailable"
  | "operational_failure"
  | "unsafe_execution_context";

export interface CommandJsonErrorEnvelope {
  readonly schema_version: typeof COMMAND_JSON_SCHEMA_VERSION;
  readonly ok: false;
  readonly command: ReadOnlyCommand;
  readonly error: {
    readonly code: CommandJsonErrorCode;
    readonly message: string;
  };
}

export function writeCommandJsonError(
  command: ReadOnlyCommand,
  code: CommandJsonErrorCode,
  message: string,
  runtime: DiagnosticRuntime,
): void {
  const envelope: CommandJsonErrorEnvelope = {
    schema_version: COMMAND_JSON_SCHEMA_VERSION,
    ok: false,
    command,
    error: { code, message },
  };
  runtime.stdout.write(`${JSON.stringify(envelope)}\n`);
}
