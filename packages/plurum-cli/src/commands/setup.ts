import { writeUnavailableText } from "./unavailable.js";

import type { ExitCode } from "../exit-codes.js";
import type { SetupInvocation } from "./types.js";

export function runSetup(invocation: SetupInvocation): ExitCode {
  return writeUnavailableText("setup", invocation.runtime);
}
