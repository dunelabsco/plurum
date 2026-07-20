import {
  HOST_ACTION_KINDS,
  HOST_IDS,
  type HostActionKind,
  type HostConfiguration,
  type HostId,
  type HostMcpDescriptor,
  type HostMarketplaceDescriptor,
  type HostPluginDescriptor,
  type HostRollbackRecipe,
  type ObservedSlot,
} from "./contracts.js";
import { HostError } from "./errors.js";
import {
  RECONCILIATION_ACTION_STAGES,
  RECONCILIATION_HOST_STAGES,
  RECONCILIATION_JOURNAL_KIND,
  RECONCILIATION_JOURNAL_SCHEMA_VERSION,
  RECONCILIATION_OPERATION_STAGES,
  type ReconciliationActionId,
  type ReconciliationActionStage,
  type ReconciliationHostStage,
  type ReconciliationJournalActionV1,
  type ReconciliationJournalHostV1,
  type ReconciliationJournalLeaseNonce,
  type ReconciliationJournalV1,
  type ReconciliationOperationId,
  type ReconciliationOperationStage,
  type ReconciliationTimestamp,
} from "./journal-contracts.js";
import {
  containsHostControlCharacter,
  containsHostSensitiveMaterial,
} from "./privacy.js";
import {
  compareCanonicalVersions,
  parseCanonicalVersion,
} from "./version.js";

export const MAX_RECONCILIATION_JOURNAL_CHARACTERS = 65_536;
export const MAX_RECONCILIATION_JOURNAL_BYTES = 65_536;

const MAX_PUBLIC_VALUE_CHARACTERS = 2_048;
const MAX_REVISION_CHARACTERS = 512;

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ACTION_ID =
  /^(?:claude-code|codex):0[1-4]:(?:add-marketplace|install-plugin|update-plugin|enable-plugin)$/u;
const CANONICAL_TIMESTAMP =
  /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/u;
const OPAQUE_REVISION = /^[A-Za-z0-9._~:+@=-]{1,512}$/u;
const FILE_URL = /^file:/iu;
const ROOTED_FILESYSTEM_PATH = /^(?:\/|\\|[A-Za-z]:)/u;
const RELATIVE_FILESYSTEM_PATH = /^(?:~[^\\/]*|\.\.?)(?:[\\/]|$)/u;
const ENVIRONMENT_FILESYSTEM_PATH =
  /^(?:\$(?:HOME|XDG_CONFIG_HOME|XDG_STATE_HOME|APPDATA|LOCALAPPDATA|USERPROFILE)(?:[\\/]|$)|\$\{(?:HOME|XDG_CONFIG_HOME|XDG_STATE_HOME|APPDATA|LOCALAPPDATA|USERPROFILE)\}(?:[\\/]|$)|%(?:HOME|XDG_CONFIG_HOME|XDG_STATE_HOME|APPDATA|LOCALAPPDATA|USERPROFILE)%(?:[\\/]|$))/iu;

const JOURNAL_FIELDS = [
  "schema_version",
  "kind",
  "operation_id",
  "created_at",
  "updated_at",
  "stage",
  "hosts",
] as const;
const HOST_FIELDS = [
  "host",
  "stage",
  "executable_revision",
  "baseline_revision",
  "owned_state_revision",
  "actions",
] as const;
const ACTION_FIELDS = [
  "action_id",
  "kind",
  "stage",
  "before",
  "after",
  "rollback",
] as const;
const CONFIGURATION_FIELDS = [
  "marketplace",
  "plugin",
  "pluginMcp",
  "directMcp",
] as const;
const SLOT_ABSENT_FIELDS = ["status"] as const;
const SLOT_PRESENT_FIELDS = ["status", "value"] as const;
const MARKETPLACE_FIELDS = ["name", "source"] as const;
const PLUGIN_FIELDS = ["name", "source", "version", "enabled"] as const;
const MCP_FIELDS = ["name", "endpoint"] as const;

function invalidJournal(): never {
  throw new HostError("invalid_reconciliation_journal");
}

