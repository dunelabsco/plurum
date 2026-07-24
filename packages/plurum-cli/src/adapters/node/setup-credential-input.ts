import { setImmediate as scheduleImmediate } from "node:timers";

import {
  SETUP_CONFIRMATION_PROMPT,
  createSetupInteractiveSessionPorts,
  type SetupInteractiveConfirmationResult,
  type SetupPlanPresentationResult,
} from "../../commands/setup-confirmation.js";
import {
  SETUP_CREDENTIAL_INPUT_MAX_BYTES,
  SETUP_CREDENTIAL_INPUT_PROMPT,
  discardSetupCredentialInput,
  retainFramedSetupCredentialInput,
  type SetupCredentialInputAttempt,
  type SetupCredentialInputCancellationReason,
  type SetupCredentialInputIdentity,
  type SetupCredentialInputResult,
} from "../../commands/setup-credential-input.js";
import type { SetupApplyOptions } from "../../commands/types.js";
import {
  copyUint8ArrayInto,
  copyUint8ArrayPrefix,
  intrinsicUint8ArrayByteLength,
  wipeUint8Array,
} from "../../data/uint8-array.js";
import {
  createNodeSetupInteractiveSession,
  type NodeSetupInteractiveSession,
  type SetupTerminalInput,
  type SetupTerminalOutput,
} from "./setup-interaction.js";

export type SetupProtectedTerminalCaptureResult =
  | Readonly<{
      readonly status: "captured";
      readonly bytes: Uint8Array;
    }>
  | Readonly<{ readonly status: "declined" }>
  | Readonly<{ readonly status: "invalid" }>
  | Readonly<{ readonly status: "cancelled" }>
  | Readonly<{ readonly status: "interrupted" }>
  | Readonly<{ readonly status: "timed-out" }>
  | Readonly<{ readonly status: "unavailable" }>;

export interface SetupProtectedTerminalCaptureRequest {
  readonly input: SetupTerminalInput;
  readonly output: SetupTerminalOutput;
  readonly prompt: typeof SETUP_CREDENTIAL_INPUT_PROMPT;
  readonly maxInputBytes: typeof SETUP_CREDENTIAL_INPUT_MAX_BYTES;
}

export const SETUP_EXACT_CONFIRMATION_MAX_BYTES = 16 as const;

export interface SetupProtectedTerminalConfirmationRequest {
  readonly input: SetupTerminalInput;
  readonly output: SetupTerminalOutput;
  readonly prompt: typeof SETUP_CONFIRMATION_PROMPT;
  readonly maxInputBytes: typeof SETUP_EXACT_CONFIRMATION_MAX_BYTES;
}

/*
 * This is a semantic native boundary, not a raw-mode toggle. A successful
 * implementation must attest that input and output are the same terminal,
 * disable only echo, retain normal line/signal processing, restore the exact
 * captured state, remove its guards, and reject OS- and stream-buffered input
 * atomically before reading confirmation. `restore` is idempotent and may
 * return `restored` only after the operation is quiescent: it cannot perform
 * any later terminal I/O or state change.
 * Production construction stays unwired until disposable PTY/console suites
 * prove those guarantees on every supported platform.
 */
export interface SetupProtectedTerminalPort {
  captureCredential(
    request: SetupProtectedTerminalCaptureRequest,
  ): Promise<SetupProtectedTerminalCaptureResult>;
  confirmExactPlan(
    request: SetupProtectedTerminalConfirmationRequest,
  ): Promise<SetupInteractiveConfirmationResult>;
  restore(
    reason: SetupCredentialInputCancellationReason | "completed",
  ): "restored" | "unavailable";
}

export interface NodeSetupProtectedInteractiveSession
  extends NodeSetupInteractiveSession {
  readonly credentialInput: SetupCredentialInputAttempt;
}

type CredentialTransportResult = SetupProtectedTerminalCaptureResult;

interface CredentialAttemptHooks {
  readonly start: () => Promise<CredentialTransportResult>;
  readonly cancelPending: (
    reason: SetupCredentialInputCancellationReason,
  ) => boolean;
  readonly cancelRetained?: (
    reason: SetupCredentialInputCancellationReason,
  ) => boolean;
  readonly framing: "interactive-line" | "explicit-eof";
  readonly accepted?: (identity: SetupCredentialInputIdentity) => void;
  readonly closed?: () => void;
}

