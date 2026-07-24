import {
  HOST_IDS,
  type DesiredHostConfiguration,
  type HostAction,
  type HostConfiguration,
  type HostExecutableAttestation,
  type HostId,
  type HostInspection,
  type HostMarketplaceDescriptor,
  type HostMcpDescriptor,
  type HostMutationSupport,
  type HostPluginDescriptor,
  type HostPreflightPlan,
  type HostRollbackRecipe,
  type HostStateSnapshot,
  type ObservedSlot,
  type ReconciliationPlan,
} from "./contracts.js";
import { HostError } from "./errors.js";
import {
  containsHostControlCharacter,
  containsHostSensitiveMaterial,
} from "./privacy.js";
import {
  compareCanonicalVersions,
  isCanonicalVersionInRange,
  parseCanonicalVersion,
} from "./version.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP_PATTERN =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const OPAQUE_REVISION = /^[A-Za-z0-9._~:+@=-]{1,512}$/;

type Invalid = () => never;
type PlainObject = Readonly<Record<string, unknown>>;

export interface CreateReconciliationPlanInput {
  readonly operationId: string;
  readonly createdAt: string;
  readonly inspections: readonly HostInspection[];
  readonly desired: readonly DesiredHostConfiguration[];
}

function invalidObservation(): never {
  throw new HostError("invalid_host_observation");
}

function invalidPlan(): never {
  throw new HostError("invalid_reconciliation_plan");
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }

  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function plainObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  invalid: Invalid,
): PlainObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid();
  }

  let keys: readonly string[];
  let symbols: readonly symbol[];
  try {
    keys = Object.keys(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return invalid();
  }

  if (symbols.length !== 0) {
    return invalid();
  }

  const allowed = new Set([...required, ...optional]);
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const rawKey of keys) {
    if (!allowed.has(rawKey)) {
      return invalid();
    }
    try {
      result[rawKey] = (value as Readonly<Record<string, unknown>>)[rawKey];
    } catch {
      return invalid();
    }
  }
  if (required.some((key) => !Object.hasOwn(result, key))) {
    return invalid();
  }

  return result;
}

function plainArray(value: unknown, invalid: Invalid): readonly unknown[] {
  if (!Array.isArray(value)) {
    return invalid();
  }

  let names: readonly string[];
  let symbols: readonly symbol[];
  try {
    names = Object.keys(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return invalid();
  }

  if (
    symbols.length !== 0 ||
    names.length !== value.length ||
    value.length > 64
  ) {
    return invalid();
  }

  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    if (names[index] !== key) {
      return invalid();
    }
    try {
      result.push(value[index]);
    } catch {
      return invalid();
    }
  }

  return result;
}

function publicText(
  value: unknown,
  invalid: Invalid,
  maximumLength = 4096,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    containsHostControlCharacter(value) ||
    containsHostSensitiveMaterial(value)
  ) {
    return invalid();
  }
  return value;
}

function opaqueRevision(value: unknown, invalid: Invalid): string {
  const revision = publicText(value, invalid, 512);
  return OPAQUE_REVISION.test(revision) ? revision : invalid();
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  invalid: Invalid,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    return invalid();
  }
  return value as Values[number];
}

function booleanValue(value: unknown, invalid: Invalid): boolean {
  return typeof value === "boolean" ? value : invalid();
}

function normalizeHostId(value: unknown, invalid: Invalid): HostId {
  return enumValue(value, HOST_IDS, invalid);
}

function normalizeMarketplace(
  value: unknown,
  invalid: Invalid,
): HostMarketplaceDescriptor {
  const object = plainObject(value, ["name", "source"], [], invalid);
  if (object.name !== "plurum") {
    return invalid();
  }
  return {
    name: "plurum",
    source: publicText(object.source, invalid),
  };
}

