import { parseArgs } from "node:util";

import { runDoctor } from "./commands/doctor.js";
import { runSetup } from "./commands/setup.js";
import { runStatus } from "./commands/status.js";
import {
  CLIENT_TARGETS,
  type ClientTarget,
  type CommandHandlers,
  type DoctorOptions,
  type SetupOptions,
  type StatusOptions,
} from "./commands/types.js";
import { ExitCode } from "./exit-codes.js";
import { writeCommandJsonError } from "./json-output.js";
import type { CliRuntime } from "./runtime.js";
import { scopeRuntime } from "./runtime.js";
import {
  doctorScope,
  planningScope,
  setupPreflightScope,
  statusScope,
} from "./system/scopes.js";
import { CLI_VERSION } from "./version.js";

const ROOT_HELP = `plurum — connect Claude Code and Codex to Plurum

Usage:
  plurum setup [--client <target>] [--api-key-stdin] [--yes] [--dry-run]
  plurum status [--client <target>] [--json]
  plurum doctor [--client <target>] [--json]
  plurum --version
  plurum --help

Commands:
  setup    create or reuse an agent and configure selected hosts
  status   report credential, agent, and host state without changing it
  doctor   diagnose connectivity and configuration without changing it

Client targets:
  claude-code | codex | all (default: all)
`;

const SETUP_HELP = `Usage:
  plurum setup [--client <target>] [--api-key-stdin] [--yes] [--dry-run]

Options:
  --client <target>  claude-code, codex, or all (default: all)
  --api-key-stdin    reserve stdin as the API-key source (requires --yes)
  --yes              reserve noninteractive approval for the exact apply plan
  --dry-run          inspect a plan without changing or reading credentials
  -h, --help         show this help

Development build: apply is unavailable; these flags do not read input.
`;

const STATUS_HELP = `Usage:
  plurum status [--client <target>] [--json]

Options:
  --client <target>  claude-code, codex, or all (default: all)
  --json             emit a versioned JSON result
  -h, --help         show this help
`;

const DOCTOR_HELP = `Usage:
  plurum doctor [--client <target>] [--json]

Options:
  --client <target>  claude-code, codex, or all (default: all)
  --json             emit a versioned JSON result
  -h, --help         show this help
`;

const DEFAULT_HANDLERS: CommandHandlers = {
  setup: runSetup,
  status: runStatus,
  doctor: runDoctor,
};

type KnownCommand = keyof CommandHandlers;

class CliUsageError extends Error {
  constructor(readonly command?: KnownCommand) {
    super("invalid command usage");
    this.name = "CliUsageError";
  }
}

interface OptionToken {
  readonly kind: string;
  readonly name?: string;
}

function rejectDuplicateOptions(
  tokens: readonly OptionToken[],
  command: KnownCommand,
): void {
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option" || token.name === undefined) {
      continue;
    }
    if (seen.has(token.name)) {
      throw new CliUsageError(command);
    }
    seen.add(token.name);
  }
}

function parseClient(value: string | undefined, command: KnownCommand): ClientTarget {
  if (value === undefined) {
    return "all";
  }
  if ((CLIENT_TARGETS as readonly string[]).includes(value)) {
    return value as ClientTarget;
  }
  throw new CliUsageError(command);
}

