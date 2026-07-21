import { setImmediate as scheduleImmediate } from "node:timers";

import {
  SETUP_CONFIRMATION_PROMPT,
  createSetupInputFreePlanPresenter,
  createSetupInteractiveSessionPorts,
  type SetupInteractiveConfirmation,
  type SetupInteractiveConfirmationResult,
  type SetupPlanPresenter,
  type SetupPlanPresentationResult,
} from "../../commands/setup-confirmation.js";

const MAX_PLAN_OUTPUT_BYTES = 256 * 1024;
const MAX_CONFIRMATION_INPUT_BYTES = 16;
const ASCII_CARRIAGE_RETURN = 0x0d;
const ASCII_LINE_FEED = 0x0a;
const ASCII_SPACE = 0x20;
const ASCII_DELETE = 0x7f;
const UTF8_ENCODER = new TextEncoder();

export interface SetupTerminalInput extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
  readonly readableFlowing?: boolean | null;
  readonly destroyed?: boolean;
  readonly readableEnded?: boolean;
  readonly closed?: boolean;
  readonly readableLength?: number;
}

export interface SetupTerminalOutput extends NodeJS.WritableStream {
  readonly isTTY?: boolean;
}

function writeAndFlush(
  output: SetupTerminalOutput,
  text: string,
): Promise<SetupPlanPresentationResult> {
  return new Promise((resolve) => {
    let settled = false;
    let callbackCompleted = false;
    let callbackHadError = false;
    let failed = false;
    let writeReturned = false;
    let checkpointScheduled = false;
    const cleanup = (): boolean => {
      let cleaned = true;
      try {
        output.off("error", onError);
      } catch {
        cleaned = false;
      }
      try {
        output.off("close", onClose);
      } catch {
        cleaned = false;
      }
      return cleaned;
    };
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      const cleaned = cleanup();
      resolve(
        !failed &&
          callbackCompleted &&
          !callbackHadError &&
          writeReturned &&
          cleaned
          ? "presented"
          : "unavailable",
      );
    };
    const scheduleCheckpoint = (): void => {
      if (checkpointScheduled || settled) {
        return;
      }
      checkpointScheduled = true;
      scheduleImmediate(() => {
        scheduleImmediate(finish);
      });
    };
    const onError = (): void => {
      failed = true;
      scheduleCheckpoint();
    };
    const onClose = (): void => {
      failed = true;
      scheduleCheckpoint();
    };

    try {
      output.on("error", onError);
      if (failed) {
        return;
      }
      output.once("close", onClose);
      if (failed) {
        return;
      }
      output.write(text, (error?: Error | null) => {
        callbackCompleted = true;
        callbackHadError = error !== undefined && error !== null;
        failed ||= callbackHadError;
        if (!writeReturned) {
          return;
        }
        scheduleCheckpoint();
      });
      writeReturned = true;
      if (callbackCompleted) {
        scheduleCheckpoint();
      }
    } catch {
      writeReturned = true;
      failed = true;
      scheduleCheckpoint();
    }
  });
}

function chunkLength(chunk: unknown): number | null {
  if (typeof chunk === "string") {
    return chunk.length;
  }
  return chunk instanceof Uint8Array ? chunk.byteLength : null;
}

function chunkByte(chunk: string | Uint8Array, index: number): number {
  return typeof chunk === "string"
    ? chunk.charCodeAt(index)
    : (chunk[index] ?? ASCII_DELETE);
}

function completedDecision(
  bytes: readonly number[],
): SetupInteractiveConfirmationResult {
  return (
    (bytes.length === 4 &&
      bytes[0] === 0x79 &&
      bytes[1] === 0x65 &&
      bytes[2] === 0x73 &&
      bytes[3] === ASCII_LINE_FEED) ||
    (bytes.length === 5 &&
      bytes[0] === 0x79 &&
      bytes[1] === 0x65 &&
      bytes[2] === 0x73 &&
      bytes[3] === ASCII_CARRIAGE_RETURN &&
      bytes[4] === ASCII_LINE_FEED)
  )
    ? "confirmed"
    : "declined";
}

