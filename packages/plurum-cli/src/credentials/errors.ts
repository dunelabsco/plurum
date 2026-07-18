export type CredentialErrorCode =
  | "invalid_api_origin"
  | "invalid_credential_document"
  | "invalid_credential_origin"
  | "invalid_credential_path"
  | "unsupported_credential_schema";

const SAFE_MESSAGES: Readonly<Record<CredentialErrorCode, string>> = Object.freeze({
  invalid_api_origin: "The Plurum API origin is invalid.",
  invalid_credential_document: "The Plurum credential file is invalid.",
  invalid_credential_origin:
    "The Plurum credential file contains an invalid API origin.",
  invalid_credential_path: "The Plurum credential location is invalid.",
  unsupported_credential_schema:
    "The Plurum credential file uses an unsupported schema version.",
});

export class CredentialError extends Error {
  readonly code: CredentialErrorCode;

  constructor(code: CredentialErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "CredentialError";
    this.code = code;
  }
}
