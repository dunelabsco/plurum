import { probeApiReachability } from "../api/reachability.js";
import {
  copyCredentialEnvironmentSnapshot,
} from "../system/credential-environment.js";
import {
  CREDENTIAL_DISCOVERY_SOURCES,
  discoverCredentials,
  type CredentialCandidateSummary,
  type CredentialDiscoveryBlocker,
  type CredentialDiscoveryResult,
  type CredentialDiscoverySource,
  type ResolvedCredential,
} from "../credentials/discovery.js";
import type { LegacyCredentialReadAdapter } from "../credentials/legacy-reader-contracts.js";
import {
  DEFAULT_API_ORIGIN,
  type ApiOrigin,
  type ApiOriginPolicy,
  normalizeApiOrigin,
} from "../credentials/origin.js";
import type { CredentialStoreReadAdapter } from "../credentials/store-contracts.js";
import {
  observeCodexDotenvStatus,
  type CodexDotenvStatusObservationAdapter,
} from "../credentials/codex-dotenv-status.js";
import {
  containsApiKeyToken,
  type ApiKey,
} from "../credentials/schema.js";
import {
  containsHostControlCharacter,
  containsHostSensitiveMaterial,
} from "../hosts/privacy.js";
import {
  CLAUDE_CODE_DESIRED_CONFIGURATION,
} from "../hosts/claude-code/configuration.js";
import {
  CODEX_DESIRED_CONFIGURATION,
} from "../hosts/codex/configuration.js";
import {
  HOST_IDS,
  type DesiredHostConfiguration,
  type HostId,
  type HostInspection,
} from "../hosts/contracts.js";
import {
  projectHostStatus,
  type PublicHostStatusProjection,
} from "../hosts/status.js";
import type {
  CredentialEnvironmentAdapter,
  CredentialEnvironmentSnapshot,
  StatusCapabilities,
} from "../system/contracts.js";
import { CLI_VERSION } from "../version.js";
import type { StatusOptions } from "./types.js";
import {
  STATUS_REPORT_SCHEMA_VERSION,
  type StatusAgentReport,
  type StatusAgentVerification,
  type StatusClientReport,
  type StatusCredentialPermissions,
  type StatusCredentialProjection,
  type StatusCredentialReport,
  type StatusCredentialState,
  type StatusReportV1,
} from "./status-contracts.js";

export interface StatusObservationDependencies {
  readonly canonicalStore: CredentialStoreReadAdapter;
  readonly legacyStore: LegacyCredentialReadAdapter;
  readonly codexProjection: CodexDotenvStatusObservationAdapter;
  readonly originPolicy?: ApiOriginPolicy;
}

interface PrivateCredentialObservation {
  readonly report: StatusCredentialReport;
  readonly agent: StatusAgentReport;
  readonly apiOrigin: ApiOrigin | null;
  readonly resolved: ResolvedCredential | null;
}

const SOURCE_ORDER = new Map(
  CREDENTIAL_DISCOVERY_SOURCES.map((source, index) => [source, index]),
);
const DESIRED_BY_HOST: Readonly<Record<HostId, DesiredHostConfiguration>> =
  Object.freeze({
    "claude-code": CLAUDE_CODE_DESIRED_CONFIGURATION,
    codex: CODEX_DESIRED_CONFIGURATION,
  });
const UNSAFE_AGENT_LABEL = /[\\/\p{Cf}\u2028\u2029]/u;

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

function selectedClients(target: StatusOptions["client"]): readonly HostId[] {
  return target === "all"
    ? HOST_IDS
    : Object.freeze([target]);
}

