import { PassThrough, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  createNodeSetupInteractiveSession,
  createNodeSetupPlanPresenter,
  type SetupTerminalInput,
  type SetupTerminalOutput,
} from "../src/adapters/node/setup-interaction.js";
import { SETUP_CONFIRMATION_PROMPT } from "../src/commands/setup-confirmation.js";

const PLAN = [
  "Plurum setup plan",
  "",
  "readiness: ready",
  "confirmation: required before any change",
  "No changes have been made.",
  "",
].join("\n");
const CANARY = "plrm_live_SETUP_INTERACTION_CANARY_DO_NOT_PRINT";
const MAX_PLAN_OUTPUT_BYTES = 256 * 1024;

type TerminalPassThrough = PassThrough & {
  readonly isTTY?: boolean;
};

interface OutputHarness {
  readonly stream: TerminalPassThrough;
  text(): string;
}

type WriteCallback = (error?: Error | null) => void;

interface ControlledOutputHarness {
  readonly stream: SetupTerminalOutput;
  readonly writes: readonly string[];
  pendingWrites(): number;
  flushNext(error?: Error): void;
}

function terminalStream(isTTY = true): TerminalPassThrough {
  const stream = new PassThrough() as TerminalPassThrough;
  Object.defineProperty(stream, "isTTY", {
    configurable: false,
    enumerable: true,
    value: isTTY,
    writable: false,
  });
  return stream;
}

function outputHarness(isTTY = true): OutputHarness {
  const stream = terminalStream(isTTY);
  const chunks: string[] = [];
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => chunks.push(chunk));
  return {
    stream,
    text: () => chunks.join(""),
  };
}

function controlledOutput(isTTY = true): ControlledOutputHarness {
  const stream = terminalStream(isTTY);
  const writes: string[] = [];
  const callbacks: WriteCallback[] = [];

  Object.defineProperty(stream, "write", {
    configurable: false,
    enumerable: false,
    value(
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | WriteCallback,
      callback?: WriteCallback,
    ): boolean {
      writes.push(
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk).toString("utf8"),
      );
      const completed =
        typeof encodingOrCallback === "function"
          ? encodingOrCallback
          : callback;
      if (completed !== undefined) {
        callbacks.push(completed);
      }
      return true;
    },
    writable: false,
  });

  return {
    stream,
    writes,
    pendingWrites: () => callbacks.length,
    flushNext(error?: Error): void {
      const callback = callbacks.shift();
      if (callback === undefined) {
        throw new Error("expected a pending output callback");
      }
      callback(error);
    },
  };
}

function throwingOutput(error: Error): SetupTerminalOutput {
  const stream = terminalStream(true);
  Object.defineProperty(stream, "write", {
    configurable: false,
    enumerable: false,
    value(): boolean {
      throw error;
    },
    writable: false,
  });
  return stream;
}

function callbackThenThrowOutput(error: Error): SetupTerminalOutput {
  const stream = terminalStream(true);
  Object.defineProperty(stream, "write", {
    configurable: false,
    enumerable: false,
    value(
      _chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | WriteCallback,
      callback?: WriteCallback,
    ): boolean {
      const completed =
        typeof encodingOrCallback === "function"
          ? encodingOrCallback
          : callback;
      completed?.();
      throw error;
    },
    writable: false,
  });
  return stream;
}

function callbackThenDestroyOutput(error: Error): SetupTerminalOutput {
  let stream: Writable;
  stream = new Writable({
    write(_chunk, _encoding, callback): void {
      callback();
      stream.destroy(error);
    },
  });
  Object.defineProperty(stream, "isTTY", {
    configurable: false,
    enumerable: true,
    value: true,
    writable: false,
  });
  return stream;
}

async function nextIoTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForText(
  output: OutputHarness,
  expected: string,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (output.text() === expected) {
      return;
    }
    await nextIoTurn();
  }
  throw new Error("expected output was not written");
}

