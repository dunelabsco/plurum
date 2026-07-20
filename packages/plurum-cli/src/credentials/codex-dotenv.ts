import {
  copyUint8Array,
  intrinsicUint8ArrayByteLength,
} from "../data/uint8-array.js";

export const MAX_CODEX_DOTENV_BYTES = 128 * 1024;

export type CodexDotenvErrorCode =
  | "codex_dotenv_invalid"
  | "codex_dotenv_too_large"
  | "codex_dotenv_duplicate"
  | "codex_dotenv_key_invalid";

const SAFE_MESSAGES: Readonly<Record<CodexDotenvErrorCode, string>> =
  Object.freeze({
    codex_dotenv_invalid:
      "The Codex credential environment file is invalid.",
    codex_dotenv_too_large:
      "The Codex credential environment file is too large.",
    codex_dotenv_duplicate:
      "The Codex credential environment file contains duplicate Plurum entries.",
    codex_dotenv_key_invalid:
      "The Plurum credential cannot be projected into Codex.",
  });

export class CodexDotenvError extends Error {
  constructor(readonly code: CodexDotenvErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "CodexDotenvError";
  }
}

export type CodexDotenvNewline = "lf" | "crlf";

export type CodexDotenvRewriteResult =
  | Readonly<{ status: "unchanged" }>
  | Readonly<{
      status: "changed";
      /*
       * Ownership transfers to the caller. These bytes may contain the Plurum
       * key and unrelated secrets from the existing .env; the native writer
       * must consume them synchronously and wipe them after its bounded write.
       */
      bytes: Uint8Array;
    }>;

interface TargetAssignment {
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly separatorAfterKey: boolean;
}

interface LogicalRecord {
  readonly start: number;
  readonly end: number;
  readonly commentStart: number | null;
  readonly multiline: boolean;
}

const UTF8_BOM = Uint8Array.of(0xef, 0xbb, 0xbf);
const TARGET_NAME = Uint8Array.from([
  0x50, 0x4c, 0x55, 0x52, 0x55, 0x4d, 0x5f, 0x41,
  0x50, 0x49, 0x5f, 0x4b, 0x45, 0x59,
]);
const TARGET_PREFIX = Uint8Array.from([
  ...TARGET_NAME,
  0x3d,
]);
const EXPORT = Uint8Array.from([0x65, 0x78, 0x70, 0x6f, 0x72, 0x74]);
const API_KEY_PREFIX = Uint8Array.from([
  0x70, 0x6c, 0x72, 0x6d, 0x5f, 0x6c, 0x69, 0x76, 0x65, 0x5f,
]);
const SET_BYTES = Uint8Array.prototype.set;
const FILL_BYTES = Uint8Array.prototype.fill;

function fail(code: CodexDotenvErrorCode): never {
  throw new CodexDotenvError(code);
}

function wipe(bytes: Uint8Array | undefined): void {
  if (bytes === undefined) {
    return;
  }
  try {
    FILL_BYTES.call(bytes, 0);
  } catch {
    // A detached owned buffer no longer exposes writable credential bytes.
  }
}

function byte(bytes: Uint8Array, index: number): number {
  return bytes[index] ?? fail("codex_dotenv_invalid");
}

function continuation(value: number): boolean {
  return value >= 0x80 && value <= 0xbf;
}

function disallowedCodePoint(value: number): boolean {
  return (
    value === 0 ||
    (value < 0x20 && value !== 0x09 && value !== 0x0a && value !== 0x0d) ||
    (value >= 0x7f && value <= 0x9f) ||
    value === 0x061c ||
    value === 0x200e ||
    value === 0x200f ||
    (value >= 0x2028 && value <= 0x202e) ||
    (value >= 0x2066 && value <= 0x206f) ||
    value === 0xfeff
  );
}

/*
 * Validate without decoding the credential-bearing file into an immutable
 * JavaScript string. A leading UTF-8 BOM is the sole U+FEFF exception.
 */
