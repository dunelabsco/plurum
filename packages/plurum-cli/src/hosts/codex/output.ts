import type {
  HostMarketplaceDescriptor,
  HostPluginDescriptor,
  ObservedSlot,
} from "../contracts.js";
import { HostError } from "../errors.js";
import {
  containsHostControlCharacter,
  containsHostSensitiveMaterial,
} from "../privacy.js";
import { parseCanonicalVersion } from "../version.js";
import {
  CODEX_MARKETPLACE_NAME,
  CODEX_MARKETPLACE_SOURCE,
  CODEX_PLUGIN_ID,
  CODEX_PLUGIN_NAME,
  CODEX_PLUGIN_SOURCE,
} from "./configuration.js";

const MAX_OUTPUT_CHARACTERS = 131_072;
const MAX_ARRAY_ENTRIES = 128;
const MAX_OBJECT_FIELDS = 32;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 4_096;
const MAX_JSON_STRING_CHARACTERS = 16_384;

type JsonPrimitive = string | number | boolean | null;
type SafeJson = JsonPrimitive | SafeJsonArray | SafeJsonObject;

interface SafeJsonArray extends ReadonlyArray<SafeJson> {}

interface SafeJsonObject {
  readonly [key: string]: SafeJson;
}

interface CopyBudget {
  nodes: number;
  stringCharacters: number;
}

interface MarketplaceSource {
  readonly sourceType: string;
  readonly source: string;
}

type PluginSourceKind = "local" | "git" | "git-subdir" | "npm";

function invalidOutput(): never {
  throw new HostError("host_output_invalid");
}

function oversizedOutput(): never {
  throw new HostError("host_output_too_large");
}

function safeString(value: string, budget: CopyBudget): string {
  if (
    value.length === 0 ||
    containsHostControlCharacter(value) ||
    containsHostSensitiveMaterial(value)
  ) {
    return invalidOutput();
  }
  if (
    value.length > MAX_JSON_STRING_CHARACTERS ||
    budget.stringCharacters + value.length > MAX_OUTPUT_CHARACTERS
  ) {
    return oversizedOutput();
  }
  budget.stringCharacters += value.length;
  return value;
}

function ownDataDescriptor(
  object: object,
  property: string,
  enumerable: boolean,
): PropertyDescriptor & { value: unknown } {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, property);
  } catch {
    return invalidOutput();
  }
  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, "value") ||
    descriptor.enumerable !== enumerable ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined
  ) {
    return invalidOutput();
  }
  return descriptor as PropertyDescriptor & { value: unknown };
}

/*
 * Clone an untrusted value without invoking accessors. These normalizers are
 * deliberately safe for hostile native test doubles as well as JSON.parse
 * output, and retain no raw host paths in their returned descriptors.
 */
function copySafeJson(
  value: unknown,
  budget: CopyBudget,
  depth: number,
  seen: WeakSet<object>,
): SafeJson {
  budget.nodes += 1;
  if (budget.nodes > MAX_JSON_NODES) {
    return oversizedOutput();
  }
  if (depth > MAX_JSON_DEPTH) {
    return oversizedOutput();
  }

  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return safeString(value, budget);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : invalidOutput();
  }
  if (typeof value !== "object" || seen.has(value)) {
    return invalidOutput();
  }
  seen.add(value);

  let prototype: object | null;
  let ownKeys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return invalidOutput();
  }

  const names: string[] = [];
  for (const key of ownKeys) {
    if (typeof key !== "string") {
      return invalidOutput();
    }
    names.push(key);
  }

  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) {
      return invalidOutput();
    }
    const lengthDescriptor = ownDataDescriptor(value, "length", false);
    const length = lengthDescriptor.value;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0
    ) {
      return invalidOutput();
    }
    if (length > MAX_ARRAY_ENTRIES) {
      return oversizedOutput();
    }
    if (names.length !== length + 1 || !names.includes("length")) {
      return invalidOutput();
    }

    const copy: SafeJson[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = ownDataDescriptor(value, String(index), true);
      copy.push(copySafeJson(descriptor.value, budget, depth + 1, seen));
    }
    return Object.freeze(copy);
  }

  if (prototype !== Object.prototype && prototype !== null) {
    return invalidOutput();
  }
  if (names.length > MAX_OBJECT_FIELDS) {
    return oversizedOutput();
  }

  const copy: Record<string, SafeJson> = Object.create(null) as Record<
    string,
    SafeJson
  >;
  for (const name of names) {
    safeString(name, budget);
    if (containsHostSensitiveMaterial(`${name}:`)) {
      return invalidOutput();
    }
    const descriptor = ownDataDescriptor(value, name, true);
    copy[name] = copySafeJson(descriptor.value, budget, depth + 1, seen);
  }
  return Object.freeze(copy);
}