const INPUT_ACCEPTED = "accepted" as const;
const INPUT_DECLINED = Object.freeze({ status: "declined" as const });
const INPUT_INVALID = Object.freeze({ status: "invalid" as const });
const INPUT_CANCELLED = Object.freeze({ status: "cancelled" as const });
const INPUT_INTERRUPTED = Object.freeze({ status: "interrupted" as const });
const INPUT_TIMED_OUT = Object.freeze({ status: "timed-out" as const });
const INPUT_UNAVAILABLE = Object.freeze({ status: "unavailable" as const });
const CANCELLED = Object.freeze({ status: "cancelled" as const });
const DISCARDED = Object.freeze({ status: "discarded" as const });
const ALREADY_SETTLED = Object.freeze({
  status: "already-settled" as const,
});
const CANCEL_UNAVAILABLE = Object.freeze({
  status: "unavailable" as const,
});
const CLAIMED_PROTECTED_TERMINAL_PORTS = new WeakSet<object>();
const CLAIMED_PROTECTED_TERMINAL_INPUTS = new WeakSet<object>();
const CLAIMED_PROTECTED_TERMINAL_OUTPUTS = new WeakSet<object>();

function cancellationResult(
  reason: SetupCredentialInputCancellationReason,
): Exclude<SetupCredentialInputResult, { readonly status: "accepted" }> {
  if (reason === "interrupted") {
    return INPUT_INTERRUPTED;
  }
  if (reason === "timed-out") {
    return INPUT_TIMED_OUT;
  }
  return INPUT_CANCELLED;
}

function transportStatus(
  result: CredentialTransportResult,
): CredentialTransportResult["status"] | undefined {
  try {
    return result.status;
  } catch {
    return undefined;
  }
}

function wipeCapturedTransport(result: unknown): void {
  try {
    if (
      result !== null &&
      typeof result === "object" &&
      (result as { readonly status?: unknown }).status === "captured"
    ) {
      wipeUint8Array(
        (result as { readonly bytes?: unknown }).bytes,
      );
    }
  } catch {
    /* A hostile result must not escape or reflect its failure. */
  }
}

function normalizeTransportResult(
  result: CredentialTransportResult,
  framing: "interactive-line" | "explicit-eof",
): SetupCredentialInputResult {
  const status = transportStatus(result);
  if (status === "captured") {
    let bytes: unknown;
    try {
      bytes = (result as Readonly<{
        readonly status: "captured";
        readonly bytes: unknown;
      }>).bytes;
    } catch {
      return INPUT_UNAVAILABLE;
    }
    const credential = retainFramedSetupCredentialInput(
      bytes as Uint8Array,
      framing,
    );
    return credential === undefined
      ? INPUT_INVALID
      : Object.freeze({ status: INPUT_ACCEPTED, credential });
  }
  if (status === "declined") {
    return INPUT_DECLINED;
  }
  if (status === "invalid") {
    return INPUT_INVALID;
  }
  if (status === "cancelled") {
    return INPUT_CANCELLED;
  }
  if (status === "interrupted") {
    return INPUT_INTERRUPTED;
  }
  if (status === "timed-out") {
    return INPUT_TIMED_OUT;
  }
  return INPUT_UNAVAILABLE;
}

