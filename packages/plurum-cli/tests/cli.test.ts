import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import type {
  CommandHandlers,
  DoctorOptions,
  SetupOptions,
  StatusOptions,
} from "../src/commands/types.js";
import { ExitCode } from "../src/exit-codes.js";
import type { CliRuntime } from "../src/runtime.js";
import { CLI_VERSION } from "../src/version.js";

const CANARY_KEY = "plrm_live_STEP_4_1_CANARY_DO_NOT_PRINT";

interface Harness {
  readonly runtime: CliRuntime;
  stdout(): string;
  stderr(): string;
}

function createHarness(stdin: NodeJS.ReadableStream = Readable.from([])): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    runtime: {
      stdin,
      stdout: { write: (text) => stdout.push(text) },
      stderr: { write: (text) => stderr.push(text) },
      env: Object.freeze({
        PLURUM_HOME: "/isolated/plurum",
        PLURUM_TEST_ROOT: "/isolated",
      }),
      platform: "linux",
      cwd: "/isolated/empty-cwd",
    },
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  };
}

function createHandlers(
  overrides: Partial<CommandHandlers> = {},
): CommandHandlers {
  return {
    setup: () => ExitCode.Success,
    status: () => ExitCode.Success,
    doctor: () => ExitCode.Success,
    ...overrides,
  };
}

describe("CLI surface", () => {
  it("pins the public numeric exit-code contract", () => {
    expect({
      success: ExitCode.Success,
      operationalFailure: ExitCode.OperationalFailure,
      usage: ExitCode.Usage,
      unavailable: ExitCode.Unavailable,
    }).toEqual({
      success: 0,
      operationalFailure: 1,
      usage: 2,
      unavailable: 3,
    });
  });

  it("shows only the three approved commands", async () => {
    const harness = createHarness();

    expect(await runCli([], harness.runtime)).toBe(ExitCode.Success);
    expect(harness.stdout()).toContain("setup");
    expect(harness.stdout()).toContain("status");
    expect(harness.stdout()).toContain("doctor");
    for (const excluded of ["register", "sessions", "pulse", "acquire", "auth login"]) {
      expect(harness.stdout()).not.toContain(excluded);
    }
    expect(harness.stderr()).toBe("");
  });

  it("reports the package development version", async () => {
    const harness = createHarness();

    expect(await runCli(["--version"], harness.runtime)).toBe(ExitCode.Success);
    expect(harness.stdout()).toBe(`${CLI_VERSION}\n`);
  });

  it("parses setup options without reading stdin", async () => {
    const harness = createHarness();
    let captured: SetupOptions | undefined;
    const handlers = createHandlers({
      setup(options) {
        captured = options;
        return ExitCode.Success;
      },
    });

    const result = await runCli(
      ["setup", "--client", "codex", "--api-key-stdin"],
      harness.runtime,
      handlers,
    );

    expect(result).toBe(ExitCode.Success);
    expect(captured).toEqual({
      client: "codex",
      apiKeyStdin: true,
      dryRun: false,
    });
    expect(harness.stdout()).toBe("");
    expect(harness.stderr()).toBe("");
  });

  it("parses dry-run without accepting a credential source", async () => {
    const harness = createHarness();
    let captured: SetupOptions | undefined;
    const handlers = createHandlers({
      setup(options) {
        captured = options;
        return ExitCode.Success;
      },
    });

    expect(
      await runCli(["setup", "--dry-run"], harness.runtime, handlers),
    ).toBe(ExitCode.Success);
    expect(captured).toEqual({
      client: "all",
      apiKeyStdin: false,
      dryRun: true,
    });
  });

  it.each([
    ["status", "claude-code", true],
    ["doctor", "all", true],
  ] as const)("parses %s read-only options", async (command, client, json) => {
    const harness = createHarness();
    let captured: StatusOptions | DoctorOptions | undefined;
    const handlers = createHandlers({
      [command](options: StatusOptions & DoctorOptions) {
        captured = options;
        return ExitCode.Success;
      },
    });

    const result = await runCli(
      [command, "--client", client, "--json"],
      harness.runtime,
      handlers,
    );

    expect(result).toBe(ExitCode.Success);
    expect(captured).toEqual({ client, json });
  });

  it.each([
    ["setup", "--json"],
    ["status", "--api-key-stdin"],
    ["doctor", "--dry-run"],
    ["setup", "--api-key-stdin", "--dry-run"],
    ["setup", "--client", "codex", "--client", "all"],
  ])("rejects unsupported or duplicate options", async (...args) => {
    const harness = createHarness();

    expect(await runCli(args, harness.runtime, createHandlers())).toBe(ExitCode.Usage);
    expect(harness.stderr()).toContain("Invalid arguments");
  });

  it("never reflects rejected secret-bearing arguments", async () => {
    const attempts = [
      ["setup", "--api-key", CANARY_KEY],
      ["setup", `--api-key=${CANARY_KEY}`],
      ["setup", "--client", CANARY_KEY],
      [CANARY_KEY],
    ];

    for (const args of attempts) {
      const harness = createHarness();
      expect(await runCli(args, harness.runtime, createHandlers())).toBe(ExitCode.Usage);
      expect(`${harness.stdout()}${harness.stderr()}`).not.toContain(CANARY_KEY);
    }
  });

  it("does not expose errors thrown by command handlers", async () => {
    const harness = createHarness();
    const handlers = createHandlers({
      setup() {
        throw new Error(`provider response contained ${CANARY_KEY}`);
      },
    });

    expect(await runCli(["setup"], harness.runtime, handlers)).toBe(
      ExitCode.OperationalFailure,
    );
    expect(`${harness.stdout()}${harness.stderr()}`).not.toContain(CANARY_KEY);
    expect(harness.stderr()).toBe("Plurum could not complete the command.\n");
  });

  it("keeps read-only JSON output machine-readable when a handler fails", async () => {
    const harness = createHarness();
    const handlers = createHandlers({
      status() {
        throw new Error(`provider response contained ${CANARY_KEY}`);
      },
    });

    expect(await runCli(["status", "--json"], harness.runtime, handlers)).toBe(
      ExitCode.OperationalFailure,
    );
    expect(JSON.parse(harness.stdout())).toEqual({
      schema_version: 1,
      ok: false,
      command: "status",
      error: {
        code: "operational_failure",
        message: "Plurum could not complete the command.",
      },
    });
    expect(harness.stderr()).toBe("");
    expect(harness.stdout()).not.toContain(CANARY_KEY);
  });

  it("shows command help without invoking its handler", async () => {
    const harness = createHarness();
    const handlers = createHandlers({
      setup() {
        throw new Error("handler must not run");
      },
    });

    expect(await runCli(["setup", "--help"], harness.runtime, handlers)).toBe(
      ExitCode.Success,
    );
    expect(harness.stdout()).toContain("--api-key-stdin");
    expect(harness.stdout()).toContain("--dry-run");
    expect(harness.stderr()).toBe("");
  });
});

