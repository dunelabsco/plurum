import { writeUnavailableJson, writeUnavailableText } from "./unavailable.js";

import type { ExitCode } from "../exit-codes.js";
import type { DoctorInvocation } from "./types.js";

export function runDoctor(invocation: DoctorInvocation): ExitCode {
  return invocation.options.json
    ? writeUnavailableJson("doctor", invocation.runtime)
    : writeUnavailableText("doctor", invocation.runtime);
}
