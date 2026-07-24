import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  SETUP_CREDENTIAL_INPUT_MAX_BYTES,
  SETUP_CREDENTIAL_KEY_MAX_BYTES,
  SETUP_CREDENTIAL_KEY_MIN_BYTES,
  claimSetupCredentialInputBytes,
  discardSetupCredentialInput,
  retainFramedSetupCredentialInput,
  type SetupCredentialInputFraming,
  type SetupCredentialInputIdentity,
} from "../src/commands/setup-credential-input.js";
import { wipeUint8Array } from "../src/data/uint8-array.js";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
const PREFIX = "plrm_live_";
const CANARY = "plrm_live_PROTECTED_INPUT_CANARY";

function encoded(text: string): Uint8Array {
  return ENCODER.encode(text);
}

function keyWithSuffixLength(length: number): string {
  return `${PREFIX}${"a".repeat(length)}`;
}

function retain(
  text: string,
  framing: SetupCredentialInputFraming = "explicit-eof",
): Readonly<{
  source: Uint8Array;
  identity: SetupCredentialInputIdentity | undefined;
}> {
  const source = encoded(text);
  return {
    source,
    identity: retainFramedSetupCredentialInput(source, framing),
  };
}

function claimText(identity: SetupCredentialInputIdentity): string {
  const bytes = claimSetupCredentialInputBytes(identity);
  if (bytes === undefined) {
    throw new Error("expected retained credential bytes");
  }
  try {
    return DECODER.decode(bytes);
  } finally {
    wipeUint8Array(bytes);
  }
}

