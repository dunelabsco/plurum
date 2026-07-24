export type HostErrorCode =
  | "invalid_host_observation"
  | "invalid_host_version"
  | "invalid_host_process_request"
  | "host_output_invalid"
  | "host_output_too_large"
  | "invalid_reconciliation_plan"
  | "invalid_reconciliation_journal"
  | "unsupported_reconciliation_journal_schema"
  | "reconciliation_busy"
  | "reconciliation_conflict"
  | "reconciliation_failed";

const HOST_ERROR_MESSAGES: Readonly<Record<HostErrorCode, string>> =
  Object.freeze({
    invalid_host_observation: "The host state could not be verified.",
    invalid_host_version: "The host version is invalid.",
    invalid_host_process_request: "The host command request is invalid.",
    host_output_invalid: "The host command returned invalid output.",
    host_output_too_large: "The host command returned too much output.",
    invalid_reconciliation_plan: "The host setup plan is invalid.",
    invalid_reconciliation_journal:
      "The host setup recovery record is invalid.",
    unsupported_reconciliation_journal_schema:
      "The host setup recovery record uses an unsupported schema.",
    reconciliation_busy: "Another host setup operation is already active.",
    reconciliation_conflict:
      "Host configuration changed while Plurum was reconciling it.",
    reconciliation_failed: "Plurum could not reconcile the host configuration.",
  });

export class HostError extends Error {
  constructor(readonly code: HostErrorCode) {
    super(HOST_ERROR_MESSAGES[code]);
    this.name = "HostError";
  }
}