function normalizePlugin(
  value: unknown,
  invalid: Invalid,
): HostPluginDescriptor {
  const object = plainObject(
    value,
    ["name", "source", "version", "enabled"],
    [],
    invalid,
  );
  if (object.name !== "plurum") {
    return invalid();
  }
  const version = publicText(object.version, invalid, 128);
  parseCanonicalVersion(version);
  return {
    name: "plurum",
    source: publicText(object.source, invalid),
    version,
    enabled: booleanValue(object.enabled, invalid),
  };
}

function normalizeMcp(value: unknown, invalid: Invalid): HostMcpDescriptor {
  const object = plainObject(value, ["name", "endpoint"], [], invalid);
  if (object.name !== "plurum") {
    return invalid();
  }
  return {
    name: "plurum",
    endpoint: publicText(object.endpoint, invalid),
  };
}

function normalizeSlot<Value>(
  value: unknown,
  normalizeValue: (candidate: unknown, invalid: Invalid) => Value,
  invalid: Invalid,
): ObservedSlot<Value> {
  const object = plainObject(value, ["status"], ["value"], invalid);
  const status = enumValue(
    object.status,
    ["absent", "present", "ambiguous"] as const,
    invalid,
  );

  if (status === "present") {
    if (!Object.hasOwn(object, "value")) {
      return invalid();
    }
    return { status, value: normalizeValue(object.value, invalid) };
  }
  if (Object.hasOwn(object, "value")) {
    return invalid();
  }
  return { status };
}

function normalizeConfiguration(
  value: unknown,
  invalid: Invalid,
): HostConfiguration {
  const object = plainObject(
    value,
    ["marketplace", "plugin", "pluginMcp", "directMcp"],
    [],
    invalid,
  );
  return {
    marketplace: normalizeSlot(object.marketplace, normalizeMarketplace, invalid),
    plugin: normalizeSlot(object.plugin, normalizePlugin, invalid),
    pluginMcp: normalizeSlot(object.pluginMcp, normalizeMcp, invalid),
    directMcp: normalizeSlot(object.directMcp, normalizeMcp, invalid),
  };
}

function normalizeSnapshot(
  value: unknown,
  invalid: Invalid,
): HostStateSnapshot {
  const object = plainObject(value, ["revision", "configuration"], [], invalid);
  return {
    revision: opaqueRevision(object.revision, invalid),
    configuration: normalizeConfiguration(object.configuration, invalid),
  };
}

function normalizeExecutable(
  value: unknown,
  invalid: Invalid,
): HostExecutableAttestation {
  const object = plainObject(
    value,
    ["sourcePath", "resolvedPath", "revision", "chain", "launch"],
    [],
    invalid,
  );
  const sourcePath = publicText(object.sourcePath, invalid);
  const resolvedPath = publicText(object.resolvedPath, invalid);
  const revision = opaqueRevision(object.revision, invalid);
  const rawChain = plainArray(object.chain, invalid);
  if (rawChain.length === 0 || rawChain.length > 16) {
    return invalid();
  }

  const chain = rawChain.map((candidate) => {
    const entry = plainObject(
      candidate,
      ["path", "kind", "owner", "access", "binding", "link", "revision"],
      [],
      invalid,
    );
    if (
      entry.access !== "not-broadly-writable" ||
      entry.binding !== "canonical"
    ) {
      return invalid();
    }
    return {
      path: publicText(entry.path, invalid),
      kind: enumValue(
        entry.kind,
        ["binary", "script", "shim"] as const,
        invalid,
      ),
      owner: enumValue(
        entry.owner,
        ["current-user", "trusted-system"] as const,
        invalid,
      ),
      access: "not-broadly-writable" as const,
      binding: "canonical" as const,
      link: enumValue(
        entry.link,
        ["direct", "resolved-link", "approved-npm-shim"] as const,
        invalid,
      ),
      revision: opaqueRevision(entry.revision, invalid),
    };
  });
  if (
    chain[0]?.path !== sourcePath ||
    !chain.some((entry) => entry.path === resolvedPath) ||
    new Set(chain.map((entry) => entry.path)).size !== chain.length
  ) {
    return invalid();
  }

  const launchObject = plainObject(
    object.launch,
    ["executable", "argumentPrefix", "shell"],
    [],
    invalid,
  );
  if (launchObject.shell !== false) {
    return invalid();
  }
  const executable = publicText(launchObject.executable, invalid);
  const source = chain[0];
  const resolved = chain.find((entry) => entry.path === resolvedPath);
  const launcher = chain.find((entry) => entry.path === executable);
  if (source === undefined || resolved === undefined || launcher === undefined) {
    return invalid();
  }
  const argumentPrefix = plainArray(
    launchObject.argumentPrefix,
    invalid,
  ).map((argument) => publicText(argument, invalid));
  if (argumentPrefix.length > 16) {
    return invalid();
  }
  if (resolved.kind === "script") {
    const directScript =
      source.kind === "script" && source.path === resolvedPath;
    const approvedNpmShim =
      source.kind === "shim" && source.link === "approved-npm-shim";
    if (
      launcher.kind !== "binary" ||
      argumentPrefix.length !== 1 ||
      argumentPrefix[0] !== resolvedPath ||
      (!directScript && !approvedNpmShim)
    ) {
      return invalid();
    }
  } else if (
    resolved.kind !== "binary" ||
    executable !== resolvedPath ||
    argumentPrefix.length !== 0
  ) {
    return invalid();
  }

  return {
    sourcePath,
    resolvedPath,
    revision,
    chain,
    launch: {
      executable,
      argumentPrefix,
      shell: false,
    },
  };
}

