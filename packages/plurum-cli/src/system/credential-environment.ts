import type {
  CredentialEnvironmentSnapshot,
} from "./contracts.js";

export const CREDENTIAL_ENVIRONMENT_KEYS = Object.freeze([
  "PLURUM_API_KEY",
  "PLURUM_API_URL",
  "HERMES_HOME",
  "OPENCLAW_HOME",
] as const);

const CREDENTIAL_ENVIRONMENT_KEY_SET = new Set<string>(
  CREDENTIAL_ENVIRONMENT_KEYS,
);

function invalidSnapshot(): never {
  throw new TypeError("The credential environment snapshot is invalid.");
}

export function copyCredentialEnvironmentSnapshot(
  input: unknown,
): CredentialEnvironmentSnapshot {
  try {
    if (
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.getOwnPropertySymbols(input).length !== 0
    ) {
      return invalidSnapshot();
    }

    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      return invalidSnapshot();
    }

    const ownNames = Object.getOwnPropertyNames(input);
    if (ownNames.some((name) => !CREDENTIAL_ENVIRONMENT_KEY_SET.has(name))) {
      return invalidSnapshot();
    }

    const copied: Record<string, string> = {};
    for (const name of CREDENTIAL_ENVIRONMENT_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(input, name);
      if (descriptor === undefined) {
        continue;
      }
      if (!("value" in descriptor)) {
        return invalidSnapshot();
      }
      const value = descriptor.value as unknown;
      if (value === undefined) {
        continue;
      }
      if (typeof value !== "string") {
        return invalidSnapshot();
      }
      Object.defineProperty(copied, name, {
        configurable: false,
        enumerable: name !== "PLURUM_API_KEY",
        value,
        writable: false,
      });
    }
    return Object.freeze(copied);
  } catch {
    return invalidSnapshot();
  }
}
