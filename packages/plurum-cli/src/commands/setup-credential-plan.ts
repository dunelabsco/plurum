import {
  CREDENTIAL_DISCOVERY_SOURCES,
  type CredentialDiscoveryBlockerReason,
} from "../credentials/discovery.js";
import type {
  CredentialKeyFingerprint,
} from "../credentials/fingerprint.js";
import {
  DEFAULT_API_ORIGIN,
  type ApiOrigin,
  normalizeApiOrigin,
} from "../credentials/origin.js";
import { containsApiKeyToken } from "../credentials/schema.js";
import {
  containsHostControlCharacter,
  containsHostSensitiveMaterial,
} from "../hosts/privacy.js";

export const SETUP_CREDENTIAL_SOURCES = Object.freeze([
  ...CREDENTIAL_DISCOVERY_SOURCES,
  "protected-input",
] as const);

export type SetupCredentialSource =
  (typeof SETUP_CREDENTIAL_SOURCES)[number];

export type SetupCredentialTransactionState =
  | "clean"
  | "recovery-required"
  | "unavailable";

export interface SetupCredentialAgentSummary {
  readonly id: string;
  readonly name: string;
  readonly username: string | null;
}

export interface SetupCredentialCandidate {
  readonly selectionId: string;
  readonly apiOrigin: ApiOrigin;
  readonly fingerprint: CredentialKeyFingerprint;
  readonly agent: SetupCredentialAgentSummary;
  readonly sources: readonly SetupCredentialSource[];
}

export interface SetupCredentialPlanningBlocker {
  readonly reason: CredentialDiscoveryBlockerReason;
  readonly sources: readonly SetupCredentialSource[];
}

export type SetupCanonicalCredentialObservation =
  | Readonly<{
      readonly status: "missing";
    }>
  | Readonly<{
      readonly status: "active-valid";
      readonly candidateSelectionId: string;
    }>
  | Readonly<{
      readonly status: "active-invalid";
    }>
  | Readonly<{
      readonly status: "pending";
      readonly apiOrigin: ApiOrigin;
      readonly fingerprint: CredentialKeyFingerprint;
      readonly agent: Readonly<{
        readonly name: string;
        readonly username: string;
      }>;
      readonly sources: readonly SetupCredentialSource[];
      readonly resumeEvidence:
        | "authenticated-match"
        | "definitively-inactive"
        | "identity-mismatch"
        | "validation-unavailable";
    }>
  | Readonly<{
      readonly status: "unavailable";
    }>;

export interface SetupCredentialPlanningObservation {
  readonly schemaVersion: 1;
  readonly transaction: SetupCredentialTransactionState;
  readonly canonical: SetupCanonicalCredentialObservation;
  readonly candidates: readonly SetupCredentialCandidate[];
  readonly blockers: readonly SetupCredentialPlanningBlocker[];
  readonly invalidSources: readonly SetupCredentialSource[];
}

export interface SetupCredentialPlanningDecision {
  readonly selectedCandidateId: string | null;
  readonly registration: Readonly<{
    readonly agentName: string;
    readonly username: string;
  }> | null;
}

export interface SetupCredentialPlanningRequest {
  readonly observation: SetupCredentialPlanningObservation;
  readonly decision: SetupCredentialPlanningDecision;
}

interface SetupCredentialResolvedCommon {
  readonly status: "resolved";
  readonly apiOrigin: ApiOrigin;
  readonly invalidSources: readonly SetupCredentialSource[];
}