function validateUtf8(bytes: Uint8Array, start: number): void {
  let index = start;
  while (index < bytes.byteLength) {
    const first = byte(bytes, index);
    let codePoint: number;
    let width: number;

    if (first <= 0x7f) {
      codePoint = first;
      width = 1;
    } else if (first >= 0xc2 && first <= 0xdf) {
      const second = byte(bytes, index + 1);
      if (!continuation(second)) {
        return fail("codex_dotenv_invalid");
      }
      codePoint = ((first & 0x1f) << 6) | (second & 0x3f);
      width = 2;
    } else if (first >= 0xe0 && first <= 0xef) {
      const second = byte(bytes, index + 1);
      const third = byte(bytes, index + 2);
      if (
        !continuation(second) ||
        !continuation(third) ||
        (first === 0xe0 && second < 0xa0) ||
        (first === 0xed && second > 0x9f)
      ) {
        return fail("codex_dotenv_invalid");
      }
      codePoint =
        ((first & 0x0f) << 12) |
        ((second & 0x3f) << 6) |
        (third & 0x3f);
      width = 3;
    } else if (first >= 0xf0 && first <= 0xf4) {
      const second = byte(bytes, index + 1);
      const third = byte(bytes, index + 2);
      const fourth = byte(bytes, index + 3);
      if (
        !continuation(second) ||
        !continuation(third) ||
        !continuation(fourth) ||
        (first === 0xf0 && second < 0x90) ||
        (first === 0xf4 && second > 0x8f)
      ) {
        return fail("codex_dotenv_invalid");
      }
      codePoint =
        ((first & 0x07) << 18) |
        ((second & 0x3f) << 12) |
        ((third & 0x3f) << 6) |
        (fourth & 0x3f);
      width = 4;
    } else {
      return fail("codex_dotenv_invalid");
    }

    if (disallowedCodePoint(codePoint)) {
      return fail("codex_dotenv_invalid");
    }
    index += width;
  }
}

function hasLeadingBom(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= UTF8_BOM.byteLength &&
    byte(bytes, 0) === byte(UTF8_BOM, 0) &&
    byte(bytes, 1) === byte(UTF8_BOM, 1) &&
    byte(bytes, 2) === byte(UTF8_BOM, 2)
  );
}

function safeInput(input: unknown): Uint8Array {
  const length = intrinsicUint8ArrayByteLength(input);
  if (length === undefined) {
    return fail("codex_dotenv_invalid");
  }
  if (length > MAX_CODEX_DOTENV_BYTES) {
    return fail("codex_dotenv_too_large");
  }
  const copied = copyUint8Array(input, length);
  if (copied === undefined) {
    return fail("codex_dotenv_invalid");
  }
  return copied;
}

function safeApiKey(input: unknown): Uint8Array {
  const length = intrinsicUint8ArrayByteLength(input);
  if (
    length === undefined ||
    length < API_KEY_PREFIX.byteLength + 10 ||
    length > API_KEY_PREFIX.byteLength + 200
  ) {
    return fail("codex_dotenv_key_invalid");
  }
  const copied = copyUint8Array(input, length);
  if (copied === undefined) {
    return fail("codex_dotenv_key_invalid");
  }
  for (let index = 0; index < copied.byteLength; index += 1) {
    const value = byte(copied, index);
    if (index < API_KEY_PREFIX.byteLength) {
      if (value !== byte(API_KEY_PREFIX, index)) {
        wipe(copied);
        return fail("codex_dotenv_key_invalid");
      }
    } else if (
      !(
        (value >= 0x41 && value <= 0x5a) ||
        (value >= 0x61 && value <= 0x7a) ||
        (value >= 0x30 && value <= 0x39) ||
        value === 0x5f ||
        value === 0x2d
      )
    ) {
      wipe(copied);
      return fail("codex_dotenv_key_invalid");
    }
  }
  return copied;
}

interface ValidatedCodePoint {
  readonly value: number;
  readonly width: number;
}

/*
 * `validateUtf8` runs before these helpers. Keeping subsequent parsing on bytes
 * avoids creating an immutable string containing unrelated dotenv secrets.
 */
