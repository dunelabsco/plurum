import { describe, expect, it } from "vitest";

import {
  CodexDotenvError,
  inspectCodexDotenv,
  MAX_CODEX_DOTENV_BYTES,
  rewriteCodexDotenv,
} from "../src/credentials/codex-dotenv.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const KEY_TEXT = `plrm_live_${"A".repeat(43)}`;

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function changed(
  input: string | Uint8Array,
  key = KEY_TEXT,
  newline: "lf" | "crlf" = "lf",
): Uint8Array {
  const result = rewriteCodexDotenv(
    typeof input === "string" ? bytes(input) : input,
    bytes(key),
    newline,
  );
  expect(result.status).toBe("changed");
  if (result.status !== "changed") {
    throw new Error("expected changed dotenv bytes");
  }
  return result.bytes;
}

function text(
  input: string | Uint8Array,
  key = KEY_TEXT,
  newline: "lf" | "crlf" = "lf",
): string {
  return decoder.decode(changed(input, key, newline));
}

function expectCode(
  operation: () => unknown,
  code:
    | "codex_dotenv_invalid"
    | "codex_dotenv_too_large"
    | "codex_dotenv_duplicate"
    | "codex_dotenv_key_invalid",
): void {
  try {
    operation();
    throw new Error("expected CodexDotenvError");
  } catch (error) {
    expect(error).toBeInstanceOf(CodexDotenvError);
    expect((error as CodexDotenvError).code).toBe(code);
    expect((error as Error).message).not.toContain("plrm_live_");
  }
}

