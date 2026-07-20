import { validateAgentCredential } from "../api/agent-validation.js";
import type {
  CredentialEnvironmentAdapter,
  HashAdapter,
  PlatformAdapter,
  ReadOnlyNetworkAdapter,
} from "../system/contracts.js";
import {
  copyCredentialEnvironmentSnapshot,
} from "../system/credential-environment.js";
import {
  LEGACY_CREDENTIAL_SOURCE_IDS,
  resolveLegacyCredentialPath,
} from "./discovery-paths.js";
import { CredentialError } from "./errors.js";
import {
  type CredentialKeyFingerprint,
  identifyCredentialKey,
} from "./fingerprint.js";
import {
  readLegacyCredential,
} from "./legacy-reader.js";
import type {
  LegacyCredentialReadAdapter,
  LegacyCredentialSource,
} from "./legacy-reader-contracts.js";
import {
  DEFAULT_API_ORIGIN,
  type ApiOrigin,
  type ApiOriginPolicy,
  normalizeApiOrigin,
} from "./origin.js";
import { resolveCredentialLocations } from "./paths.js";
import {
  type ApiKey,
  type CredentialV1,
  containsApiKeyToken,
  parseApiKey,
} from "./schema.js";
import {
  readCredentialStore,
} from "./store.js";
import type {
  CredentialStoreReadAdapter,
} from "./store-contracts.js";

export const CREDENTIAL_DISCOVERY_SOURCES = Object.freeze([
  "environment",
  "canonical",
  "hermes",
  "openclaw",
  "removed-cli",
] as const);

export type CredentialDiscoverySource =
  (typeof CREDENTIAL_DISCOVERY_SOURCES)[number];

export type CredentialDiscoveryBlockerReason =
  | "canonical_credential_pending"
  | "canonical_credential_unavailable"
  | "canonical_identity_mismatch"
  | "canonical_location_invalid"
  | "credential_discovery_unavailable"
  | "credential_environment_invalid"
  | "credential_fingerprint_collision"
  | "credential_fingerprint_unavailable"
  | "credential_source_malformed"
  | "credential_origin_required"
  | "credential_source_unsafe"
  | "credential_source_unavailable"
  | "credential_validation_unavailable"
  | "legacy_locations_invalid";

export interface CredentialDiscoveryBlocker {
  readonly reason: CredentialDiscoveryBlockerReason;
  readonly sources: readonly CredentialDiscoverySource[];
}

export interface CredentialAgentSummary {
  readonly id: string;
  readonly name: string;
  readonly username: string | null;
}

export interface CredentialCandidateSummary {
  readonly selectionId: string;
  readonly apiOrigin: ApiOrigin;
  readonly fingerprint: CredentialKeyFingerprint;
  readonly agent: CredentialAgentSummary;
  readonly sources: readonly CredentialDiscoverySource[];
}

export interface ResolvedCredential {
  readonly apiOrigin: ApiOrigin;
  readonly apiKey: ApiKey;
  readonly fingerprint: CredentialKeyFingerprint;
  readonly agent: CredentialAgentSummary;
  readonly sources: readonly CredentialDiscoverySource[];
}

interface DiscoveryResultCommon {
  readonly registrationAllowed: boolean;
  readonly invalidSources: readonly CredentialDiscoverySource[];
}

export type CredentialDiscoveryResult =
  | (DiscoveryResultCommon &
      Readonly<{
        status: "not-found";
        registrationAllowed: true;
      }>)
  | (DiscoveryResultCommon &
      Readonly<{
        status: "all-invalid";
        registrationAllowed: true;
      }>)
  | (DiscoveryResultCommon &
      Readonly<{
        status: "ready";
        registrationAllowed: false;
        candidate: CredentialCandidateSummary;
        credential: ResolvedCredential;
      }>)
  | (DiscoveryResultCommon &
      Readonly<{
        status: "selection-required";
        registrationAllowed: false;
        candidates: readonly CredentialCandidateSummary[];
        select(selectionId: string): ResolvedCredential;
      }>)
  | (DiscoveryResultCommon &
      Readonly<{
        status: "blocked";
        registrationAllowed: false;
        blockers: readonly CredentialDiscoveryBlocker[];
        validCandidates: readonly CredentialCandidateSummary[];
      }>);

export interface CredentialDiscoveryDependencies {
  readonly credentialEnvironment: CredentialEnvironmentAdapter;
  readonly canonicalStore: CredentialStoreReadAdapter;
  readonly legacyStore: LegacyCredentialReadAdapter;
  readonly network: ReadOnlyNetworkAdapter;
  readonly hash: HashAdapter;
  readonly platform: PlatformAdapter;
}