function validatedCodePoint(
  bytes: Uint8Array,
  index: number,
): ValidatedCodePoint {
  const first = byte(bytes, index);
  if (first <= 0x7f) {
    return { value: first, width: 1 };
  }
  if (first <= 0xdf) {
    return {
      value: ((first & 0x1f) << 6) | (byte(bytes, index + 1) & 0x3f),
      width: 2,
    };
  }
  if (first <= 0xef) {
    return {
      value:
        ((first & 0x0f) << 12) |
        ((byte(bytes, index + 1) & 0x3f) << 6) |
        (byte(bytes, index + 2) & 0x3f),
      width: 3,
    };
  }
  if (first <= 0xf4) {
    return {
      value:
        ((first & 0x07) << 18) |
        ((byte(bytes, index + 1) & 0x3f) << 12) |
        ((byte(bytes, index + 2) & 0x3f) << 6) |
        (byte(bytes, index + 3) & 0x3f),
      width: 4,
    };
  }
  return fail("codex_dotenv_invalid");
}

function dotenvWhitespace(value: number): boolean {
  return (
    (value >= 0x09 && value <= 0x0d) ||
    value === 0x20 ||
    value === 0x85 ||
    value === 0xa0 ||
    value === 0x1680 ||
    (value >= 0x2000 && value <= 0x200a) ||
    value === 0x2028 ||
    value === 0x2029 ||
    value === 0x202f ||
    value === 0x205f ||
    value === 0x3000
  );
}

function skipWhitespace(
  bytes: Uint8Array,
  index: number,
  end: number,
): number {
  while (index < end) {
    const decoded = validatedCodePoint(bytes, index);
    if (!dotenvWhitespace(decoded.value)) {
      break;
    }
    index += decoded.width;
  }
  return index;
}

function trimTrailingWhitespace(
  bytes: Uint8Array,
  start: number,
  end: number,
): number {
  let index = start;
  let lastNonWhitespaceEnd = start;
  while (index < end) {
    const decoded = validatedCodePoint(bytes, index);
    index += decoded.width;
    if (!dotenvWhitespace(decoded.value)) {
      lastNonWhitespaceEnd = index;
    }
  }
  return lastNonWhitespaceEnd;
}

type LogicalState =
  | "complete"
  | "whitespace"
  | "escape"
  | "single"
  | "single-escape"
  | "double"
  | "double-escape"
  | "comment";