function createCredentialInputAttempt(
  hooks: CredentialAttemptHooks,
): SetupCredentialInputAttempt {
  let captureStarted = false;
  let startEntered = false;
  let pending = false;
  let settled = false;
  let cancellation:
    | Readonly<{
        readonly reason: SetupCredentialInputCancellationReason;
        readonly restored: boolean;
      }>
    | undefined;
  let resolveCancellation:
    | ((value: Readonly<{ readonly kind: "cancelled" }>) => void)
    | undefined;
  let retainedIdentity: SetupCredentialInputIdentity | undefined;

  const close = (): void => {
    try {
      hooks.closed?.();
    } catch {
      /* Fixed outcomes only. */
    }
  };

  const attempt: SetupCredentialInputAttempt = Object.freeze({
    async capture(): Promise<SetupCredentialInputResult> {
      if (captureStarted || settled) {
        return INPUT_UNAVAILABLE;
      }
      captureStarted = true;
      pending = true;

      const cancelled = new Promise<
        Readonly<{ readonly kind: "cancelled" }>
      >((resolve) => {
        resolveCancellation = resolve;
      });
      const read = Promise.resolve()
        .then(() => {
          if (cancellation !== undefined) {
            return INPUT_UNAVAILABLE as CredentialTransportResult;
          }
          startEntered = true;
          return hooks.start();
        })
        .then(
          (value) =>
            Object.freeze({ kind: "read" as const, value }),
          () =>
            Object.freeze({
              kind: "read" as const,
              value: INPUT_UNAVAILABLE as CredentialTransportResult,
            }),
        );

      const outcome = await Promise.race([read, cancelled]);
      pending = false;
      resolveCancellation = undefined;

      if (outcome.kind === "cancelled") {
        void read.then(({ value }) => wipeCapturedTransport(value));
        settled = true;
        close();
        return cancellation?.restored === true
          ? cancellationResult(cancellation.reason)
          : INPUT_UNAVAILABLE;
      }
      if (cancellation !== undefined) {
        wipeCapturedTransport(outcome.value);
        settled = true;
        close();
        return cancellation.restored
          ? cancellationResult(cancellation.reason)
          : INPUT_UNAVAILABLE;
      }

      const result = normalizeTransportResult(
        outcome.value,
        hooks.framing,
      );
      settled = true;
      if (result.status === "accepted") {
        retainedIdentity = result.credential;
        try {
          hooks.accepted?.(result.credential);
        } catch {
          discardSetupCredentialInput(result.credential);
          retainedIdentity = undefined;
          close();
          return INPUT_UNAVAILABLE;
        }
      } else {
        close();
      }
      return result;
    },

    cancel(reason = "cancelled") {
      if (
        reason !== "cancelled" &&
        reason !== "interrupted" &&
        reason !== "timed-out"
      ) {
        return CANCEL_UNAVAILABLE;
      }
      if (retainedIdentity !== undefined) {
        let quiesced = true;
        if (hooks.cancelRetained !== undefined) {
          try {
            quiesced = hooks.cancelRetained(reason);
          } catch {
            quiesced = false;
          }
        }
        const result = discardSetupCredentialInput(retainedIdentity);
        retainedIdentity = undefined;
        close();
        return result.status === "discarded" && quiesced
          ? DISCARDED
          : CANCEL_UNAVAILABLE;
      }
      if (settled || cancellation !== undefined) {
        return ALREADY_SETTLED;
      }
      if (!captureStarted) {
        captureStarted = true;
        settled = true;
        close();
        return CANCELLED;
      }

      let restored = false;
      if (!startEntered) {
        restored = true;
      } else {
        try {
          restored = hooks.cancelPending(reason);
        } catch {
          restored = false;
        }
      }
      cancellation = Object.freeze({ reason, restored });
      if (pending) {
        resolveCancellation?.(Object.freeze({ kind: "cancelled" }));
      }
      return restored ? CANCELLED : CANCEL_UNAVAILABLE;
    },
  });
  return attempt;
}

function terminalInputIsSecretReady(
  input: SetupTerminalInput,
  requireUnread: boolean,
): boolean {
  try {
    return (
      input.isTTY === true &&
      input.listenerCount("data") === 0 &&
      input.listenerCount("readable") === 0 &&
      input.listenerCount("newListener") === 0 &&
      input.listenerCount("removeListener") === 0 &&
      input.readableFlowing !== true &&
      input.readableEncoding === null &&
      input.readableObjectMode === false &&
      input.readableAborted !== true &&
      input.errored == null &&
      input.destroyed !== true &&
      input.readableEnded !== true &&
      input.closed !== true &&
      input.readableLength === 0 &&
      (!requireUnread || input.readableDidRead !== true)
    );
  } catch {
    return false;
  }
}

function terminalOutputIsReady(output: SetupTerminalOutput): boolean {
  try {
    return (
      output.isTTY === true &&
      output.destroyed !== true &&
      output.closed !== true
    );
  } catch {
    return false;
  }
}

function restoreProtectedTerminal(
  terminal: SetupProtectedTerminalPort,
  reason: SetupCredentialInputCancellationReason | "completed",
): boolean {
  try {
    return terminal.restore(reason) === "restored";
  } catch {
    return false;
  }
}

type TerminalGuardSnapshot = readonly (readonly unknown[])[];

