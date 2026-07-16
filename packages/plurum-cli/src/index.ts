#!/usr/bin/env node

import { runCli } from "./cli.js";
import { ExitCode } from "./exit-codes.js";
import { createProcessRuntime } from "./runtime.js";

try {
  const runtime = createProcessRuntime();
  process.exitCode = await runCli(process.argv.slice(2), runtime);
} catch {
  process.stderr.write("Plurum failed to start.\n");
  process.exitCode = ExitCode.OperationalFailure;
}
