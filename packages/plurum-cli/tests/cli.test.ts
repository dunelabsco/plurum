import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import type {
  CommandHandlers,
  DoctorOptions,
  DoctorInvocation,
  SetupOptions,
  StatusOptions,
  StatusInvocation,
} from "../src/commands/types.js";
import { ExitCode } from "../src/exit-codes.js";
import type { CliRuntime } from "../src/runtime.js";
import type { SystemCapabilities } from "../src/system/contracts.js";
import { CLI_VERSION } from "../src/version.js";
import { createTestSystem } from "./support/system.js";

const CANARY_KEY = "plrm_live_STEP_4_1_CANARY_DO_NOT_PRINT";

interface Harness {
  readonly runtime: CliRuntime;
  stdout(): string;
  stderr(): string;
}

function createHarness(
  stdin: NodeJS.ReadableStream = Readable.from([]),
  system: SystemCapabilities = createTestSystem(),
): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    runtime: {
      stdin,
      stdout: { write: (text) => stdout.push(text) },
      stderr: { write: (text) => stderr.push(text) },
      system,
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
    for (const excluded of [
      "register",
      "sessions",
      "pulse",
      "acquire",
      "auth login",
      "PLURUM_HOME",
      "PLURUM_TEST_ROOT",
      "PLURUM_TEST_RUN_ID",
    ]) {
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
      setup({ options }) {
        captured = options;
        return ExitCode.Success;
      },
    });

    const result = await runCli(
      [
        "setup",
        "--client",
        "codex",
        "--api-key-stdin",
        "--yes",
      ],
      harness.runtime,
      handlers,
    );

    expect(result).toBe(ExitCode.Success);
    expect(captured).toEqual({
      client: "codex",
      apiKeyStdin: true,
      dryRun: false,
      yes: true,
    });
    expect(harness.stdout()).toBe("");
    expect(harness.stderr()).toBe("");
  });

  it("defaults setup apply to an unapproved invocation", async () => {
    const harness = createHarness();
    let captured: SetupOptions | undefined;
    const handlers = createHandlers({
      setup({ options }) {
        captured = options;
        return ExitCode.Success;
      },
    });

    expect(await runCli(["setup"], harness.runtime, handlers)).toBe(
      ExitCode.Success,
    );
    expect(captured).toEqual({
      client: "all",
      apiKeyStdin: false,
      dryRun: false,
      yes: false,
    });
  });

  it("parses dry-run without accepting a credential source", async () => {
    const harness = createHarness();
    let captured: SetupOptions | undefined;
    const handlers = createHandlers({
      setup({ options }) {
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
      yes: false,
    });
  });

  it("withholds stdin from dry-run and read-only command runtimes", async () => {
    const receivedStdin: boolean[] = [];
    const cases: ReadonlyArray<readonly [readonly string[], CommandHandlers]> = [
      [
        ["setup", "--dry-run"],
        createHandlers({
          setup({ runtime }) {
            expect(Object.isFrozen(runtime)).toBe(true);
            receivedStdin.push("stdin" in runtime);
            return ExitCode.Success;
          },
        }),
      ],
      [
        ["status"],
        createHandlers({
          status({ runtime }) {
            expect(Object.isFrozen(runtime)).toBe(true);
            receivedStdin.push("stdin" in runtime);
            return ExitCode.Success;
          },
        }),
      ],
      [
        ["doctor"],
        createHandlers({
          doctor({ runtime }) {
            expect(Object.isFrozen(runtime)).toBe(true);
            receivedStdin.push("stdin" in runtime);
            return ExitCode.Success;
          },
        }),
      ],
    ];

    for (const [args, handlers] of cases) {
      const harness = createHarness();
      expect(await runCli(args, harness.runtime, handlers)).toBe(ExitCode.Success);
    }
    expect(receivedStdin).toEqual([false, false, false]);
  });

  it("withholds raw stdin and mutation authority from setup apply preflight", async () => {
    const harness = createHarness();
    let receivedStdin = false;
    const handlers = createHandlers({
      setup({ runtime }) {
        expect(Object.isFrozen(runtime)).toBe(true);
        receivedStdin = "stdin" in runtime;
        expect(Object.keys(runtime.system).sort()).toEqual([
          "hosts",
          "platform",
        ]);
        expect("mutation" in runtime.system.hosts).toBe(false);
        for (const adapter of Object.values(
          runtime.system.hosts.inspection,
        )) {
          expect(Object.keys(adapter)).toEqual(["inspect"]);
          expect("apply" in adapter).toBe(false);
          expect("rollback" in adapter).toBe(false);
        }
        return ExitCode.Success;
      },
    });

    expect(
      await runCli(["setup", "--yes"], harness.runtime, handlers),
    ).toBe(
      ExitCode.Success,
    );
    expect(receivedStdin).toBe(false);
  });

  it.each([
    ["status", "claude-code", true],
    ["doctor", "all", true],
  ] as const)("parses %s read-only options", async (command, client, json) => {
    const harness = createHarness();
    let captured: StatusOptions | DoctorOptions | undefined;
    const handlers = createHandlers({
      [command](invocation: StatusInvocation & DoctorInvocation) {
        captured = invocation.options;
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
    ["setup", "--api-key-stdin"],
    ["setup", "--yes", "--dry-run"],
    ["setup", "--yes", "--yes"],
    ["setup", "--client", "codex", "--client", "all"],
  ])("rejects unsupported or duplicate options", async (...args) => {
    const harness = createHarness();

    expect(await runCli(args, harness.runtime, createHandlers())).toBe(ExitCode.Usage);
    expect(harness.stderr()).toContain("Invalid arguments");
  });

  it("rejects stdin credentials without --yes before reading input or invoking setup", async () => {
    let readAttempted = false;
    let invoked = false;
    const stdin = new Readable({
      read() {
        readAttempted = true;
        this.push(CANARY_KEY);
        this.push(null);
      },
    });
    const harness = createHarness(stdin);
    const handlers = createHandlers({
      setup() {
        invoked = true;
        return ExitCode.Success;
      },
    });

    expect(
      await runCli(
        ["setup", "--api-key-stdin"],
        harness.runtime,
        handlers,
      ),
    ).toBe(ExitCode.Usage);
    expect(readAttempted).toBe(false);
    expect(invoked).toBe(false);
    expect(`${harness.stdout()}${harness.stderr()}`).not.toContain(
      CANARY_KEY,
    );
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
    expect(harness.stdout()).toContain("--yes");
    expect(harness.stdout()).toContain("--dry-run");
    expect(harness.stderr()).toBe("");
  });

  it("refuses elevated execution before invoking a command handler", async () => {
    const harness = createHarness(
      Readable.from([]),
      createTestSystem("elevated"),
    );
    let invoked = false;
    const handlers = createHandlers({
      setup() {
        invoked = true;
        return ExitCode.Success;
      },
    });

    expect(await runCli(["setup"], harness.runtime, handlers)).toBe(
      ExitCode.OperationalFailure,
    );
    expect(invoked).toBe(false);
    expect(harness.stdout()).toBe("");
    expect(harness.stderr()).toBe(
      "plurum setup: Plurum refuses to run with elevated privileges.\n",
    );
  });

  it("fails closed when privilege state is unknown", async () => {
    const harness = createHarness(Readable.from([]), createTestSystem("unknown"));
    let invoked = false;
    const handlers = createHandlers({
      status() {
        invoked = true;
        return ExitCode.Success;
      },
    });

    expect(
      await runCli(["status", "--json"], harness.runtime, handlers),
    ).toBe(ExitCode.OperationalFailure);
    expect(invoked).toBe(false);
    expect(JSON.parse(harness.stdout())).toEqual({
      schema_version: 1,
      ok: false,
      command: "status",
      error: {
        code: "unsafe_execution_context",
        message:
          "Plurum cannot verify a non-elevated execution context on this platform.",
      },
    });
    expect(harness.stderr()).toBe("");
  });

  it("allows help and version output when privilege state is unknown", async () => {
    for (const args of [["--help"], ["--version"], ["setup", "--help"]]) {
      const harness = createHarness(
        Readable.from([]),
        createTestSystem("unknown"),
      );
      expect(await runCli(args, harness.runtime, createHandlers())).toBe(
        ExitCode.Success,
      );
      expect(harness.stderr()).toBe("");
    }
  });
});

describe("development handlers", () => {
  it("fails setup closed instead of pretending configuration succeeded", async () => {
    const harness = createHarness();

    expect(await runCli(["setup"], harness.runtime)).toBe(ExitCode.Unavailable);
    expect(harness.stdout()).toBe("");
    expect(harness.stderr()).toContain("private development build");
    expect(harness.stderr()).not.toContain(CANARY_KEY);
  });

  it.each([
    ["setup", "--yes"],
    ["setup", "--api-key-stdin", "--yes"],
  ])(
    "keeps unavailable apply from consuming stdin for %s",
    async (...args) => {
      let readAttempted = false;
      const stdin = new Readable({
        read() {
          readAttempted = true;
          this.push(CANARY_KEY);
          this.push(null);
        },
      });
      const harness = createHarness(stdin);

      expect(await runCli(args, harness.runtime)).toBe(
        ExitCode.Unavailable,
      );
      expect(readAttempted).toBe(false);
      expect(harness.stdout()).toBe("");
      expect(harness.stderr()).toContain("private development build");
      expect(harness.stderr()).not.toContain(CANARY_KEY);
    },
  );

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
      ExitCode.OperationalFailure,
    );
    expect(readAttempted).toBe(false);
    expect(harness.stdout()).toContain("Plurum setup preflight");
    expect(harness.stdout()).toContain("No changes were made.");
    expect(harness.stderr()).toBe("");
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
