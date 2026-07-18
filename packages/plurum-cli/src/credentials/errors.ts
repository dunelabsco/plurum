export type CredentialErrorCode =
  | "credential_fingerprint_failed"
  | "credential_document_too_large"
  | "credential_store_busy"
  | "credential_store_conflict"
  | "credential_recovery_required"
  | "credential_store_unavailable"
  | "invalid_api_origin"
  | "invalid_credential_document"
  | "invalid_credential_origin"
  | "invalid_credential_path"
  | "invalid_credential_transaction"
  | "unsafe_credential_store"
  | "unsupported_credential_schema"
  | "unsupported_credential_transaction_schema";

const SAFE_MESSAGES: Readonly<Record<CredentialErrorCode, string>> = Object.freeze({
  credential_fingerprint_failed:
    "The Plurum credential fingerprint could not be created.",
  credential_document_too_large:
    "The Plurum credential file is too large.",
  credential_store_busy:
    "Another Plurum setup operation is already running.",
  credential_store_conflict:
    "The Plurum credential store changed during setup.",
  credential_recovery_required:
    "The Plurum credential store requires safe recovery.",
  credential_store_unavailable:
    "The Plurum credential store could not be accessed safely.",
  invalid_api_origin: "The Plurum API origin is invalid.",
  invalid_credential_document: "The Plurum credential file is invalid.",
  invalid_credential_origin:
    "The Plurum credential file contains an invalid API origin.",
  invalid_credential_path: "The Plurum credential location is invalid.",
  invalid_credential_transaction:
    "The Plurum credential transaction is invalid.",
  unsafe_credential_store:
    "The Plurum credential store does not meet the required protections.",
  unsupported_credential_schema:
    "The Plurum credential file uses an unsupported schema version.",
  unsupported_credential_transaction_schema:
    "The Plurum credential transaction uses an unsupported schema version.",
});

export class CredentialError extends Error {
  readonly code: CredentialErrorCode;

  constructor(code: CredentialErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "CredentialError";
    this.code = code;
  }
}