function normalizeMutationSupport(
  value: unknown,
  invalid: Invalid,
): HostMutationSupport {
  const keys = [
    "addMarketplace",
    "removeMarketplace",
    "installPlugin",
    "removePlugin",
    "updatePlugin",
    "restorePlugin",
    "enablePlugin",
    "disablePlugin",
  ] as const;
  const object = plainObject(value, keys, [], invalid);
  return {
    addMarketplace: booleanValue(object.addMarketplace, invalid),
    removeMarketplace: booleanValue(object.removeMarketplace, invalid),
    installPlugin: booleanValue(object.installPlugin, invalid),
    removePlugin: booleanValue(object.removePlugin, invalid),
    updatePlugin: booleanValue(object.updatePlugin, invalid),
    restorePlugin: booleanValue(object.restorePlugin, invalid),
    enablePlugin: booleanValue(object.enablePlugin, invalid),
    disablePlugin: booleanValue(object.disablePlugin, invalid),
  };
}

function normalizeInspection(value: unknown): HostInspection {
  const base = plainObject(
    value,
    ["host", "status"],
    [
      "reason",
      "candidatePath",
      "executable",
      "version",
      "state",
      "mutationSupport",
    ],
    invalidObservation,
  );
  const host = normalizeHostId(base.host, invalidObservation);
  const status = enumValue(
    base.status,
    ["absent", "blocked", "unavailable", "available"] as const,
    invalidObservation,
  );

  if (status === "absent") {
    plainObject(base, ["host", "status"], [], invalidObservation);
    return { host, status };
  }
  if (status === "blocked") {
    const object = plainObject(
      base,
      ["host", "status", "reason"],
      ["candidatePath"],
      invalidObservation,
    );
    const candidatePath = Object.hasOwn(object, "candidatePath")
      ? publicText(object.candidatePath, invalidObservation)
      : undefined;
    const normalized = {
      host,
      status,
      reason: enumValue(
        object.reason,
        [
          "unsafe-path-entry",
          "unsafe-shadow",
          "unsafe-executable",
          "ambiguous-executable",
          "unsupported-shim",
          "unverifiable-executable",
        ] as const,
        invalidObservation,
      ),
      ...(candidatePath === undefined ? {} : { candidatePath }),
    };
    return normalized;
  }
  if (status === "unavailable") {
    const object = plainObject(
      base,
      ["host", "status", "reason", "executable"],
      [],
      invalidObservation,
    );
    return {
      host,
      status,
      reason: enumValue(
        object.reason,
        [
          "probe-failed",
          "probe-timeout",
          "probe-output-invalid",
          "probe-output-too-large",
        ] as const,
        invalidObservation,
      ),
      executable: normalizeExecutable(object.executable, invalidObservation),
    };
  }

  const object = plainObject(
    base,
    [
      "host",
      "status",
      "executable",
      "version",
      "state",
      "mutationSupport",
    ],
    [],
    invalidObservation,
  );
  const version = publicText(object.version, invalidObservation, 128);
  parseCanonicalVersion(version);
  return {
    host,
    status,
    executable: normalizeExecutable(object.executable, invalidObservation),
    version,
    state: normalizeSnapshot(object.state, invalidObservation),
    mutationSupport: normalizeMutationSupport(
      object.mutationSupport,
      invalidObservation,
    ),
  };
}