interface DiscoveryEnvironment {
  readonly apiKey: string | undefined;
  readonly apiOrigin: string | undefined;
  readonly hermesHome: string | undefined;
  readonly openclawHome: string | undefined;
}

interface RawCandidate {
  readonly apiKey: ApiKey;
  readonly apiOrigin: ApiOrigin;
  readonly sources: CredentialDiscoverySource[];
  canonicalCredential?: CredentialV1;
}

interface UnboundCandidate {
  readonly apiKey: ApiKey;
  readonly sources: CredentialDiscoverySource[];
}

interface IdentifiedCandidate extends RawCandidate {
  readonly identity: string;
  readonly fingerprint: CredentialKeyFingerprint;
}

interface ValidCandidate extends IdentifiedCandidate {
  readonly agent: CredentialAgentSummary;
}

const SOURCE_ORDER = new Map(
  CREDENTIAL_DISCOVERY_SOURCES.map((source, index) => [source, index]),
);

function sourceOrder(source: CredentialDiscoverySource): number {
  return SOURCE_ORDER.get(source) ?? Number.MAX_SAFE_INTEGER;
}

function sortedSources(
  sources: Iterable<CredentialDiscoverySource>,
): readonly CredentialDiscoverySource[] {
  return Object.freeze(
    [...new Set(sources)].sort(
      (left, right) => sourceOrder(left) - sourceOrder(right),
    ),
  );
}

function copyEnvironment(
  adapter: CredentialEnvironmentAdapter,
): DiscoveryEnvironment {
  try {
    const snapshot = copyCredentialEnvironmentSnapshot(adapter.read());
    const apiKey = snapshot.PLURUM_API_KEY;
    const apiOrigin = snapshot.PLURUM_API_URL;
    const hermesHome = snapshot.HERMES_HOME;
    const openclawHome = snapshot.OPENCLAW_HOME;
    return Object.freeze({
      apiKey: apiKey === "" ? undefined : apiKey,
      apiOrigin: apiOrigin === "" ? undefined : apiOrigin,
      hermesHome: hermesHome === "" ? undefined : hermesHome,
      openclawHome: openclawHome === "" ? undefined : openclawHome,
    });
  } catch {
    throw new CredentialDiscoveryError();
  }
}

class CredentialDiscoveryError extends Error {
  readonly code = "credential_discovery_failed";

  constructor() {
    super("Plurum credentials could not be discovered safely.");
    this.name = "CredentialDiscoveryError";
  }
}

function blocker(
  reason: CredentialDiscoveryBlockerReason,
  sources: Iterable<CredentialDiscoverySource>,
): CredentialDiscoveryBlocker {
  return Object.freeze({ reason, sources: sortedSources(sources) });
}

function blockerKey(value: CredentialDiscoveryBlocker): string {
  return `${value.reason}:${value.sources.join(",")}`;
}

function addBlocker(
  blockers: CredentialDiscoveryBlocker[],
  value: CredentialDiscoveryBlocker,
): void {
  const key = blockerKey(value);
  if (!blockers.some((existing) => blockerKey(existing) === key)) {
    blockers.push(value);
  }
}

function candidate(
  rawApiOrigin: string,
  rawApiKey: string,
  source: CredentialDiscoverySource,
  originPolicy: ApiOriginPolicy,
  canonicalCredential?: CredentialV1,
): RawCandidate {
  const apiKey = parseApiKey(rawApiKey);
  const apiOrigin = normalizeApiOrigin(rawApiOrigin, originPolicy);
  if (containsApiKeyToken(apiOrigin, apiKey)) {
    throw new CredentialDiscoveryError();
  }
  return {
    apiKey,
    apiOrigin,
    sources: [source],
    ...(canonicalCredential === undefined ? {} : { canonicalCredential }),
  };
}

function mergeRawCandidate(
  candidates: RawCandidate[],
  value: RawCandidate,
): void {
  const existing = candidates.find(
    (entry) =>
      entry.apiOrigin === value.apiOrigin && entry.apiKey === value.apiKey,
  );
  if (existing === undefined) {
    candidates.push(value);
    return;
  }
  existing.sources.push(...value.sources);
  if (value.canonicalCredential !== undefined) {
    existing.canonicalCredential = value.canonicalCredential;
  }
}

