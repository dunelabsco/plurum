import {
  containsHostControlCharacter,
  containsHostSensitiveMaterial,
} from "../hosts/privacy.js";

const MAX_DISPLAY_CHARACTERS = 32_767;
const UNSAFE_TERMINAL_FORMATTING = /[\p{Cf}\u2028\u2029]/u;

class SetupDisplayError extends Error {
  constructor() {
    super("Setup text could not be rendered safely.");
    this.name = "SetupDisplayError";
  }
}

export function setupDisplayText(
  value: unknown,
  maximumLength = MAX_DISPLAY_CHARACTERS,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    containsHostControlCharacter(value) ||
    containsHostSensitiveMaterial(value) ||
    UNSAFE_TERMINAL_FORMATTING.test(value)
  ) {
    throw new SetupDisplayError();
  }
  return value;
}