export type SetupCredentialResolvedPlan =
  | (SetupCredentialResolvedCommon &
      Readonly<{
        readonly disposition: "reuse";
        readonly acquisition: "existing";
        readonly canonicalEffect: "unchanged";
        readonly reason: "canonical-credential-valid";
        readonly credential: SetupCredentialCandidate;
      }>)
  | (SetupCredentialResolvedCommon &
      Readonly<{
        readonly disposition: "adopt";
        readonly acquisition: "existing";
        readonly canonicalEffect: "create";
        readonly reason: "canonical-credential-missing";
        readonly credential: SetupCredentialCandidate;
      }>)
  | (SetupCredentialResolvedCommon &
      Readonly<{
        readonly disposition: "replace";
        readonly acquisition: "existing";
        readonly canonicalEffect: "replace";
        readonly reason:
          | "canonical-credential-invalid"
          | "different-credential-selected";
        readonly credential: SetupCredentialCandidate;
      }>)
  | (SetupCredentialResolvedCommon &
      Readonly<{
        readonly disposition: "register";
        readonly acquisition: "new-registration";
        readonly canonicalEffect: "create";
        readonly reason:
          | "credential-not-found"
          | "all-discovered-credentials-invalid";
        readonly registration: Readonly<{
          readonly mode: "new";
          readonly agent: Readonly<{
            readonly name: string;
            readonly username: string;
          }>;
        }>;
      }>)
  | (SetupCredentialResolvedCommon &
      Readonly<{
        readonly disposition: "replace";
        readonly acquisition: "new-registration";
        readonly canonicalEffect: "replace";
        readonly reason: "canonical-credential-invalid";
        readonly registration: Readonly<{
          readonly mode: "new";
          readonly agent: Readonly<{
            readonly name: string;
            readonly username: string;
          }>;
        }>;
      }>)
  | (SetupCredentialResolvedCommon &
      Readonly<{
        readonly disposition: "register";
        readonly acquisition: "resume-registration";
        readonly canonicalEffect: "resume";
        readonly reason: "canonical-registration-pending";
        readonly registration: Readonly<{
          readonly mode: "resume";
          readonly nextStep:
            | "activate-existing"
            | "retry-registration";
          readonly fingerprint: CredentialKeyFingerprint;
          readonly agent: Readonly<{
            readonly name: string;
            readonly username: string;
          }>;
          readonly sources: readonly SetupCredentialSource[];
        }>;
      }>);

export type SetupCredentialPlanningResult =
  | SetupCredentialResolvedPlan
  | Readonly<{
      readonly status: "selection-required";
      readonly reason: "multiple-valid-credentials";
      readonly candidates: readonly SetupCredentialCandidate[];
      readonly invalidSources: readonly SetupCredentialSource[];
    }>
  | Readonly<{
      readonly status: "registration-input-required";
      readonly reason:
        | "credential-not-found"
        | "all-discovered-credentials-invalid"
        | "canonical-credential-invalid";
      readonly apiOrigin: ApiOrigin;
      readonly canonicalEffect: "create" | "replace";
      readonly invalidSources: readonly SetupCredentialSource[];
    }>
  | Readonly<{
      readonly status: "blocked";
      readonly disposition: "blocked";
      readonly category: "blocked" | "unavailable";
      readonly reason:
        | "credential-discovery-blocked"
        | "credential-discovery-unavailable"
        | "explicit-credential-invalid"
        | "credential-origin-mismatch"
        | "credential-recovery-required"
        | "credential-recovery-unavailable";
      readonly candidates: readonly SetupCredentialCandidate[];
      readonly blockers: readonly SetupCredentialPlanningBlocker[];
      readonly invalidSources: readonly SetupCredentialSource[];
    }>;

export class SetupCredentialPlanError extends Error {
  readonly code = "invalid_setup_credential_plan";

  constructor() {
    super("The setup credential plan could not be created safely.");
    this.name = "SetupCredentialPlanError";
  }
}

type PlainRecord = Readonly<Record<string, unknown>>;

interface NormalizedPlanningObservation {
  readonly transaction: SetupCredentialTransactionState;
  readonly canonical: SetupCanonicalCredentialObservation;
  readonly candidates: readonly SetupCredentialCandidate[];
  readonly blockers: readonly SetupCredentialPlanningBlocker[];
  readonly invalidSources: readonly SetupCredentialSource[];
}

interface NormalizedPlanningDecision {
  readonly selectedCandidateId: string | null;
  readonly registration: Readonly<{
    readonly agentName: string;
    readonly username: string;
  }> | null;
}