function terminalGuardSnapshot(
  input: SetupTerminalInput,
  output: SetupTerminalOutput,
): TerminalGuardSnapshot | undefined {
  try {
    return Object.freeze(
      [
        [input, "data"],
        [input, "readable"],
        [input, "end"],
        [input, "error"],
        [input, "close"],
        [input, "newListener"],
        [input, "removeListener"],
        [output, "error"],
        [output, "close"],
        [output, "newListener"],
        [output, "removeListener"],
      ].map(([stream, event]) =>
        Object.freeze(
          [
            ...(stream as SetupTerminalInput).rawListeners(
              event as string,
            ),
          ],
        ),
      ),
    );
  } catch {
    return undefined;
  }
}

function terminalGuardsRestored(
  input: SetupTerminalInput,
  output: SetupTerminalOutput,
  expected: TerminalGuardSnapshot,
): boolean {
  const actual = terminalGuardSnapshot(input, output);
  return (
    actual !== undefined &&
    actual.length === expected.length &&
    actual.every((listeners, index) => {
      const prior = expected[index];
      return (
        prior !== undefined &&
        listeners.length === prior.length &&
        listeners.every(
          (listener, listenerIndex) =>
            listener === prior[listenerIndex],
        )
      );
    })
  );
}

function explicitInputIsReady(input: SetupTerminalInput): boolean {
  try {
    return (
      input.isTTY !== true &&
      input.listenerCount("data") === 0 &&
      input.listenerCount("readable") === 0 &&
      input.listenerCount("newListener") === 0 &&
      input.listenerCount("removeListener") === 0 &&
      input.readableFlowing !== true &&
      input.readableEncoding === null &&
      input.readableObjectMode === false &&
      input.readableAborted !== true &&
      input.readableDidRead !== true &&
      input.errored == null &&
      input.destroyed !== true &&
      input.readableEnded !== true &&
      input.closed !== true &&
      input.readableLength === 0
    );
  } catch {
    return false;
  }
}

interface ExplicitCredentialRead {
  readonly promise: Promise<CredentialTransportResult>;
  cancel(): boolean;
}

function beginExplicitCredentialRead(
  input: SetupTerminalInput,
): ExplicitCredentialRead {
  const bytes = new Uint8Array(SETUP_CREDENTIAL_INPUT_MAX_BYTES);
  let length = 0;
  let settled = false;
  let finalizing = false;
  let ended = false;
  let failed = false;
  let invalid = false;
  let resolveRead:
    | ((result: CredentialTransportResult) => void)
    | undefined;

  const cleanup = (): boolean => {
    let cleaned = true;
    try {
      input.pause();
    } catch {
      cleaned = false;
    }
    for (const [event, listener] of [
      ["data", onData],
      ["end", onEnd],
      ["close", onClose],
      ["error", onError],
    ] as const) {
      try {
        input.off(event, listener);
      } catch {
        cleaned = false;
      }
    }
    return cleaned;
  };

  const finish = (
    result: "captured" | "invalid" | "unavailable",
  ): void => {
    if (settled || finalizing) {
      return;
    }
    finalizing = true;
    scheduleImmediate(() => {
      scheduleImmediate(() => {
        const cleaned = cleanup();
        let captured: Uint8Array | undefined;
        if (result === "captured" && cleaned && !failed && ended) {
          captured = copyUint8ArrayPrefix(bytes, length);
        }
        wipeUint8Array(bytes);
        settled = true;
        if (captured !== undefined) {
          resolveRead?.(Object.freeze({
            status: "captured" as const,
            bytes: captured,
          }));
        } else {
          resolveRead?.(
            result === "invalid" && cleaned && !failed
              ? INPUT_INVALID
              : INPUT_UNAVAILABLE,
          );
        }
      });
    });
  };

  function onData(rawChunk: unknown): void {
    try {
      if (finalizing || settled) {
        failed = true;
        wipeUint8Array(rawChunk);
        return;
      }
      if (invalid) {
        wipeUint8Array(rawChunk);
        return;
      }
      const chunkLength = intrinsicUint8ArrayByteLength(rawChunk);
      if (
        chunkLength === undefined ||
        chunkLength > SETUP_CREDENTIAL_INPUT_MAX_BYTES - length ||
        !copyUint8ArrayInto(bytes, length, rawChunk)
      ) {
        wipeUint8Array(rawChunk);
        invalid = true;
        return;
      }
      length += chunkLength;
      wipeUint8Array(rawChunk);
    } catch {
      wipeUint8Array(rawChunk);
      invalid = true;
    }
  }

  function onEnd(): void {
    ended = true;
    finish(invalid ? "invalid" : "captured");
  }

  function onError(): void {
    failed = true;
    finish("unavailable");
  }

  function onClose(): void {
    if (!ended) {
      failed = true;
      finish("unavailable");
    }
  }

  const promise = new Promise<CredentialTransportResult>((resolve) => {
    resolveRead = resolve;
    if (!explicitInputIsReady(input)) {
      wipeUint8Array(bytes);
      settled = true;
      resolve(INPUT_UNAVAILABLE);
      return;
    }
    try {
      input.on("error", onError);
      input.once("close", onClose);
      input.once("end", onEnd);
      input.on("data", onData);
      input.resume();
    } catch {
      failed = true;
      finish("unavailable");
    }
  });

  return Object.freeze({
    promise,
    cancel(): boolean {
      if (settled || finalizing) {
        return false;
      }
      failed = true;
      finalizing = true;
      const cleaned = cleanup();
      wipeUint8Array(bytes);
      settled = true;
      resolveRead?.(INPUT_UNAVAILABLE);
      return cleaned;
    },
  });
}

