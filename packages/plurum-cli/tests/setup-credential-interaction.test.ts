import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  createNodeSetupExplicitCredentialInput,
  createNodeSetupProtectedInteractiveSession,
  SETUP_EXACT_CONFIRMATION_MAX_BYTES,
  type SetupProtectedTerminalCaptureRequest,
  type SetupProtectedTerminalCaptureResult,
  type SetupProtectedTerminalConfirmationRequest,
  type SetupProtectedTerminalPort,
} from "../src/adapters/node/setup-credential-input.js";
import type {
  SetupTerminalInput,
} from "../src/adapters/node/setup-interaction.js";
import { SETUP_CONFIRMATION_PROMPT } from "../src/commands/setup-confirmation.js";
import {
  SETUP_CREDENTIAL_INPUT_MAX_BYTES,
  SETUP_CREDENTIAL_INPUT_PROMPT,
  claimSetupCredentialInputBytes,
  discardSetupCredentialInput,
  type SetupCredentialInputIdentity,
} from "../src/commands/setup-credential-input.js";
import type { SetupApplyOptions } from "../src/commands/types.js";
import { wipeUint8Array } from "../src/data/uint8-array.js";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
const PLAN = [
  "Plurum setup plan",
  "",
  "readiness: ready",
  "confirmation: required before any change",
  "No changes have been made.",
  "",
].join("\n");
const KEY = "plrm_live_PROTECTED_READER_TEST_KEY";
const CANARY = "plrm_live_SECRET_READER_ERROR_CANARY";
const EXPLICIT_OPTIONS: SetupApplyOptions = Object.freeze({
  client: "all",
  apiKeyStdin: true,
  dryRun: false,
  yes: true,
});

type TerminalPassThrough = PassThrough & {
  readonly isTTY?: boolean;
};

function terminalStream(isTTY: boolean): TerminalPassThrough {
  const stream = new PassThrough() as TerminalPassThrough;
  Object.defineProperty(stream, "isTTY", {
    configurable: false,
    enumerable: true,
    value: isTTY,
    writable: false,
  });
  return stream;
}

function outputHarness(isTTY = true): Readonly<{
  stream: TerminalPassThrough;
  text(): string;
}> {
  const stream = terminalStream(isTTY);
  const chunks: string[] = [];
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => chunks.push(chunk));
  return Object.freeze({
    stream,
    text: () => chunks.join(""),
  });
}

async function nextIoTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForReader(input: SetupTerminalInput): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (
      input.listenerCount("data") === 1 &&
      input.listenerCount("end") === 1 &&
      input.listenerCount("error") === 1 &&
      input.listenerCount("close") === 1
    ) {
      return;
    }
    await nextIoTurn();
  }
  throw new Error("expected a bounded credential reader");
}

async function waitForOutput(
  output: ReturnType<typeof outputHarness>,
  expected: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (output.text() === expected) {
      return;
    }
    await nextIoTurn();
  }
  throw new Error("expected output was not flushed");
}

function claimText(identity: SetupCredentialInputIdentity): string {
  const bytes = claimSetupCredentialInputBytes(identity);
  if (bytes === undefined) {
    throw new Error("expected retained credential material");
  }
  try {
    return DECODER.decode(bytes);
  } finally {
    wipeUint8Array(bytes);
  }
}

async function explicitCapture(
  chunks: readonly Uint8Array[],
): Promise<Awaited<
  ReturnType<
    ReturnType<
      typeof createNodeSetupExplicitCredentialInput
    >["capture"]
  >
>> {
  const input = terminalStream(false);
  const attempt = createNodeSetupExplicitCredentialInput(
    input,
    EXPLICIT_OPTIONS,
  );
  const result = attempt.capture();
  await waitForReader(input);
  for (const chunk of chunks) {
    input.write(chunk);
  }
  input.end();
  return result;
}

interface FakeTerminalHarness {
  readonly port: SetupProtectedTerminalPort;
  readonly requests: SetupProtectedTerminalCaptureRequest[];
  readonly confirmations: SetupProtectedTerminalConfirmationRequest[];
  readonly restorations: string[];
}