const MAX_CANDIDATES = 32;
const MAX_BLOCKERS = 32;
const SELECTION_ID = /^credential-([1-9][0-9]{0,3})$/u;
const FINGERPRINT = /^plurum-fp-v1:[0-9a-f]{12}$/u;
const AGENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const USERNAME = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u;
const NAME_DISPLAY_CONTROL = /[\u061c\u200e\u200f\u2028-\u202e\u2066-\u206f]/u;

const SOURCE_ORDER = new Map(
  SETUP_CREDENTIAL_SOURCES.map((source, index) => [source, index]),
);
const SOURCE_SET: ReadonlySet<string> = new Set(
  SETUP_CREDENTIAL_SOURCES,
);
const BLOCKER_REASON_SET: ReadonlySet<string> = new Set([
  "canonical_credential_pending",
  "canonical_credential_unavailable",
  "canonical_identity_mismatch",
  "canonical_location_invalid",
  "credential_discovery_unavailable",
  "credential_environment_invalid",
  "credential_fingerprint_collision",
  "credential_fingerprint_unavailable",
  "credential_source_malformed",
  "credential_origin_required",
  "credential_source_unsafe",
  "credential_source_unavailable",
  "credential_validation_unavailable",
  "legacy_locations_invalid",
] satisfies readonly CredentialDiscoveryBlockerReason[]);
const UNAVAILABLE_BLOCKER_REASONS: ReadonlySet<
  CredentialDiscoveryBlockerReason
> = new Set([
  "canonical_credential_unavailable",
  "credential_discovery_unavailable",
  "credential_fingerprint_unavailable",
  "credential_source_unavailable",
  "credential_validation_unavailable",
]);
const OWNED_RESOLVED_PLANS = new WeakSet<object>();

function invalidPlan(): never {
  throw new SetupCredentialPlanError();
}

function exactRecord(
  value: unknown,
  fields: readonly string[],
): PlainRecord {
  let array: boolean;
  let prototype: object | null;
  let names: readonly string[];
  let symbols: readonly symbol[];
  try {
    array = Array.isArray(value);
    if (value === null || typeof value !== "object" || array) {
      return invalidPlan();
    }
    prototype = Object.getPrototypeOf(value) as object | null;
    names = Object.getOwnPropertyNames(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return invalidPlan();
  }
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    symbols.length !== 0 ||
    names.length !== fields.length ||
    names.some((name) => !fields.includes(name)) ||
    fields.some((field) => !names.includes(field))
  ) {
    return invalidPlan();
  }

  const snapshot: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const field of fields) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, field);
    } catch {
      return invalidPlan();
    }
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      return invalidPlan();
    }
    snapshot[field] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function recordField(value: unknown, field: string): unknown {
  let array: boolean;
  let prototype: object | null;
  let symbols: readonly symbol[];
  let descriptor: PropertyDescriptor | undefined;
  try {
    array = Array.isArray(value);
    if (value === null || typeof value !== "object" || array) {
      return invalidPlan();
    }
    prototype = Object.getPrototypeOf(value) as object | null;
    symbols = Object.getOwnPropertySymbols(value);
    descriptor = Object.getOwnPropertyDescriptor(value, field);
  } catch {
    return invalidPlan();
  }
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    symbols.length !== 0 ||
    descriptor === undefined ||
    !Object.hasOwn(descriptor, "value") ||
    descriptor.enumerable !== true ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined
  ) {
    return invalidPlan();
  }
  return descriptor.value;
}

