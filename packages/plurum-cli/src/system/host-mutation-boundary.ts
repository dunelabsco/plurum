import {
  HOST_ACTION_KINDS,
  type HostAction,
  type HostApplyRequest,
  type HostConfiguration,
  type HostId,
  type HostMutationResult,
  type HostRollbackRecipe,
  type HostRollbackRequest,
} from "../hosts/contracts.js";
import { copyHostConfiguration } from "../hosts/inspection.js";
import {
  containsHostControlCharacter,
  containsHostSensitiveMaterial,
} from "../hosts/privacy.js";
import {
  compareCanonicalVersions,
  parseCanonicalVersion,
} from "../hosts/version.js";
import { CapabilityPolicyError } from "./errors.js";

const REVISION = /^[A-Za-z0-9._~:+@=-]{1,512}$/u;
const FILE_URL = /^file:/iu;
const ROOTED_PATH = /^(?:\/|\\|[A-Za-z]:)/u;
const RELATIVE_PATH = /^(?:~[^\\/]*|\.\.?)(?:[\\/]|$)/u;
const ENVIRONMENT_PATH =
  /^(?:\$(?:HOME|XDG_CONFIG_HOME|XDG_STATE_HOME|APPDATA|LOCALAPPDATA|USERPROFILE)(?:[\\/]|$)|\$\{(?:HOME|XDG_CONFIG_HOME|XDG_STATE_HOME|APPDATA|LOCALAPPDATA|USERPROFILE)\}(?:[\\/]|$)|%(?:HOME|XDG_CONFIG_HOME|XDG_STATE_HOME|APPDATA|LOCALAPPDATA|USERPROFILE)%(?:[\\/]|$))/iu;

type DataRecord = Readonly<Record<string, unknown>>;

function reject(operation: string): never {
  throw new CapabilityPolicyError("hosts", operation);
}

function dataRecord(
  value: unknown,
  fields: readonly string[],
  operation: string,
  requireFrozen = true,
): DataRecord {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      (requireFrozen && !Object.isFrozen(value))
    ) {
      return reject(operation);
    }
    const names = Object.getOwnPropertyNames(value);
    if (
      names.length !== fields.length ||
      names.some((name) => !fields.includes(name))
    ) {
      return reject(operation);
    }
    const result: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")
      ) {
        return reject(operation);
      }
      result[field] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (error instanceof CapabilityPolicyError) {
      throw error;
    }
    return reject(operation);
  }
}

function requireDeeplyFrozen(
  value: unknown,
  operation: string,
  seen = new WeakSet<object>(),
): void {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return;
  }
  try {
    if (
      Array.isArray(value) ||
      !Object.isFrozen(value) ||
      Object.getOwnPropertySymbols(value).length !== 0
    ) {
      return reject(operation);
    }
    seen.add(value);
    for (const name of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")
      ) {
        return reject(operation);
      }
      requireDeeplyFrozen(descriptor.value, operation, seen);
    }
  } catch (error) {
    if (error instanceof CapabilityPolicyError) {
      throw error;
    }
    return reject(operation);
  }
}

function revision(value: unknown, operation: string): string {
  if (
    typeof value !== "string" ||
    !REVISION.test(value) ||
    containsHostControlCharacter(value) ||
    containsHostSensitiveMaterial(value) ||
    FILE_URL.test(value) ||
    ROOTED_PATH.test(value) ||
    RELATIVE_PATH.test(value) ||
    ENVIRONMENT_PATH.test(value)
  ) {
    return reject(operation);
  }
  return value;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function publicIdentifier(value: string, operation: string): void {
  if (
    FILE_URL.test(value) ||
    ROOTED_PATH.test(value) ||
    RELATIVE_PATH.test(value) ||
    ENVIRONMENT_PATH.test(value) ||
    containsHostControlCharacter(value) ||
    containsHostSensitiveMaterial(value)
  ) {
    return reject(operation);
  }
}

function endpoint(value: string, operation: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return reject(operation);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    parsed.toString() !== value
  ) {
    return reject(operation);
  }
}