function sourceOrigin(
  source: LegacyCredentialSource,
  fileOrigin: string | null,
  environmentOrigin: string | undefined,
): string | undefined {
  if (source === "hermes") {
    return fileOrigin === null || fileOrigin === ""
      ? environmentOrigin
      : fileOrigin;
  }
  if (source === "removed-cli") {
    return environmentOrigin ??
      (fileOrigin === null || fileOrigin === ""
        ? undefined
        : fileOrigin);
  }
  return undefined;
}

function mergeUnboundCandidate(
  candidates: UnboundCandidate[],
  rawApiKey: string,
  source: CredentialDiscoverySource,
): void {
  const apiKey = parseApiKey(rawApiKey);
  const existing = candidates.find((entry) => entry.apiKey === apiKey);
  if (existing === undefined) {
    candidates.push({ apiKey, sources: [source] });
  } else {
    existing.sources.push(source);
  }
}

function bindUnboundCandidates(
  unboundCandidates: readonly UnboundCandidate[],
  boundCandidates: RawCandidate[],
  blockers: CredentialDiscoveryBlocker[],
): void {
  for (const unbound of unboundCandidates) {
    const matching = boundCandidates.filter(
      (candidateValue) => candidateValue.apiKey === unbound.apiKey,
    );
    const origins = new Set(
      matching.map((candidateValue) => candidateValue.apiOrigin),
    );
    if (origins.size !== 1) {
      addBlocker(
        blockers,
        blocker("credential_origin_required", [
          ...unbound.sources,
          ...matching.flatMap((candidateValue) => candidateValue.sources),
        ]),
      );
      continue;
    }
    const match = matching[0];
    if (match === undefined) {
      addBlocker(
        blockers,
        blocker("credential_origin_required", unbound.sources),
      );
      continue;
    }
    mergeRawCandidate(boundCandidates, {
      apiKey: unbound.apiKey,
      apiOrigin: match.apiOrigin,
      sources: [...unbound.sources],
    });
  }
}

function identifyCandidates(
  rawCandidates: readonly RawCandidate[],
  hash: HashAdapter,
  originPolicy: ApiOriginPolicy,
  blockers: CredentialDiscoveryBlocker[],
): readonly IdentifiedCandidate[] {
  const byIdentity = new Map<string, IdentifiedCandidate>();
  const byFingerprint = new Map<string, string>();

  for (const raw of rawCandidates) {
    let descriptor;
    try {
      descriptor = identifyCredentialKey(
        raw.apiOrigin,
        raw.apiKey,
        originPolicy,
        hash,
      );
    } catch {
      addBlocker(
        blockers,
        blocker("credential_fingerprint_unavailable", raw.sources),
      );
      continue;
    }

    const existing = byIdentity.get(descriptor.identity);
    if (existing !== undefined) {
      if (
        existing.apiOrigin !== raw.apiOrigin ||
        existing.apiKey !== raw.apiKey
      ) {
        addBlocker(
          blockers,
          blocker("credential_fingerprint_collision", [
            ...existing.sources,
            ...raw.sources,
          ]),
        );
        continue;
      }
      existing.sources.push(...raw.sources);
      if (raw.canonicalCredential !== undefined) {
        existing.canonicalCredential = raw.canonicalCredential;
      }
      continue;
    }

    const fingerprintIdentity = byFingerprint.get(descriptor.fingerprint);
    if (
      fingerprintIdentity !== undefined &&
      fingerprintIdentity !== descriptor.identity
    ) {
      const colliding = byIdentity.get(fingerprintIdentity);
      addBlocker(
        blockers,
        blocker("credential_fingerprint_collision", [
          ...(colliding?.sources ?? []),
          ...raw.sources,
        ]),
      );
    } else {
      byFingerprint.set(descriptor.fingerprint, descriptor.identity);
    }

    byIdentity.set(descriptor.identity, {
      ...raw,
      identity: descriptor.identity,
      fingerprint: descriptor.fingerprint,
    });
  }

  return [...byIdentity.values()];
}

function frozenAgent(
  agent: CredentialAgentSummary,
): CredentialAgentSummary {
  return Object.freeze({
    id: agent.id,
    name: agent.name,
    username: agent.username,
  });
}

function summary(
  value: ValidCandidate,
  index: number,
): CredentialCandidateSummary {
  return Object.freeze({
    selectionId: `credential-${index + 1}`,
    apiOrigin: value.apiOrigin,
    fingerprint: value.fingerprint,
    agent: value.agent,
    sources: sortedSources(value.sources),
  });
}

