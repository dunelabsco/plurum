import { writeUnavailableJson, writeUnavailableText } from "./unavailable.js";

import type { ExitCode } from "../exit-codes.js";
import type { CliRuntime } from "../runtime.js";
import type { StatusOptions } from "./types.js";

export function runStatus(options: StatusOptions, runtime: CliRuntime): ExitCode {
  return options.json
    ? writeUnavailableJson("status", runtime)
    : writeUnavailableText("status", runtime);
}
