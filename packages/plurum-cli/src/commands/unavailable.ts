import type { CliRuntime } from "../runtime.js";

import { ExitCode } from "../exit-codes.js";
import {
  writeCommandJsonError,
  type ReadOnlyCommand,
} from "../json-output.js";

const UNAVAILABLE_MESSAGE =
  "This command is not available in the private development build.";

export function writeUnavailableText(
  command: "setup" | ReadOnlyCommand,
  runtime: CliRuntime,
): ExitCode {
  runtime.stderr.write(`plurum ${command}: ${UNAVAILABLE_MESSAGE}\n`);
  return ExitCode.Unavailable;
}

export function writeUnavailableJson(
  command: ReadOnlyCommand,
  runtime: CliRuntime,
): ExitCode {
  writeCommandJsonError(
    command,
    "command_unavailable",
    UNAVAILABLE_MESSAGE,
    runtime,
  );
  return ExitCode.Unavailable;
}
