import { writeUnavailableText } from "./unavailable.js";
import {
  createSetupDryRunPreflight,
} from "./setup-preflight.js";
import { renderSetupDryRunPreflight } from "./setup-output.js";

import { ExitCode } from "../exit-codes.js";
import type { SetupInvocation } from "./types.js";

export async function runSetup(
  invocation: SetupInvocation,
): Promise<ExitCode> {
  if (!invocation.options.dryRun) {
    return writeUnavailableText("setup", invocation.runtime);
  }

  const preflight = await createSetupDryRunPreflight(
    invocation.options.client,
    invocation.runtime.system,
  );
  invocation.runtime.stdout.write(
    renderSetupDryRunPreflight(preflight),
  );
  return preflight.readiness === "ready" ||
    preflight.readiness === "no-op"
    ? ExitCode.Success
    : ExitCode.OperationalFailure;
}
