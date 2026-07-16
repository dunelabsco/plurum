import { writeUnavailableJson, writeUnavailableText } from "./unavailable.js";

import type { ExitCode } from "../exit-codes.js";
import type { DoctorOptions } from "./types.js";
import type { CliRuntime } from "../runtime.js";

export function runDoctor(options: DoctorOptions, runtime: CliRuntime): ExitCode {
  return options.json
    ? writeUnavailableJson("doctor", runtime)
    : writeUnavailableText("doctor", runtime);
}