async function waitForConfirmationReader(
  input: SetupTerminalInput,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
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
  throw new Error("confirmation reader was not attached");
}

async function presentedInteraction(options?: {
  readonly inputTty?: boolean;
  readonly outputTty?: boolean;
  readonly stringInput?: boolean;
}): Promise<Readonly<{
  input: TerminalPassThrough;
  output: OutputHarness;
  session: ReturnType<typeof createNodeSetupInteractiveSession>;
}>> {
  const input = terminalStream(options?.inputTty ?? true);
  if (options?.stringInput === true) {
    input.setEncoding("utf8");
  }
  const output = outputHarness(options?.outputTty ?? true);
  const session = createNodeSetupInteractiveSession(input, output.stream);
  expect(await session.presenter.presentPlan(PLAN)).toBe("presented");
  expect(output.text()).toBe(PLAN);
  return { input, output, session };
}

async function confirmWith(
  response: string | Uint8Array,
  options?: { readonly stringInput?: boolean },
): Promise<Readonly<{
  decision: Awaited<ReturnType<
    ReturnType<
      typeof createNodeSetupInteractiveSession
    >["confirmation"]["confirm"]
  >>;
  output: string;
}>> {
  const fixture = await presentedInteraction(options);
  const decision = fixture.session.confirmation.confirm();
  await waitForText(
    fixture.output,
    `${PLAN}${SETUP_CONFIRMATION_PROMPT}`,
  );
  await waitForConfirmationReader(fixture.input);
  fixture.input.end(response);
  return {
    decision: await decision,
    output: fixture.output.text(),
  };
}