function normalizeDesired(value: unknown): DesiredHostConfiguration {
  const object = plainObject(
    value,
    ["host", "minimumHostVersion", "marketplace", "plugin", "mcp"],
    [],
    invalidPlan,
  );
  const host = normalizeHostId(object.host, invalidPlan);
  const minimumHostVersion = publicText(
    object.minimumHostVersion,
    invalidPlan,
    128,
  );
  parseCanonicalVersion(minimumHostVersion);
  const marketplace = normalizeMarketplace(object.marketplace, invalidPlan);
  const pluginObject = plainObject(
    object.plugin,
    [
      "name",
      "source",
      "version",
      "compatibleMinimum",
      "compatibleMaximumExclusive",
    ],
    [],
    invalidPlan,
  );
  if (pluginObject.name !== "plurum") {
    return invalidPlan();
  }
  const version = publicText(pluginObject.version, invalidPlan, 128);
  const compatibleMinimum = publicText(
    pluginObject.compatibleMinimum,
    invalidPlan,
    128,
  );
  const compatibleMaximumExclusive = publicText(
    pluginObject.compatibleMaximumExclusive,
    invalidPlan,
    128,
  );
  parseCanonicalVersion(version);
  parseCanonicalVersion(compatibleMinimum);
  parseCanonicalVersion(compatibleMaximumExclusive);
  if (
    !isCanonicalVersionInRange(
      version,
      compatibleMinimum,
      compatibleMaximumExclusive,
    )
  ) {
    return invalidPlan();
  }

  const mcp = normalizeMcp(object.mcp, invalidPlan);
  let endpoint: URL;
  try {
    endpoint = new URL(mcp.endpoint);
  } catch {
    return invalidPlan();
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.hash !== "" ||
    endpoint.toString() !== mcp.endpoint
  ) {
    return invalidPlan();
  }

  return {
    host,
    minimumHostVersion,
    marketplace,
    plugin: {
      name: "plurum",
      source: publicText(pluginObject.source, invalidPlan),
      version,
      compatibleMinimum,
      compatibleMaximumExclusive,
    },
    mcp,
  };
}

function cloneSlot<Value extends object>(
  slot: ObservedSlot<Value>,
): ObservedSlot<Value> {
  if (slot.status !== "present") {
    return { status: slot.status };
  }
  return { status: "present", value: { ...slot.value } };
}

function cloneConfiguration(
  configuration: HostConfiguration,
): HostConfiguration {
  return {
    marketplace: cloneSlot(configuration.marketplace),
    plugin: cloneSlot(configuration.plugin),
    pluginMcp: cloneSlot(configuration.pluginMcp),
    directMcp: cloneSlot(configuration.directMcp),
  };
}

function marketplaceMatches(
  descriptor: HostMarketplaceDescriptor,
  desired: DesiredHostConfiguration,
): boolean {
  return descriptor.source === desired.marketplace.source;
}

function pluginMatches(
  descriptor: HostPluginDescriptor,
  desired: DesiredHostConfiguration,
): boolean {
  return descriptor.source === desired.plugin.source;
}