function configuration(
  value: unknown,
  operation: string,
): HostConfiguration {
  requireDeeplyFrozen(value, operation);
  let copied: HostConfiguration;
  try {
    copied = copyHostConfiguration(value);
  } catch {
    return reject(operation);
  }
  if (
    copied.marketplace.status === "ambiguous" ||
    copied.plugin.status === "ambiguous" ||
    copied.pluginMcp.status === "ambiguous" ||
    copied.directMcp.status !== "absent" ||
    (copied.plugin.status === "absent" &&
      copied.pluginMcp.status !== "absent") ||
    (copied.plugin.status === "present" &&
      copied.plugin.value.enabled !==
        (copied.pluginMcp.status === "present"))
  ) {
    return reject(operation);
  }
  if (copied.marketplace.status === "present") {
    publicIdentifier(copied.marketplace.value.source, operation);
  }
  if (copied.plugin.status === "present") {
    publicIdentifier(copied.plugin.value.source, operation);
    try {
      parseCanonicalVersion(copied.plugin.value.version);
    } catch {
      return reject(operation);
    }
  }
  if (copied.pluginMcp.status === "present") {
    endpoint(copied.pluginMcp.value.endpoint, operation);
  }
  return copied;
}

function rollback(
  value: unknown,
  kind: HostAction["kind"],
  before: HostConfiguration,
  operation: string,
): HostRollbackRecipe {
  const fields =
    kind === "update-plugin"
      ? ["kind", "pluginVersion"]
      : ["kind"];
  const record = dataRecord(value, fields, operation);
  const expected =
    kind === "add-marketplace"
      ? "remove-cli-created-marketplace"
      : kind === "install-plugin"
        ? "remove-cli-created-plugin"
        : kind === "enable-plugin"
          ? "restore-plugin-disabled"
          : "restore-plugin-version";
  if (record.kind !== expected) {
    return reject(operation);
  }
  if (kind !== "update-plugin") {
    return Object.freeze({ kind: expected }) as HostRollbackRecipe;
  }
  if (
    before.plugin.status !== "present" ||
    typeof record.pluginVersion !== "string" ||
    record.pluginVersion !== before.plugin.value.version
  ) {
    return reject(operation);
  }
  try {
    parseCanonicalVersion(record.pluginVersion);
  } catch {
    return reject(operation);
  }
  return Object.freeze({
    kind: "restore-plugin-version",
    pluginVersion: record.pluginVersion,
  });
}

function validateActionTransition(
  kind: HostAction["kind"],
  before: HostConfiguration,
  after: HostConfiguration,
  operation: string,
): void {
  if (
    sameValue(before, after) ||
    !sameValue(before.directMcp, after.directMcp)
  ) {
    return reject(operation);
  }
  if (kind === "add-marketplace") {
    if (
      before.marketplace.status !== "absent" ||
      after.marketplace.status !== "present" ||
      !sameValue(before.plugin, after.plugin) ||
      !sameValue(before.pluginMcp, after.pluginMcp)
    ) {
      return reject(operation);
    }
    return;
  }
  if (!sameValue(before.marketplace, after.marketplace)) {
    return reject(operation);
  }
  if (kind === "install-plugin") {
    if (
      before.plugin.status !== "absent" ||
      before.pluginMcp.status !== "absent" ||
      after.plugin.status !== "present" ||
      !after.plugin.value.enabled ||
      after.pluginMcp.status !== "present"
    ) {
      return reject(operation);
    }
    return;
  }
  if (kind === "update-plugin") {
    if (
      before.plugin.status !== "present" ||
      after.plugin.status !== "present" ||
      compareCanonicalVersions(
        after.plugin.value.version,
        before.plugin.value.version,
      ) <= 0 ||
      before.plugin.value.source !== after.plugin.value.source ||
      before.plugin.value.enabled !== after.plugin.value.enabled ||
      !sameValue(before.pluginMcp, after.pluginMcp)
    ) {
      return reject(operation);
    }
    return;
  }
  if (
    before.plugin.status !== "present" ||
    after.plugin.status !== "present" ||
    before.plugin.value.enabled ||
    !after.plugin.value.enabled ||
    before.pluginMcp.status !== "absent" ||
    after.pluginMcp.status !== "present" ||
    before.plugin.value.source !== after.plugin.value.source ||
    before.plugin.value.version !== after.plugin.value.version
  ) {
    return reject(operation);
  }
}