function normalizeSafeJson(value: unknown): SafeJson {
  return copySafeJson(
    value,
    { nodes: 0, stringCharacters: 0 },
    0,
    new WeakSet<object>(),
  );
}

function parseJsonOutput(output: string): SafeJson {
  if (typeof output !== "string") {
    return invalidOutput();
  }
  if (output.length > MAX_OUTPUT_CHARACTERS) {
    return oversizedOutput();
  }
  if (containsHostSensitiveMaterial(output)) {
    return invalidOutput();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    return invalidOutput();
  }
  return normalizeSafeJson(parsed);
}

function safeArray(value: SafeJson): readonly SafeJson[] {
  return Array.isArray(value) ? value : invalidOutput();
}

function safeObject(value: SafeJson): Readonly<Record<string, SafeJson>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidOutput();
  }
  return value as SafeJsonObject;
}

function exactObject(
  value: SafeJson,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, SafeJson>> {
  const object = safeObject(value);
  const keys = Object.keys(object);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(object, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    return invalidOutput();
  }
  return object;
}

function stringField(
  object: Readonly<Record<string, SafeJson>>,
  key: string,
): string {
  const value = object[key];
  return typeof value === "string" ? value : invalidOutput();
}

function booleanField(
  object: Readonly<Record<string, SafeJson>>,
  key: string,
): boolean {
  const value = object[key];
  return typeof value === "boolean" ? value : invalidOutput();
}

function absent<Value>(): ObservedSlot<Value> {
  return Object.freeze({ status: "absent" });
}

function present<Value>(value: Value): ObservedSlot<Value> {
  return Object.freeze({ status: "present", value: Object.freeze(value) });
}

function marketplaceSource(value: SafeJson): MarketplaceSource {
  const source = exactObject(value, ["sourceType", "source"]);
  return Object.freeze({
    sourceType: stringField(source, "sourceType"),
    source: stringField(source, "source"),
  });
}

function isExactMarketplaceSource(source: MarketplaceSource): boolean {
  return (
    source.sourceType === "git" &&
    source.source === CODEX_MARKETPLACE_SOURCE
  );
}

function normalizeMarketplaceList(
  value: SafeJson,
): ObservedSlot<HostMarketplaceDescriptor> {
  const output = exactObject(value, ["marketplaces"]);
  const rawMarketplaces = output.marketplaces;
  if (rawMarketplaces === undefined) {
    return invalidOutput();
  }
  const entries = safeArray(rawMarketplaces);
  let match: HostMarketplaceDescriptor | null = null;

  for (const rawEntry of entries) {
    const entry = exactObject(
      rawEntry,
      ["name", "root"],
      ["marketplaceSource"],
    );
    const rawName = stringField(entry, "name");
    stringField(entry, "root");
    const rawSource = entry.marketplaceSource;
    const source =
      rawSource === undefined ? null : marketplaceSource(rawSource);

    if (rawName.toLowerCase() !== CODEX_MARKETPLACE_NAME) {
      continue;
    }
    if (
      rawName !== CODEX_MARKETPLACE_NAME ||
      match !== null ||
      source === null ||
      !isExactMarketplaceSource(source)
    ) {
      return invalidOutput();
    }

    match = {
      name: CODEX_MARKETPLACE_NAME,
      source: CODEX_MARKETPLACE_SOURCE,
    };
  }

  return match === null ? absent() : present(match);
}

function normalizeOptionalString(
  object: Readonly<Record<string, SafeJson>>,
  key: string,
): void {
  if (!Object.hasOwn(object, key)) {
    return;
  }
  if (typeof object[key] !== "string") {
    return invalidOutput();
  }
}

function normalizePluginSource(value: SafeJson): PluginSourceKind {
  const raw = safeObject(value);
  const source = stringField(raw, "source");

  switch (source) {
    case "local": {
      const local = exactObject(value, ["source", "path"]);
      stringField(local, "path");
      return source;
    }
    case "git": {
      const git = exactObject(value, ["source", "url"], ["ref", "sha"]);
      stringField(git, "url");
      normalizeOptionalString(git, "ref");
      normalizeOptionalString(git, "sha");
      return source;
    }
    case "git-subdir": {
      const subdir = exactObject(
        value,
        ["source", "url", "path"],
        ["ref", "sha"],
      );
      stringField(subdir, "url");
      stringField(subdir, "path");
      normalizeOptionalString(subdir, "ref");
      normalizeOptionalString(subdir, "sha");
      return source;
    }
    case "npm": {
      const npm = exactObject(
        value,
        ["source", "package"],
        ["version", "registry"],
      );
      stringField(npm, "package");
      normalizeOptionalString(npm, "version");
      normalizeOptionalString(npm, "registry");
      return source;
    }
    default:
      return invalidOutput();
  }
}

function normalizePluginVersion(
  object: Readonly<Record<string, SafeJson>>,
): string | null {
  const version = object.version;
  return version === null || typeof version === "string"
    ? version
    : invalidOutput();
}

function normalizeInstallPolicy(value: string): void {
  if (
    value !== "NOT_AVAILABLE" &&
    value !== "AVAILABLE" &&
    value !== "INSTALLED_BY_DEFAULT"
  ) {
    return invalidOutput();
  }
}

function normalizeAuthPolicy(value: string): void {
  if (value !== "ON_INSTALL" && value !== "ON_USE") {
    return invalidOutput();
  }
}

function isConflictingPlurumPluginId(id: string): boolean {
  const separator = id.indexOf("@");
  const pluginName = separator === -1 ? id : id.slice(0, separator);
  return pluginName.toLowerCase() === CODEX_PLUGIN_NAME;
}

function normalizePluginList(
  value: SafeJson,
): ObservedSlot<HostPluginDescriptor> {
  const output = exactObject(value, ["installed", "available"]);
  const rawInstalled = output.installed;
  const rawAvailable = output.available;
  if (rawInstalled === undefined || rawAvailable === undefined) {
    return invalidOutput();
  }

  let targetSeen = false;
  let match: HostPluginDescriptor | null = null;

  const scan = (rawEntries: SafeJson, expectedInstalled: boolean): void => {
    for (const rawEntry of safeArray(rawEntries)) {
      const entry = exactObject(
        rawEntry,
        [
          "pluginId",
          "name",
          "marketplaceName",
          "version",
          "installed",
          "enabled",
          "source",
          "installPolicy",
          "authPolicy",
        ],
        ["marketplaceSource"],
      );
      const pluginId = stringField(entry, "pluginId");
      const name = stringField(entry, "name");
      const marketplaceName = stringField(entry, "marketplaceName");
      const version = normalizePluginVersion(entry);
      const installed = booleanField(entry, "installed");
      const enabled = booleanField(entry, "enabled");
      const rawSource = entry.source;
      if (rawSource === undefined) {
        return invalidOutput();
      }
      const sourceKind = normalizePluginSource(rawSource);
      const rawMarketplaceSource = entry.marketplaceSource;
      const configuredSource =
        rawMarketplaceSource === undefined
          ? null
          : marketplaceSource(rawMarketplaceSource);
      const installPolicy = stringField(entry, "installPolicy");
      const authPolicy = stringField(entry, "authPolicy");
      normalizeInstallPolicy(installPolicy);
      normalizeAuthPolicy(authPolicy);

      if (installed !== expectedInstalled) {
        return invalidOutput();
      }
      if (
        marketplaceName.toLowerCase() === CODEX_MARKETPLACE_NAME &&
        marketplaceName !== CODEX_MARKETPLACE_NAME
      ) {
        return invalidOutput();
      }

      const targetIdentity =
        pluginId === CODEX_PLUGIN_ID ||
        isConflictingPlurumPluginId(pluginId) ||
        name.toLowerCase() === CODEX_PLUGIN_NAME;
      if (!targetIdentity) {
        continue;
      }
      if (
        targetSeen ||
        pluginId !== CODEX_PLUGIN_ID ||
        name !== CODEX_PLUGIN_NAME ||
        marketplaceName !== CODEX_MARKETPLACE_NAME ||
        version === null ||
        sourceKind !== "local" ||
        configuredSource === null ||
        !isExactMarketplaceSource(configuredSource) ||
        installPolicy !== "AVAILABLE" ||
        authPolicy !== "ON_INSTALL" ||
        (!expectedInstalled && enabled)
      ) {
        return invalidOutput();
      }

      try {
        parseCanonicalVersion(version);
      } catch {
        return invalidOutput();
      }
      targetSeen = true;
      if (expectedInstalled) {
        match = {
          name: CODEX_PLUGIN_NAME,
          source: CODEX_PLUGIN_SOURCE,
          version,
          enabled,
        };
      }
    }
  };

  scan(rawInstalled, true);
  scan(rawAvailable, false);
  return match === null ? absent() : present(match);
}

export function normalizeCodexMarketplaceListJson(
  value: unknown,
): ObservedSlot<HostMarketplaceDescriptor> {
  return normalizeMarketplaceList(normalizeSafeJson(value));
}

export function parseCodexMarketplaceListOutput(
  output: string,
): ObservedSlot<HostMarketplaceDescriptor> {
  return normalizeMarketplaceList(parseJsonOutput(output));
}

export function normalizeCodexPluginListJson(
  value: unknown,
): ObservedSlot<HostPluginDescriptor> {
  return normalizePluginList(normalizeSafeJson(value));
}

export function parseCodexPluginListOutput(
  output: string,
): ObservedSlot<HostPluginDescriptor> {
  return normalizePluginList(parseJsonOutput(output));
}