function mcpMatches(
  descriptor: HostMcpDescriptor,
  desired: DesiredHostConfiguration,
): boolean {
  return descriptor.endpoint === desired.mcp.endpoint;
}

function fixedPlan(
  desired: DesiredHostConfiguration,
  classification: HostPreflightPlan["classification"],
  explanation: string,
  executable: HostExecutableAttestation | null,
  detectedVersion: string | null,
  baseline: HostStateSnapshot | null,
): HostPreflightPlan {
  return deepFreeze({
    host: desired.host,
    classification,
    automatic: false,
    executable,
    detectedVersion,
    minimumVersion: desired.minimumHostVersion,
    baseline,
    desired,
    actions: [],
    explanation,
  });
}

function rollbackFor(
  kind: HostAction["kind"],
  pluginVersion?: string,
): HostRollbackRecipe {
  switch (kind) {
    case "add-marketplace":
      return { kind: "remove-cli-created-marketplace" };
    case "install-plugin":
      return { kind: "remove-cli-created-plugin" };
    case "update-plugin":
      if (pluginVersion === undefined) {
        return invalidPlan();
      }
      return { kind: "restore-plugin-version", pluginVersion };
    case "enable-plugin":
      return { kind: "restore-plugin-disabled" };
  }
}

function actionDisplay(kind: HostAction["kind"]): string {
  switch (kind) {
    case "add-marketplace":
      return "add the Plurum marketplace";
    case "install-plugin":
      return "install the Plurum plugin";
    case "update-plugin":
      return "update the Plurum plugin";
    case "enable-plugin":
      return "enable the Plurum plugin";
  }
}

function supportsReversibleAction(
  kind: HostAction["kind"],
  support: HostMutationSupport,
): boolean {
  switch (kind) {
    case "add-marketplace":
      return support.addMarketplace && support.removeMarketplace;
    case "install-plugin":
      return support.installPlugin && support.removePlugin;
    case "update-plugin":
      return support.updatePlugin && support.restorePlugin;
    case "enable-plugin":
      return support.enablePlugin && support.disablePlugin;
  }
}

function createActions(
  host: HostId,
  baseline: HostConfiguration,
  desired: DesiredHostConfiguration,
  kinds: readonly HostAction["kind"][],
): readonly HostAction[] {
  let working = cloneConfiguration(baseline);
  const actions: HostAction[] = [];

  for (const [index, kind] of kinds.entries()) {
    const before = cloneConfiguration(working);
    let rollbackVersion: string | undefined;

    switch (kind) {
      case "add-marketplace":
        working = {
          ...working,
          marketplace: { status: "present", value: { ...desired.marketplace } },
        };
        break;
      case "install-plugin":
        working = {
          ...working,
          plugin: {
            status: "present",
            value: {
              name: "plurum",
              source: desired.plugin.source,
              version: desired.plugin.version,
              enabled: true,
            },
          },
          pluginMcp: { status: "present", value: { ...desired.mcp } },
        };
        break;
      case "update-plugin": {
        if (working.plugin.status !== "present") {
          return invalidPlan();
        }
        rollbackVersion = working.plugin.value.version;
        working = {
          ...working,
          plugin: {
            status: "present",
            value: {
              ...working.plugin.value,
              version: desired.plugin.version,
            },
          },
        };
        break;
      }
      case "enable-plugin": {
        if (working.plugin.status !== "present") {
          return invalidPlan();
        }
        working = {
          ...working,
          plugin: {
            status: "present",
            value: { ...working.plugin.value, enabled: true },
          },
          pluginMcp: { status: "present", value: { ...desired.mcp } },
        };
        break;
      }
    }

    actions.push({
      id: `${host}:${String(index + 1).padStart(2, "0")}:${kind}`,
      host,
      kind,
      before,
      after: cloneConfiguration(working),
      rollback: rollbackFor(kind, rollbackVersion),
      display: actionDisplay(kind),
    });
  }

  return actions;
}