function resolved(
  value: ValidCandidate,
): ResolvedCredential {
  const output = {
    apiOrigin: value.apiOrigin,
    fingerprint: value.fingerprint,
    agent: value.agent,
    sources: sortedSources(value.sources),
  } as ResolvedCredential;
  Object.defineProperty(output, "apiKey", {
    configurable: false,
    enumerable: false,
    value: value.apiKey,
    writable: false,
  });
  return Object.freeze(output);
}

function safeInvalidSources(
  sources: Iterable<CredentialDiscoverySource>,
): readonly CredentialDiscoverySource[] {
  return sortedSources(sources);
}

function blockedResult(
  blockers: readonly CredentialDiscoveryBlocker[],
  validCandidates: readonly ValidCandidate[] = [],
  invalidSources: Iterable<CredentialDiscoverySource> = [],
): CredentialDiscoveryResult {
  return Object.freeze({
    status: "blocked" as const,
    registrationAllowed: false as const,
    blockers: Object.freeze([...blockers]),
    validCandidates: Object.freeze(
      validCandidates.map((value, index) => summary(value, index)),
    ),
    invalidSources: safeInvalidSources(invalidSources),
  });
}

function fatalBlockedResult(): CredentialDiscoveryResult {
  return blockedResult([
    blocker(
      "credential_discovery_unavailable",
      CREDENTIAL_DISCOVERY_SOURCES,
    ),
  ]);
}