function unsupportedSchema(): never {
  throw new HostError("unsupported_reconciliation_journal_schema");
}

function hasExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === fields.length && keys.every((key) => fields.includes(key))
  );
}

function plainRecord(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return invalidJournal();
  }

  let keys: readonly string[];
  let symbols: readonly symbol[];
  try {
    keys = Object.keys(input);
    symbols = Object.getOwnPropertySymbols(input);
  } catch {
    return invalidJournal();
  }
  if (symbols.length !== 0) {
    return invalidJournal();
  }

  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of keys) {
    try {
      result[key] = (input as Readonly<Record<string, unknown>>)[key];
    } catch {
      return invalidJournal();
    }
  }
  return result;
}

function plainArray(input: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(input)) {
    return invalidJournal();
  }

  let keys: readonly string[];
  let symbols: readonly symbol[];
  let length: number;
  try {
    keys = Object.keys(input);
    symbols = Object.getOwnPropertySymbols(input);
    length = input.length;
  } catch {
    return invalidJournal();
  }
  if (
    symbols.length !== 0 ||
    !Number.isInteger(length) ||
    length < 0 ||
    length > maximum ||
    keys.length !== length
  ) {
    return invalidJournal();
  }

  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    if (keys[index] !== String(index)) {
      return invalidJournal();
    }
    try {
      result.push(input[index]);
    } catch {
      return invalidJournal();
    }
  }
  return result;
}

function safeString(
  value: unknown,
  maximum: number,
  options: Readonly<{
    allowEmpty?: boolean;
    pattern?: RegExp;
  }> = {},
): string {
  if (
    typeof value !== "string" ||
    (!options.allowEmpty && value.length === 0) ||
    value.length > maximum ||
    containsHostControlCharacter(value) ||
    containsHostSensitiveMaterial(value) ||
    (options.pattern !== undefined && !options.pattern.test(value))
  ) {
    return invalidJournal();
  }
  return value;
}

function rejectsFilesystemPath(value: string): boolean {
  return (
    FILE_URL.test(value) ||
    ROOTED_FILESYSTEM_PATH.test(value) ||
    RELATIVE_FILESYSTEM_PATH.test(value) ||
    ENVIRONMENT_FILESYSTEM_PATH.test(value)
  );
}

function publicIdentifier(value: unknown): string {
  const text = safeString(value, MAX_PUBLIC_VALUE_CHARACTERS);
  return rejectsFilesystemPath(text) ? invalidJournal() : text;
}

function canonicalVersion(value: unknown): string {
  try {
    return parseCanonicalVersion(value).canonical;
  } catch {
    return invalidJournal();
  }
}

function publicEndpoint(value: unknown): string {
  const text = publicIdentifier(value);
  let endpoint: URL;
  try {
    endpoint = new URL(text);
  } catch {
    return invalidJournal();
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.hash !== "" ||
    endpoint.toString() !== text
  ) {
    return invalidJournal();
  }
  return text;
}

function opaqueRevision(value: unknown): string {
  const text = safeString(value, MAX_REVISION_CHARACTERS, {
    pattern: OPAQUE_REVISION,
  });
  return rejectsFilesystemPath(text) ? invalidJournal() : text;
}

function uuid(value: unknown): string {
  return safeString(value, 36, { pattern: UUID_V4 });
}

function actionId(value: unknown): ReconciliationActionId {
  return safeString(value, 64, {
    pattern: ACTION_ID,
  }) as ReconciliationActionId;
}

function timestamp(value: unknown): ReconciliationTimestamp {
  const text = safeString(value, 24, { pattern: CANONICAL_TIMESTAMP });
  try {
    if (new Date(text).toISOString() !== text) {
      return invalidJournal();
    }
  } catch {
    return invalidJournal();
  }
  return text as ReconciliationTimestamp;
}

function enumValue<const Values extends readonly string[]>(
  input: unknown,
  values: Values,
): Values[number] {
  if (
    typeof input !== "string" ||
    !values.includes(input as Values[number])
  ) {
    return invalidJournal();
  }
  return input as Values[number];
}

