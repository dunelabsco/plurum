import { writeUnavailableJson, writeUnavailableText } from "./unavailable.js";

import type { ExitCode } from "../exit-codes.js";
import type { StatusInvocation } from "./types.js";
import {
  observeStatus,
  type StatusObservationDependencies,
} from "./status-observation.js";
import { writeStatusReport } from "./status-output.js";

export type StatusCommand = (
  invocation: StatusInvocation,
) => ExitCode | Promise<ExitCode>;

/*
 * Portable Step 4.9 composition. Production deliberately keeps the default
 * handler unavailable until native semantic credential, host, and Codex
 * projection observers pass the release gates.
 */
export function createStatusCommand(
  dependencies: StatusObservationDependencies,
): StatusCommand {
  return async (invocation) => {
    const report = await observeStatus(
      invocation.options,
      invocation.runtime.system,
      dependencies,
    );
    return writeStatusReport(
      report,
      invocation.options.json,
      invocation.runtime,
    );
  };
}

export function runStatus(invocation: StatusInvocation): ExitCode {
  return invocation.options.json
    ? writeUnavailableJson("status", invocation.runtime)
    : writeUnavailableText("status", invocation.runtime);
}
