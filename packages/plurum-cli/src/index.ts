#!/usr/bin/env node

import { runCli } from "./cli.js";
import { createProcessRuntime } from "./adapters/node/process-runtime.js";
import { ExitCode } from "./exit-codes.js";

try {
  const runtime = createProcessRuntime();
  process.exitCode = await runCli(process.argv.slice(2), runtime);
} catch {
  process.stderr.write("Plurum failed to start.\n");
  process.exitCode = ExitCode.OperationalFailure;
}