export function createHostPreflightPlan(
  rawInspection: HostInspection,
  rawDesired: DesiredHostConfiguration,
): HostPreflightPlan {
  const inspection = deepFreeze(normalizeInspection(rawInspection));
  const desired = deepFreeze(normalizeDesired(rawDesired));
  if (inspection.host !== desired.host) {
    return invalidPlan();
  }

  if (inspection.status === "absent") {
    return fixedPlan(
      desired,
      "absent",
      "The host executable is not installed.",
      null,
      null,
      null,
    );
  }
  if (inspection.status === "blocked") {
    return fixedPlan(
      desired,
      "unsafe",
      "The host executable could not be trusted.",
      null,
      null,
      null,
    );
  }
  if (inspection.status === "unavailable") {
    return fixedPlan(
      desired,
      "unavailable",
      "The host did not return a verifiable configuration.",
      inspection.executable,
      null,
      null,
    );
  }

  const executable = inspection.executable;
  const detectedVersion = inspection.version;
  const baseline = inspection.state;
  if (
    compareCanonicalVersions(
      detectedVersion,
      desired.minimumHostVersion,
    ) < 0
  ) {
    return fixedPlan(
      desired,
      "unsupported-version",
      "The installed host version is not supported.",
      executable,
      detectedVersion,
      baseline,
    );
  }

  const configuration = baseline.configuration;
  if (
    configuration.marketplace.status === "ambiguous" ||
    configuration.plugin.status === "ambiguous" ||
    configuration.pluginMcp.status === "ambiguous" ||
    configuration.directMcp.status === "ambiguous"
  ) {
    return fixedPlan(
      desired,
      "ambiguous",
      "The host reported more than one possible Plurum configuration.",
      executable,
      detectedVersion,
      baseline,
    );
  }

  if (
    (configuration.marketplace.status === "present" &&
      !marketplaceMatches(configuration.marketplace.value, desired)) ||
    (configuration.plugin.status === "present" &&
      !pluginMatches(configuration.plugin.value, desired)) ||
    (configuration.pluginMcp.status === "present" &&
      !mcpMatches(configuration.pluginMcp.value, desired)) ||
    (configuration.directMcp.status === "present" &&
      !mcpMatches(configuration.directMcp.value, desired))
  ) {
    return fixedPlan(
      desired,
      "mismatched",
      "A Plurum-named host entry points to a different source.",
      executable,
      detectedVersion,
      baseline,
    );
  }

  if (
    configuration.plugin.status === "present" &&
    configuration.directMcp.status === "present"
  ) {
    return fixedPlan(
      desired,
      "duplicate",
      "The host has both plugin-managed and direct Plurum MCP entries.",
      executable,
      detectedVersion,
      baseline,
    );
  }
  if (configuration.directMcp.status === "present") {
    return fixedPlan(
      desired,
      "direct-only",
      "The host has a direct Plurum MCP entry that setup will not replace.",
      executable,
      detectedVersion,
      baseline,
    );
  }

  if (
    (configuration.plugin.status === "absent" &&
      configuration.pluginMcp.status !== "absent") ||
    (configuration.plugin.status === "present" &&
      configuration.plugin.value.enabled &&
      configuration.pluginMcp.status !== "present") ||
    (configuration.plugin.status === "present" &&
      !configuration.plugin.value.enabled &&
      configuration.pluginMcp.status !== "absent")
  ) {
    return fixedPlan(
      desired,
      "mismatched",
      "The plugin and its managed MCP entry are inconsistent.",
      executable,
      detectedVersion,
      baseline,
    );
  }

  const kinds: HostAction["kind"][] = [];
  if (configuration.marketplace.status === "absent") {
    kinds.push("add-marketplace");
  }

  let compatibleNewer = false;
  if (configuration.plugin.status === "absent") {
    kinds.push("install-plugin");
  } else {
    const comparison = compareCanonicalVersions(
      configuration.plugin.value.version,
      desired.plugin.version,
    );
    if (comparison > 0) {
      if (
        !isCanonicalVersionInRange(
          configuration.plugin.value.version,
          desired.plugin.compatibleMinimum,
          desired.plugin.compatibleMaximumExclusive,
        )
      ) {
        return fixedPlan(
          desired,
          "mismatched",
          "The installed plugin is newer but outside the compatible range.",
          executable,
          detectedVersion,
          baseline,
        );
      }
      compatibleNewer = true;
    } else if (comparison < 0) {
      kinds.push("update-plugin");
    }

    if (!configuration.plugin.value.enabled) {
      kinds.push("enable-plugin");
    }
  }

  if (
    kinds.some(
      (kind) =>
        !supportsReversibleAction(kind, inspection.mutationSupport),
    )
  ) {
    return fixedPlan(
      desired,
      "irreversible",
      "The host cannot safely reverse every required change.",
      executable,
      detectedVersion,
      baseline,
    );
  }

  if (kinds.length === 0) {
    return deepFreeze({
      host: desired.host,
      classification: compatibleNewer ? "healthy-newer" : "healthy",
      automatic: true,
      executable,
      detectedVersion,
      minimumVersion: desired.minimumHostVersion,
      baseline,
      desired,
      actions: [],
      explanation: compatibleNewer
        ? "The host already has a newer compatible Plurum plugin."
        : "The host already matches the desired Plurum configuration.",
    });
  }

  return deepFreeze({
    host: desired.host,
    classification: "needs-changes",
    automatic: true,
    executable,
    detectedVersion,
    minimumVersion: desired.minimumHostVersion,
    baseline,
    desired,
    actions: createActions(
      desired.host,
      configuration,
      desired,
      kinds,
    ),
    explanation: "The listed reversible changes will configure Plurum.",
  });
}