function scanLogicalRecords(
  bytes: Uint8Array,
  contentStart: number,
): Readonly<{
  records: readonly LogicalRecord[];
  newline: CodexDotenvNewline | null;
  terminated: boolean;
}> {
  const records: LogicalRecord[] = [];
  let recordStart = contentStart;
  let recordCommentStart: number | null = null;
  let recordMultiline = false;
  let observedNewline: CodexDotenvNewline | null = null;
  let state: LogicalState = "complete";
  let leadingOnlyWhitespace = true;

  const finishRecord = (end: number, nextStart: number): void => {
    records.push(
      Object.freeze({
        start: recordStart,
        end,
        commentStart: recordCommentStart,
        multiline: recordMultiline,
      }),
    );
    recordStart = nextStart;
    recordCommentStart = null;
    recordMultiline = false;
    state = "complete";
    leadingOnlyWhitespace = true;
  };

  let index = contentStart;
  while (index < bytes.byteLength) {
    const current = byte(bytes, index);
    let newline: CodexDotenvNewline | null = null;
    let newlineWidth = 0;
    if (current === 0x0d) {
      if (
        index + 1 >= bytes.byteLength ||
        byte(bytes, index + 1) !== 0x0a
      ) {
        return fail("codex_dotenv_invalid");
      }
      newline = "crlf";
      newlineWidth = 2;
    } else if (current === 0x0a) {
      newline = "lf";
      newlineWidth = 1;
    }

    if (newline !== null) {
      observedNewline ??= newline;
      if (state === "single-escape") {
        state = "single";
      } else if (state === "double-escape") {
        state = "double";
      } else if (
        state === "escape" ||
        state === "whitespace"
      ) {
        state = "complete";
      }
      if (
        state === "single" ||
        state === "double"
      ) {
        recordMultiline = true;
        index += newlineWidth;
        continue;
      }
      finishRecord(index, index + newlineWidth);
      index += newlineWidth;
      continue;
    }

    if (state === "comment") {
      const decoded = validatedCodePoint(bytes, index);
      index += decoded.width;
      continue;
    }
    if (state === "escape") {
      const decoded = validatedCodePoint(bytes, index);
      state = "complete";
      index += decoded.width;
      continue;
    }
    if (state === "single-escape") {
      const decoded = validatedCodePoint(bytes, index);
      state = "single";
      index += decoded.width;
      continue;
    }
    if (state === "double-escape") {
      const decoded = validatedCodePoint(bytes, index);
      state = "double";
      index += decoded.width;
      continue;
    }
    if (state === "single") {
      if (current === 0x5c) {
        state = "single-escape";
      } else if (current === 0x27) {
        state = "complete";
      }
      index += 1;
      continue;
    }
    if (state === "double") {
      if (current === 0x5c) {
        state = "double-escape";
      } else if (current === 0x22) {
        state = "complete";
      }
      index += 1;
      continue;
    }

    const decoded = validatedCodePoint(bytes, index);
    const isWhitespace = dotenvWhitespace(decoded.value);
    if (current === 0x23 && leadingOnlyWhitespace) {
      state = "comment";
      recordCommentStart = index;
      index += 1;
      continue;
    }
    if (!isWhitespace) {
      leadingOnlyWhitespace = false;
    }

    if (state === "whitespace") {
      if (current === 0x23) {
        state = "comment";
        recordCommentStart = index;
      } else if (current === 0x5c) {
        state = "escape";
      } else if (current === 0x27) {
        state = "single";
      } else if (current === 0x22) {
        state = "double";
      } else {
        state = "complete";
      }
      index += decoded.width;
      continue;
    }

    if (isWhitespace) {
      state = "whitespace";
    } else if (current === 0x5c) {
      state = "escape";
    } else if (current === 0x27) {
      state = "single";
    } else if (current === 0x22) {
      state = "double";
    }
    index += decoded.width;
  }

  if (
    state === "escape" ||
    state === "single" ||
    state === "single-escape" ||
    state === "double" ||
    state === "double-escape"
  ) {
    return fail("codex_dotenv_invalid");
  }
  if (recordStart < bytes.byteLength) {
    finishRecord(bytes.byteLength, bytes.byteLength);
  }
  return Object.freeze({
    records: Object.freeze(records),
    newline: observedNewline,
    terminated:
      bytes.byteLength > contentStart &&
      byte(bytes, bytes.byteLength - 1) === 0x0a,
  });
}

function asciiIdentifierStart(value: number): boolean {
  return (
    (value >= 0x41 && value <= 0x5a) ||
    (value >= 0x61 && value <= 0x7a) ||
    value === 0x5f
  );
}

function asciiIdentifierContinue(value: number): boolean {
  return (
    asciiIdentifierStart(value) ||
    (value >= 0x30 && value <= 0x39) ||
    value === 0x2e
  );
}

function exactBytes(
  bytes: Uint8Array,
  start: number,
  end: number,
  expected: Uint8Array,
): boolean {
  if (end - start !== expected.byteLength) {
    return false;
  }
  for (let index = 0; index < expected.byteLength; index += 1) {
    if (byte(bytes, start + index) !== byte(expected, index)) {
      return false;
    }
  }
  return true;
}

function lowerAscii(value: number): number {
  return value >= 0x41 && value <= 0x5a ? value + 0x20 : value;
}

function caseInsensitiveTarget(
  bytes: Uint8Array,
  start: number,
  end: number,
): boolean {
  if (end - start !== TARGET_NAME.byteLength) {
    return false;
  }
  for (let index = 0; index < TARGET_NAME.byteLength; index += 1) {
    if (
      lowerAscii(byte(bytes, start + index)) !==
      lowerAscii(byte(TARGET_NAME, index))
    ) {
      return false;
    }
  }
  return true;
}

