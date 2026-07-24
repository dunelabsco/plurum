import { writeUnavailableText } from "./unavailable.js";
import {
  createSetupDryRunPreflight,
} from "./setup-preflight.js";
import { renderSetupDryRunPreflight } from "./setup-output.js";

import { ExitCode } from "../exit-codes.js";
import type { SetupInvocation } from "./types.js";

type SetupDryRunInvocation = Extract<
  SetupInvocation,
  { readonly options: { readonly dryRun: true } }
>;

function isDryRunInvocation(
  invocation: SetupInvocation,
): invocation is SetupDryRunInvocation {
  return invocation.options.dryRun;
}

export async function runSetup(
  invocation: SetupInvocation,
): Promise<ExitCode> {
  if (isDryRunInvocation(invocation)) {
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

  return writeUnavailableText("setup", invocation.runtime);
}