function sources(
  values: Iterable<CredentialDiscoverySource>,
): readonly CredentialDiscoverySource[] {
  return Object.freeze(
    [...new Set(values)].sort(
      (left, right) =>
        (SOURCE_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (SOURCE_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER),
    ),
  );
}

function blockerSources(
  blockers: readonly CredentialDiscoveryBlocker[],
): readonly CredentialDiscoverySource[] {
  return blockers.flatMap((blocker) => blocker.sources);
}

function blockedCredentialState(
  blockers: readonly CredentialDiscoveryBlocker[],
): StatusCredentialState {
  const reasons = new Set(blockers.map((blocker) => blocker.reason));
  if (reasons.has("credential_source_unsafe")) {
    return "unsafe";
  }
  if (reasons.has("canonical_identity_mismatch")) {
    return "mismatched";
  }
  if (reasons.has("canonical_credential_pending")) {
    return "pending";
  }
  if (
    reasons.has("credential_source_malformed") ||
    reasons.has("credential_environment_invalid")
  ) {
    return "invalid";
  }
  return "unavailable";
}

function permissionsFor(
  state: StatusCredentialState,
  credentialSources: readonly CredentialDiscoverySource[],
): StatusCredentialPermissions {
  if (state === "unsafe") {
    return "unsafe";
  }
  if (state === "unavailable" || state === "mismatched") {
    return "unknown";
  }
  if (
    credentialSources.some((source) => source !== "environment")
  ) {
    return "verified-user-only";
  }
  return "not-applicable";
}

function safeAgentLabel(value: string): string | null {
  return value.length === 0 ||
    value.length > 510 ||
    containsHostControlCharacter(value) ||
    containsHostSensitiveMaterial(value) ||
    UNSAFE_AGENT_LABEL.test(value)
    ? null
    : value;
}

function emptyAgent(
  verification: StatusAgentVerification,
): StatusAgentReport {
  return Object.freeze({
    verification,
    id: null,
    displayName: null,
    username: null,
    active: null,
  });
}

function verifiedAgent(
  candidate: CredentialCandidateSummary,
): StatusAgentReport {
  return Object.freeze({
    verification: "verified" as const,
    id: candidate.agent.id,
    displayName: safeAgentLabel(candidate.agent.name),
    username: candidate.agent.username,
    active: true as const,
  });
}

function verificationFor(
  state: StatusCredentialState,
): StatusAgentVerification {
  switch (state) {
    case "missing":
      return "not-configured";
    case "pending":
      return "pending";
    case "invalid":
      return "invalid-credential";
    case "selection-required":
      return "selection-required";
    case "mismatched":
      return "mismatched";
    case "ready":
      return "verified";
    case "unsafe":
    case "unavailable":
      return "unavailable";
  }
}

function uniqueCandidateOrigin(
  candidates: readonly CredentialCandidateSummary[],
): ApiOrigin | null {
  const origins = [...new Set(candidates.map((candidate) => candidate.apiOrigin))];
  return origins.length === 1 ? safeApiOrigin(origins[0] ?? null) : null;
}

function safeApiOrigin(value: ApiOrigin | null): ApiOrigin | null {
  return value === null ||
    containsHostControlCharacter(value) ||
    containsHostSensitiveMaterial(value) ||
    containsApiKeyToken(value)
    ? null
    : value;
}

function configuredOrigin(
  environment: CredentialEnvironmentSnapshot | null,
  policy: ApiOriginPolicy,
): ApiOrigin | null {
  if (environment === null) {
    return null;
  }
  const raw = environment.PLURUM_API_URL;
  if (raw === undefined || raw === "") {
    return DEFAULT_API_ORIGIN;
  }
  try {
    return safeApiOrigin(normalizeApiOrigin(raw, policy));
  } catch {
    return null;
  }
}

function mapCredentialDiscovery(
  discovery: CredentialDiscoveryResult,
  fallbackOrigin: ApiOrigin | null,
): PrivateCredentialObservation {
  let state: StatusCredentialState;
  let discoveredSources: readonly CredentialDiscoverySource[];
  let fingerprint: string | null = null;
  let candidateCount = 0;
  let agent: StatusAgentReport;
  let apiOrigin = fallbackOrigin;
  let resolved: ResolvedCredential | null = null;

  switch (discovery.status) {
    case "not-found":
      state = "missing";
      discoveredSources = Object.freeze([]);
      agent = emptyAgent("not-configured");
      break;
    case "all-invalid":
      state = "invalid";
      discoveredSources = sources(discovery.invalidSources);
      agent = emptyAgent("invalid-credential");
      break;
    case "ready":
      state = "ready";
      discoveredSources = sources(discovery.candidate.sources);
      fingerprint = discovery.candidate.fingerprint;
      candidateCount = 1;
      agent = verifiedAgent(discovery.candidate);
      apiOrigin = safeApiOrigin(discovery.candidate.apiOrigin);
      resolved = discovery.credential;
      break;
    case "selection-required":
      state = "selection-required";
      discoveredSources = sources(
        discovery.candidates.flatMap((candidate) => candidate.sources),
      );
      candidateCount = discovery.candidates.length;
      agent = emptyAgent("selection-required");
      apiOrigin = uniqueCandidateOrigin(discovery.candidates);
      break;
    case "blocked": {
      state = blockedCredentialState(discovery.blockers);
      discoveredSources = sources([
        ...blockerSources(discovery.blockers),
        ...discovery.invalidSources,
        ...discovery.validCandidates.flatMap((candidate) => candidate.sources),
      ]);
      candidateCount = discovery.validCandidates.length;
      if (discovery.validCandidates.length === 1) {
        fingerprint = discovery.validCandidates[0]?.fingerprint ?? null;
      }
      agent = emptyAgent(verificationFor(state));
      apiOrigin =
        discovery.validCandidates.length === 0
          ? fallbackOrigin
          : uniqueCandidateOrigin(discovery.validCandidates);
      break;
    }
  }

  return {
    report: deepFreeze({
      state,
      sources: discoveredSources,
      permissions: permissionsFor(state, discoveredSources),
      fingerprint,
      candidateCount,
    }),
    agent,
    apiOrigin,
    resolved,
  };
}

function snapshotEnvironment(
  adapter: CredentialEnvironmentAdapter,
): Readonly<{
  snapshot: CredentialEnvironmentSnapshot | null;
  adapter: CredentialEnvironmentAdapter;
}> {
  let snapshot: CredentialEnvironmentSnapshot | null = null;
  try {
    snapshot = copyCredentialEnvironmentSnapshot(adapter.read());
  } catch {
    // Discovery receives a fixed throwing view and maps it without details.
  }
  return Object.freeze({
    snapshot,
    adapter: Object.freeze({
      read(): CredentialEnvironmentSnapshot {
        if (snapshot === null) {
          throw new Error("Credential environment unavailable.");
        }
        return snapshot;
      },
    }),
  });
}

function unknownHost(client: HostId): PublicHostStatusProjection {
  return deepFreeze({
    client,
    status: "unknown" as const,
    reason: "inspection-unavailable" as const,
    hostVersion: null,
    pluginVersion: null,
    pluginEnabled: null,
    mcp: { state: "unknown" as const, endpoint: null },
  });
}

async function inspectHost(
  client: HostId,
  capabilities: StatusCapabilities,
): Promise<PublicHostStatusProjection> {
  let inspection: HostInspection;
  try {
    inspection = await capabilities.hosts.inspection[client].inspect(
      Object.freeze({
        host: client,
        scope: "user" as const,
        excludedProjectDirectory: capabilities.platform.cwd,
      }),
    );
  } catch {
    return unknownHost(client);
  }
  return projectHostStatus(inspection, DESIRED_BY_HOST[client]);
}

function withCredentialProjection(
  host: PublicHostStatusProjection,
  projection: StatusCredentialProjection,
): StatusClientReport {
  let status = host.status;
  let reason = host.reason;
  if (host.status === "healthy") {
    if (projection === "absent" || projection === "unavailable") {
      status = "incomplete";
      reason = "configuration-incomplete";
    } else if (projection === "mismatched") {
      status = "mismatched";
      reason = "configuration-mismatched";
    } else if (projection === "ambiguous") {
      status = "duplicated";
      reason = "ambiguous-configuration";
    } else if (projection === "unsafe") {
      status = "unknown";
      reason = "inspection-unavailable";
    }
  }
  return deepFreeze({
    ...host,
    status,
    reason,
    credentialProjection: projection,
  });
}

async function inspectClient(
  client: HostId,
  capabilities: StatusCapabilities,
  credential: PrivateCredentialObservation,
  codexProjection: CodexDotenvStatusObservationAdapter,
): Promise<StatusClientReport> {
  const host = await inspectHost(client, capabilities);
  if (client === "claude-code" || host.status === "absent") {
    return withCredentialProjection(host, "not-applicable");
  }
  if (credential.resolved === null) {
    return withCredentialProjection(host, "unavailable");
  }

  const observed = await observeCodexDotenvStatus(
    codexProjection,
    Object.freeze({
      apiKey: credential.resolved.apiKey as ApiKey,
      excludedProjectDirectory: capabilities.platform.cwd,
    }),
  );
  const projection: StatusCredentialProjection =
    observed.status === "credential-unavailable" ||
    observed.status === "unavailable"
      ? "unavailable"
      : observed.status;
  return withCredentialProjection(host, projection);
}

function hostPolicyHealthy(
  target: StatusOptions["client"],
  clients: readonly StatusClientReport[],
): boolean {
  if (target !== "all") {
    return clients.length === 1 && clients[0]?.status === "healthy";
  }
  return (
    clients.some((client) => client.status === "healthy") &&
    clients.every(
      (client) => client.status === "healthy" || client.status === "absent",
    )
  );
}

export async function observeStatus(
  options: StatusOptions,
  capabilities: StatusCapabilities,
  dependencies: StatusObservationDependencies,
): Promise<StatusReportV1> {
  const originPolicy = dependencies.originPolicy ?? "https-only";
  const environment = snapshotEnvironment(capabilities.credentialEnvironment);
  const fallbackOrigin = configuredOrigin(environment.snapshot, originPolicy);
  const discovery = await discoverCredentials(
    {
      canonicalStore: dependencies.canonicalStore,
      legacyStore: dependencies.legacyStore,
      credentialEnvironment: environment.adapter,
      network: capabilities.network,
      hash: capabilities.hash,
      platform: capabilities.platform,
    },
    originPolicy,
  );
  const credential = mapCredentialDiscovery(discovery, fallbackOrigin);
  const api =
    credential.apiOrigin === null
      ? Object.freeze({
          origin: null,
          reachability: "unknown" as const,
          health: "unknown" as const,
        })
      : Object.freeze({
          origin: credential.apiOrigin,
          ...(await probeApiReachability(
            capabilities.network,
            credential.apiOrigin,
            originPolicy,
          )),
        });

  const selected = selectedClients(options.client);
  const clients: StatusClientReport[] = [];
  for (const client of selected) {
    clients.push(
      await inspectClient(
        client,
        capabilities,
        credential,
        dependencies.codexProjection,
      ),
    );
  }

  const canonicalReady =
    credential.report.state === "ready" &&
    credential.report.sources.includes("canonical");
  const healthy =
    api.reachability === "reachable" &&
    api.health === "healthy" &&
    canonicalReady &&
    credential.agent.verification === "verified" &&
    credential.agent.active === true &&
    hostPolicyHealthy(options.client, clients);

  return deepFreeze({
    schemaVersion: STATUS_REPORT_SCHEMA_VERSION,
    overall: healthy
      ? ("healthy" as const)
      : ("attention-required" as const),
    requestedClient: options.client,
    selectedClients: selected,
    cli: { version: CLI_VERSION },
    api,
    credential: credential.report,
    agent: credential.agent,
    clients,
  });
}