function readBoundedConfirmation(
  input: SetupTerminalInput,
): Promise<SetupInteractiveConfirmationResult> {
  return new Promise((resolve) => {
    try {
      if (
        input.listenerCount("data") !== 0 ||
        input.listenerCount("readable") !== 0 ||
        input.readableFlowing === true ||
        input.destroyed === true ||
        input.readableEnded === true ||
        input.closed === true ||
        input.readableLength !== 0
      ) {
        resolve("unavailable");
        return;
      }
    } catch {
      resolve("unavailable");
      return;
    }

    const bytes: number[] = [];
    let settled = false;
    let finalizing = false;
    let activationComplete = false;
    let checkpointScheduled = false;
    let lineCompleted = false;
    let ended = false;
    let candidate: SetupInteractiveConfirmationResult | null = null;
    const finish = (result: SetupInteractiveConfirmationResult): void => {
      if (settled || finalizing) {
        return;
      }
      finalizing = true;
      let pauseFailed = false;
      try {
        input.pause();
      } catch {
        pauseFailed = true;
      }
      try {
        if (
          (input.destroyed === true || input.closed === true) &&
          !ended
        ) {
          candidate = "unavailable";
        }
      } catch {
        candidate = "unavailable";
      }
      scheduleImmediate(() => {
        scheduleImmediate(() => {
          let cleanupFailed = false;
          for (const [event, listener] of [
            ["data", onData],
            ["end", onEnd],
            ["close", onClose],
            ["error", onError],
          ] as const) {
            try {
              input.off(event, listener);
            } catch {
              cleanupFailed = true;
            }
          }
          settled = true;
          resolve(
            cleanupFailed ||
              pauseFailed ||
              candidate === "unavailable"
              ? "unavailable"
              : result,
          );
        });
      });
    };
    const scheduleCheckpoint = (): void => {
      if (
        checkpointScheduled ||
        settled ||
        !activationComplete ||
        candidate === null
      ) {
        return;
      }
      checkpointScheduled = true;
      scheduleImmediate(() => {
        scheduleImmediate(() => {
          if (candidate !== null) {
            finish(candidate);
          }
        });
      });
    };
    const decide = (
      result: SetupInteractiveConfirmationResult,
    ): void => {
      if (
        candidate === null ||
        result === "unavailable"
      ) {
        candidate = result;
      }
      scheduleCheckpoint();
    };
    const stopAfterUnavailable = (): boolean => {
      if (candidate !== "unavailable") {
        return false;
      }
      activationComplete = true;
      scheduleCheckpoint();
      return true;
    };
    const onEnd = (): void => {
      ended = true;
      if (candidate === null) {
        decide("unavailable");
      }
    };
    const onError = (): void => decide("unavailable");
    const onClose = (): void => {
      if (!ended || candidate === null) {
        decide("unavailable");
      }
    };
    const onData = (rawChunk: unknown): void => {
      try {
        if (candidate === "unavailable" || lineCompleted) {
          decide("unavailable");
          return;
        }
        const length = chunkLength(rawChunk);
        if (length === null) {
          decide("unavailable");
          return;
        }
        const chunk = rawChunk as string | Uint8Array;
        for (let index = 0; index < length; index += 1) {
          if (bytes.length >= MAX_CONFIRMATION_INPUT_BYTES) {
            decide("unavailable");
            return;
          }
          const byte = chunkByte(chunk, index);
          if (
            !Number.isInteger(byte) ||
            byte > 0x7f ||
            byte === ASCII_DELETE ||
            (byte < ASCII_SPACE &&
              byte !== ASCII_CARRIAGE_RETURN &&
              byte !== ASCII_LINE_FEED)
          ) {
            decide("unavailable");
            return;
          }
          if (
            bytes.at(-1) === ASCII_CARRIAGE_RETURN &&
            byte !== ASCII_LINE_FEED
          ) {
            decide("unavailable");
            return;
          }
          bytes.push(byte);
          if (byte === ASCII_LINE_FEED) {
            lineCompleted = true;
            decide(
              index === length - 1
                ? completedDecision(bytes)
                : "unavailable",
            );
            return;
          }
        }
      } catch {
        decide("unavailable");
      }
    };

    try {
      input.on("error", onError);
      if (stopAfterUnavailable()) {
        return;
      }
      input.once("close", onClose);
      if (stopAfterUnavailable()) {
        return;
      }
      input.once("end", onEnd);
      if (stopAfterUnavailable()) {
        return;
      }
      input.on("data", onData);
      if (stopAfterUnavailable()) {
        return;
      }
      input.resume();
      activationComplete = true;
      scheduleCheckpoint();
    } catch {
      activationComplete = true;
      decide("unavailable");
    }
  });
}

/*
 * This adapter is intentionally not wired to process.stdin/stdout yet. Tests
 * provide isolated in-memory streams; the completed setup orchestrator will
 * construct it only after a fully resolved plan exists.
 */
export function createNodeSetupPlanPresenter(
  output: SetupTerminalOutput,
): SetupPlanPresenter {
  let presentationStarted = false;

  return createSetupInputFreePlanPresenter(
    async (text: string): Promise<SetupPlanPresentationResult> => {
      if (
        presentationStarted ||
        typeof text !== "string" ||
        text.length > MAX_PLAN_OUTPUT_BYTES ||
        UTF8_ENCODER.encode(text).byteLength > MAX_PLAN_OUTPUT_BYTES
      ) {
        return "unavailable";
      }
      presentationStarted = true;
      return writeAndFlush(output, text);
    },
  );
}

export interface NodeSetupInteractiveSession {
  readonly presenter: SetupPlanPresenter;
  readonly confirmation: SetupInteractiveConfirmation;
}

export function createNodeSetupInteractiveSession(
  input: SetupTerminalInput,
  output: SetupTerminalOutput,
): NodeSetupInteractiveSession {
  let presentationStarted = false;
  let planPresented = false;
  let confirmationStarted = false;
  return createSetupInteractiveSessionPorts(
    async (text: string): Promise<SetupPlanPresentationResult> => {
      if (
        presentationStarted ||
        typeof text !== "string" ||
        text.length > MAX_PLAN_OUTPUT_BYTES ||
        UTF8_ENCODER.encode(text).byteLength > MAX_PLAN_OUTPUT_BYTES
      ) {
        return "unavailable";
      }
      presentationStarted = true;
      const result = await writeAndFlush(output, text);
      planPresented = result === "presented";
      return result;
    },
    async (): Promise<SetupInteractiveConfirmationResult> => {
      if (confirmationStarted) {
        return "unavailable";
      }
      confirmationStarted = true;
      if (
        !planPresented ||
        input.isTTY !== true ||
        output.isTTY !== true
      ) {
        return "unavailable";
      }
      if (
        await writeAndFlush(output, SETUP_CONFIRMATION_PROMPT) !==
        "presented"
      ) {
        return "unavailable";
      }
      return readBoundedConfirmation(input);
    },
  );
}