function action(
  value: unknown,
  host: HostId,
  operation: string,
): HostAction {
  requireDeeplyFrozen(value, operation);
  const record = dataRecord(
    value,
    ["id", "host", "kind", "before", "after", "rollback", "display"],
    operation,
  );
  if (
    record.host !== host ||
    typeof record.kind !== "string" ||
    !HOST_ACTION_KINDS.includes(record.kind as HostAction["kind"])
  ) {
    return reject(operation);
  }
  const kind = record.kind as HostAction["kind"];
  if (
    typeof record.id !== "string" ||
    !new RegExp(
      `^${host}:0[1-4]:${kind}$`,
      "u",
    ).test(record.id) ||
    typeof record.display !== "string" ||
    record.display.length === 0 ||
    record.display.length > 256 ||
    containsHostControlCharacter(record.display) ||
    containsHostSensitiveMaterial(record.display)
  ) {
    return reject(operation);
  }
  const before = configuration(record.before, operation);
  const after = configuration(record.after, operation);
  validateActionTransition(kind, before, after, operation);
  return Object.freeze({
    id: record.id,
    host,
    kind,
    before,
    after,
    rollback: rollback(record.rollback, kind, before, operation),
    display: record.display,
  });
}

export function snapshotHostApplyRequest(
  value: unknown,
  host: HostId,
): HostApplyRequest {
  const operation = "applyRequest";
  const record = dataRecord(
    value,
    [
      "host",
      "executableRevision",
      "expectedBeforeRevision",
      "expectedBefore",
      "action",
    ],
    operation,
  );
  if (record.host !== host) {
    return reject(operation);
  }
  const copiedAction = action(record.action, host, operation);
  const expectedBefore = configuration(record.expectedBefore, operation);
  if (!sameValue(expectedBefore, copiedAction.before)) {
    return reject(operation);
  }
  return Object.freeze({
    host,
    executableRevision: revision(record.executableRevision, operation),
    expectedBeforeRevision: revision(
      record.expectedBeforeRevision,
      operation,
    ),
    expectedBefore,
    action: copiedAction,
  });
}

export function snapshotHostRollbackRequest(
  value: unknown,
  host: HostId,
): HostRollbackRequest {
  const operation = "rollbackRequest";
  const record = dataRecord(
    value,
    [
      "host",
      "executableRevision",
      "expectedAfterRevision",
      "expectedAfter",
      "action",
    ],
    operation,
  );
  if (record.host !== host) {
    return reject(operation);
  }
  const copiedAction = action(record.action, host, operation);
  const expectedAfter = configuration(record.expectedAfter, operation);
  if (!sameValue(expectedAfter, copiedAction.after)) {
    return reject(operation);
  }
  return Object.freeze({
    host,
    executableRevision: revision(record.executableRevision, operation),
    expectedAfterRevision: revision(
      record.expectedAfterRevision,
      operation,
    ),
    expectedAfter,
    action: copiedAction,
  });
}

export function snapshotHostMutationResult(
  value: unknown,
  operation: "applyResult" | "rollbackResult",
): HostMutationResult {
  let record: DataRecord;
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getOwnPropertySymbols(value).length !== 0
    ) {
      return reject(operation);
    }
    const names = Object.getOwnPropertyNames(value);
    if (
      !(
        (names.length === 1 && names[0] === "status") ||
        (names.length === 2 &&
          names.includes("status") &&
          names.includes("stateRevision"))
      )
    ) {
      return reject(operation);
    }
    const snapshot: Record<string, unknown> = Object.create(
      null,
    ) as Record<string, unknown>;
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")
      ) {
        return reject(operation);
      }
      snapshot[name] = descriptor.value;
    }
    record = snapshot;
  } catch (error) {
    if (error instanceof CapabilityPolicyError) {
      throw error;
    }
    return reject(operation);
  }
  if (
    (record.status === "failed" ||
      record.status === "precondition-failed") &&
    !Object.hasOwn(record, "stateRevision")
  ) {
    return Object.freeze({ status: record.status });
  }
  if (
    record.status !== "changed" ||
    !Object.hasOwn(record, "stateRevision")
  ) {
    return reject(operation);
  }
  return Object.freeze({
    status: "changed",
    stateRevision: revision(record.stateRevision, operation),
  });
}