async function discover(
  dependencies: CredentialDiscoveryDependencies,
  originPolicy: ApiOriginPolicy,
): Promise<CredentialDiscoveryResult> {
  const blockers: CredentialDiscoveryBlocker[] = [];
  const invalidSources: CredentialDiscoverySource[] = [];
  const rawCandidates: RawCandidate[] = [];
  const unboundCandidates: UnboundCandidate[] = [];

  let environment: DiscoveryEnvironment;
  try {
    environment = copyEnvironment(dependencies.credentialEnvironment);
  } catch {
    return blockedResult([
      blocker("credential_environment_invalid", ["environment"]),
    ]);
  }

  if (environment.apiOrigin !== undefined) {
    try {
      normalizeApiOrigin(
        environment.apiOrigin,
        originPolicy,
      );
    } catch {
      addBlocker(
        blockers,
        blocker("credential_environment_invalid", ["environment"]),
      );
    }
  }

  if (environment.apiKey !== undefined) {
    try {
      mergeRawCandidate(
        rawCandidates,
        candidate(
          environment.apiOrigin ?? DEFAULT_API_ORIGIN,
          environment.apiKey,
          "environment",
          originPolicy,
        ),
      );
    } catch {
      addBlocker(
        blockers,
        blocker("credential_source_malformed", ["environment"]),
      );
    }
  }

  let locations;
  try {
    locations = resolveCredentialLocations(dependencies.platform);
  } catch {
    addBlocker(
      blockers,
      blocker("canonical_location_invalid", ["canonical"]),
    );
  }

  if (locations !== undefined) {
    try {
      const canonical = await readCredentialStore(
        dependencies.canonicalStore,
        locations,
        originPolicy,
      );
      if (canonical.status === "loaded") {
        mergeRawCandidate(
          rawCandidates,
          candidate(
            canonical.credential.api_origin,
            canonical.credential.api_key,
            "canonical",
            originPolicy,
            canonical.credential,
          ),
        );
        if (canonical.credential.state === "pending") {
          addBlocker(
            blockers,
            blocker("canonical_credential_pending", ["canonical"]),
          );
        }
      }
    } catch (error) {
      let reason: CredentialDiscoveryBlockerReason =
        "canonical_credential_unavailable";
      if (error instanceof CredentialError) {
        if (error.code === "unsafe_credential_store") {
          reason = "credential_source_unsafe";
        } else if (
          error.code === "invalid_credential_document" ||
          error.code === "invalid_credential_origin" ||
          error.code === "unsupported_credential_schema" ||
          error.code === "credential_document_too_large"
        ) {
          reason = "credential_source_malformed";
        }
      }
      addBlocker(blockers, blocker(reason, ["canonical"]));
    }
  }

  const legacyEnvironment = {
    ...(environment.hermesHome === undefined
      ? {}
      : { HERMES_HOME: environment.hermesHome }),
    ...(environment.openclawHome === undefined
      ? {}
      : { OPENCLAW_HOME: environment.openclawHome }),
  };
  for (const source of LEGACY_CREDENTIAL_SOURCE_IDS) {
    let legacyPath;
    try {
      legacyPath = resolveLegacyCredentialPath(
        dependencies.platform,
        source,
        legacyEnvironment,
      );
    } catch {
      addBlocker(
        blockers,
        blocker("legacy_locations_invalid", [source]),
      );
      continue;
    }
    const legacy = await readLegacyCredential(
      dependencies.legacyStore,
      legacyPath.source,
      legacyPath.path,
    );
    if (legacy.status === "missing") {
      continue;
    }
    if (legacy.status === "unsafe") {
      addBlocker(
        blockers,
        blocker("credential_source_unsafe", [legacy.source]),
      );
      continue;
    }
    if (legacy.status === "malformed") {
      addBlocker(
        blockers,
        blocker("credential_source_malformed", [legacy.source]),
      );
      continue;
    }
    if (legacy.status === "unavailable") {
      addBlocker(
        blockers,
        blocker("credential_source_unavailable", [legacy.source]),
      );
      continue;
    }

    try {
      const origin = sourceOrigin(
        legacy.source,
        legacy.apiOrigin,
        environment.apiOrigin,
      );
      if (origin === undefined) {
        mergeUnboundCandidate(
          unboundCandidates,
          legacy.apiKey,
          legacy.source,
        );
      } else {
        mergeRawCandidate(
          rawCandidates,
          candidate(
            origin,
            legacy.apiKey,
            legacy.source,
            originPolicy,
          ),
        );
      }
    } catch {
      addBlocker(
        blockers,
        blocker("credential_source_malformed", [legacy.source]),
      );
    }
  }

  bindUnboundCandidates(unboundCandidates, rawCandidates, blockers);

  const identified = identifyCandidates(
    rawCandidates,
    dependencies.hash,
    originPolicy,
    blockers,
  );
  const validCandidates: ValidCandidate[] = [];

  for (const value of identified) {
    const validation = await validateAgentCredential(
      dependencies.network,
      value.apiOrigin,
      value.apiKey,
      originPolicy,
    );
    if (validation.status === "invalid") {
      invalidSources.push(...value.sources);
      continue;
    }
    if (validation.status === "indeterminate") {
      addBlocker(
        blockers,
        blocker("credential_validation_unavailable", value.sources),
      );
      continue;
    }

    const canonical = value.canonicalCredential;
    if (
      canonical?.state === "active" &&
      canonical.agent_id !== validation.agent.id
    ) {
      addBlocker(
        blockers,
        blocker("canonical_identity_mismatch", ["canonical"]),
      );
      continue;
    }
    validCandidates.push({
      ...value,
      agent: frozenAgent(validation.agent),
    });
  }

  if (blockers.length > 0) {
    return blockedResult(blockers, validCandidates, invalidSources);
  }
  if (validCandidates.length === 0) {
    return Object.freeze({
      status:
        rawCandidates.length === 0
          ? ("not-found" as const)
          : ("all-invalid" as const),
      registrationAllowed: true as const,
      invalidSources: safeInvalidSources(invalidSources),
    });
  }
  if (validCandidates.length === 1) {
    const value = validCandidates[0];
    if (value === undefined) {
      return fatalBlockedResult();
    }
    return Object.freeze({
      status: "ready" as const,
      registrationAllowed: false as const,
      candidate: summary(value, 0),
      credential: resolved(value),
      invalidSources: safeInvalidSources(invalidSources),
    });
  }

  const summaries = Object.freeze(
    validCandidates.map((value, index) => summary(value, index)),
  );
  const output = {
    status: "selection-required" as const,
    registrationAllowed: false as const,
    candidates: summaries,
    invalidSources: safeInvalidSources(invalidSources),
  } as CredentialDiscoveryResult & {
    select(selectionId: string): ResolvedCredential;
  };
  Object.defineProperty(output, "select", {
    configurable: false,
    enumerable: false,
    value(selectionId: string): ResolvedCredential {
      try {
        const index = summaries.findIndex(
          (entry) => entry.selectionId === selectionId,
        );
        const selected = validCandidates[index];
        if (index < 0 || selected === undefined) {
          throw new CredentialDiscoveryError();
        }
        return resolved(selected);
      } catch {
        throw new CredentialDiscoveryError();
      }
    },
    writable: false,
  });
  return Object.freeze(output);
}

export async function discoverCredentials(
  dependencies: CredentialDiscoveryDependencies,
  originPolicy: ApiOriginPolicy = "https-only",
): Promise<CredentialDiscoveryResult> {
  try {
    if (
      dependencies === null ||
      typeof dependencies !== "object" ||
      (originPolicy !== "https-only" &&
        originPolicy !== "explicit-loopback-development")
    ) {
      return fatalBlockedResult();
    }
    return await discover(dependencies, originPolicy);
  } catch {
    return fatalBlockedResult();
  }
}