export function createReconciliationPlan(
  rawInput: CreateReconciliationPlanInput,
): ReconciliationPlan {
  const object = plainObject(
    rawInput,
    ["operationId", "createdAt", "inspections", "desired"],
    [],
    invalidPlan,
  );
  const operationId = publicText(object.operationId, invalidPlan, 36);
  if (!UUID_PATTERN.test(operationId)) {
    return invalidPlan();
  }
  const createdAt = publicText(object.createdAt, invalidPlan, 24);
  if (
    !TIMESTAMP_PATTERN.test(createdAt) ||
    Number.isNaN(Date.parse(createdAt)) ||
    new Date(createdAt).toISOString() !== createdAt
  ) {
    return invalidPlan();
  }

  const inspections = plainArray(object.inspections, invalidPlan);
  const desired = plainArray(object.desired, invalidPlan);
  if (
    inspections.length === 0 ||
    inspections.length > HOST_IDS.length ||
    desired.length !== inspections.length
  ) {
    return invalidPlan();
  }

  const inspectionByHost = new Map<HostId, HostInspection>();
  for (const candidate of inspections) {
    const normalized = normalizeInspection(candidate);
    if (inspectionByHost.has(normalized.host)) {
      return invalidPlan();
    }
    inspectionByHost.set(normalized.host, normalized);
  }
  const desiredByHost = new Map<HostId, DesiredHostConfiguration>();
  for (const candidate of desired) {
    const normalized = normalizeDesired(candidate);
    if (desiredByHost.has(normalized.host)) {
      return invalidPlan();
    }
    desiredByHost.set(normalized.host, normalized);
  }
  if (
    inspectionByHost.size !== desiredByHost.size ||
    [...inspectionByHost.keys()].some((host) => !desiredByHost.has(host))
  ) {
    return invalidPlan();
  }

  const hosts = HOST_IDS.filter((host) => inspectionByHost.has(host)).map(
    (host) => {
      const inspection = inspectionByHost.get(host);
      const target = desiredByHost.get(host);
      if (inspection === undefined || target === undefined) {
        return invalidPlan();
      }
      return createHostPreflightPlan(inspection, target);
    },
  );

  return deepFreeze({
    schemaVersion: 1 as const,
    operationId,
    createdAt,
    hosts,
  });
}