function identifierInRecord(
  bytes: Uint8Array,
  index: number,
  end: number,
): Readonly<{ start: number; end: number }> | null {
  if (index >= end || !asciiIdentifierStart(byte(bytes, index))) {
    return null;
  }
  const start = index;
  index += 1;
  while (index < end && asciiIdentifierContinue(byte(bytes, index))) {
    index += 1;
  }
  return Object.freeze({ start, end: index });
}

function asciiValueWhitespace(value: number): boolean {
  return value === 0x20 || value === 0x09;
}

function quotedSuffixIsSafe(
  bytes: Uint8Array,
  suffixStart: number,
  record: LogicalRecord,
): boolean {
  if (record.commentStart !== null) {
    return (
      skipWhitespace(bytes, suffixStart, record.commentStart) ===
      record.commentStart
    );
  }

  const suffixEnd = trimTrailingWhitespace(
    bytes,
    suffixStart,
    record.end,
  );
  if (suffixEnd === suffixStart) {
    return true;
  }

  let index = suffixStart;
  while (
    index < suffixEnd &&
    asciiValueWhitespace(byte(bytes, index))
  ) {
    index += 1;
  }
  return (
    index > suffixStart &&
    index < suffixEnd &&
    byte(bytes, index) === 0x23
  );
}

function simpleQuotedAssignment(
  bytes: Uint8Array,
  record: LogicalRecord,
  valueStart: number,
  quote: number,
): TargetAssignment {
  let index = valueStart + 1;
  const contentStart = index;
  while (index < record.end) {
    const value = byte(bytes, index);
    if (value === 0x0a || value === 0x0d) {
      return fail("codex_dotenv_invalid");
    }
    if (quote === 0x27 && value === 0x5c) {
      /*
       * dotenvy's logical-line iterator and value parser disagree about
       * backslashes in strong quotes. Refuse that rare shape instead of
       * rewriting against an ambiguous closing quote.
       */
      return fail("codex_dotenv_invalid");
    }
    if (quote === 0x22 && value === 0x5c) {
      if (index + 1 >= record.end) {
        return fail("codex_dotenv_invalid");
      }
      const escaped = validatedCodePoint(bytes, index + 1);
      index += 1 + escaped.width;
      continue;
    }
    if (value === quote) {
      const contentEnd = index;
      const suffixStart = index + 1;
      if (!quotedSuffixIsSafe(bytes, suffixStart, record)) {
        /*
         * Dotenvy concatenates adjacent quoted/unquoted segments. Replacing
         * only one segment could leave a suffix attached to the credential.
         */
        return fail("codex_dotenv_invalid");
      }
      return Object.freeze({
        valueStart: contentStart,
        valueEnd: contentEnd,
        separatorAfterKey: false,
      });
    }
    const decoded = validatedCodePoint(bytes, index);
    index += decoded.width;
  }
  return fail("codex_dotenv_invalid");
}

function simpleUnquotedValueEnd(
  bytes: Uint8Array,
  valueStart: number,
  record: LogicalRecord,
): number {
  const syntaxEnd = trimTrailingWhitespace(
    bytes,
    valueStart,
    record.commentStart ?? record.end,
  );
  if (record.commentStart !== null) {
    return syntaxEnd;
  }

  let index = valueStart;
  while (index < syntaxEnd) {
    if (asciiValueWhitespace(byte(bytes, index))) {
      const valueEnd = index;
      do {
        index += 1;
      } while (
        index < syntaxEnd &&
        asciiValueWhitespace(byte(bytes, index))
      );
      if (index < syntaxEnd && byte(bytes, index) === 0x23) {
        return valueEnd;
      }
      return fail("codex_dotenv_invalid");
    }
    index += validatedCodePoint(bytes, index).width;
  }
  return syntaxEnd;
}

