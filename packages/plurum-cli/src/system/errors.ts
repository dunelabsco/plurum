export type CapabilityName =
  | "filesystem"
  | "processes"
  | "network"
  | "credential-environment";

export class CapabilityUnavailableError extends Error {
  readonly code = "capability_unavailable";

  constructor(
    readonly capability: CapabilityName,
    readonly operation: string,
  ) {
    super(`The ${capability}.${operation} capability is unavailable.`);
    this.name = "CapabilityUnavailableError";
  }
}

export class CapabilityPolicyError extends Error {
  readonly code = "capability_policy_rejected";

  constructor(
    readonly capability: CapabilityName,
    readonly operation: string,
  ) {
    super(`The ${capability}.${operation} operation is outside command policy.`);
    this.name = "CapabilityPolicyError";
  }
}

export type TestBoundaryViolationCode =
  | "invalid_root"
  | "invalid_sentinel"
  | "invalid_environment"
  | "path_escape"
  | "link_rejected"
  | "network_rejected"
  | "process_rejected";

export class TestBoundaryViolationError extends Error {
  constructor(readonly code: TestBoundaryViolationCode) {
    super(`The isolated test boundary rejected an operation (${code}).`);
    this.name = "TestBoundaryViolationError";
  }
}
