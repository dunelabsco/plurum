import type { SystemCapabilities } from "./system/contracts.js";

export interface TextSink {
  write(text: string): void;
}

export interface DiagnosticRuntime {
  readonly stdout: TextSink;
  readonly stderr: TextSink;
}

export interface CliRuntime extends DiagnosticRuntime {
  readonly stdin: NodeJS.ReadableStream;
  readonly system: SystemCapabilities;
}

export type CommandRuntime<Capabilities> = DiagnosticRuntime & {
  readonly system: Capabilities;
};

export function scopeRuntime<Capabilities>(
  runtime: CliRuntime,
  system: Capabilities,
): CommandRuntime<Capabilities> {
  return Object.freeze({
    stdout: runtime.stdout,
    stderr: runtime.stderr,
    system,
  });
}