function fakeProtectedTerminal(
  result:
    | SetupProtectedTerminalCaptureResult
    | (() => Promise<SetupProtectedTerminalCaptureResult>),
): FakeTerminalHarness {
  const requests: SetupProtectedTerminalCaptureRequest[] = [];
  const confirmations: SetupProtectedTerminalConfirmationRequest[] = [];
  const restorations: string[] = [];
  return Object.freeze({
    requests,
    confirmations,
    restorations,
    port: Object.freeze({
      async captureCredential(
        request: SetupProtectedTerminalCaptureRequest,
      ): Promise<SetupProtectedTerminalCaptureResult> {
        requests.push(request);
        return typeof result === "function" ? result() : result;
      },
      async confirmExactPlan(
        request: SetupProtectedTerminalConfirmationRequest,
      ) {
        confirmations.push(request);
        request.output.write(request.prompt);
        return "confirmed" as const;
      },
      restore(
        reason:
          | "cancelled"
          | "interrupted"
          | "timed-out"
          | "completed",
      ) {
        restorations.push(reason);
        return "restored" as const;
      },
    }),
  });
}

describe("explicit setup credential stdin", () => {
  it.each([
    ["bare EOF", ""],
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("accepts one key with %s only after clean EOF", async (_label, terminator) => {
    const source = ENCODER.encode(`${KEY}${terminator}`);
    const result = await explicitCapture([source]);

    expect(result.status).toBe("accepted");
    expect(source.every((byte) => byte === 0)).toBe(true);
    if (result.status === "accepted") {
      expect(claimText(result.credential)).toBe(KEY);
    }
  });

  it("accepts every one-byte chunk split without building a string", async () => {
    const chunks = [...ENCODER.encode(`${KEY}\r\n`)].map(
      (byte) => new Uint8Array([byte]),
    );
    const result = await explicitCapture(chunks);

    expect(result.status).toBe("accepted");
    expect(chunks.every((chunk) => chunk[0] === 0)).toBe(true);
    if (result.status === "accepted") {
      expect(claimText(result.credential)).toBe(KEY);
    }
  });

  it("accepts the exact 212-byte transport boundary", async () => {
    const maximumKey = `plrm_live_${"a".repeat(200)}`;
    const transport = ENCODER.encode(`${maximumKey}\r\n`);
    expect(transport.byteLength).toBe(SETUP_CREDENTIAL_INPUT_MAX_BYTES);

    const result = await explicitCapture([transport]);
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") {
      expect(claimText(result.credential)).toBe(maximumKey);
    }
  });

  it("keeps wiping oversized input through EOF before returning invalid", async () => {
    const input = terminalStream(false);
    const attempt = createNodeSetupExplicitCredentialInput(
      input,
      EXPLICIT_OPTIONS,
    );
    let settled = false;
    const capture = attempt.capture();
    void capture.then(() => {
      settled = true;
    });
    await waitForReader(input);
    const first = new Uint8Array(SETUP_CREDENTIAL_INPUT_MAX_BYTES);
    first.fill(0x61);
    const overflow = new Uint8Array([0x62]);
    const trailing = ENCODER.encode(CANARY);

    input.write(first);
    input.write(overflow);
    input.write(trailing);
    await nextIoTurn();
    expect(settled).toBe(false);
    expect(first.every((byte) => byte === 0)).toBe(true);
    expect(overflow[0]).toBe(0);
    expect(trailing.every((byte) => byte === 0)).toBe(true);

    input.end();
    expect((await capture).status).toBe("invalid");
  });

  it("withholds provisional success until EOF and rejects delayed trailing data", async () => {
    const input = terminalStream(false);
    const attempt = createNodeSetupExplicitCredentialInput(
      input,
      EXPLICIT_OPTIONS,
    );
    let settled = false;
    const capture = attempt.capture();
    void capture.then(() => {
      settled = true;
    });
    await waitForReader(input);

    input.write(ENCODER.encode(`${KEY}\n`));
    await nextIoTurn();
    expect(settled).toBe(false);
    input.end(ENCODER.encode("yes\n"));

    expect((await capture).status).toBe("invalid");
  });

  it.each([
    ["empty", ""],
    ["leading space", ` ${KEY}`],
    ["trailing space", `${KEY} `],
    ["second line", `${KEY}\nyes\n`],
    ["double newline", `${KEY}\n\n`],
    ["bare carriage return", `${KEY}\r`],
    ["NUL", `${KEY}\0`],
    ["non-ASCII", `${KEY}é`],
    ["environment assignment", `PLURUM_API_KEY=${KEY}`],
  ])("rejects %s input with a fixed result", async (_label, value) => {
    expect(
      (await explicitCapture([ENCODER.encode(value)])).status,
    ).toBe("invalid");
  });

  it("rejects TTY stdin without attaching a reader or consuming buffered data", async () => {
    const input = terminalStream(true);
    const attempt = createNodeSetupExplicitCredentialInput(
      input,
      EXPLICIT_OPTIONS,
    );
    input.write(ENCODER.encode(KEY));

    expect((await attempt.capture()).status).toBe("unavailable");
    expect(input.listenerCount("data")).toBe(0);
    expect(input.readableLength).toBe(KEY.length);
  });

  it("rejects a stream that already creates immutable strings", async () => {
    const input = terminalStream(false);
    input.setEncoding("utf8");
    const attempt = createNodeSetupExplicitCredentialInput(
      input,
      EXPLICIT_OPTIONS,
    );

    expect((await attempt.capture()).status).toBe("unavailable");
    expect(input.listenerCount("data")).toBe(0);
  });

  it("rejects listener meta-hooks before they can intercept credential readers", async () => {
    const input = terminalStream(false);
    const intercepted: unknown[] = [];
    const intercept = (event: string): void => {
      intercepted.push(event);
    };
    input.on("newListener", intercept);
    const attempt = createNodeSetupExplicitCredentialInput(
      input,
      EXPLICIT_OPTIONS,
    );

    expect((await attempt.capture()).status).toBe("unavailable");
    expect(input.listenerCount("data")).toBe(0);
    expect(intercepted).toEqual([]);
    input.off("newListener", intercept);
  });

  it("requires the exact --api-key-stdin --yes mode before reading", async () => {
    const input = terminalStream(false);
    const options: SetupApplyOptions = Object.freeze({
      client: "all",
      apiKeyStdin: false,
      dryRun: false,
      yes: true,
    });
    const attempt = createNodeSetupExplicitCredentialInput(input, options);
    input.write(ENCODER.encode(KEY));

    expect((await attempt.capture()).status).toBe("unavailable");
    expect(input.listenerCount("data")).toBe(0);
    expect(input.readableLength).toBe(KEY.length);
  });

  it("restores a fixed timeout result through synchronous cancellation", async () => {
    const input = terminalStream(false);
    const attempt = createNodeSetupExplicitCredentialInput(
      input,
      EXPLICIT_OPTIONS,
    );
    const capture = attempt.capture();
    await waitForReader(input);

    expect(attempt.cancel("timed-out")).toEqual({
      status: "cancelled",
    });
    expect((await capture).status).toBe("timed-out");
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("error")).toBe(0);
    expect(input.listenerCount("close")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
  });

  it("cancels before the first microtask without ever attaching a stdin reader", async () => {
    const input = terminalStream(false);
    const attempt = createNodeSetupExplicitCredentialInput(
      input,
      EXPLICIT_OPTIONS,
    );

    const capture = attempt.capture();
    expect(attempt.cancel()).toEqual({ status: "cancelled" });
    expect(await capture).toEqual({ status: "cancelled" });
    await nextIoTurn();

    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    expect(input.listenerCount("error")).toBe(0);
    expect(input.listenerCount("close")).toBe(0);
    expect(input.readableFlowing).not.toBe(true);
    expect(input.readableDidRead).not.toBe(true);
  });

  it("burns concurrent and replayed capture attempts", async () => {
    const input = terminalStream(false);
    const attempt = createNodeSetupExplicitCredentialInput(
      input,
      EXPLICIT_OPTIONS,
    );
    const first = attempt.capture();
    await waitForReader(input);

    expect((await attempt.capture()).status).toBe("unavailable");
    input.end(ENCODER.encode(KEY));
    const result = await first;
    expect(result.status).toBe("accepted");
    expect((await attempt.capture()).status).toBe("unavailable");
    if (result.status === "accepted") {
      discardSetupCredentialInput(result.credential);
    }
  });

  it("contains stream errors and never reflects their message", async () => {
    const input = terminalStream(false);
    const attempt = createNodeSetupExplicitCredentialInput(
      input,
      EXPLICIT_OPTIONS,
    );
    const capture = attempt.capture();
    await waitForReader(input);

    input.emit("error", new Error(CANARY));
    const result = await capture;
    expect(result.status).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });
});

describe("protected interactive setup credential session", () => {
  it("orchestrates the native capture/restore/confirmation contract sequentially", async () => {
    const input = terminalStream(true);
    const output = outputHarness();
    const framedBytes = ENCODER.encode(`${KEY}\n`);
    const terminal = fakeProtectedTerminal(
      Object.freeze({ status: "captured", bytes: framedBytes }),
    );
    const session = createNodeSetupProtectedInteractiveSession(
      input,
      output.stream,
      terminal.port,
    );

    const capture = await session.credentialInput.capture();
    expect(capture.status).toBe("accepted");
    expect(framedBytes.every((byte) => byte === 0)).toBe(true);
    expect(terminal.requests).toHaveLength(1);
    expect(terminal.requests[0]).toEqual({
      input,
      output: output.stream,
      prompt: SETUP_CREDENTIAL_INPUT_PROMPT,
      maxInputBytes: SETUP_CREDENTIAL_INPUT_MAX_BYTES,
    });

    expect(await session.presenter.presentPlan(PLAN)).toBe("presented");
    expect(await session.confirmation.confirm()).toBe("confirmed");
    await waitForOutput(output, `${PLAN}${SETUP_CONFIRMATION_PROMPT}`);
    expect(output.text()).toBe(`${PLAN}${SETUP_CONFIRMATION_PROMPT}`);
    expect(terminal.confirmations).toEqual([
      {
        input,
        output: output.stream,
        prompt: SETUP_CONFIRMATION_PROMPT,
        maxInputBytes: SETUP_EXACT_CONFIRMATION_MAX_BYTES,
      },
    ]);
    expect(terminal.restorations).toEqual(["completed", "completed"]);
    if (capture.status === "accepted") {
      expect(claimText(capture.credential)).toBe(KEY);
    }
  });

  it("burns the session when plan presentation is attempted before key capture", async () => {
    const input = terminalStream(true);
    const output = outputHarness();
    const terminal = fakeProtectedTerminal(
      Object.freeze({
        status: "captured",
        bytes: ENCODER.encode(`${KEY}\n`),
      }),
    );
    const session = createNodeSetupProtectedInteractiveSession(
      input,
      output.stream,
      terminal.port,
    );

    expect(await session.presenter.presentPlan(PLAN)).toBe("unavailable");
    expect((await session.credentialInput.capture()).status).toBe(
      "unavailable",
    );
    expect(terminal.requests).toEqual([]);
    expect(output.text()).toBe("");
  });

  it("rejects stale bytes after restoration before printing the plan", async () => {
    const input = terminalStream(true);
    const output = outputHarness();
    const terminal = fakeProtectedTerminal(
      Object.freeze({
        status: "captured",
        bytes: ENCODER.encode(`${KEY}\n`),
      }),
    );
    const session = createNodeSetupProtectedInteractiveSession(
      input,
      output.stream,
      terminal.port,
    );
    const capture = await session.credentialInput.capture();
    expect(capture.status).toBe("accepted");
    input.write(ENCODER.encode("yes\n"));

    expect(await session.presenter.presentPlan(PLAN)).toBe("unavailable");
    expect(output.text()).toBe("");
    if (capture.status === "accepted") {
      expect(
        claimSetupCredentialInputBytes(capture.credential),
      ).toBeUndefined();
    }
  });

  it("discards captured material when confirmation is declined", async () => {
    const input = terminalStream(true);
    const output = outputHarness();
    const requests: SetupProtectedTerminalCaptureRequest[] = [];
    const terminal: SetupProtectedTerminalPort = Object.freeze({
      async captureCredential(
        request: SetupProtectedTerminalCaptureRequest,
      ) {
        requests.push(request);
        return Object.freeze({
          status: "captured" as const,
          bytes: ENCODER.encode(`${KEY}\n`),
        });
      },
      async confirmExactPlan(
        request: SetupProtectedTerminalConfirmationRequest,
      ) {
        request.output.write(request.prompt);
        return "declined" as const;
      },
      restore() {
        return "restored" as const;
      },
    });
    const session = createNodeSetupProtectedInteractiveSession(
      input,
      output.stream,
      terminal,
    );
    const capture = await session.credentialInput.capture();
    expect(await session.presenter.presentPlan(PLAN)).toBe("presented");
    expect(await session.confirmation.confirm()).toBe("declined");
    expect(requests).toHaveLength(1);
    if (capture.status === "accepted") {
      expect(
        claimSetupCredentialInputBytes(capture.credential),
      ).toBeUndefined();
    }
  });

  it("calls the exact restoration boundary when interrupted while capture is pending", async () => {
    let resolveCapture:
      | ((result: SetupProtectedTerminalCaptureResult) => void)
      | undefined;
    const pending = new Promise<SetupProtectedTerminalCaptureResult>(
      (resolve) => {
        resolveCapture = resolve;
      },
    );
    const terminal = fakeProtectedTerminal(() => pending);
    const input = terminalStream(true);
    const output = outputHarness();
    const session = createNodeSetupProtectedInteractiveSession(
      input,
      output.stream,
      terminal.port,
    );
    const capture = session.credentialInput.capture();
    await nextIoTurn();

    expect(session.credentialInput.cancel("interrupted")).toEqual({
      status: "cancelled",
    });
    expect(await capture).toEqual({ status: "interrupted" });
    expect(terminal.restorations).toEqual(["interrupted"]);

    const lateBytes = ENCODER.encode(`${KEY}\n`);
    resolveCapture?.(Object.freeze({
      status: "captured",
      bytes: lateBytes,
    }));
    await nextIoTurn();
    await nextIoTurn();
    expect(lateBytes.every((byte) => byte === 0)).toBe(true);
    expect(terminal.restorations).toEqual([
      "interrupted",
      "completed",
    ]);
  });

  it("cancels and quiesces a pending native confirmation", async () => {
    let resolveConfirmation:
      | ((result: "confirmed") => void)
      | undefined;
    const pendingConfirmation = new Promise<"confirmed">((resolve) => {
      resolveConfirmation = resolve;
    });
    const restorations: string[] = [];
    const terminal: SetupProtectedTerminalPort = Object.freeze({
      async captureCredential() {
        return Object.freeze({
          status: "captured" as const,
          bytes: ENCODER.encode(`${KEY}\n`),
        });
      },
      async confirmExactPlan() {
        return pendingConfirmation;
      },
      restore(
        reason:
          | "cancelled"
          | "interrupted"
          | "timed-out"
          | "completed",
      ) {
        restorations.push(reason);
        return "restored" as const;
      },
    });
    const input = terminalStream(true);
    const output = outputHarness();
    const session = createNodeSetupProtectedInteractiveSession(
      input,
      output.stream,
      terminal,
    );
    expect((await session.credentialInput.capture()).status).toBe(
      "accepted",
    );
    expect(await session.presenter.presentPlan(PLAN)).toBe("presented");
    const confirmation = session.confirmation.confirm();
    await nextIoTurn();

    expect(session.credentialInput.cancel("interrupted")).toEqual({
      status: "discarded",
    });
    resolveConfirmation?.("confirmed");
    expect(await confirmation).toBe("unavailable");
    expect(restorations).toContain("interrupted");
  });

  it("restores after a native capture error instead of trusting the throw path", async () => {
    let echoDisabled = false;
    const restorations: string[] = [];
    const terminal: SetupProtectedTerminalPort = Object.freeze({
      async captureCredential() {
        echoDisabled = true;
        throw new Error(CANARY);
      },
      async confirmExactPlan() {
        return "unavailable" as const;
      },
      restore(
        reason:
          | "cancelled"
          | "interrupted"
          | "timed-out"
          | "completed",
      ) {
        restorations.push(reason);
        echoDisabled = false;
        return "restored" as const;
      },
    });
    const session = createNodeSetupProtectedInteractiveSession(
      terminalStream(true),
      outputHarness().stream,
      terminal,
    );

    expect(await session.credentialInput.capture()).toEqual({
      status: "unavailable",
    });
    expect(echoDisabled).toBe(false);
    expect(restorations).toEqual(["cancelled"]);
  });

  it("rejects equal-count listener substitution after native capture", async () => {
    const input = terminalStream(true);
    const output = outputHarness();
    const original = (): void => undefined;
    const replacement = (): void => undefined;
    input.on("error", original);
    const bytes = ENCODER.encode(`${KEY}\n`);
    const terminal: SetupProtectedTerminalPort = Object.freeze({
      async captureCredential(
        request: SetupProtectedTerminalCaptureRequest,
      ) {
        request.input.off("error", original);
        request.input.on("error", replacement);
        return Object.freeze({ status: "captured" as const, bytes });
      },
      async confirmExactPlan() {
        return "unavailable" as const;
      },
      restore() {
        return "restored" as const;
      },
    });
    const session = createNodeSetupProtectedInteractiveSession(
      input,
      output.stream,
      terminal,
    );

    expect(await session.credentialInput.capture()).toEqual({
      status: "unavailable",
    });
    expect(bytes.every((byte) => byte === 0)).toBe(true);
    input.off("error", replacement);
  });

  it("refuses a reused terminal port before any protected input", async () => {
    const terminal = fakeProtectedTerminal(
      Object.freeze({
        status: "captured",
        bytes: ENCODER.encode(`${KEY}\n`),
      }),
    );
    const first = createNodeSetupProtectedInteractiveSession(
      terminalStream(true),
      outputHarness().stream,
      terminal.port,
    );
    const second = createNodeSetupProtectedInteractiveSession(
      terminalStream(true),
      outputHarness().stream,
      terminal.port,
    );

    expect((await first.credentialInput.capture()).status).toBe(
      "accepted",
    );
    expect((await second.credentialInput.capture()).status).toBe(
      "unavailable",
    );
    expect(terminal.requests).toHaveLength(1);
  });

  it("refuses distinct ports that try to claim the same terminal streams", async () => {
    const input = terminalStream(true);
    const output = outputHarness();
    const firstTerminal = fakeProtectedTerminal(
      Object.freeze({
        status: "captured",
        bytes: ENCODER.encode(`${KEY}\n`),
      }),
    );
    const secondTerminal = fakeProtectedTerminal(
      Object.freeze({
        status: "captured",
        bytes: ENCODER.encode(`${KEY}\n`),
      }),
    );
    const first = createNodeSetupProtectedInteractiveSession(
      input,
      output.stream,
      firstTerminal.port,
    );
    const second = createNodeSetupProtectedInteractiveSession(
      input,
      output.stream,
      secondTerminal.port,
    );

    expect((await first.credentialInput.capture()).status).toBe(
      "accepted",
    );
    expect((await second.credentialInput.capture()).status).toBe(
      "unavailable",
    );
    expect(firstTerminal.requests).toHaveLength(1);
    expect(secondTerminal.requests).toHaveLength(0);
  });

  it.each([
    [false, true],
    [true, false],
    [false, false],
  ])("requires TTY input/output before invoking the native port (%s/%s)", async (inputTty, outputTty) => {
    const input = terminalStream(inputTty);
    const output = outputHarness(outputTty);
    const terminal = fakeProtectedTerminal(
      Object.freeze({
        status: "captured",
        bytes: ENCODER.encode(`${KEY}\n`),
      }),
    );
    const session = createNodeSetupProtectedInteractiveSession(
      input,
      output.stream,
      terminal.port,
    );

    expect((await session.credentialInput.capture()).status).toBe(
      "unavailable",
    );
    expect(terminal.requests).toEqual([]);
  });

  it("contains native-port errors without reflecting credential canaries", async () => {
    const terminal = fakeProtectedTerminal(async () => {
      throw new Error(CANARY);
    });
    const session = createNodeSetupProtectedInteractiveSession(
      terminalStream(true),
      outputHarness().stream,
      terminal.port,
    );

    const result = await session.credentialInput.capture();
    expect(result).toEqual({ status: "unavailable" });
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });
});