function exactArray(value: unknown, maximum: number): readonly unknown[] {
  let array: boolean;
  let prototype: object | null;
  let names: readonly string[];
  let symbols: readonly symbol[];
  try {
    array = Array.isArray(value);
    if (!array) {
      return invalidPlan();
    }
    prototype = Object.getPrototypeOf(value) as object | null;
    names = Object.getOwnPropertyNames(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return invalidPlan();
  }
  if (
    prototype !== Array.prototype ||
    symbols.length !== 0
  ) {
    return invalidPlan();
  }

  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    return invalidPlan();
  }
  const length = lengthDescriptor?.value;
  if (
    lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, "value") ||
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > maximum ||
    names.length !== length + 1
  ) {
    return invalidPlan();
  }

  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const field = String(index);
    if (!names.includes(field)) {
      return invalidPlan();
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, field);
    } catch {
      return invalidPlan();
    }
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      return invalidPlan();
    }
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function safeSelectionId(value: unknown): string {
  if (typeof value !== "string" || !SELECTION_ID.test(value)) {
    return invalidPlan();
  }
  return value;
}

function safeOrigin(value: unknown): ApiOrigin {
  try {
    const normalized = normalizeApiOrigin(value, "https-only");
    if (normalized !== value || containsHostSensitiveMaterial(normalized)) {
      return invalidPlan();
    }
    return normalized;
  } catch {
    return invalidPlan();
  }
}

function safeFingerprint(value: unknown): CredentialKeyFingerprint {
  if (typeof value !== "string" || !FINGERPRINT.test(value)) {
    return invalidPlan();
  }
  return value as CredentialKeyFingerprint;
}

function safeAgentName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 510 ||
    containsHostControlCharacter(value) ||
    NAME_DISPLAY_CONTROL.test(value) ||
    containsApiKeyToken(value) ||
    containsHostSensitiveMaterial(value)
  ) {
    return invalidPlan();
  }
  let codePoints = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      (codePoints += 1) > 255
    ) {
      return invalidPlan();
    }
  }
  return value;
}

function safeUsername(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > 50 ||
    !USERNAME.test(value) ||
    containsApiKeyToken(value) ||
    containsHostSensitiveMaterial(value)
  ) {
    return invalidPlan();
  }
  return value;
}

function safeAgentId(value: unknown): string {
  if (typeof value !== "string" || !AGENT_ID.test(value)) {
    return invalidPlan();
  }
  return value;
}