function assignmentInRecord(
  bytes: Uint8Array,
  record: LogicalRecord,
): TargetAssignment | null {
  let index = skipWhitespace(bytes, record.start, record.end);
  if (index === record.end || byte(bytes, index) === 0x23) {
    return null;
  }

  let identifier = identifierInRecord(bytes, index, record.end);
  if (identifier === null) {
    return null;
  }
  index = skipWhitespace(bytes, identifier.end, record.end);
  if (exactBytes(bytes, identifier.start, identifier.end, EXPORT)) {
    if (index < record.end && byte(bytes, index) === 0x3d) {
      return null;
    }
    identifier = identifierInRecord(bytes, index, record.end);
    if (identifier === null) {
      return null;
    }
    index = skipWhitespace(bytes, identifier.end, record.end);
  }

  if (!caseInsensitiveTarget(bytes, identifier.start, identifier.end)) {
    return null;
  }
  if (!exactBytes(bytes, identifier.start, identifier.end, TARGET_NAME)) {
    return fail("codex_dotenv_invalid");
  }

  if (index >= record.end || byte(bytes, index) !== 0x3d) {
    return fail("codex_dotenv_invalid");
  }
  const afterEquals = index + 1;
  index = skipWhitespace(bytes, afterEquals, record.end);
  const valueStart = index;
  if (record.multiline) {
    return fail("codex_dotenv_invalid");
  }
  if (valueStart === record.end) {
    return Object.freeze({
      valueStart: afterEquals,
      valueEnd: afterEquals,
      separatorAfterKey: false,
    });
  }
  if (byte(bytes, valueStart) === 0x23) {
    return Object.freeze({
      valueStart: afterEquals,
      valueEnd: afterEquals,
      separatorAfterKey: valueStart === afterEquals,
    });
  }

  if (byte(bytes, index) === 0x22 || byte(bytes, index) === 0x27) {
    return simpleQuotedAssignment(
      bytes,
      record,
      valueStart,
      byte(bytes, valueStart),
    );
  }

  const valueEnd = simpleUnquotedValueEnd(bytes, valueStart, record);
  let cursor = valueStart;
  while (cursor < valueEnd) {
    const decoded = validatedCodePoint(bytes, cursor);
    if (
      dotenvWhitespace(decoded.value) ||
      decoded.value === 0x22 ||
      decoded.value === 0x27 ||
      decoded.value === 0x5c
    ) {
      /*
       * Complex concatenation and escape grammar is valid in dotenvy, but a
       * partial byte replacement could change its meaning. Refuse it.
       */
      return fail("codex_dotenv_invalid");
    }
    cursor += decoded.width;
  }
  if (valueEnd === valueStart) {
    return Object.freeze({
      valueStart: afterEquals,
      valueEnd: afterEquals,
      separatorAfterKey: false,
    });
  }
  return Object.freeze({
    valueStart,
    valueEnd,
    separatorAfterKey: false,
  });
}

function equalRange(
  bytes: Uint8Array,
  start: number,
  end: number,
  expected: Uint8Array,
): boolean {
  return exactBytes(bytes, start, end, expected);
}

function newlineBytes(newline: CodexDotenvNewline): Uint8Array {
  return newline === "crlf"
    ? Uint8Array.of(0x0d, 0x0a)
    : Uint8Array.of(0x0a);
}

function allocate(length: number): Uint8Array {
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_CODEX_DOTENV_BYTES
  ) {
    return fail("codex_dotenv_too_large");
  }
  try {
    return new Uint8Array(length);
  } catch {
    return fail("codex_dotenv_too_large");
  }
}

function copyRange(
  destination: Uint8Array,
  destinationOffset: number,
  source: Uint8Array,
  start: number,
  end: number,
): number {
  try {
    const view = Uint8Array.prototype.subarray.call(
      source,
      start,
      end,
    ) as Uint8Array;
    SET_BYTES.call(destination, view, destinationOffset);
    return destinationOffset + (end - start);
  } catch {
    return fail("codex_dotenv_invalid");
  }
}

