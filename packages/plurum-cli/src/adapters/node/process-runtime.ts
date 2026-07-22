import type { CliRuntime } from "../../runtime.js";
import { createProductionSystem } from "./production.js";

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
