const INVALID_JSON_OBJECT_MESSAGE = "The JSON object is invalid.";

function invalidJsonObject(): never {
  throw new SyntaxError(INVALID_JSON_OBJECT_MESSAGE);
}

function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (
    text[index] === " " ||
    text[index] === "\t" ||
    text[index] === "\n" ||
    text[index] === "\r"
  ) {
    index += 1;
  }
  return index;
}

function scanString(text: string, start: number): number {
  if (text[start] !== '"') {
    return invalidJsonObject();
  }
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === '"') {
      return index + 1;
    }
    if (character === "\\") {
      index += 2;
    } else {
      index += 1;
    }
  }
  return invalidJsonObject();
}

function scanComposite(text: string, start: number): number {
  const opening = text[start];
  if (opening !== "{" && opening !== "[") {
    return invalidJsonObject();
  }
  const stack: string[] = [opening];
  let index = start + 1;

  while (index < text.length && stack.length > 0) {
    const character = text[index];
    if (character === '"') {
      index = scanString(text, index);
      continue;
    }
    if (character === "{" || character === "[") {
      stack.push(character);
      index += 1;
      continue;
    }
    if (character === "}" || character === "]") {
      const expected = character === "}" ? "{" : "[";
      if (stack.pop() !== expected) {
        return invalidJsonObject();
      }
    }
    index += 1;
  }

  return stack.length === 0 ? index : invalidJsonObject();
}

function scanValue(text: string, start: number): number {
  if (text[start] === '"') {
    return scanString(text, start);
  }
  if (text[start] === "{" || text[start] === "[") {
    return scanComposite(text, start);
  }

  let index = start;
  while (
    index < text.length &&
    text[index] !== "," &&
    text[index] !== "}"
  ) {
    index += 1;
  }
  return index;
}

function rejectDuplicateTopLevelKeys(text: string): void {
  let index = skipWhitespace(text, 0);
  if (text[index] !== "{") {
    return invalidJsonObject();
  }
  index = skipWhitespace(text, index + 1);
  if (text[index] === "}") {
    return;
  }

  const keys = new Set<string>();
  while (index < text.length) {
    const keyStart = index;
    const keyEnd = scanString(text, keyStart);
    let key: unknown;
    try {
      key = JSON.parse(text.slice(keyStart, keyEnd)) as unknown;
    } catch {
      return invalidJsonObject();
    }
    if (typeof key !== "string" || keys.has(key)) {
      return invalidJsonObject();
    }
    keys.add(key);

    index = skipWhitespace(text, keyEnd);
    if (text[index] !== ":") {
      return invalidJsonObject();
    }
    index = skipWhitespace(text, index + 1);
    index = skipWhitespace(text, scanValue(text, index));

    if (text[index] === "}") {
      return;
    }
    if (text[index] !== ",") {
      return invalidJsonObject();
    }
    index = skipWhitespace(text, index + 1);
  }
  return invalidJsonObject();
}

export function parseStrictJsonObject(
  text: string,
): Readonly<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return invalidJsonObject();
    }
    rejectDuplicateTopLevelKeys(text);
    return Object.freeze(parsed as Record<string, unknown>);
  } catch {
    return invalidJsonObject();
  }
}