describe("Node setup interaction adapter", () => {
  it("writes the exact plan once and resolves only after its write callback flushes", async () => {
    const output = controlledOutput(true);
    const presenter = createNodeSetupPlanPresenter(output.stream);
    let settled = false;

    const presentation = presenter.presentPlan(PLAN);
    void presentation.then(() => {
      settled = true;
    });

    expect(output.writes).toEqual([PLAN]);
    expect(output.pendingWrites()).toBe(1);
    await Promise.resolve();
    expect(settled).toBe(false);

    output.flushNext();
    expect(await presentation).toBe("presented");
    expect(settled).toBe(true);
    expect(output.writes.join("")).toBe(PLAN);
  });

  it("writes the fixed prompt only after the plan flushes and reads only after the prompt flushes", async () => {
    const input = terminalStream(true);
    const output = controlledOutput(true);
    const session = createNodeSetupInteractiveSession(
      input,
      output.stream,
    );

    const presentation = session.presenter.presentPlan(PLAN);
    expect(output.writes).toEqual([PLAN]);
    expect(input.listenerCount("data")).toBe(0);
    output.flushNext();
    expect(await presentation).toBe("presented");

    const confirmation = session.confirmation.confirm();
    expect(output.writes).toEqual([PLAN, SETUP_CONFIRMATION_PROMPT]);
    expect(output.pendingWrites()).toBe(1);
    expect(input.listenerCount("data")).toBe(0);

    output.flushNext();
    await waitForConfirmationReader(input);
    input.end("yes\n");
    expect(await confirmation).toBe("confirmed");
    expect(output.writes.join("")).toBe(
      `${PLAN}${SETUP_CONFIRMATION_PROMPT}`,
    );
    expect(input.listenerCount("data")).toBe(0);
  });

  it("rejects confirmation bytes buffered before the prompt finishes", async () => {
    const input = terminalStream(true);
    const output = controlledOutput(true);
    const session = createNodeSetupInteractiveSession(
      input,
      output.stream,
    );
    const presentation = session.presenter.presentPlan(PLAN);
    output.flushNext();
    expect(await presentation).toBe("presented");

    const confirmation = session.confirmation.confirm();
    input.write("yes\n");
    expect(input.readableLength).toBe(4);
    expect(input.listenerCount("data")).toBe(0);
    output.flushNext();

    expect(await confirmation).toBe("unavailable");
    expect(input.listenerCount("data")).toBe(0);
    expect(input.read()?.toString("utf8")).toBe("yes\n");
  });

  it.each([
    [false, true],
    [true, false],
    [false, false],
  ])(
    "requires true input/output TTY state (%s/%s) without reading input",
    async (inputTty, outputTty) => {
      const fixture = await presentedInteraction({ inputTty, outputTty });
      fixture.input.write("yes\n");

      expect(await fixture.session.confirmation.confirm()).toBe(
        "unavailable",
      );
      expect(fixture.output.text()).toBe(PLAN);
      expect(fixture.input.listenerCount("data")).toBe(0);
      expect(fixture.input.read()?.toString("utf8")).toBe("yes\n");
    },
  );

  it.each([
    ["LF", "yes\n"],
    ["CRLF", "yes\r\n"],
  ])("accepts exact lowercase ASCII yes with %s", async (_label, answer) => {
    const result = await confirmWith(answer);

    expect(result.decision).toBe("confirmed");
    expect(result.output).toBe(`${PLAN}${SETUP_CONFIRMATION_PROMPT}`);
  });

  it.each([
    ["empty", "\n"],
    ["no", "no\n"],
    ["other printable response", "maybe\n"],
    ["uppercase initial", "Yes\n"],
    ["uppercase", "YES\n"],
    ["leading space", " yes\n"],
    ["trailing space", "yes \n"],
    ["single y", "y\n"],
  ])("declines %s without broadening the accepted grammar", async (_label, answer) => {
    const result = await confirmWith(answer);

    expect(result.decision).toBe("declined");
    expect(result.output).toBe(`${PLAN}${SETUP_CONFIRMATION_PROMPT}`);
  });

  it.each([
    ["NUL", new Uint8Array([0x00, 0x0a])],
    ["escape", new Uint8Array([0x1b, 0x0a])],
    ["tab", new Uint8Array([0x09, 0x0a])],
    ["delete", new Uint8Array([0x7f, 0x0a])],
    ["non-ASCII UTF-8", Buffer.from("é\n", "utf8")],
    ["Unicode lookalike", Buffer.from("ｙｅｓ\n", "utf8")],
  ] as const)("rejects %s input as unavailable", async (_label, answer) => {
    const result = await confirmWith(answer);

    expect(result.decision).toBe("unavailable");
    expect(result.output).toBe(`${PLAN}${SETUP_CONFIRMATION_PROMPT}`);
  });

  it("contains a hostile proxied typed-array chunk without reflecting its error", async () => {
    const fixture = await presentedInteraction();
    const confirmation = fixture.session.confirmation.confirm();
    await waitForText(
      fixture.output,
      `${PLAN}${SETUP_CONFIRMATION_PROMPT}`,
    );
    await waitForConfirmationReader(fixture.input);
    let traps = 0;
    const hostile = new Proxy(
      new Uint8Array([0x79, 0x65, 0x73, 0x0a]),
      {
        get() {
          traps += 1;
          throw new Error(CANARY);
        },
      },
    );

    fixture.input.emit("data", hostile);

    expect(await confirmation).toBe("unavailable");
    expect(traps).toBeGreaterThan(0);
    expect(fixture.output.text()).toBe(
      `${PLAN}${SETUP_CONFIRMATION_PROMPT}`,
    );
    expect(fixture.output.text()).not.toContain(CANARY);
  });

  it("enforces the sixteen-byte input bound before accepting a terminator", async () => {
    const within = await confirmWith(`${"a".repeat(15)}\n`);
    const overflow = await confirmWith(`${"a".repeat(16)}\n`);

    expect(within.decision).toBe("declined");
    expect(overflow.decision).toBe("unavailable");
  });

  it.each([
    ["empty EOF", ""],
    ["yes at EOF", "yes"],
    ["bare carriage return", "yes\r"],
    ["maximum unterminated input", "a".repeat(16)],
  ])("rejects %s before a complete line", async (_label, answer) => {
    const result = await confirmWith(answer);

    expect(result.decision).toBe("unavailable");
  });

  it.each([
    ["second line", "yes\nno\n"],
    ["empty second line", "yes\n\n"],
    ["trailing byte", "yes\nx"],
    ["trailing carriage return", "yes\n\r"],
  ])("rejects %s in the same input chunk", async (_label, answer) => {
    const result = await confirmWith(answer);

    expect(result.decision).toBe("unavailable");
  });

  it("accepts LF and CRLF split across bounded string chunks", async () => {
    for (const chunks of [
      ["y", "e", "s", "\n"],
      ["ye", "s\r", "\n"],
    ]) {
      const fixture = await presentedInteraction({ stringInput: true });
      const confirmation = fixture.session.confirmation.confirm();
      await waitForText(
        fixture.output,
        `${PLAN}${SETUP_CONFIRMATION_PROMPT}`,
      );
      await waitForConfirmationReader(fixture.input);
      for (const chunk of chunks) {
        fixture.input.write(chunk);
      }

      expect(await confirmation).toBe("confirmed");
      expect(fixture.input.listenerCount("data")).toBe(0);
    }
  });

  it("rejects a second input chunk delivered during the bounded decision checkpoint", async () => {
    const fixture = await presentedInteraction({ stringInput: true });
    const confirmation = fixture.session.confirmation.confirm();
    await waitForText(
      fixture.output,
      `${PLAN}${SETUP_CONFIRMATION_PROMPT}`,
    );
    await waitForConfirmationReader(fixture.input);

    fixture.input.write("yes\n");
    fixture.input.write("no\n");

    expect(await confirmation).toBe("unavailable");
  });

  it("rejects a non-LF byte after a split carriage return", async () => {
    const fixture = await presentedInteraction({ stringInput: true });
    const confirmation = fixture.session.confirmation.confirm();
    await waitForText(
      fixture.output,
      `${PLAN}${SETUP_CONFIRMATION_PROMPT}`,
    );
    await waitForConfirmationReader(fixture.input);
    fixture.input.write("yes\r");
    fixture.input.write("x\n");

    expect(await confirmation).toBe("unavailable");
  });

  it.each(["error", "close"] as const)(
    "fails closed when plan output emits %s before flushing",
    async (event) => {
      const output = controlledOutput(true);
      const presenter = createNodeSetupPlanPresenter(output.stream);
      const presentation = presenter.presentPlan(PLAN);

      if (event === "error") {
        output.stream.emit("error", new Error(CANARY));
      } else {
        output.stream.emit("close");
      }

      expect(await presentation).toBe("unavailable");
      expect(output.writes.join("")).toBe(PLAN);
      expect(output.writes.join("")).not.toContain(CANARY);
    },
  );

  it("keeps the output error guard active through repeated checkpoint errors", async () => {
    const output = controlledOutput(true);
    const presenter = createNodeSetupPlanPresenter(output.stream);
    const presentation = presenter.presentPlan(PLAN);

    output.stream.emit("error", new Error(CANARY));
    expect(output.stream.listenerCount("error")).toBe(1);
    output.stream.emit("error", new Error(CANARY));

    expect(await presentation).toBe("unavailable");
    expect(output.stream.listenerCount("error")).toBe(0);
    expect(output.stream.listenerCount("close")).toBe(0);
  });

  it("fails closed when an output write throws or its callback reports an error", async () => {
    const thrown = createNodeSetupPlanPresenter(
      throwingOutput(new Error(CANARY)),
    );
    expect(await thrown.presentPlan(PLAN)).toBe("unavailable");

    const callbackOutput = controlledOutput(true);
    const callback = createNodeSetupPlanPresenter(callbackOutput.stream);
    const pending = callback.presentPlan(PLAN);
    callbackOutput.flushNext(new Error(CANARY));
    expect(await pending).toBe("unavailable");
    expect(callbackOutput.writes.join("")).not.toContain(CANARY);
  });

  it("fails closed when a hostile write calls back successfully and then throws", async () => {
    const output = callbackThenThrowOutput(new Error(CANARY));
    const presenter = createNodeSetupPlanPresenter(output);

    expect(await presenter.presentPlan(PLAN)).toBe("unavailable");
    expect(output.listenerCount("error")).toBe(0);
    expect(output.listenerCount("close")).toBe(0);
  });

  it("fails closed when a Writable reports success and then destroys itself with an error", async () => {
    const output = callbackThenDestroyOutput(new Error(CANARY));
    const presenter = createNodeSetupPlanPresenter(output);

    expect(await presenter.presentPlan(PLAN)).toBe("unavailable");
    expect(output.listenerCount("error")).toBe(0);
    expect(output.listenerCount("close")).toBe(0);
  });

  it("never reports presentation success when listener cleanup fails", async () => {
    const output = terminalStream(true);
    Object.defineProperty(output, "off", {
      configurable: false,
      enumerable: false,
      value(): never {
        throw new Error(CANARY);
      },
      writable: false,
    });
    const presenter = createNodeSetupPlanPresenter(output);

    expect(await presenter.presentPlan(PLAN)).toBe("unavailable");
  });

  it.each([
    "close-callback-error-error",
    "close-error-callback-error",
  ] as const)(
    "keeps output errors handled for the controlled %s ordering",
    async (ordering) => {
      const output = controlledOutput(true);
      const presenter = createNodeSetupPlanPresenter(output.stream);
      const presentation = presenter.presentPlan(PLAN);
      const failure = new Error(CANARY);

      output.stream.emit("close");
      expect(output.stream.listenerCount("error")).toBe(1);
      if (ordering === "close-callback-error-error") {
        output.flushNext(failure);
        expect(output.stream.listenerCount("error")).toBe(1);
        output.stream.emit("error", failure);
      } else {
        output.stream.emit("error", failure);
        expect(output.stream.listenerCount("error")).toBe(1);
        output.flushNext(failure);
      }

      expect(await presentation).toBe("unavailable");
      expect(output.stream.listenerCount("error")).toBe(0);
      expect(output.stream.listenerCount("close")).toBe(0);
      expect(output.writes.join("")).toBe(PLAN);
      expect(output.writes.join("")).not.toContain(CANARY);
    },
  );

  it.each(["error", "close"] as const)(
    "fails closed when prompt output emits %s and never reads input",
    async (event) => {
      const input = terminalStream(true);
      const output = controlledOutput(true);
      const session = createNodeSetupInteractiveSession(
        input,
        output.stream,
      );
      const presentation = session.presenter.presentPlan(PLAN);
      output.flushNext();
      expect(await presentation).toBe("presented");

      input.write("yes\n");
      const confirmation = session.confirmation.confirm();
      expect(output.writes).toEqual([PLAN, SETUP_CONFIRMATION_PROMPT]);
      expect(input.listenerCount("data")).toBe(0);
      if (event === "error") {
        output.stream.emit("error", new Error(CANARY));
      } else {
        output.stream.emit("close");
      }

      expect(await confirmation).toBe("unavailable");
      expect(input.listenerCount("data")).toBe(0);
      expect(input.read()?.toString("utf8")).toBe("yes\n");
      expect(output.writes.join("")).not.toContain(CANARY);
    },
  );

  it.each(["error", "close", "end"] as const)(
    "fails closed when confirmation input emits %s",
    async (event) => {
      const fixture = await presentedInteraction();
      const confirmation = fixture.session.confirmation.confirm();
      await waitForText(
        fixture.output,
        `${PLAN}${SETUP_CONFIRMATION_PROMPT}`,
      );
      await waitForConfirmationReader(fixture.input);

      if (event === "error") {
        fixture.input.emit("error", new Error(CANARY));
      } else if (event === "close") {
        fixture.input.emit("close");
      } else {
        fixture.input.end();
      }

      expect(await confirmation).toBe("unavailable");
      expect(fixture.input.listenerCount("data")).toBe(0);
      expect(fixture.input.listenerCount("end")).toBe(0);
      expect(fixture.input.listenerCount("error")).toBe(0);
      expect(fixture.input.listenerCount("close")).toBe(0);
      expect(fixture.output.text()).not.toContain(CANARY);
    },
  );

  it("fails closed when input provides yes and then destroys itself with an error", async () => {
    const fixture = await presentedInteraction();
    const confirmation = fixture.session.confirmation.confirm();
    await waitForText(
      fixture.output,
      `${PLAN}${SETUP_CONFIRMATION_PROMPT}`,
    );
    await waitForConfirmationReader(fixture.input);

    fixture.input.write("yes\n");
    fixture.input.destroy(new Error(CANARY));

    expect(await confirmation).toBe("unavailable");
    expect(fixture.input.listenerCount("error")).toBe(0);
    expect(fixture.output.text()).not.toContain(CANARY);
  });

  it("keeps the input error guard active through repeated checkpoint errors", async () => {
    const fixture = await presentedInteraction();
    const confirmation = fixture.session.confirmation.confirm();
    await waitForText(
      fixture.output,
      `${PLAN}${SETUP_CONFIRMATION_PROMPT}`,
    );
    await waitForConfirmationReader(fixture.input);

    fixture.input.emit("error", new Error(CANARY));
    expect(fixture.input.listenerCount("error")).toBe(1);
    fixture.input.emit("error", new Error(CANARY));

    expect(await confirmation).toBe("unavailable");
    expect(fixture.input.listenerCount("error")).toBe(0);
  });

  it("rejects close without graceful end after a complete yes line", async () => {
    const fixture = await presentedInteraction();
    const confirmation = fixture.session.confirmation.confirm();
    await waitForText(
      fixture.output,
      `${PLAN}${SETUP_CONFIRMATION_PROMPT}`,
    );
    await waitForConfirmationReader(fixture.input);

    fixture.input.write("yes\n");
    fixture.input.destroy();

    expect(await confirmation).toBe("unavailable");
    expect(fixture.input.listenerCount("close")).toBe(0);
  });

  it("fails closed when resume emits yes synchronously and then throws", async () => {
    const input = terminalStream(true);
    Object.defineProperty(input, "resume", {
      configurable: false,
      enumerable: false,
      value(): never {
        input.emit("data", Buffer.from("yes\n", "utf8"));
        throw new Error(CANARY);
      },
      writable: false,
    });
    const output = outputHarness(true);
    const session = createNodeSetupInteractiveSession(
      input,
      output.stream,
    );
    expect(await session.presenter.presentPlan(PLAN)).toBe("presented");

    expect(await session.confirmation.confirm()).toBe("unavailable");
    expect(output.text()).toBe(
      `${PLAN}${SETUP_CONFIRMATION_PROMPT}`,
    );
    expect(output.text()).not.toContain(CANARY);
  });

  it("fails closed and removes guards when pause throws during finalization", async () => {
    const fixture = await presentedInteraction();
    Object.defineProperty(fixture.input, "pause", {
      configurable: false,
      enumerable: false,
      value(): never {
        throw new Error(CANARY);
      },
      writable: false,
    });
    const confirmation = fixture.session.confirmation.confirm();
    await waitForText(
      fixture.output,
      `${PLAN}${SETUP_CONFIRMATION_PROMPT}`,
    );
    await waitForConfirmationReader(fixture.input);

    fixture.input.end("yes\n");

    expect(await confirmation).toBe("unavailable");
    expect(fixture.input.listenerCount("data")).toBe(0);
    expect(fixture.input.listenerCount("end")).toBe(0);
    expect(fixture.input.listenerCount("error")).toBe(0);
    expect(fixture.input.listenerCount("close")).toBe(0);
  });

  it("fails closed when pause emits trailing input during finalization", async () => {
    const fixture = await presentedInteraction();
    const nativePause = fixture.input.pause.bind(fixture.input);
    Object.defineProperty(fixture.input, "pause", {
      configurable: false,
      enumerable: false,
      value(): NodeJS.ReadableStream {
        fixture.input.emit("data", Buffer.from("no\n", "utf8"));
        return nativePause();
      },
      writable: false,
    });
    const confirmation = fixture.session.confirmation.confirm();
    await waitForText(
      fixture.output,
      `${PLAN}${SETUP_CONFIRMATION_PROMPT}`,
    );
    await waitForConfirmationReader(fixture.input);

    fixture.input.end("yes\n");

    expect(await confirmation).toBe("unavailable");
    expect(fixture.input.listenerCount("data")).toBe(0);
    expect(fixture.input.listenerCount("error")).toBe(0);
  });

  it("fails closed when pause destroys input during finalization", async () => {
    const fixture = await presentedInteraction();
    const nativePause = fixture.input.pause.bind(fixture.input);
    Object.defineProperty(fixture.input, "pause", {
      configurable: false,
      enumerable: false,
      value(): NodeJS.ReadableStream {
        fixture.input.destroy();
        return nativePause();
      },
      writable: false,
    });
    const confirmation = fixture.session.confirmation.confirm();
    await waitForText(
      fixture.output,
      `${PLAN}${SETUP_CONFIRMATION_PROMPT}`,
    );
    await waitForConfirmationReader(fixture.input);

    fixture.input.write("yes\n");

    expect(await confirmation).toBe("unavailable");
    expect(fixture.input.listenerCount("close")).toBe(0);
    expect(fixture.input.listenerCount("error")).toBe(0);
  });

  it("rejects an input stream that already has a data consumer", async () => {
    const fixture = await presentedInteraction();
    const existing = (): void => undefined;
    fixture.input.on("data", existing);

    expect(await fixture.session.confirmation.confirm()).toBe(
      "unavailable",
    );
    expect(fixture.input.listeners("data")).toEqual([existing]);
    expect(fixture.output.text()).toBe(
      `${PLAN}${SETUP_CONFIRMATION_PROMPT}`,
    );

    fixture.input.off("data", existing);
  });

  it("rejects an input stream that already has a readable consumer", async () => {
    const fixture = await presentedInteraction();
    const existing = (): void => undefined;
    fixture.input.on("readable", existing);
    fixture.input.write("yes\n");

    expect(await fixture.session.confirmation.confirm()).toBe(
      "unavailable",
    );
    expect(fixture.input.listeners("readable")).toEqual([existing]);
    expect(fixture.input.listenerCount("data")).toBe(0);
    expect(fixture.input.read()?.toString("utf8")).toBe("yes\n");
    expect(fixture.output.text()).toBe(
      `${PLAN}${SETUP_CONFIRMATION_PROMPT}`,
    );

    fixture.input.off("readable", existing);
  });

  it.each([
    "readableFlowing",
    "destroyed",
    "readableEnded",
    "closed",
  ] as const)("rejects input with %s already true", async (property) => {
    const fixture = await presentedInteraction();
    fixture.input.write("yes\n");
    Object.defineProperty(fixture.input, property, {
      configurable: true,
      enumerable: true,
      value: true,
      writable: false,
    });

    expect(await fixture.session.confirmation.confirm()).toBe(
      "unavailable",
    );
    expect(fixture.input.listenerCount("data")).toBe(0);
    expect(fixture.input.read()?.toString("utf8")).toBe("yes\n");
    expect(fixture.output.text()).toBe(
      `${PLAN}${SETUP_CONFIRMATION_PROMPT}`,
    );
  });

  it("uses the standalone presenter without capturing or touching an input object", async () => {
    const output = outputHarness(false);
    let inputAccesses = 0;
    const inputCanary = new Proxy(terminalStream(true), {
      get() {
        inputAccesses += 1;
        throw new Error(CANARY);
      },
    });

    const presenter = createNodeSetupPlanPresenter(output.stream);
    expect(createNodeSetupPlanPresenter.length).toBe(1);
    expect(await presenter.presentPlan(PLAN)).toBe("presented");

    expect(inputCanary).toBeDefined();
    expect(inputAccesses).toBe(0);
    expect(output.text()).toBe(PLAN);
    expect(output.text()).not.toContain(CANARY);
  });

  it("makes plan presentation one-use even while its first write is pending", async () => {
    const output = controlledOutput(true);
    const presenter = createNodeSetupPlanPresenter(output.stream);

    const first = presenter.presentPlan(PLAN);
    expect(await presenter.presentPlan("replacement plan\n")).toBe(
      "unavailable",
    );
    expect(output.writes).toEqual([PLAN]);

    output.flushNext();
    expect(await first).toBe("presented");
    expect(await presenter.presentPlan(PLAN)).toBe("unavailable");
    expect(output.writes).toEqual([PLAN]);
  });

  it("makes confirmation one-use and rejects a concurrent second reader", async () => {
    const fixture = await presentedInteraction();

    const first = fixture.session.confirmation.confirm();
    expect(await fixture.session.confirmation.confirm()).toBe(
      "unavailable",
    );
    await waitForText(
      fixture.output,
      `${PLAN}${SETUP_CONFIRMATION_PROMPT}`,
    );
    await waitForConfirmationReader(fixture.input);
    fixture.input.end("yes\n");

    expect(await first).toBe("confirmed");
    expect(await fixture.session.confirmation.confirm()).toBe(
      "unavailable",
    );
    expect(fixture.output.text()).toBe(
      `${PLAN}${SETUP_CONFIRMATION_PROMPT}`,
    );
  });

  it("burns confirmation when called before a successful presentation", async () => {
    const input = terminalStream(true);
    const output = outputHarness(true);
    const session = createNodeSetupInteractiveSession(input, output.stream);

    expect(await session.confirmation.confirm()).toBe("unavailable");
    expect(output.text()).toBe("");
    expect(await session.presenter.presentPlan(PLAN)).toBe("presented");
    expect(await session.confirmation.confirm()).toBe("unavailable");
    expect(output.text()).toBe(PLAN);
  });

  it("bounds plan output by UTF-8 bytes without writing rejected text", async () => {
    const exactOutput = outputHarness(true);
    const exact = createNodeSetupPlanPresenter(exactOutput.stream);
    const exactText = `${"a".repeat(MAX_PLAN_OUTPUT_BYTES - 4)}😀`;
    expect(new TextEncoder().encode(exactText).byteLength).toBe(
      MAX_PLAN_OUTPUT_BYTES,
    );
    expect(await exact.presentPlan(exactText)).toBe("presented");
    expect(exactOutput.text()).toBe(exactText);

    const rejectedOutput = outputHarness(true);
    const rejected = createNodeSetupPlanPresenter(rejectedOutput.stream);
    const oversized = `${exactText}x`;
    expect(await rejected.presentPlan(oversized)).toBe("unavailable");
    expect(rejectedOutput.text()).toBe("");
  });

  it("never reflects rejected input or stream errors into terminal output or results", async () => {
    const inputResult = await confirmWith(`${CANARY}\n`);
    expect(inputResult.decision).toBe("unavailable");
    expect(inputResult.output).not.toContain(CANARY);
    expect(JSON.stringify(inputResult.decision)).not.toContain(CANARY);

    const fixture = await presentedInteraction();
    const confirmation = fixture.session.confirmation.confirm();
    await waitForText(
      fixture.output,
      `${PLAN}${SETUP_CONFIRMATION_PROMPT}`,
    );
    await waitForConfirmationReader(fixture.input);
    fixture.input.emit("error", new Error(CANARY));

    const errorResult = await confirmation;
    expect(errorResult).toBe("unavailable");
    expect(fixture.output.text()).not.toContain(CANARY);
    expect(JSON.stringify(errorResult)).not.toContain(CANARY);
  });
});