describe("protected setup credential material", () => {
  it("pins the byte bounds to the existing API-key grammar", () => {
    expect(SETUP_CREDENTIAL_KEY_MIN_BYTES).toBe(20);
    expect(SETUP_CREDENTIAL_KEY_MAX_BYTES).toBe(210);
    expect(SETUP_CREDENTIAL_INPUT_MAX_BYTES).toBe(212);
  });

  it.each([
    ["minimum", 10],
    ["mixed alphabet", 26],
    ["maximum", 200],
  ])("retains a valid %s key without retaining its transport buffer", (_label, suffixLength) => {
    const key = keyWithSuffixLength(suffixLength);
    const { source, identity } = retain(key);

    expect(identity).toBeDefined();
    expect([...source]).toEqual(new Array(source.byteLength).fill(0));
    expect(claimText(identity as SetupCredentialInputIdentity)).toBe(key);
    expect(
      claimSetupCredentialInputBytes(
        identity as SetupCredentialInputIdentity,
      ),
    ).toBeUndefined();
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("accepts one exact %s terminator in interactive mode", (_label, terminator) => {
    const key = keyWithSuffixLength(16);
    const { source, identity } = retain(
      `${key}${terminator}`,
      "interactive-line",
    );

    expect(identity).toBeDefined();
    expect(source.every((byte) => byte === 0)).toBe(true);
    expect(claimText(identity as SetupCredentialInputIdentity)).toBe(key);
  });

  it.each([
    ["bare EOF", ""],
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("accepts the practical explicit-stdin %s framing", (_label, terminator) => {
    const key = keyWithSuffixLength(16);
    const { identity } = retain(`${key}${terminator}`);

    expect(identity).toBeDefined();
    expect(claimText(identity as SetupCredentialInputIdentity)).toBe(key);
  });

  it.each([
    ["short suffix", keyWithSuffixLength(9), "explicit-eof"],
    ["long suffix", keyWithSuffixLength(201), "explicit-eof"],
    ["wrong prefix case", `PLRM_live_${"a".repeat(12)}`, "explicit-eof"],
    ["partial prefix", `plrm_liv_${"a".repeat(12)}`, "explicit-eof"],
    ["space", `${PREFIX}${"a".repeat(10)} `, "explicit-eof"],
    ["equals", `${PREFIX}${"a".repeat(10)}=`, "explicit-eof"],
    ["slash", `${PREFIX}${"a".repeat(10)}/`, "explicit-eof"],
    ["NUL", `${PREFIX}${"a".repeat(10)}\0`, "explicit-eof"],
    ["tab", `${PREFIX}${"a".repeat(10)}\t`, "explicit-eof"],
    ["non-ASCII", `${PREFIX}${"a".repeat(10)}é`, "explicit-eof"],
    ["Unicode lookalike", `ｐｌｒｍ＿ｌｉｖｅ＿${"a".repeat(10)}`, "explicit-eof"],
    ["bare CR", `${keyWithSuffixLength(12)}\r`, "explicit-eof"],
    ["second line", `${keyWithSuffixLength(12)}\nyes\n`, "explicit-eof"],
    ["duplicate newline", `${keyWithSuffixLength(12)}\n\n`, "explicit-eof"],
    ["interactive EOF", keyWithSuffixLength(12), "interactive-line"],
    ["interactive bare CR", `${keyWithSuffixLength(12)}\r`, "interactive-line"],
  ] as const)("rejects %s and wipes the transferred bytes", (_label, text, framing) => {
    const { source, identity } = retain(text, framing);

    expect(identity).toBeUndefined();
    expect(source.every((byte) => byte === 0)).toBe(true);
  });

  it("rejects byte 213 before attempting to retain material", () => {
    const source = new Uint8Array(
      SETUP_CREDENTIAL_INPUT_MAX_BYTES + 1,
    );
    source.fill(0x61);

    expect(
      retainFramedSetupCredentialInput(source, "explicit-eof"),
    ).toBeUndefined();
    expect(source.every((byte) => byte === 0)).toBe(true);
  });

  it("issues an empty frozen identity that disappears from JSON", () => {
    const { identity } = retain(CANARY);
    expect(identity).toBeDefined();

    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.keys(identity as object)).toEqual([]);
    expect(Object.getOwnPropertySymbols(identity as object)).toEqual([]);
    expect(JSON.stringify(identity)).toBeUndefined();
    expect(JSON.stringify({ credential: identity })).toBe("{}");
    expect(JSON.stringify({ credential: identity })).not.toContain(CANARY);

    const bytes = claimSetupCredentialInputBytes(
      identity as SetupCredentialInputIdentity,
    );
    expect(bytes).toBeDefined();
    wipeUint8Array(bytes);
  });

  it("discards one live identity without affecting another", () => {
    const first = retain(keyWithSuffixLength(12)).identity;
    const second = retain(keyWithSuffixLength(13)).identity;
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    expect(
      discardSetupCredentialInput(first as SetupCredentialInputIdentity),
    ).toEqual({ status: "discarded" });
    expect(
      discardSetupCredentialInput(first as SetupCredentialInputIdentity),
    ).toEqual({ status: "precondition-failed" });
    expect(
      claimSetupCredentialInputBytes(
        first as SetupCredentialInputIdentity,
      ),
    ).toBeUndefined();
    expect(claimText(second as SetupCredentialInputIdentity)).toBe(
      keyWithSuffixLength(13),
    );
  });

  it("fails closed on forged and hostile identities or transferred buffers", () => {
    const live = retain(keyWithSuffixLength(12)).identity;
    const forged = Object.freeze(Object.create(null));
    const hostile = new Proxy(new Uint8Array([1, 2, 3]), {
      get() {
        throw new Error(CANARY);
      },
    });

    expect(
      claimSetupCredentialInputBytes(
        forged as SetupCredentialInputIdentity,
      ),
    ).toBeUndefined();
    expect(
      retainFramedSetupCredentialInput(
        hostile,
        "explicit-eof",
      ),
    ).toBeUndefined();
    expect(claimText(live as SetupCredentialInputIdentity)).toBe(
      keyWithSuffixLength(12),
    );
  });

  it("rejects shared mutable transport storage", () => {
    const source = new Uint8Array(
      new SharedArrayBuffer(SETUP_CREDENTIAL_KEY_MIN_BYTES),
    );
    source.set(encoded(keyWithSuffixLength(10)));

    expect(
      retainFramedSetupCredentialInput(source, "explicit-eof"),
    ).toBeUndefined();
    expect(source.every((byte) => byte === 0)).toBe(true);
  });

  it("keeps unsafe terminal and string-conversion APIs out of both protected boundaries", () => {
    const source = [
      "../src/commands/setup-credential-input.ts",
      "../src/adapters/node/setup-credential-input.ts",
    ]
      .map((path) =>
        readFileSync(new URL(path, import.meta.url), "utf8"),
      )
      .join("\n");

    for (const forbidden of [
      "TextDecoder",
      "Buffer.toString",
      "String.fromCharCode",
      "parseApiKey",
      "setEncoding(",
      "setRawMode(",
      "readline",
      "process.stdin",
      "process.on(",
      "stty",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