function replaceAssignment(
  bytes: Uint8Array,
  key: Uint8Array,
  assignment: TargetAssignment,
): Uint8Array {
  const replacedLength =
    bytes.byteLength -
    (assignment.valueEnd - assignment.valueStart) +
    key.byteLength +
    (assignment.separatorAfterKey ? 1 : 0);
  const output = allocate(replacedLength);
  let succeeded = false;
  try {
    let offset = copyRange(
      output,
      0,
      bytes,
      0,
      assignment.valueStart,
    );
    SET_BYTES.call(output, key, offset);
    offset += key.byteLength;
    if (assignment.separatorAfterKey) {
      output[offset] = 0x20;
      offset += 1;
    }
    offset = copyRange(
      output,
      offset,
      bytes,
      assignment.valueEnd,
      bytes.byteLength,
    );
    if (offset !== output.byteLength) {
      return fail("codex_dotenv_invalid");
    }
    succeeded = true;
    return output;
  } finally {
    if (!succeeded) {
      wipe(output);
    }
  }
}

function appendAssignment(
  bytes: Uint8Array,
  contentStart: number,
  observedNewline: CodexDotenvNewline | null,
  terminated: boolean,
  defaultNewline: CodexDotenvNewline,
  prefixSeparatorWhenEmpty: boolean,
  key: Uint8Array,
): Uint8Array {
  const newline = newlineBytes(observedNewline ?? defaultNewline);
  const contentLength = bytes.byteLength - contentStart;
  const empty = contentLength === 0;
  const separatorLength = empty
    ? prefixSeparatorWhenEmpty
      ? newline.byteLength
      : 0
    : terminated
      ? 0
      : newline.byteLength;
  const trailingLength = empty || terminated ? newline.byteLength : 0;
  const length =
    bytes.byteLength +
    separatorLength +
    TARGET_PREFIX.byteLength +
    key.byteLength +
    trailingLength;
  const output = allocate(length);
  let succeeded = false;
  try {
    let offset = copyRange(output, 0, bytes, 0, bytes.byteLength);
    if (separatorLength !== 0) {
      SET_BYTES.call(output, newline, offset);
      offset += newline.byteLength;
    }
    SET_BYTES.call(output, TARGET_PREFIX, offset);
    offset += TARGET_PREFIX.byteLength;
    SET_BYTES.call(output, key, offset);
    offset += key.byteLength;
    if (trailingLength !== 0) {
      SET_BYTES.call(output, newline, offset);
      offset += newline.byteLength;
    }
    if (offset !== output.byteLength) {
      return fail("codex_dotenv_invalid");
    }
    succeeded = true;
    return output;
  } finally {
    if (!succeeded) {
      wipe(output);
    }
  }
}

export function rewriteCodexDotenv(
  input: Uint8Array,
  apiKey: Uint8Array,
  defaultNewline: CodexDotenvNewline,
): CodexDotenvRewriteResult {
  if (defaultNewline !== "lf" && defaultNewline !== "crlf") {
    return fail("codex_dotenv_invalid");
  }

  let bytes: Uint8Array | undefined;
  let key: Uint8Array | undefined;
  try {
    bytes = safeInput(input);
    key = safeApiKey(apiKey);
    const bom = hasLeadingBom(bytes);
    const contentStart = bom ? UTF8_BOM.byteLength : 0;
    validateUtf8(bytes, contentStart);
    const scanned = scanLogicalRecords(bytes, 0);

    let assignment: TargetAssignment | null = null;
    for (const record of scanned.records) {
      const candidate = assignmentInRecord(bytes, record);
      if (candidate === null) {
        continue;
      }
      if (assignment !== null) {
        return fail("codex_dotenv_duplicate");
      }
      assignment = candidate;
    }

    if (assignment !== null) {
      if (
        !assignment.separatorAfterKey &&
        equalRange(
          bytes,
          assignment.valueStart,
          assignment.valueEnd,
          key,
        )
      ) {
        return Object.freeze({ status: "unchanged" });
      }
      return Object.freeze({
        status: "changed",
        bytes: replaceAssignment(bytes, key, assignment),
      });
    }

    return Object.freeze({
      status: "changed",
      bytes: appendAssignment(
        bytes,
        contentStart,
        scanned.newline,
        scanned.terminated,
        defaultNewline,
        bom && bytes.byteLength === contentStart,
        key,
      ),
    });
  } finally {
    wipe(key);
    wipe(bytes);
  }
}