function exactRecord(
  input: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  const value = plainRecord(input);
  if (!hasExactFields(value, fields)) {
    return invalidJournal();
  }
  return value;
}

function validateMarketplaceDescriptor(
  input: unknown,
): HostMarketplaceDescriptor {
  const value = exactRecord(input, MARKETPLACE_FIELDS);
  if (value.name !== "plurum") {
    return invalidJournal();
  }
  return Object.freeze({
    name: "plurum",
    source: publicIdentifier(value.source),
  });
}

function validatePluginDescriptor(input: unknown): HostPluginDescriptor {
  const value = exactRecord(input, PLUGIN_FIELDS);
  if (value.name !== "plurum" || typeof value.enabled !== "boolean") {
    return invalidJournal();
  }
  return Object.freeze({
    name: "plurum",
    source: publicIdentifier(value.source),
    version: canonicalVersion(value.version),
    enabled: value.enabled,
  });
}

function validateMcpDescriptor(input: unknown): HostMcpDescriptor {
  const value = exactRecord(input, MCP_FIELDS);
  if (value.name !== "plurum") {
    return invalidJournal();
  }
  return Object.freeze({
    name: "plurum",
    endpoint: publicEndpoint(value.endpoint),
  });
}

function validateSlot<Value>(
  input: unknown,
  validateValue: (value: unknown) => Value,
): ObservedSlot<Value> {
  const value = plainRecord(input);
  const status = value.status;
  if (status === "absent") {
    if (!hasExactFields(value, SLOT_ABSENT_FIELDS)) {
      return invalidJournal();
    }
    return Object.freeze({ status: "absent" });
  }
  if (status === "present") {
    if (!hasExactFields(value, SLOT_PRESENT_FIELDS)) {
      return invalidJournal();
    }
    return Object.freeze({
      status: "present",
      value: validateValue(value.value),
    });
  }
  /*
   * Recovery must never act from an ambiguous before/after snapshot. An
   * ambiguous observation belongs in preflight and blocks journal creation.
   */
  return invalidJournal();
}

