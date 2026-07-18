import { CredentialError } from "./errors.js";
import type { ApiOriginPolicy } from "./origin.js";
import {
  parseCredentialDocument,
  type CredentialV1,
} from "./schema.js";

export const MAX_CREDENTIAL_DOCUMENT_BYTES = 16_384;

function invalidDocument(): never {
  throw new CredentialError("invalid_credential_document");
}

function wipeBytes(bytes: Uint8Array): void {
  try {
    Uint8Array.prototype.fill.call(bytes, 0);
  } catch {
    // Best effort only; never replace the safe parse result or error.
  }
}

export function decodeCredentialDocumentBytes(input: Uint8Array): string {
  let bytes: Uint8Array;
  try {
    if (
      !(input instanceof Uint8Array) ||
      input.byteLength === 0 ||
      input.byteLength > MAX_CREDENTIAL_DOCUMENT_BYTES
    ) {
      return invalidDocument();
    }
    bytes = Uint8Array.prototype.slice.call(input);
  } catch {
    return invalidDocument();
  }

  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      // Preserve a leading BOM so canonical parsing rejects it.
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    return invalidDocument();
  } finally {
    wipeBytes(bytes);
  }
}

export function parseCredentialDocumentBytes(
  input: Uint8Array,
  originPolicy: ApiOriginPolicy = "https-only",
): CredentialV1 {
  return parseCredentialDocument(
    decodeCredentialDocumentBytes(input),
    originPolicy,
  );
}