describe("Codex dotenv byte-preserving rewrite", () => {
  it("shares exact target detection with deferred registration inspection", () => {
    expect(inspectCodexDotenv(bytes("# comment\nOTHER=value\n"))).toEqual({
      status: "absent",
    });
    expect(
      inspectCodexDotenv(
        bytes(`# comment\nexport PLURUM_API_KEY = '${KEY_TEXT}'\n`),
      ),
    ).toEqual({ status: "present" });
    expectCode(
      () =>
        inspectCodexDotenv(
          bytes(
            `PLURUM_API_KEY=${KEY_TEXT}\nPLURUM_API_KEY=${KEY_TEXT}\n`,
          ),
        ),
      "codex_dotenv_duplicate",
    );
  });

  it("creates one canonical assignment with the selected empty-file newline", () => {
    expect(text("", KEY_TEXT, "lf")).toBe(
      `PLURUM_API_KEY=${KEY_TEXT}\n`,
    );
    expect(text("", KEY_TEXT, "crlf")).toBe(
      `PLURUM_API_KEY=${KEY_TEXT}\r\n`,
    );
  });

  it("preserves a leading UTF-8 BOM", () => {
    const input = Uint8Array.of(0xef, 0xbb, 0xbf);
    const output = changed(input);

    expect([...output.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(decoder.decode(output.slice(3))).toBe(
      `\nPLURUM_API_KEY=${KEY_TEXT}\n`,
    );
  });

  it("preserves a BOM-tainted first assignment and appends an effective one", () => {
    const input = Uint8Array.from([
      0xef,
      0xbb,
      0xbf,
      ...bytes("PLURUM_API_KEY=old\r\nOTHER=one\r\n"),
    ]);
    const output = changed(input);

    expect([...output.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(decoder.decode(output.slice(3))).toBe(
      `PLURUM_API_KEY=old\r\nOTHER=one\r\nPLURUM_API_KEY=${KEY_TEXT}\r\n`,
    );
    expect(rewriteCodexDotenv(output, bytes(KEY_TEXT), "lf")).toEqual({
      status: "unchanged",
    });
  });

  it("keeps every BOM-tainted unrelated prefix byte unchanged", () => {
    const input = Uint8Array.from([
      0xef,
      0xbb,
      0xbf,
      ...bytes("OTHER=secret\n"),
    ]);
    const output = changed(input);

    expect(output.slice(0, input.byteLength)).toEqual(input);
    expect(decoder.decode(output.slice(input.byteLength))).toBe(
      `PLURUM_API_KEY=${KEY_TEXT}\n`,
    );
  });

  it("appends using the exact existing LF or CRLF style", () => {
    expect(text("FIRST=one\nSECOND=two\n")).toBe(
      `FIRST=one\nSECOND=two\nPLURUM_API_KEY=${KEY_TEXT}\n`,
    );
    expect(text("FIRST=one\r\nSECOND=two\r\n")).toBe(
      `FIRST=one\r\nSECOND=two\r\nPLURUM_API_KEY=${KEY_TEXT}\r\n`,
    );
  });

  it("preserves mixed delimiters and uses the first observed style when appending", () => {
    expect(text("FIRST=one\nSECOND=two\r\n")).toBe(
      `FIRST=one\nSECOND=two\r\nPLURUM_API_KEY=${KEY_TEXT}\n`,
    );
    expect(text("FIRST=one\r\nSECOND=two")).toBe(
      `FIRST=one\r\nSECOND=two\r\nPLURUM_API_KEY=${KEY_TEXT}`,
    );
  });

  it("preserves whether a nonempty input has a final newline", () => {
    expect(text("FIRST=one")).toBe(
      `FIRST=one\nPLURUM_API_KEY=${KEY_TEXT}`,
    );
    expect(text("FIRST=one\r\n", KEY_TEXT, "lf")).toBe(
      `FIRST=one\r\nPLURUM_API_KEY=${KEY_TEXT}\r\n`,
    );
  });

  it("accepts and preserves dotenvy-valid trailing whitespace at EOF", () => {
    expect(text("OTHER=value   ")).toBe(
      `OTHER=value   \nPLURUM_API_KEY=${KEY_TEXT}`,
    );
    expect(text("OTHER=value\n   ")).toBe(
      `OTHER=value\n   \nPLURUM_API_KEY=${KEY_TEXT}`,
    );
  });

  it.each([
    [
      "plain",
      "BEFORE=1\nPLURUM_API_KEY=old\nAFTER=2\n",
      `BEFORE=1\nPLURUM_API_KEY=${KEY_TEXT}\nAFTER=2\n`,
    ],
    [
      "single quoted",
      "PLURUM_API_KEY = 'old-value'  # keep me\n",
      `PLURUM_API_KEY = '${KEY_TEXT}'  # keep me\n`,
    ],
    [
      "double quoted",
      '  export  PLURUM_API_KEY = "old-value"\t# keep me\r\nOTHER=1\r\n',
      `  export  PLURUM_API_KEY = "${KEY_TEXT}"\t# keep me\r\nOTHER=1\r\n`,
    ],
    [
      "empty before comment",
      "PLURUM_API_KEY=   # configured by somebody\n",
      `PLURUM_API_KEY=${KEY_TEXT}   # configured by somebody\n`,
    ],
    [
      "unquoted hash",
      "PLURUM_API_KEY=old#literal\n",
      `PLURUM_API_KEY=${KEY_TEXT}\n`,
    ],
    [
      "adjacent empty-value comment",
      "PLURUM_API_KEY=# configured by somebody\n",
      `PLURUM_API_KEY=${KEY_TEXT} # configured by somebody\n`,
    ],
  ])("replaces only the value bytes for %s syntax", (_label, input, expected) => {
    expect(text(input)).toBe(expected);
  });

  it("preserves every unrelated byte, including Unicode comments and ordering", () => {
    const input =
      "# café — untouched\n" +
      "ZED='alpha beta'\n" +
      "PLURUM_API_KEY = old\t # target comment\n" +
      "JSON={\"a\":1}\n";
    const expected =
      "# café — untouched\n" +
      "ZED='alpha beta'\n" +
      `PLURUM_API_KEY = ${KEY_TEXT}\t # target comment\n` +
      "JSON={\"a\":1}\n";

    expect(text(input)).toBe(expected);
  });

  it("recognizes dotenvy Unicode whitespace around a target assignment", () => {
    const input =
      "\u00a0PLURUM_API_KEY\u2003=\u3000old\u2009# keep Unicode spacing\n";
    expect(text(input)).toBe(
      `\u00a0PLURUM_API_KEY\u2003=\u3000${KEY_TEXT}\u2009# keep Unicode spacing\n`,
    );
  });

  it("rejects duplicates hidden behind dotenvy Unicode whitespace", () => {
    expectCode(
      () =>
        rewriteCodexDotenv(
          bytes(
            `\u00a0PLURUM_API_KEY=old\nPLURUM_API_KEY=${KEY_TEXT}\n`,
          ),
          bytes(KEY_TEXT),
          "lf",
        ),
      "codex_dotenv_duplicate",
    );
  });

  it("leaves dotted dotenv identifiers unrelated to the target", () => {
    const input = "PLURUM_API_KEY.EXTRA=untouched\n";
    expect(text(input)).toBe(
      `${input}PLURUM_API_KEY=${KEY_TEXT}\n`,
    );
  });

  it("supports an export prefix separated by dotenvy Unicode whitespace", () => {
    expect(text("export\u00a0PLURUM_API_KEY=old\n")).toBe(
      `export\u00a0PLURUM_API_KEY=${KEY_TEXT}\n`,
    );
  });

  it.each([
    [
      "double quoted",
      'OTHER="first\nPLURUM_API_KEY=not-an-assignment\nlast"\n',
    ],
    [
      "single quoted",
      "OTHER='first\nPLURUM_API_KEY=not-an-assignment\nlast'\n",
    ],
  ])(
    "does not rewrite a target-looking physical line inside an unrelated %s record",
    (_label, input) => {
      expect(text(input)).toBe(
        `${input}PLURUM_API_KEY=${KEY_TEXT}\n`,
      );
    },
  );

  it("does not let quote characters inside a comment create a multiline record", () => {
    const input = 'OTHER=one # "not a quote\n';
    expect(text(input)).toBe(
      `${input}PLURUM_API_KEY=${KEY_TEXT}\n`,
    );
  });

  it("keeps target-looking lines inside dotenvy's multiline comment-grouping edge case", () => {
    const input =
      'OTHER=# "open\n' +
      "PLURUM_API_KEY=not-an-assignment\n" +
      'close"\n';
    expect(text(input)).toBe(
      `${input}PLURUM_API_KEY=${KEY_TEXT}\n`,
    );
  });

  it("supports comments after repeated ASCII value whitespace", () => {
    expect(text("PLURUM_API_KEY=old  # keep me\n")).toBe(
      `PLURUM_API_KEY=${KEY_TEXT}  # keep me\n`,
    );
    expect(text("PLURUM_API_KEY='old'  # keep me\n")).toBe(
      `PLURUM_API_KEY='${KEY_TEXT}'  # keep me\n`,
    );
    expect(text("PLURUM_API_KEY='old'\t \t# keep me\n")).toBe(
      `PLURUM_API_KEY='${KEY_TEXT}'\t \t# keep me\n`,
    );
  });

  it("ignores comments and non-target identifiers", () => {
    const input =
      `# PLURUM_API_KEY=${"B".repeat(20)}\n` +
      "MY_PLURUM_API_KEY=unchanged\n" +
      "exportPLURUM_API_KEY=unchanged\n";
    expect(text(input)).toBe(
      `${input}PLURUM_API_KEY=${KEY_TEXT}\n`,
    );
  });

  it("returns an immutable unchanged disposition without returning secret bytes", () => {
    const input = bytes(`PLURUM_API_KEY='${KEY_TEXT}' # exact\n`);
    const key = bytes(KEY_TEXT);
    const inputBefore = input.slice();
    const keyBefore = key.slice();

    const result = rewriteCodexDotenv(input, key, "lf");

    expect(result).toEqual({ status: "unchanged" });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.hasOwn(result, "bytes")).toBe(false);
    expect(input).toEqual(inputBefore);
    expect(key).toEqual(keyBefore);
  });

  it("does not mutate caller-owned input or key buffers on change", () => {
    const input = bytes("OTHER=value\n");
    const key = bytes(KEY_TEXT);
    const inputBefore = input.slice();
    const keyBefore = key.slice();

    const result = rewriteCodexDotenv(input, key, "lf");

    expect(result.status).toBe("changed");
    expect(input).toEqual(inputBefore);
    expect(key).toEqual(keyBefore);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("is byte-for-byte idempotent on the second rewrite", () => {
    const first = changed("# comment\r\nOTHER=value\r\n");
    const second = rewriteCodexDotenv(first, bytes(KEY_TEXT), "lf");

    expect(second).toEqual({ status: "unchanged" });
  });

  it("does not accept an inline hash suffix as part of an exact credential", () => {
    expect(text(`PLURUM_API_KEY=${KEY_TEXT}#literal\n`)).toBe(
      `PLURUM_API_KEY=${KEY_TEXT}\n`,
    );
  });

  it("fails closed for concatenated quoted and unquoted target syntax", () => {
    expectCode(
      () =>
        rewriteCodexDotenv(
          bytes(`PLURUM_API_KEY='${KEY_TEXT}'#literal\n`),
          bytes(KEY_TEXT),
          "lf",
        ),
      "codex_dotenv_invalid",
    );
  });

  it("fails closed for a multiline target value", () => {
    expectCode(
      () =>
        rewriteCodexDotenv(
          bytes('PLURUM_API_KEY="old\ncontinued"\n'),
          bytes(KEY_TEXT),
          "lf",
        ),
      "codex_dotenv_invalid",
    );
  });

  it.each([
    [
      "ordinary duplicate",
      "PLURUM_API_KEY=first\nPLURUM_API_KEY=second\n",
      "codex_dotenv_duplicate",
    ],
    [
      "export duplicate",
      "export PLURUM_API_KEY=first\nPLURUM_API_KEY=second\n",
      "codex_dotenv_duplicate",
    ],
    [
      "noncanonical target casing",
      "Plurum_Api_Key=value\n",
      "codex_dotenv_invalid",
    ],
    [
      "missing equals",
      "PLURUM_API_KEY value\n",
      "codex_dotenv_invalid",
    ],
    [
      "unterminated quote",
      "PLURUM_API_KEY='value\n",
      "codex_dotenv_invalid",
    ],
    [
      "trailing quoted data",
      "PLURUM_API_KEY='value' trailing\n",
      "codex_dotenv_invalid",
    ],
    ["bare carriage return", "ONE=1\rTWO=2", "codex_dotenv_invalid"],
    ["NUL", "ONE=1\u0000TWO=2", "codex_dotenv_invalid"],
    ["bidi control", "# unsafe\u202ecomment\n", "codex_dotenv_invalid"],
    ["interior BOM", "ONE=1\n# \ufeff\n", "codex_dotenv_invalid"],
  ] as const)("rejects %s", (_label, input, code) => {
    expectCode(
      () => rewriteCodexDotenv(bytes(input), bytes(KEY_TEXT), "lf"),
      code,
    );
  });

  it("rejects malformed UTF-8 without decoding the file", () => {
    expectCode(
      () =>
        rewriteCodexDotenv(
          Uint8Array.of(0x4f, 0x4e, 0x45, 0x3d, 0xc0, 0xaf),
          bytes(KEY_TEXT),
          "lf",
        ),
      "codex_dotenv_invalid",
    );
  });

  it.each([
    ["wrong prefix", `plrm_test_${"A".repeat(43)}`],
    ["too short", "plrm_live_short"],
    ["invalid character", `plrm_live_${"A".repeat(20)}!`],
    ["newline", `plrm_live_${"A".repeat(20)}\n`],
  ])("rejects an invalid API key: %s", (_label, key) => {
    expectCode(
      () => rewriteCodexDotenv(bytes(""), bytes(key), "lf"),
      "codex_dotenv_key_invalid",
    );
  });

  it("rejects non-Uint8Array inputs and invalid newline selectors", () => {
    expectCode(
      () =>
        rewriteCodexDotenv(
          "not bytes" as unknown as Uint8Array,
          bytes(KEY_TEXT),
          "lf",
        ),
      "codex_dotenv_invalid",
    );
    expectCode(
      () =>
        rewriteCodexDotenv(
          bytes(""),
          bytes(KEY_TEXT),
          "native" as unknown as "lf",
        ),
      "codex_dotenv_invalid",
    );
  });

  it("bounds both the input and rewritten output", () => {
    expectCode(
      () =>
        rewriteCodexDotenv(
          new Uint8Array(MAX_CODEX_DOTENV_BYTES + 1),
          bytes(KEY_TEXT),
          "lf",
        ),
      "codex_dotenv_too_large",
    );

    const full = new Uint8Array(MAX_CODEX_DOTENV_BYTES);
    full.fill(0x41);
    expectCode(
      () => rewriteCodexDotenv(full, bytes(KEY_TEXT), "lf"),
      "codex_dotenv_too_large",
    );
  });

  it("does not reflect credential-bearing content in any failure", () => {
    const secret = `plrm_live_${"Z".repeat(43)}`;
    try {
      rewriteCodexDotenv(
        bytes(`PLURUM_API_KEY=${secret}\nPLURUM_API_KEY=duplicate\n`),
        bytes(KEY_TEXT),
        "lf",
      );
      throw new Error("expected failure");
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });
});