function validateConfiguration(input: unknown): HostConfiguration {
  const value = exactRecord(input, CONFIGURATION_FIELDS);
  const marketplace = validateSlot(
    value.marketplace,
    validateMarketplaceDescriptor,
  );
  const plugin = validateSlot(value.plugin, validatePluginDescriptor);
  const pluginMcp = validateSlot(value.pluginMcp, validateMcpDescriptor);
  const directMcp = validateSlot(value.directMcp, validateMcpDescriptor);

  if (
    directMcp.status !== "absent" ||
    (plugin.status === "absent" && pluginMcp.status !== "absent") ||
    (plugin.status === "present" &&
      plugin.value.enabled !== (pluginMcp.status === "present"))
  ) {
    return invalidJournal();
  }

  return Object.freeze({
    marketplace,
    plugin,
    pluginMcp,
    directMcp,
  });
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateRollback(
  input: unknown,
  kind: HostActionKind,
  before: HostConfiguration,
): HostRollbackRecipe {
  const value = plainRecord(input);

  if (
    kind === "add-marketplace" &&
    hasExactFields(value, ["kind"]) &&
    value.kind === "remove-cli-created-marketplace"
  ) {
    return Object.freeze({ kind: "remove-cli-created-marketplace" });
  }
  if (
    kind === "install-plugin" &&
    hasExactFields(value, ["kind"]) &&
    value.kind === "remove-cli-created-plugin"
  ) {
    return Object.freeze({ kind: "remove-cli-created-plugin" });
  }
  if (
    kind === "enable-plugin" &&
    hasExactFields(value, ["kind"]) &&
    value.kind === "restore-plugin-disabled"
  ) {
    return Object.freeze({ kind: "restore-plugin-disabled" });
  }
  if (
    kind === "update-plugin" &&
    hasExactFields(value, ["kind", "pluginVersion"]) &&
    value.kind === "restore-plugin-version" &&
    before.plugin.status === "present"
  ) {
    const pluginVersion = canonicalVersion(value.pluginVersion);
    if (pluginVersion !== before.plugin.value.version) {
      return invalidJournal();
    }
    return Object.freeze({
      kind: "restore-plugin-version",
      pluginVersion,
    });
  }
  return invalidJournal();
}

function validateActionSemantics(
  kind: HostActionKind,
  before: HostConfiguration,
  after: HostConfiguration,
): void {
  if (sameValue(before, after) || !sameValue(before.directMcp, after.directMcp)) {
    return invalidJournal();
  }

  if (kind === "add-marketplace") {
    if (
      before.marketplace.status !== "absent" ||
      after.marketplace.status !== "present" ||
      !sameValue(before.plugin, after.plugin) ||
      !sameValue(before.pluginMcp, after.pluginMcp)
    ) {
      return invalidJournal();
    }
    return;
  }

  if (!sameValue(before.marketplace, after.marketplace)) {
    return invalidJournal();
  }
  if (kind === "install-plugin") {
    if (
      before.plugin.status !== "absent" ||
      before.pluginMcp.status !== "absent" ||
      after.plugin.status !== "present" ||
      !after.plugin.value.enabled ||
      after.pluginMcp.status !== "present"
    ) {
      return invalidJournal();
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
      return invalidJournal();
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
    return invalidJournal();
  }
}

function validateAction(
  input: unknown,
  host: HostId,
  index: number,
): ReconciliationJournalActionV1 {
  const value = exactRecord(input, ACTION_FIELDS);
  const validatedActionId = actionId(value.action_id);
  const kind = enumValue(value.kind, HOST_ACTION_KINDS);
  if (
    validatedActionId !==
    `${host}:${String(index + 1).padStart(2, "0")}:${kind}`
  ) {
    return invalidJournal();
  }
  const stage = enumValue(
    value.stage,
    RECONCILIATION_ACTION_STAGES,
  ) as ReconciliationActionStage;
  const before = validateConfiguration(value.before);
  const after = validateConfiguration(value.after);
  validateActionSemantics(kind, before, after);
  const rollback = validateRollback(value.rollback, kind, before);

  return Object.freeze({
    action_id: validatedActionId,
    kind,
    stage,
    before,
    after,
    rollback,
  });
}

function validateHost(input: unknown): ReconciliationJournalHostV1 {
  const value = exactRecord(input, HOST_FIELDS);
  const host = enumValue(value.host, HOST_IDS) as HostId;
  const stage = enumValue(
    value.stage,
    RECONCILIATION_HOST_STAGES,
  ) as ReconciliationHostStage;
  const executableRevision = opaqueRevision(value.executable_revision);
  const baselineRevision = opaqueRevision(value.baseline_revision);
  const ownedStateRevision =
    value.owned_state_revision === null
      ? null
      : opaqueRevision(value.owned_state_revision);
  const actionInputs = plainArray(value.actions, HOST_ACTION_KINDS.length);
  if (actionInputs.length === 0) {
    return invalidJournal();
  }

  const actions = actionInputs.map((action, index) =>
    validateAction(action, host, index),
  );
  const actionIds = new Set(actions.map((action) => action.action_id));
  const actionKinds = new Set(actions.map((action) => action.kind));
  if (
    actionIds.size !== actions.length ||
    actionKinds.size !== actions.length
  ) {
    return invalidJournal();
  }

  for (let index = 1; index < actions.length; index += 1) {
    const previous = actions[index - 1];
    const current = actions[index];
    if (
      previous === undefined ||
      current === undefined ||
      !sameValue(previous.after, current.before)
    ) {
      return invalidJournal();
    }
  }

  return Object.freeze({
    host,
    stage,
    executable_revision: executableRevision,
    baseline_revision: baselineRevision,
    owned_state_revision: ownedStateRevision,
    actions: Object.freeze(actions),
  });
}

function matchesForwardActionProgress(
  stages: readonly ReconciliationActionStage[],
  activeStage: ReconciliationActionStage,
): boolean {
  const activeIndex = stages.indexOf(activeStage);
  return (
    activeIndex >= 0 &&
    stages.lastIndexOf(activeStage) === activeIndex &&
    stages
      .slice(0, activeIndex)
      .every((stage) => stage === "verified") &&
    stages
      .slice(activeIndex + 1)
      .every((stage) => stage === "pending")
  );
}

function matchesVerifiedPrefix(
  stages: readonly ReconciliationActionStage[],
): boolean {
  const firstPending = stages.indexOf("pending");
  const verifiedEnd = firstPending < 0 ? stages.length : firstPending;
  return (
    verifiedEnd > 0 &&
    stages
      .slice(0, verifiedEnd)
      .every((stage) => stage === "verified") &&
    stages
      .slice(verifiedEnd)
      .every((stage) => stage === "pending")
  );
}

function matchesCommitProgress(
  stages: readonly ReconciliationActionStage[],
): boolean {
  let cursor = 0;
  while (stages[cursor] === "committed") {
    cursor += 1;
  }
  if (stages[cursor] === "commit-started") {
    cursor += 1;
  }
  while (stages[cursor] === "verified") {
    cursor += 1;
  }
  return cursor === stages.length;
}

function matchesRollbackProgress(
  stages: readonly ReconciliationActionStage[],
  activeStage: "failed" | "rollback-started" | null,
): boolean {
  let cursor = 0;
  while (stages[cursor] === "verified") {
    cursor += 1;
  }

  if (activeStage !== null) {
    if (stages[cursor] !== activeStage) {
      return false;
    }
    cursor += 1;
  } else if (
    stages[cursor] === "failed" ||
    stages[cursor] === "rollback-started"
  ) {
    return false;
  }

  const rolledBackStart = cursor;
  while (stages[cursor] === "rolled-back") {
    cursor += 1;
  }
  const rolledBackCount = cursor - rolledBackStart;
  while (stages[cursor] === "pending") {
    cursor += 1;
  }
  return (
    cursor === stages.length &&
    (activeStage !== null || rolledBackCount > 0)
  );
}

function matchesRolledBackProgress(
  stages: readonly ReconciliationActionStage[],
): boolean {
  let cursor = 0;
  while (stages[cursor] === "rolled-back") {
    cursor += 1;
  }
  if (cursor === 0) {
    return false;
  }
  while (stages[cursor] === "pending") {
    cursor += 1;
  }
  return cursor === stages.length;
}

function matchesFirstActionPreMutationFailure(
  stages: readonly ReconciliationActionStage[],
  allowedFirstStages: readonly ReconciliationActionStage[],
): boolean {
  return (
    stages.length > 0 &&
    allowedFirstStages.includes(stages[0] as ReconciliationActionStage) &&
    stages.slice(1).every((stage) => stage === "pending")
  );
}

function validateHostOwnership(
  host: ReconciliationJournalHostV1,
  stages: readonly ReconciliationActionStage[],
): void {
  const ownsState = host.owned_state_revision !== null;
  let valid: boolean;

  switch (host.stage) {
    case "pending":
    case "rolled-back":
      valid = !ownsState;
      break;
    case "apply-started":
      valid = ownsState === (stages.indexOf("apply-started") > 0);
      break;
    case "apply-complete":
    case "verify-started":
    case "verify-complete":
    case "commit-started":
    case "committed":
      valid = ownsState;
      break;
    case "failed":
      valid =
        ownsState ||
        matchesFirstActionPreMutationFailure(stages, ["failed"]);
      break;
    case "rollback-started":
      valid =
        ownsState ||
        matchesFirstActionPreMutationFailure(stages, [
          "failed",
          "rollback-started",
          "rolled-back",
        ]);
      break;
  }

  if (!valid) {
    return invalidJournal();
  }
}

function validateHostProgress(host: ReconciliationJournalHostV1): void {
  const stages = host.actions.map((action) => action.stage);
  let valid: boolean;
  switch (host.stage) {
    case "pending":
      valid = stages.every((stage) => stage === "pending");
      break;
    case "apply-started":
      valid = matchesForwardActionProgress(stages, "apply-started");
      break;
    case "apply-complete":
      valid = matchesForwardActionProgress(stages, "applied");
      break;
    case "verify-started":
      valid = matchesForwardActionProgress(stages, "verify-started");
      break;
    case "verify-complete":
      valid = matchesVerifiedPrefix(stages);
      break;
    case "commit-started":
      valid = matchesCommitProgress(stages);
      break;
    case "committed":
      valid = stages.every((stage) => stage === "committed");
      break;
    case "rollback-started":
      valid =
        matchesRollbackProgress(stages, "failed") ||
        matchesRollbackProgress(stages, "rollback-started") ||
        matchesRollbackProgress(stages, null);
      break;
    case "rolled-back":
      valid = matchesRolledBackProgress(stages);
      break;
    case "failed":
      valid = matchesRollbackProgress(stages, "failed");
      break;
  }
  if (!valid) {
    return invalidJournal();
  }
  validateHostOwnership(host, stages);
}

function validateOperationProgress(
  stage: ReconciliationOperationStage,
  hosts: readonly ReconciliationJournalHostV1[],
): void {
  for (const host of hosts) {
    validateHostProgress(host);
  }

  let cursor = 0;
  while (hosts[cursor]?.stage === "committed") {
    cursor += 1;
  }
  const committedCount = cursor;
  const candidate = hosts[cursor];
  const active =
    candidate !== undefined && candidate.stage !== "pending"
      ? candidate
      : undefined;
  if (active !== undefined) {
    cursor += 1;
  }
  if (
    hosts
      .slice(cursor)
      .some((host) => host.stage !== "pending")
  ) {
    return invalidJournal();
  }

  const activeStage = active?.stage;
  const valid =
    (stage === "apply" &&
      ((committedCount === 0 &&
        active === undefined &&
        hosts.every((host) => host.stage === "pending")) ||
        activeStage === "apply-started" ||
        activeStage === "apply-complete")) ||
    (stage === "verify" &&
      (activeStage === "verify-started" ||
        activeStage === "verify-complete")) ||
    (stage === "commit" &&
      (activeStage === "commit-started" ||
        (active === undefined && committedCount > 0))) ||
    (stage === "rollback" && activeStage === "rollback-started") ||
    (stage === "failed" &&
      (activeStage === "failed" || activeStage === "rolled-back")) ||
    (stage === "complete" &&
      active === undefined &&
      committedCount === hosts.length);

  if (!valid) {
    return invalidJournal();
  }
}

function canonicalText(journal: ReconciliationJournalV1): string {
  return `${JSON.stringify(journal, null, 2)}\n`;
}

function wipeBytes(bytes: Uint8Array): void {
  try {
    Uint8Array.prototype.fill.call(bytes, 0);
  } catch {
    // Best effort only; never replace the safe parse result or error.
  }
}

export function validateReconciliationOperationId(
  value: unknown,
): ReconciliationOperationId {
  return uuid(value) as ReconciliationOperationId;
}

export function validateReconciliationActionId(
  value: unknown,
): ReconciliationActionId {
  return actionId(value);
}

export function validateReconciliationJournalLeaseNonce(
  value: unknown,
): ReconciliationJournalLeaseNonce {
  return uuid(value) as ReconciliationJournalLeaseNonce;
}

export function validateReconciliationJournalDocument(
  input: unknown,
): ReconciliationJournalV1 {
  let value: Record<string, unknown>;
  try {
    value = plainRecord(input);
  } catch {
    return invalidJournal();
  }

  let schemaVersion: unknown;
  try {
    schemaVersion = value.schema_version;
  } catch {
    return invalidJournal();
  }
  if (
    typeof schemaVersion === "number" &&
    Number.isInteger(schemaVersion) &&
    schemaVersion !== RECONCILIATION_JOURNAL_SCHEMA_VERSION
  ) {
    return unsupportedSchema();
  }

  try {
    if (
      schemaVersion !== RECONCILIATION_JOURNAL_SCHEMA_VERSION ||
      !hasExactFields(value, JOURNAL_FIELDS) ||
      value.kind !== RECONCILIATION_JOURNAL_KIND
    ) {
      return invalidJournal();
    }

    const operationId = validateReconciliationOperationId(value.operation_id);
    const createdAt = timestamp(value.created_at);
    const updatedAt = timestamp(value.updated_at);
    if (updatedAt < createdAt) {
      return invalidJournal();
    }
    const stage = enumValue(
      value.stage,
      RECONCILIATION_OPERATION_STAGES,
    ) as ReconciliationOperationStage;
    if (
      value.hosts === undefined
    ) {
      return invalidJournal();
    }
    const hostInputs = plainArray(value.hosts, HOST_IDS.length);
    if (hostInputs.length === 0) {
      return invalidJournal();
    }
    const hosts = hostInputs.map((host) => validateHost(host));
    if (new Set(hosts.map((host) => host.host)).size !== hosts.length) {
      return invalidJournal();
    }
    const expectedOrder = HOST_IDS.filter((host) =>
      hosts.some((entry) => entry.host === host),
    );
    if (
      hosts.some((host, index) => host.host !== expectedOrder[index])
    ) {
      return invalidJournal();
    }
    validateOperationProgress(stage, hosts);

    return Object.freeze({
      schema_version: RECONCILIATION_JOURNAL_SCHEMA_VERSION,
      kind: RECONCILIATION_JOURNAL_KIND,
      operation_id: operationId,
      created_at: createdAt,
      updated_at: updatedAt,
      stage,
      hosts: Object.freeze(hosts),
    });
  } catch (error) {
    if (
      error instanceof HostError &&
      error.code === "unsupported_reconciliation_journal_schema"
    ) {
      throw error;
    }
    return invalidJournal();
  }
}

export function serializeReconciliationJournalDocument(
  journal: ReconciliationJournalV1,
): string {
  const text = canonicalText(validateReconciliationJournalDocument(journal));
  if (text.length > MAX_RECONCILIATION_JOURNAL_CHARACTERS) {
    return invalidJournal();
  }
  return text;
}

export function parseReconciliationJournalDocument(
  input: unknown,
): ReconciliationJournalV1 {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > MAX_RECONCILIATION_JOURNAL_CHARACTERS
  ) {
    return invalidJournal();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch {
    return invalidJournal();
  }
  const journal = validateReconciliationJournalDocument(parsed);
  if (input !== canonicalText(journal)) {
    return invalidJournal();
  }
  return journal;
}

export function decodeReconciliationJournalDocumentBytes(
  input: Uint8Array,
): string {
  let bytes: Uint8Array;
  try {
    if (
      !(input instanceof Uint8Array) ||
      input.byteLength === 0 ||
      input.byteLength > MAX_RECONCILIATION_JOURNAL_BYTES
    ) {
      return invalidJournal();
    }
    bytes = Uint8Array.prototype.slice.call(input);
  } catch {
    return invalidJournal();
  }

  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      // Preserve a leading BOM so canonical parsing rejects it.
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    return invalidJournal();
  } finally {
    wipeBytes(bytes);
  }
}

export function serializeReconciliationJournalDocumentBytes(
  journal: ReconciliationJournalV1,
): Uint8Array {
  const bytes = new TextEncoder().encode(
    serializeReconciliationJournalDocument(journal),
  );
  if (bytes.byteLength > MAX_RECONCILIATION_JOURNAL_BYTES) {
    wipeBytes(bytes);
    return invalidJournal();
  }
  return bytes;
}

export function parseReconciliationJournalDocumentBytes(
  input: Uint8Array,
): ReconciliationJournalV1 {
  return parseReconciliationJournalDocument(
    decodeReconciliationJournalDocumentBytes(input),
  );
}
