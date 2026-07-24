import { writeUnavailableJson, writeUnavailableText } from "./unavailable.js";

import type { ExitCode } from "../exit-codes.js";
import type { DoctorInvocation } from "./types.js";
import {
  observeDoctor,
  type DoctorObservationDependencies,
} from "./doctor-observation.js";
import { writeDoctorReport } from "./doctor-output.js";

export type DoctorCommand = (
  invocation: DoctorInvocation,
) => ExitCode | Promise<ExitCode>;

/*
 * Portable Step 4.10 composition. Production deliberately keeps the default
 * handler unavailable until native runtime support and all semantic status
 * observers pass the release gates.
 */
export function createDoctorCommand(
  dependencies: DoctorObservationDependencies,
): DoctorCommand {
  return async (invocation) => {
    const report = await observeDoctor(
      invocation.options,
      invocation.runtime.system,
      dependencies,
    );
    return writeDoctorReport(
      report,
      invocation.options.json,
      invocation.runtime,
    );
  };
}

export function runDoctor(invocation: DoctorInvocation): ExitCode {
  return invocation.options.json
    ? writeUnavailableJson("doctor", invocation.runtime)
    : writeUnavailableText("doctor", invocation.runtime);
}