describe("private development handlers", () => {
  it("fails setup closed instead of pretending configuration succeeded", async () => {
    const harness = createHarness();

    expect(await runCli(["setup"], harness.runtime)).toBe(ExitCode.Unavailable);
    expect(harness.stdout()).toBe("");
    expect(harness.stderr()).toContain("private development build");
    expect(harness.stderr()).not.toContain(CANARY_KEY);
  });

  it("does not consume stdin during setup --dry-run", async () => {
    let readAttempted = false;
    const stdin = new Readable({
      read() {
        readAttempted = true;
        this.push(null);
      },
    });
    const harness = createHarness(stdin);

    expect(await runCli(["setup", "--dry-run"], harness.runtime)).toBe(
      ExitCode.Unavailable,
    );
    expect(readAttempted).toBe(false);
  });

  it.each(["status", "doctor"] as const)(
    "emits a versioned JSON error for %s --json",
    async (command) => {
      const harness = createHarness();

      expect(await runCli([command, "--json"], harness.runtime)).toBe(
        ExitCode.Unavailable,
      );
      expect(JSON.parse(harness.stdout())).toEqual({
        schema_version: 1,
        ok: false,
        command,
        error: {
          code: "command_unavailable",
          message: "This command is not available in the private development build.",
        },
      });
      expect(harness.stderr()).toBe("");
      expect(harness.stdout()).not.toContain(CANARY_KEY);
    },
  );
});
