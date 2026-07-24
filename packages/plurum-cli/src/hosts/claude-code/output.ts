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
  CLAUDE_CODE_MARKETPLACE_NAME,
  CLAUDE_CODE_MARKETPLACE_SOURCE,
  CLAUDE_CODE_PLUGIN_ID,
  CLAUDE_CODE_PLUGIN_NAME,
  CLAUDE_CODE_PLUGIN_SOURCE,
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
 * Clone an untrusted value without invoking accessors. The direct normalizers
 * are deliberately safe for hostile test doubles even though JSON.parse
 * itself only creates ordinary data properties.
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
  let names: string[];
  let symbols: symbol[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    names = Object.getOwnPropertyNames(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return invalidOutput();
  }

  if (symbols.length !== 0) {
    return invalidOutput();
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

function absent<Value>(): ObservedSlot<Value> {
  return Object.freeze({ status: "absent" });
}

function present<Value>(value: Value): ObservedSlot<Value> {
  return Object.freeze({ status: "present", value: Object.freeze(value) });
}

function normalizeMarketplaceList(
  value: SafeJson,
): ObservedSlot<HostMarketplaceDescriptor> {
  const entries = safeArray(value);
  let match: HostMarketplaceDescriptor | null = null;

  for (const rawEntry of entries) {
    const entry = safeObject(rawEntry);
    const rawName = entry.name;
    if (typeof rawName !== "string") {
      return invalidOutput();
    }
    if (rawName.toLowerCase() !== CLAUDE_CODE_MARKETPLACE_NAME) {
      continue;
    }
    if (rawName !== CLAUDE_CODE_MARKETPLACE_NAME || match !== null) {
      return invalidOutput();
    }

    const target = exactObject(entry, ["name", "source"]);
    const targetSource = target.source;
    if (targetSource === undefined) {
      return invalidOutput();
    }
    const source = exactObject(targetSource, ["source", "repo"]);
    if (
      source.source !== "github" ||
      source.repo !== CLAUDE_CODE_MARKETPLACE_SOURCE
    ) {
      return invalidOutput();
    }
    match = {
      name: CLAUDE_CODE_MARKETPLACE_NAME,
      source: CLAUDE_CODE_MARKETPLACE_SOURCE,
    };
  }

  return match === null ? absent() : present(match);
}

function isConflictingPlurumPluginId(id: string): boolean {
  const separator = id.indexOf("@");
  const pluginName = separator === -1 ? id : id.slice(0, separator);
  return pluginName.toLowerCase() === CLAUDE_CODE_PLUGIN_NAME;
}

function normalizeEmptyErrors(value: SafeJson): void {
  if (!Array.isArray(value) || value.length !== 0) {
    return invalidOutput();
  }
}

function normalizePluginList(
  value: SafeJson,
): ObservedSlot<HostPluginDescriptor> {
  const entries = safeArray(value);
  let match: HostPluginDescriptor | null = null;

  for (const rawEntry of entries) {
    const entry = safeObject(rawEntry);
    const rawId = entry.id;
    if (typeof rawId !== "string") {
      return invalidOutput();
    }
    if (rawId !== CLAUDE_CODE_PLUGIN_ID) {
      if (isConflictingPlurumPluginId(rawId)) {
        return invalidOutput();
      }
      continue;
    }
    if (match !== null) {
      return invalidOutput();
    }

    const target = exactObject(
      entry,
      ["id", "version", "scope", "enabled"],
      ["errors"],
    );
    if (target.scope !== "user" || typeof target.enabled !== "boolean") {
      return invalidOutput();
    }
    if (Object.hasOwn(target, "errors")) {
      normalizeEmptyErrors(target.errors!);
    }
    const version = stringField(target, "version");
    try {
      parseCanonicalVersion(version);
    } catch {
      return invalidOutput();
    }

    match = {
      name: CLAUDE_CODE_PLUGIN_NAME,
      source: CLAUDE_CODE_PLUGIN_SOURCE,
      version,
      enabled: target.enabled,
    };
  }

  if (match === null) {
    return absent<HostPluginDescriptor>();
  }
  return present(match);
}

export function normalizeClaudeCodeMarketplaceListJson(
  value: unknown,
): ObservedSlot<HostMarketplaceDescriptor> {
  return normalizeMarketplaceList(normalizeSafeJson(value));
}

export function parseClaudeCodeMarketplaceListOutput(
  output: string,
): ObservedSlot<HostMarketplaceDescriptor> {
  return normalizeMarketplaceList(parseJsonOutput(output));
}

export function normalizeClaudeCodePluginListJson(
  value: unknown,
): ObservedSlot<HostPluginDescriptor> {
  return normalizePluginList(normalizeSafeJson(value));
}

export function parseClaudeCodePluginListOutput(
  output: string,
): ObservedSlot<HostPluginDescriptor> {
  return normalizePluginList(parseJsonOutput(output));
}