function explicitModeIsAuthorized(options: SetupApplyOptions): boolean {
  try {
    return (
      options.apiKeyStdin === true &&
      options.dryRun === false &&
      options.yes === true
    );
  } catch {
    return false;
  }
}

/*
 * This factory owns no output or confirmation port. The future production
 * composition may call it only for the parser-proven `--api-key-stdin --yes`
 * mode, leaving stdin exclusively reserved for one key through clean EOF.
 */
export function createNodeSetupExplicitCredentialInput(
  input: SetupTerminalInput,
  options: SetupApplyOptions,
): SetupCredentialInputAttempt {
  let active: ExplicitCredentialRead | undefined;
  return createCredentialInputAttempt({
    framing: "explicit-eof",
    async start(): Promise<CredentialTransportResult> {
      if (!explicitModeIsAuthorized(options)) {
        return INPUT_UNAVAILABLE;
      }
      active = beginExplicitCredentialRead(input);
      return active.promise;
    },
    cancelPending(): boolean {
      return active?.cancel() ?? false;
    },
  });
}

/*
 * Credential entry, plan presentation, and confirmation share this one
 * factory-owned terminal session. The native port must finish exact-state
 * restoration and stale-input checks before returning credential bytes.
 */
export function createNodeSetupProtectedInteractiveSession(
  input: SetupTerminalInput,
  output: SetupTerminalOutput,
  terminal: SetupProtectedTerminalPort,
): NodeSetupProtectedInteractiveSession {
  let terminalOwned = false;
  let credentialReady = false;
  let interaction: NodeSetupInteractiveSession | undefined;
  let presentationStarted = false;
  let planPresented = false;
  let confirmationStarted = false;
  try {
    const terminalObject = terminal as object;
    const inputObject = input as object;
    const outputObject = output as object;
    if (
      ((typeof terminal === "object" && terminal !== null) ||
        typeof terminal === "function") &&
      ((typeof input === "object" && input !== null) ||
        typeof input === "function") &&
      ((typeof output === "object" && output !== null) ||
        typeof output === "function")
    ) {
      if (
        !CLAIMED_PROTECTED_TERMINAL_PORTS.has(terminalObject) &&
        !CLAIMED_PROTECTED_TERMINAL_INPUTS.has(inputObject) &&
        !CLAIMED_PROTECTED_TERMINAL_OUTPUTS.has(outputObject)
      ) {
        CLAIMED_PROTECTED_TERMINAL_PORTS.add(terminalObject);
        CLAIMED_PROTECTED_TERMINAL_INPUTS.add(inputObject);
        CLAIMED_PROTECTED_TERMINAL_OUTPUTS.add(outputObject);
        terminalOwned = true;
      }
    }
  } catch {
    terminalOwned = false;
  }

  const credentialInput = createCredentialInputAttempt({
    framing: "interactive-line",
    async start(): Promise<CredentialTransportResult> {
      if (
        !terminalOwned ||
        !terminalInputIsSecretReady(input, true) ||
        !terminalOutputIsReady(output)
      ) {
        return INPUT_UNAVAILABLE;
      }
      const guards = terminalGuardSnapshot(input, output);
      if (guards === undefined) {
        return INPUT_UNAVAILABLE;
      }
      let result: CredentialTransportResult;
      try {
        result = await terminal.captureCredential(
          Object.freeze({
            input,
            output,
            prompt: SETUP_CREDENTIAL_INPUT_PROMPT,
            maxInputBytes: SETUP_CREDENTIAL_INPUT_MAX_BYTES,
          }),
        );
      } catch {
        restoreProtectedTerminal(terminal, "cancelled");
        return INPUT_UNAVAILABLE;
      }
      let restored = false;
      let attested = false;
      try {
        restored = restoreProtectedTerminal(terminal, "completed");
        attested =
          terminalInputIsSecretReady(input, false) &&
          terminalOutputIsReady(output) &&
          terminalGuardsRestored(input, output, guards);
      } catch {
        restored = false;
        attested = false;
      }
      if (!restored || !attested) {
        restoreProtectedTerminal(terminal, "cancelled");
        wipeCapturedTransport(result);
        return INPUT_UNAVAILABLE;
      }
      return result;
    },
    cancelPending(reason): boolean {
      if (!terminalOwned) {
        return false;
      }
      return restoreProtectedTerminal(terminal, reason);
    },
    cancelRetained(reason): boolean {
      return restoreProtectedTerminal(terminal, reason);
    },
    accepted(): void {
      interaction = createNodeSetupInteractiveSession(input, output);
      credentialReady = true;
    },
    closed(): void {
      credentialReady = false;
      interaction = undefined;
    },
  });

  const abandonCredential = (): void => {
    credentialInput.cancel();
    credentialReady = false;
    interaction = undefined;
  };

  const ports = createSetupInteractiveSessionPorts(
    async (text: string): Promise<SetupPlanPresentationResult> => {
      if (
        presentationStarted ||
        !credentialReady ||
        interaction === undefined ||
        !terminalInputIsSecretReady(input, false) ||
        !terminalOutputIsReady(output)
      ) {
        abandonCredential();
        return "unavailable";
      }
      presentationStarted = true;
      const result = await interaction.presenter.presentPlan(text);
      if (!credentialReady) {
        return "unavailable";
      }
      planPresented = result === "presented";
      if (!planPresented) {
        abandonCredential();
      }
      return result;
    },
    async (): Promise<SetupInteractiveConfirmationResult> => {
      if (
        confirmationStarted ||
        !credentialReady ||
        !planPresented ||
        interaction === undefined ||
        !terminalInputIsSecretReady(input, false) ||
        !terminalOutputIsReady(output)
      ) {
        abandonCredential();
        return "unavailable";
      }
      confirmationStarted = true;
      const guards = terminalGuardSnapshot(input, output);
      if (guards === undefined) {
        abandonCredential();
        return "unavailable";
      }
      let result: SetupInteractiveConfirmationResult;
      try {
        result = await terminal.confirmExactPlan(
          Object.freeze({
            input,
            output,
            prompt: SETUP_CONFIRMATION_PROMPT,
            maxInputBytes: SETUP_EXACT_CONFIRMATION_MAX_BYTES,
          }),
        );
      } catch {
        restoreProtectedTerminal(terminal, "cancelled");
        abandonCredential();
        return "unavailable";
      }
      let restored = false;
      let attested = false;
      try {
        restored = restoreProtectedTerminal(terminal, "completed");
        attested =
          terminalInputIsSecretReady(input, false) &&
          terminalOutputIsReady(output) &&
          terminalGuardsRestored(input, output, guards);
      } catch {
        restored = false;
        attested = false;
      }
      if (!credentialReady || !restored || !attested) {
        restoreProtectedTerminal(terminal, "cancelled");
        abandonCredential();
        return "unavailable";
      }
      const normalized =
        result === "confirmed" || result === "declined"
          ? result
          : "unavailable";
      if (normalized !== "confirmed") {
        abandonCredential();
      }
      return normalized;
    },
  );

  return Object.freeze({
    credentialInput,
    presenter: ports.presenter,
    confirmation: ports.confirmation,
  });
}
