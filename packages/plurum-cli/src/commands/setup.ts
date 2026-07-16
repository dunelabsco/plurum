import { writeUnavailableText } from "./unavailable.js";

import type { ExitCode } from "../exit-codes.js";
import type { CliRuntime } from "../runtime.js";
import type { SetupOptions } from "./types.js";

export function runSetup(
  _options: SetupOptions,
  runtime: CliRuntime,
): ExitCode {
  return writeUnavailableText("setup", runtime);
}
