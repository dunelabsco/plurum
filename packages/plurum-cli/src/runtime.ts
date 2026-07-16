import { createProductionSystem } from "./adapters/node/production.js";
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

export type InteractiveCommandRuntime<Capabilities> =
  CommandRuntime<Capabilities> & Pick<CliRuntime, "stdin">;

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

export function scopeInteractiveRuntime<Capabilities>(
  runtime: CliRuntime,
  system: Capabilities,
): InteractiveCommandRuntime<Capabilities> {
  return Object.freeze({
    ...scopeRuntime(runtime, system),
    stdin: runtime.stdin,
  });
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
    system: createProductionSystem(),
  };
}
