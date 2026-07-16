import { writeUnavailableJson, writeUnavailableText } from "./unavailable.js";

import type { ExitCode } from "../exit-codes.js";
import type { StatusInvocation } from "./types.js";

export function runStatus(invocation: StatusInvocation): ExitCode {
  return invocation.options.json
    ? writeUnavailableJson("status", invocation.runtime)
    : writeUnavailableText("status", invocation.runtime);
}