function sourceList(
  value: unknown,
  allowEmpty: boolean,
): readonly SetupCredentialSource[] {
  const values = exactArray(value, SETUP_CREDENTIAL_SOURCES.length);
  const sources: SetupCredentialSource[] = [];
  for (const entry of values) {
    if (typeof entry !== "string" || !SOURCE_SET.has(entry)) {
      return invalidPlan();
    }
    const source = entry as SetupCredentialSource;
    if (sources.includes(source)) {
      return invalidPlan();
    }
    sources.push(source);
  }
  if (!allowEmpty && sources.length === 0) {
    return invalidPlan();
  }
  sources.sort(
    (left, right) =>
      (SOURCE_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (SOURCE_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER),
  );
  return Object.freeze(sources);
}

function agentSummary(value: unknown): SetupCredentialAgentSummary {
  const record = exactRecord(value, ["id", "name", "username"]);
  const username = record.username;
  if (username !== null && typeof username !== "string") {
    return invalidPlan();
  }
  return Object.freeze({
    id: safeAgentId(record.id),
    name: safeAgentName(record.name),
    username: username === null ? null : safeUsername(username),
  });
}

function candidate(value: unknown): SetupCredentialCandidate {
  const record = exactRecord(value, [
    "selectionId",
    "apiOrigin",
    "fingerprint",
    "agent",
    "sources",
  ]);
  return Object.freeze({
    selectionId: safeSelectionId(record.selectionId),
    apiOrigin: safeOrigin(record.apiOrigin),
    fingerprint: safeFingerprint(record.fingerprint),
    agent: agentSummary(record.agent),
    sources: sourceList(record.sources, false),
  });
}

function candidateList(
  value: unknown,
): readonly SetupCredentialCandidate[] {
  const values = exactArray(value, MAX_CANDIDATES);
  const candidates = values.map(candidate);
  for (let index = 0; index < candidates.length; index += 1) {
    const entry = candidates[index] ?? invalidPlan();
    if (entry.selectionId !== `credential-${index + 1}`) {
      return invalidPlan();
    }
  }
  return Object.freeze(candidates);
}

function planningBlocker(
  value: unknown,
): SetupCredentialPlanningBlocker {
  const record = exactRecord(value, ["reason", "sources"]);
  if (
    typeof record.reason !== "string" ||
    !BLOCKER_REASON_SET.has(record.reason)
  ) {
    return invalidPlan();
  }
  return Object.freeze({
    reason: record.reason as CredentialDiscoveryBlockerReason,
    sources: sourceList(record.sources, false),
  });
}

function blockerList(
  value: unknown,
): readonly SetupCredentialPlanningBlocker[] {
  const values = exactArray(value, MAX_BLOCKERS);
  const blockers = values.map(planningBlocker);
  const keys = new Set<string>();
  for (const entry of blockers) {
    const key = `${entry.reason}:${entry.sources.join(",")}`;
    if (keys.has(key)) {
      return invalidPlan();
    }
    keys.add(key);
  }
  return Object.freeze(blockers);
}

function pendingAgent(value: unknown): Readonly<{
  readonly name: string;
  readonly username: string;
}> {
  const record = exactRecord(value, ["name", "username"]);
  return Object.freeze({
    name: safeAgentName(record.name),
    username: safeUsername(record.username),
  });
}

function canonicalObservation(
  value: unknown,
): SetupCanonicalCredentialObservation {
  const status = recordField(value, "status");
  if (status === "missing") {
    const record = exactRecord(value, ["status"]);
    if (record.status !== status) {
      return invalidPlan();
    }
    return Object.freeze({ status });
  }
  if (status === "active-invalid") {
    const record = exactRecord(value, ["status"]);
    if (record.status !== status) {
      return invalidPlan();
    }
    return Object.freeze({ status });
  }
  if (status === "unavailable") {
    const record = exactRecord(value, ["status"]);
    if (record.status !== status) {
      return invalidPlan();
    }
    return Object.freeze({ status });
  }
  if (status === "active-valid") {
    const record = exactRecord(value, [
      "status",
      "candidateSelectionId",
    ]);
    if (record.status !== status) {
      return invalidPlan();
    }
    return Object.freeze({
      status,
      candidateSelectionId: safeSelectionId(
        record.candidateSelectionId,
      ),
    });
  }
  if (status === "pending") {
    const record = exactRecord(value, [
      "status",
      "apiOrigin",
      "fingerprint",
      "agent",
      "sources",
      "resumeEvidence",
    ]);
    if (
      record.status !== status ||
      record.resumeEvidence !== "authenticated-match" &&
      record.resumeEvidence !== "definitively-inactive" &&
      record.resumeEvidence !== "identity-mismatch" &&
      record.resumeEvidence !== "validation-unavailable"
    ) {
      return invalidPlan();
    }
    const sources = sourceList(record.sources, false);
    if (!sources.includes("canonical")) {
      return invalidPlan();
    }
    return Object.freeze({
      status,
      apiOrigin: safeOrigin(record.apiOrigin),
      fingerprint: safeFingerprint(record.fingerprint),
      agent: pendingAgent(record.agent),
      sources,
      resumeEvidence: record.resumeEvidence,
    });
  }
  return invalidPlan();
}

function normalizeObservation(
  value: unknown,
): NormalizedPlanningObservation {
  const record = exactRecord(value, [
    "schemaVersion",
    "transaction",
    "canonical",
    "candidates",
    "blockers",
    "invalidSources",
  ]);
  if (
    record.schemaVersion !== 1 ||
    (record.transaction !== "clean" &&
      record.transaction !== "recovery-required" &&
      record.transaction !== "unavailable")
  ) {
    return invalidPlan();
  }

  const canonical = canonicalObservation(record.canonical);
  const candidates = candidateList(record.candidates);
  const blockers = blockerList(record.blockers);
  const invalidSources = sourceList(record.invalidSources, true);
  const canonicalCandidates = candidates.filter((entry) =>
    entry.sources.includes("canonical"),
  );
  const assignedSources = new Set<SetupCredentialSource>();
  let contradictorySource = false;
  const fingerprints = new Set<string>();
  let duplicateFingerprint = false;
  for (const entry of candidates) {
    if (fingerprints.has(entry.fingerprint)) {
      duplicateFingerprint = true;
    }
    fingerprints.add(entry.fingerprint);
    for (const source of entry.sources) {
      if (
        assignedSources.has(source) ||
        invalidSources.includes(source)
      ) {
        contradictorySource = true;
      }
      assignedSources.add(source);
    }
  }
  if (canonical.status === "pending") {
    for (const source of canonical.sources) {
      if (
        assignedSources.has(source) ||
        (invalidSources.includes(source) &&
          canonical.resumeEvidence !== "definitively-inactive")
      ) {
        contradictorySource = true;
      }
      assignedSources.add(source);
    }
  }

  if (
    contradictorySource ||
    (duplicateFingerprint &&
      !blockers.some(
        (entry) => entry.reason === "credential_fingerprint_collision",
      )) ||
    (canonical.status === "missing" &&
      (canonicalCandidates.length !== 0 ||
        invalidSources.includes("canonical"))) ||
    (canonical.status === "active-invalid" &&
      (canonicalCandidates.length !== 0 ||
        !invalidSources.includes("canonical"))) ||
    (canonical.status === "active-valid" &&
      (invalidSources.includes("canonical") ||
        canonicalCandidates.length !== 1 ||
        canonicalCandidates[0]?.selectionId !==
          canonical.candidateSelectionId)) ||
    (canonical.status === "pending" &&
      (canonicalCandidates.length !== 0 ||
        (canonical.resumeEvidence === "definitively-inactive"
          ? !canonical.sources.every((source) =>
              invalidSources.includes(source),
            )
          : canonical.sources.some((source) =>
              invalidSources.includes(source),
            )) ||
        (canonical.resumeEvidence === "identity-mismatch" &&
          !blockers.some(
            (entry) =>
              entry.reason === "canonical_identity_mismatch" &&
              entry.sources.includes("canonical"),
          )) ||
        (canonical.resumeEvidence === "validation-unavailable" &&
          !blockers.some(
            (entry) =>
              entry.reason === "credential_validation_unavailable" &&
              entry.sources.includes("canonical"),
          )))) ||
    (canonical.status === "unavailable" &&
      !blockers.some((entry) => entry.sources.includes("canonical")))
  ) {
    return invalidPlan();
  }

  return Object.freeze({
    transaction: record.transaction,
    canonical,
    candidates,
    blockers,
    invalidSources,
  });
}

function normalizeDecision(value: unknown): NormalizedPlanningDecision {
  const record = exactRecord(value, [
    "selectedCandidateId",
    "registration",
  ]);
  const selectedCandidateId = record.selectedCandidateId;
  if (
    selectedCandidateId !== null &&
    typeof selectedCandidateId !== "string"
  ) {
    return invalidPlan();
  }

  let registration: NormalizedPlanningDecision["registration"] = null;
  if (record.registration !== null) {
    const registrationRecord = exactRecord(record.registration, [
      "agentName",
      "username",
    ]);
    registration = Object.freeze({
      agentName: safeAgentName(registrationRecord.agentName),
      username: safeUsername(registrationRecord.username),
    });
  }
  return Object.freeze({
    selectedCandidateId:
      selectedCandidateId === null
        ? null
        : safeSelectionId(selectedCandidateId),
    registration,
  });
}

function blocked(
  observation: NormalizedPlanningObservation,
  category: "blocked" | "unavailable",
  reason:
    | "credential-discovery-blocked"
    | "credential-discovery-unavailable"
    | "explicit-credential-invalid"
    | "credential-origin-mismatch"
    | "credential-recovery-required"
    | "credential-recovery-unavailable",
): SetupCredentialPlanningResult {
  return Object.freeze({
    status: "blocked",
    disposition: "blocked",
    category,
    reason,
    candidates: observation.candidates,
    blockers: observation.blockers,
    invalidSources: observation.invalidSources,
  });
}

function registrationInputReason(
  observation: NormalizedPlanningObservation,
): "credential-not-found" | "all-discovered-credentials-invalid" {
  return observation.invalidSources.length === 0
    ? "credential-not-found"
    : "all-discovered-credentials-invalid";
}

function planRegistration(
  observation: NormalizedPlanningObservation,
  decision: NormalizedPlanningDecision,
): SetupCredentialPlanningResult {
  const canonicalInvalid =
    observation.canonical.status === "active-invalid";
  if (decision.registration === null) {
    return Object.freeze({
      status: "registration-input-required",
      reason: canonicalInvalid
        ? "canonical-credential-invalid"
        : registrationInputReason(observation),
      apiOrigin: DEFAULT_API_ORIGIN,
      canonicalEffect: canonicalInvalid ? "replace" : "create",
      invalidSources: observation.invalidSources,
    });
  }
  const agent = Object.freeze({
    name: decision.registration.agentName,
    username: decision.registration.username,
  });
  const registration = Object.freeze({ mode: "new" as const, agent });
  if (canonicalInvalid) {
    return Object.freeze({
      status: "resolved",
      disposition: "replace",
      acquisition: "new-registration",
      canonicalEffect: "replace",
      reason: "canonical-credential-invalid",
      apiOrigin: DEFAULT_API_ORIGIN,
      registration,
      invalidSources: observation.invalidSources,
    });
  }
  return Object.freeze({
    status: "resolved",
    disposition: "register",
    acquisition: "new-registration",
    canonicalEffect: "create",
    reason: registrationInputReason(observation),
    apiOrigin: DEFAULT_API_ORIGIN,
    registration,
    invalidSources: observation.invalidSources,
  });
}

function resolvedCandidate(
  observation: NormalizedPlanningObservation,
  selected: SetupCredentialCandidate,
): SetupCredentialResolvedPlan {
  if (observation.canonical.status === "missing") {
    return Object.freeze({
      status: "resolved",
      disposition: "adopt",
      acquisition: "existing",
      canonicalEffect: "create",
      reason: "canonical-credential-missing",
      apiOrigin: DEFAULT_API_ORIGIN,
      credential: selected,
      invalidSources: observation.invalidSources,
    });
  }
  if (observation.canonical.status === "active-invalid") {
    return Object.freeze({
      status: "resolved",
      disposition: "replace",
      acquisition: "existing",
      canonicalEffect: "replace",
      reason: "canonical-credential-invalid",
      apiOrigin: DEFAULT_API_ORIGIN,
      credential: selected,
      invalidSources: observation.invalidSources,
    });
  }
  if (observation.canonical.status !== "active-valid") {
    return invalidPlan();
  }
  if (
    selected.selectionId ===
    observation.canonical.candidateSelectionId
  ) {
    return Object.freeze({
      status: "resolved",
      disposition: "reuse",
      acquisition: "existing",
      canonicalEffect: "unchanged",
      reason: "canonical-credential-valid",
      apiOrigin: DEFAULT_API_ORIGIN,
      credential: selected,
      invalidSources: observation.invalidSources,
    });
  }
  return Object.freeze({
    status: "resolved",
    disposition: "replace",
    acquisition: "existing",
    canonicalEffect: "replace",
    reason: "different-credential-selected",
    apiOrigin: DEFAULT_API_ORIGIN,
    credential: selected,
    invalidSources: observation.invalidSources,
  });
}

function createPlan(
  observation: NormalizedPlanningObservation,
  decision: NormalizedPlanningDecision,
): SetupCredentialPlanningResult {
  if (observation.transaction === "recovery-required") {
    return blocked(
      observation,
      "blocked",
      "credential-recovery-required",
    );
  }
  if (observation.transaction === "unavailable") {
    return blocked(
      observation,
      "unavailable",
      "credential-recovery-unavailable",
    );
  }
  if (observation.blockers.length > 0) {
    const unavailable = observation.blockers.some((entry) =>
      UNAVAILABLE_BLOCKER_REASONS.has(entry.reason),
    );
    return blocked(
      observation,
      unavailable ? "unavailable" : "blocked",
      unavailable
        ? "credential-discovery-unavailable"
        : "credential-discovery-blocked",
    );
  }
  if (observation.invalidSources.includes("protected-input")) {
    return blocked(
      observation,
      "blocked",
      "explicit-credential-invalid",
    );
  }
  if (observation.canonical.status === "unavailable") {
    return invalidPlan();
  }
  if (
    observation.candidates.some(
      (entry) => entry.apiOrigin !== DEFAULT_API_ORIGIN,
    ) ||
    (observation.canonical.status === "pending" &&
      observation.canonical.apiOrigin !== DEFAULT_API_ORIGIN)
  ) {
    return blocked(
      observation,
      "blocked",
      "credential-origin-mismatch",
    );
  }

  if (observation.canonical.status === "pending") {
    if (
      decision.selectedCandidateId !== null ||
      decision.registration !== null
    ) {
      return invalidPlan();
    }
    if (
      observation.canonical.resumeEvidence !==
        "authenticated-match" &&
      observation.canonical.resumeEvidence !==
        "definitively-inactive"
    ) {
      return invalidPlan();
    }
    return Object.freeze({
      status: "resolved",
      disposition: "register",
      acquisition: "resume-registration",
      canonicalEffect: "resume",
      reason: "canonical-registration-pending",
      apiOrigin: DEFAULT_API_ORIGIN,
      registration: Object.freeze({
        mode: "resume",
        nextStep:
          observation.canonical.resumeEvidence ===
          "authenticated-match"
            ? "activate-existing"
            : "retry-registration",
        fingerprint: observation.canonical.fingerprint,
        agent: observation.canonical.agent,
        sources: observation.canonical.sources,
      }),
      invalidSources: observation.invalidSources,
    });
  }

  if (decision.registration !== null) {
    if (
      observation.candidates.length !== 0 ||
      decision.selectedCandidateId !== null ||
      observation.canonical.status === "active-valid"
    ) {
      return invalidPlan();
    }
    return planRegistration(observation, decision);
  }

  if (observation.candidates.length === 0) {
    if (
      decision.selectedCandidateId !== null ||
      observation.canonical.status === "active-valid"
    ) {
      return invalidPlan();
    }
    return planRegistration(observation, decision);
  }

  let selected: SetupCredentialCandidate | undefined;
  if (decision.selectedCandidateId !== null) {
    selected = observation.candidates.find(
      (entry) =>
        entry.selectionId === decision.selectedCandidateId,
    );
    if (selected === undefined) {
      return invalidPlan();
    }
  } else if (observation.candidates.length === 1) {
    selected = observation.candidates[0];
  } else {
    return Object.freeze({
      status: "selection-required",
      reason: "multiple-valid-credentials",
      candidates: observation.candidates,
      invalidSources: observation.invalidSources,
    });
  }
  if (selected === undefined) {
    return invalidPlan();
  }
  return resolvedCandidate(observation, selected);
}

export function planSetupCredential(
  request: SetupCredentialPlanningRequest,
): SetupCredentialPlanningResult {
  try {
    const record = exactRecord(request, ["observation", "decision"]);
    const plan = createPlan(
      normalizeObservation(record.observation),
      normalizeDecision(record.decision),
    );
    if (plan.status === "resolved") {
      OWNED_RESOLVED_PLANS.add(plan);
    }
    return plan;
  } catch {
    throw new SetupCredentialPlanError();
  }
}

/*
 * Apply planning accepts only the exact resolved object returned above. This
 * runtime provenance check rejects forged, cloned, proxied, and unresolved
 * credential plans before any caller-controlled property is read.
 */
export function isOwnedSetupCredentialResolvedPlan(
  value: unknown,
): value is SetupCredentialResolvedPlan {
  return (
    typeof value === "object" &&
    value !== null &&
    OWNED_RESOLVED_PLANS.has(value)
  );
}