function parseSetup(args: readonly string[]): SetupOptions | "help" {
  try {
    const parsed = parseArgs({
      args: [...args],
      allowPositionals: false,
      strict: true,
      tokens: true,
      options: {
        client: { type: "string" },
        "api-key-stdin": { type: "boolean" },
        "dry-run": { type: "boolean" },
        yes: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
    rejectDuplicateOptions(parsed.tokens, "setup");
    if (parsed.values.help === true) {
      return "help";
    }
    const apiKeyStdin = parsed.values["api-key-stdin"] === true;
    const dryRun = parsed.values["dry-run"] === true;
    const yes = parsed.values.yes === true;
    if ((apiKeyStdin || yes) && dryRun) {
      throw new CliUsageError("setup");
    }
    if (apiKeyStdin && !yes) {
      throw new CliUsageError("setup");
    }
    const client = parseClient(parsed.values.client, "setup");
    return dryRun
      ? { client, apiKeyStdin: false, dryRun: true, yes: false }
      : { client, apiKeyStdin, dryRun: false, yes };
  } catch {
    throw new CliUsageError("setup");
  }
}

function parseStatus(args: readonly string[]): StatusOptions | "help" {
  try {
    const parsed = parseArgs({
      args: [...args],
      allowPositionals: false,
      strict: true,
      tokens: true,
      options: {
        client: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
    rejectDuplicateOptions(parsed.tokens, "status");
    if (parsed.values.help === true) {
      return "help";
    }
    return {
      client: parseClient(parsed.values.client, "status"),
      json: parsed.values.json === true,
    };
  } catch {
    throw new CliUsageError("status");
  }
}

function parseDoctor(args: readonly string[]): DoctorOptions | "help" {
  try {
    const parsed = parseArgs({
      args: [...args],
      allowPositionals: false,
      strict: true,
      tokens: true,
      options: {
        client: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
    rejectDuplicateOptions(parsed.tokens, "doctor");
    if (parsed.values.help === true) {
      return "help";
    }
    return {
      client: parseClient(parsed.values.client, "doctor"),
      json: parsed.values.json === true,
    };
  } catch {
    throw new CliUsageError("doctor");
  }
}

function writeUsageError(error: CliUsageError, runtime: CliRuntime): ExitCode {
  const target = error.command === undefined ? "plurum --help" : `plurum ${error.command} --help`;
  runtime.stderr.write(`Invalid arguments. Run '${target}' for usage.\n`);
  return ExitCode.Usage;
}

function writeOperationalFailureJson(
  command: "status" | "doctor",
  runtime: CliRuntime,
): ExitCode {
  writeCommandJsonError(
    command,
    "operational_failure",
    "Plurum could not complete the command.",
    runtime,
  );
  return ExitCode.OperationalFailure;
}

function writeUnsafeExecutionContext(
  command: KnownCommand,
  json: boolean,
  runtime: CliRuntime,
): ExitCode | undefined {
  const elevation = runtime.system.platform.elevation;
  if (elevation === "standard") {
    return undefined;
  }

  const message =
    elevation === "elevated"
      ? "Plurum refuses to run with elevated privileges."
      : "Plurum cannot verify a non-elevated execution context on this platform.";

  if (json && command !== "setup") {
    writeCommandJsonError(command, "unsafe_execution_context", message, runtime);
  } else {
    runtime.stderr.write(`plurum ${command}: ${message}\n`);
  }
  return ExitCode.OperationalFailure;
}

export async function runCli(
  args: readonly string[],
  runtime: CliRuntime,
  handlers: CommandHandlers = DEFAULT_HANDLERS,
): Promise<ExitCode> {
  if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0] ?? ""))) {
    runtime.stdout.write(ROOT_HELP);
    return ExitCode.Success;
  }

  if (args.length === 1 && args[0] === "--version") {
    runtime.stdout.write(`${CLI_VERSION}\n`);
    return ExitCode.Success;
  }

  const [command, ...commandArgs] = args;
  let jsonCommand: "status" | "doctor" | undefined;

  try {
    switch (command) {
      case "setup": {
        const options = parseSetup(commandArgs);
        if (options === "help") {
          runtime.stdout.write(SETUP_HELP);
          return ExitCode.Success;
        }
        const unsafe = writeUnsafeExecutionContext("setup", false, runtime);
        if (unsafe !== undefined) {
          return unsafe;
        }
        return options.dryRun
          ? await handlers.setup({
              options,
              runtime: scopeRuntime(runtime, planningScope(runtime.system)),
            })
          : await handlers.setup({
              options,
              runtime: scopeRuntime(
                runtime,
                setupPreflightScope(runtime.system),
              ),
            });
      }
      case "status": {
        const options = parseStatus(commandArgs);
        if (options === "help") {
          runtime.stdout.write(STATUS_HELP);
          return ExitCode.Success;
        }
        if (options.json) {
          jsonCommand = "status";
        }
        const unsafe = writeUnsafeExecutionContext("status", options.json, runtime);
        if (unsafe !== undefined) {
          return unsafe;
        }
        return await handlers.status({
          options,
          runtime: scopeRuntime(runtime, statusScope(runtime.system)),
        });
      }
      case "doctor": {
        const options = parseDoctor(commandArgs);
        if (options === "help") {
          runtime.stdout.write(DOCTOR_HELP);
          return ExitCode.Success;
        }
        if (options.json) {
          jsonCommand = "doctor";
        }
        const unsafe = writeUnsafeExecutionContext("doctor", options.json, runtime);
        if (unsafe !== undefined) {
          return unsafe;
        }
        return await handlers.doctor({
          options,
          runtime: scopeRuntime(runtime, doctorScope(runtime.system)),
        });
      }
      default:
        throw new CliUsageError();
    }
  } catch (error) {
    if (error instanceof CliUsageError) {
      return writeUsageError(error, runtime);
    }
    if (jsonCommand !== undefined) {
      return writeOperationalFailureJson(jsonCommand, runtime);
    }
    runtime.stderr.write("Plurum could not complete the command.\n");
    return ExitCode.OperationalFailure;
  }
}
