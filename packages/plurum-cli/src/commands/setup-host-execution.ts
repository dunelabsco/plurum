import { validateAgentCredential } from "../api/agent-validation.js";
import {
  CODEX_CREDENTIAL_CONTAINMENT_ARCHITECTURE,
  revalidateCodexCredentialContainment,
  type CodexCredentialContainmentAdapter,
  type CodexCredentialContainmentRequest,
} from "../credentials/codex-containment.js";
import type {
  CodexDotenvProjectionAdapter,
  CodexDotenvProjectionIdentity,
} from "../credentials/codex-dotenv-contracts.js";
import { isOwnedCodexDotenvProjectionAdapter } from "../credentials/codex-dotenv-projection.js";
import type { ActiveCredentialV1 } from "../credentials/schema.js";
import {
  HOST_IDS,
  type HostAdapterMap,
  type HostConfiguration,
  type HostId,
  type HostInspection,
  type HostMutationAdapter,
  type HostPreflightPlan,
  type ReconciliationPlan,
} from "../hosts/contracts.js";
import { HostError } from "../hosts/errors.js";
import type { ReconciliationJournalStoreAdapter } from "../hosts/journal-contracts.js";
import {
  PLURUM_MCP_TOOL_NAMES,
  verifyHostMcpInventory,
  type HostMcpVerificationAdapter,
  type HostMcpVerificationRequest,
} from "../hosts/mcp-verification.js";
import { acquireAndReconcileSelectedHostPlanSettled } from "../hosts/reconciler.js";
import type { NetworkAdapter } from "../system/contracts.js";
import type { SetupApplyPlan } from "./setup-apply-plan.js";
import type { SetupPreparedPlan } from "./setup-approval.js";
import {
  isOwnedSetupCredentialSessionAuthority,
  type SetupCredentialSessionAuthority,
  type SetupCredentialSessionGuard,
  type SetupCredentialSessionResult,
} from "./setup-credential-session.js";
import { setupDisplayText } from "./setup-display.js";
import {
  claimSetupHostConfigurationGrant,
  discardSetupHostConfigurationGrant,
  type SetupHostConfigurationClaim,
  type SetupHostConfigurationGrant,
  type SetupRegistrationExecutionDiscardResult,
} from "./setup-registration-execution.js";

export interface SetupHostExecutionNonceAdapter {
  uuid(): string;
}

export interface SetupHostExecutionDependencies {
  readonly hosts: HostAdapterMap<HostMutationAdapter>;
  readonly journal: ReconciliationJournalStoreAdapter;
  readonly verification: HostAdapterMap<HostMcpVerificationAdapter>;
  readonly containment: CodexCredentialContainmentAdapter;
  readonly nonce: SetupHostExecutionNonceAdapter;
  readonly network: NetworkAdapter;
}

export type SetupHostConfigurationDisposition =
  | "changed"
  | "unchanged"
  | "restored"
  | "uncertain"
  | "not-attempted"
  | "absent";

export type SetupCodexProjectionDisposition =
  | "changed"
  | "unchanged"
  | "failed"
  | "uncertain"
  | "not-attempted"
  | "not-applicable";

export type SetupHostMcpDisposition = "verified" | "failed" | "not-run";

export type SetupCredentialSessionDisposition =
  | "verified"
  | "busy"
  | "state-changed"
  | "unavailable";

export type SetupHostExecutionReason =
  | "containment-rejected"
  | "containment-unavailable"
  | "containment-changed"
  | "credential-projection-blocked"
  | "credential-projection-failed"
  | "credential-projection-state-changed"
  | "credential-busy"
  | "credential-state-changed"
  | "credential-state-unavailable"
  | "configuration-restored"
  | "configuration-busy"
  | "configuration-state-changed"
  | "configuration-unavailable"
  | "post-configuration-drift"
  | "mcp-initialization-unavailable"
  | "mcp-agent-identity-mismatch"
  | "unexpected-mcp-tool-inventory"
  | "earlier-state-uncertain";

export interface SetupHostClientExecutionResult {
  readonly client: HostId;
  readonly configuration: SetupHostConfigurationDisposition;
  readonly projection: SetupCodexProjectionDisposition;
  readonly mcp: SetupHostMcpDisposition;
  readonly reason: SetupHostExecutionReason | null;
  readonly restartRequired: boolean;
}

export type SetupAgentIdentityVerification =
  | "verified"
  | "unavailable"
  | "invalid"
  | "mismatch";

export type SetupHostExecutionResult =
  | Readonly<{ readonly status: "precondition-failed" }>
  | Readonly<{
      readonly status:
        | "complete"
        | "partial"
        | "failed"
        | "busy"
        | "replan-required";
      readonly credential: SetupCredentialSessionDisposition;
      readonly agent: Readonly<{
        readonly id: string;
        readonly name: string;
        readonly username: string | null;
        readonly verification: SetupAgentIdentityVerification;
      }>;
      readonly clients: readonly SetupHostClientExecutionResult[];
    }>;

export interface SetupHostExecutionAttempt {
  /* One attempt only; the post-registration grant burns before the first await. */
  execute(): Promise<SetupHostExecutionResult>;
  discard(): SetupRegistrationExecutionDiscardResult;
}

declare const setupHostExecutionAuthorityBrand: unique symbol;

export interface SetupHostExecutionAuthority {
  readonly [setupHostExecutionAuthorityBrand]: never;
  createAttempt(
    plan: SetupPreparedPlan<SetupApplyPlan>,
    grant: SetupHostConfigurationGrant,
  ): SetupHostExecutionAttempt;
}

interface NormalizedDependencies extends SetupHostExecutionDependencies {
  readonly credentialSession: SetupCredentialSessionAuthority;
}

type HostLocalResult =
  | Readonly<{
      readonly status: "ready";
      readonly configuration: "changed" | "unchanged";
      readonly inspection: Extract<HostInspection, { status: "available" }>;
    }>
  | Readonly<{
      readonly status: "restored";
    }>
  | Readonly<{
      readonly status: "halt";
      readonly configuration: "not-attempted" | "uncertain";
      readonly reason:
        | "configuration-busy"
        | "configuration-state-changed"
        | "configuration-unavailable"
        | "post-configuration-drift";
    }>;

type ProjectionResult =
  | Readonly<{
      readonly status: "ready";
      readonly disposition: "changed" | "unchanged";
    }>
  | Readonly<{
      readonly status: "failed";
      readonly reason:
        | "credential-projection-blocked"
        | "credential-projection-failed"
        | "credential-projection-state-changed";
    }>;

const PRECONDITION_FAILED = Object.freeze({
  status: "precondition-failed" as const,
});
const DISCARDED = Object.freeze({ status: "discarded" as const });
const TOKEN_TO_JSON = Object.freeze(function tokenToJson(): undefined {
  return undefined;
});
const OWNED_AUTHORITIES = new WeakMap<
  SetupHostExecutionAuthority,
  NormalizedDependencies
>();

class SetupHostExecutionError extends Error {
  constructor() {
    super("The setup host executor could not be created safely.");
    this.name = "SetupHostExecutionError";
  }
}

function invalidDependencies(): never {
  throw new SetupHostExecutionError();
}

function exactDataObject(
  value: unknown,
  names: readonly string[],
): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !Object.isFrozen(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0
    ) {
      return invalidDependencies();
    }
    const actual = Object.getOwnPropertyNames(value);
    if (
      actual.length !== names.length ||
      actual.some((name) => !names.includes(name))
    ) {
      return invalidDependencies();
    }
    const copied: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        return invalidDependencies();
      }
      copied[name] = descriptor.value;
    }
    return Object.freeze(copied);
  } catch (error) {
    if (error instanceof SetupHostExecutionError) {
      throw error;
    }
    return invalidDependencies();
  }
}

function exactMethodObject(
  value: unknown,
  methods: readonly string[],
): void {
  const object = exactDataObject(value, methods);
  if (methods.some((method) => typeof object[method] !== "function")) {
    return invalidDependencies();
  }
}

function normalizeDependencies(
  value: SetupHostExecutionDependencies,
  credentialSession: SetupCredentialSessionAuthority,
): NormalizedDependencies {
  const root = exactDataObject(value, [
    "hosts",
    "journal",
    "verification",
    "containment",
    "nonce",
    "network",
  ]);
  const hosts = exactDataObject(root.hosts, HOST_IDS);
  const verification = exactDataObject(root.verification, HOST_IDS);
  for (const host of HOST_IDS) {
    exactMethodObject(hosts[host], ["inspect", "apply", "rollback"]);
    exactMethodObject(verification[host], ["verify"]);
  }
  exactMethodObject(root.journal, ["acquire"]);
  exactMethodObject(root.containment, ["revalidate"]);
  exactMethodObject(root.nonce, ["uuid"]);
  exactMethodObject(root.network, ["request"]);
  if (!isOwnedSetupCredentialSessionAuthority(credentialSession)) {
    return invalidDependencies();
  }
  return Object.freeze({
    hosts: root.hosts as HostAdapterMap<HostMutationAdapter>,
    journal: root.journal as ReconciliationJournalStoreAdapter,
    verification:
      root.verification as HostAdapterMap<HostMcpVerificationAdapter>,
    containment: root.containment as CodexCredentialContainmentAdapter,
    nonce: root.nonce as SetupHostExecutionNonceAdapter,
    network: root.network as NetworkAdapter,
    credentialSession,
  });
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

function sameValue(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function expectedConfiguration(plan: HostPreflightPlan): HostConfiguration {
  const final = plan.actions.at(-1)?.after ?? plan.baseline?.configuration;
  if (final === undefined) {
    return invalidDependencies();
  }
  return final;
}

async function reinspectHost(
  dependencies: NormalizedDependencies,
  plan: HostPreflightPlan,
  cwd: string,
): Promise<Extract<HostInspection, { status: "available" }> | undefined> {
  let inspection: HostInspection;
  try {
    inspection = await dependencies.hosts[plan.host].inspect(
      Object.freeze({
        host: plan.host,
        scope: "user" as const,
        excludedProjectDirectory: cwd,
      }),
    );
  } catch {
    return undefined;
  }
  if (
    inspection.status !== "available" ||
    plan.executable === null ||
    inspection.executable.revision !== plan.executable.revision ||
    !sameValue(inspection.executable, plan.executable) ||
    !sameValue(
      inspection.state.configuration,
      expectedConfiguration(plan),
    )
  ) {
    return undefined;
  }
  if (
    inspection.host !== plan.host ||
    inspection.version !== plan.detectedVersion
  ) {
    return undefined;
  }
  return inspection;
}

async function reconcileOneHost(
  dependencies: NormalizedDependencies,
  plan: ReconciliationPlan,
  host: HostPreflightPlan,
  cwd: string,
): Promise<HostLocalResult> {
  let nonce: string;
  try {
    nonce = dependencies.nonce.uuid();
  } catch {
    return Object.freeze({
      status: "halt" as const,
      configuration: "not-attempted" as const,
      reason: "configuration-unavailable" as const,
    });
  }
  try {
    const reconciled = await acquireAndReconcileSelectedHostPlanSettled(
      plan,
      host,
      dependencies.hosts,
      dependencies.journal,
      nonce,
      Object.freeze({ excludedProjectDirectory: cwd }),
    );
    if (reconciled.status === "failed-restored") {
      return Object.freeze({ status: "restored" as const });
    }
    if (reconciled.status === "recovered") {
      return Object.freeze({
        status: "halt" as const,
        configuration: "uncertain" as const,
        reason: "configuration-state-changed" as const,
      });
    }
    const inspection = await reinspectHost(dependencies, host, cwd);
    if (inspection === undefined) {
      return Object.freeze({
        status: "halt" as const,
        configuration: "uncertain" as const,
        reason: "post-configuration-drift" as const,
      });
    }
    return Object.freeze({
      status: "ready" as const,
      configuration:
        reconciled.status === "complete" ? "changed" : "unchanged",
      inspection,
    });
  } catch (error) {
    if (error instanceof HostError) {
      if (error.code === "reconciliation_busy") {
        return Object.freeze({
          status: "halt" as const,
          configuration: "not-attempted" as const,
          reason: "configuration-busy" as const,
        });
      }
      if (
        error.code === "reconciliation_conflict" ||
        error.code === "invalid_reconciliation_journal"
      ) {
        return Object.freeze({
          status: "halt" as const,
          configuration: "uncertain" as const,
          reason: "configuration-state-changed" as const,
        });
      }
    }
    return Object.freeze({
      status: "halt" as const,
      configuration: "uncertain" as const,
      reason: "configuration-unavailable" as const,
    });
  }
}

function containmentRequest(
  host: HostPreflightPlan,
  cwd: string,
): CodexCredentialContainmentRequest {
  if (host.host !== "codex" || host.executable === null) {
    return invalidDependencies();
  }
  return Object.freeze({
    host: "codex" as const,
    scope: "user" as const,
    architecture: CODEX_CREDENTIAL_CONTAINMENT_ARCHITECTURE,
    endpoint: host.desired.mcp.endpoint,
    executableRevision: host.executable.revision,
    expectedConfiguration: expectedConfiguration(host),
    expectedTools: PLURUM_MCP_TOOL_NAMES,
    excludedProjectDirectory: cwd,
  });
}

function projectionFailureReason(
  status: string,
): ProjectionResult {
  return Object.freeze({
    status: "failed" as const,
    reason:
      status === "blocked"
        ? ("credential-projection-blocked" as const)
        : status === "precondition-failed" ||
            status === "converged-unowned" ||
            status === "indeterminate"
          ? ("credential-projection-state-changed" as const)
          : ("credential-projection-failed" as const),
  });
}

async function applyCodexProjection(
  claim: SetupHostConfigurationClaim,
): Promise<ProjectionResult> {
  const planned = claim.plan.execution.codexProjection;
  const retained = claim.projection;
  if (
    planned === null ||
    retained === null ||
    !isOwnedCodexDotenvProjectionAdapter(retained.adapter)
  ) {
    return projectionFailureReason("failed");
  }
  const adapter = retained.adapter as CodexDotenvProjectionAdapter;
  let identity = retained.identity as CodexDotenvProjectionIdentity;
  if (retained.deferred) {
    const completed = adapter.completeDeferred({
      expectedIdentity: identity,
      persistedApiKey: claim.credential.api_key,
      excludedProjectDirectory: claim.cwd,
    });
    if (completed.status !== "completed") {
      return projectionFailureReason(completed.status);
    }
    identity = completed.state.identity;
  }

  let applied;
  try {
    applied = await adapter.apply({
      expectedIdentity: identity,
      excludedProjectDirectory: claim.cwd,
    });
  } catch {
    return projectionFailureReason("failed");
  }
  if (applied.status !== "changed" && applied.status !== "unchanged") {
    return projectionFailureReason(applied.status);
  }
  const matchesPlan =
    planned.effect === "unchanged"
      ? applied.status === "unchanged"
      : applied.status === "changed";
  return matchesPlan
    ? Object.freeze({
        status: "ready" as const,
        disposition: applied.status,
      })
    : projectionFailureReason("precondition-failed");
}

function verificationRequest(
  host: HostPreflightPlan,
  inspection: Extract<HostInspection, { status: "available" }>,
  expectedAgentId: string,
  cwd: string,
): HostMcpVerificationRequest {
  if (host.executable === null) {
    return invalidDependencies();
  }
  return Object.freeze({
    host: host.host,
    scope: "user" as const,
    endpoint: host.desired.mcp.endpoint,
    executableRevision: inspection.executable.revision,
    expectedStateRevision: inspection.state.revision,
    expectedConfiguration: expectedConfiguration(host),
    expectedTools: PLURUM_MCP_TOOL_NAMES,
    expectedAgentId,
    excludedProjectDirectory: cwd,
  });
}

function clientResult(
  client: HostId,
  configuration: SetupHostConfigurationDisposition,
  projection: SetupCodexProjectionDisposition,
  mcp: SetupHostMcpDisposition,
  reason: SetupHostExecutionReason | null,
  restartRequired: boolean,
): SetupHostClientExecutionResult {
  return Object.freeze({
    client,
    configuration,
    projection,
    mcp,
    reason,
    restartRequired,
  });
}

async function verifyAgent(
  dependencies: NormalizedDependencies,
  credential: ActiveCredentialV1,
): Promise<Readonly<{
  id: string;
  name: string;
  username: string | null;
  verification: SetupAgentIdentityVerification;
}>> {
  let validation;
  try {
    validation = await validateAgentCredential(
      dependencies.network,
      credential.api_origin,
      credential.api_key,
    );
  } catch {
    validation = Object.freeze({ status: "indeterminate" as const });
  }
  if (validation.status === "valid") {
    const identityMatches = validation.agent.id === credential.agent_id;
    let name: string = credential.agent_name;
    let username: string | null = credential.username;
    if (identityMatches) {
      try {
        name = setupDisplayText(validation.agent.name, 510);
        username =
          validation.agent.username === null
            ? null
            : setupDisplayText(validation.agent.username, 50);
      } catch {
        /* The stable identity is valid, but late profile labels must remain
         * render-safe. The already-approved persisted labels are retained. */
      }
    }
    return Object.freeze({
      id: credential.agent_id,
      name,
      username,
      verification: identityMatches
        ? ("verified" as const)
        : ("mismatch" as const),
    });
  }
  return Object.freeze({
    id: credential.agent_id,
    name: credential.agent_name,
    username: credential.username,
    verification:
      validation.status === "invalid"
        ? ("invalid" as const)
        : ("unavailable" as const),
  });
}

function overallStatus(
  clients: readonly SetupHostClientExecutionResult[],
  identity: SetupAgentIdentityVerification,
  haltedReason: SetupHostExecutionReason | null,
): Exclude<SetupHostExecutionResult, { status: "precondition-failed" }>["status"] {
  const executable = clients.filter(
    ({ configuration }) => configuration !== "absent",
  );
  const verified = executable.filter(({ mcp }) => mcp === "verified").length;
  const locallyConfigured = executable.some(({ configuration }) =>
    configuration === "changed" || configuration === "unchanged",
  );
  if (
    identity === "invalid" ||
    identity === "mismatch" ||
    clients.some(({ reason }) =>
      reason === "credential-projection-state-changed" ||
      reason === "credential-state-changed" ||
      reason === "credential-state-unavailable" ||
      reason === "mcp-agent-identity-mismatch" ||
      reason === "containment-changed" ||
      reason === "post-configuration-drift"
    ) ||
    clients.some(
      ({ configuration, projection }) =>
        configuration === "uncertain" || projection === "uncertain",
    ) ||
    haltedReason === "configuration-state-changed" ||
    haltedReason === "credential-state-changed" ||
    haltedReason === "credential-state-unavailable" ||
    haltedReason === "earlier-state-uncertain"
  ) {
    return "replan-required";
  }
  if (
    haltedReason === "configuration-busy" &&
    verified === 0 &&
    !locallyConfigured
  ) {
    return "busy";
  }
  if (
    identity === "verified" &&
    executable.length > 0 &&
    verified === executable.length
  ) {
    return "complete";
  }
  if (verified > 0 || locallyConfigured) {
    return "partial";
  }
  return "failed";
}

async function executeClaim(
  dependencies: NormalizedDependencies,
  claim: SetupHostConfigurationClaim,
  credentialGuard: SetupCredentialSessionGuard,
): Promise<Exclude<SetupHostExecutionResult, { status: "precondition-failed" }>> {
  const reconciliation = claim.plan.execution.hostReconciliation;
  const byHost = new Map(reconciliation.hosts.map((host) => [host.host, host]));
  const clients: SetupHostClientExecutionResult[] = [];
  let haltedReason: SetupHostExecutionReason | null = null;
  let haltedStateUncertain = false;

  async function credentialReason(): Promise<
    "credential-state-changed" | "credential-state-unavailable" | null
  > {
    try {
      const state = await credentialGuard.revalidate();
      return state === "exact"
        ? null
        : state === "state-changed"
          ? "credential-state-changed"
          : "credential-state-unavailable";
    } catch {
      return "credential-state-unavailable";
    }
  }

  for (const client of claim.plan.preview.selectedClients) {
    const host = byHost.get(client);
    if (host === undefined) {
      clients.push(
        clientResult(
          client,
          "absent",
          "not-applicable",
          "not-run",
          null,
          false,
        ),
      );
      continue;
    }
    if (haltedReason !== null) {
      const reason = haltedStateUncertain
        ? "earlier-state-uncertain"
        : haltedReason;
      clients.push(
        clientResult(
          client,
          "not-attempted",
          client === "codex" ? "not-attempted" : "not-applicable",
          "not-run",
          reason,
          false,
        ),
      );
      continue;
    }

    const beforeHostCredential = await credentialReason();
    if (beforeHostCredential !== null) {
      haltedReason = beforeHostCredential;
      clients.push(
        clientResult(
          client,
          "not-attempted",
          client === "codex" ? "not-attempted" : "not-applicable",
          "not-run",
          beforeHostCredential,
          false,
        ),
      );
      continue;
    }

    let projection: SetupCodexProjectionDisposition = "not-applicable";
    let firstContainmentRevision: string | null = null;
    if (client === "codex") {
      const firstContainment = await revalidateCodexCredentialContainment(
        dependencies.containment,
        containmentRequest(host, claim.cwd),
      );
      if (firstContainment.status !== "accepted") {
        const reason =
          firstContainment.reason === "rejected"
            ? "containment-rejected"
            : "containment-unavailable";
        clients.push(
          clientResult(
            client,
            "not-attempted",
            "not-attempted",
            "not-run",
            reason,
            false,
          ),
        );
        continue;
      }
      firstContainmentRevision = firstContainment.decisionRevision;
      const projected = await applyCodexProjection(claim);
      if (projected.status !== "ready") {
        clients.push(
          clientResult(
            client,
            "not-attempted",
            "failed",
            "not-run",
            projected.reason,
            false,
          ),
        );
        continue;
      }
      projection = projected.disposition;

      const secondContainment = await revalidateCodexCredentialContainment(
        dependencies.containment,
        containmentRequest(host, claim.cwd),
      );
      if (
        secondContainment.status !== "accepted" ||
        secondContainment.decisionRevision !== firstContainmentRevision
      ) {
        const reason =
          secondContainment.status === "accepted"
            ? "containment-changed"
            : secondContainment.reason === "rejected"
              ? "containment-rejected"
              : "containment-unavailable";
        clients.push(
          clientResult(
            client,
            "not-attempted",
            projection,
            "not-run",
            reason,
            projection === "changed",
          ),
        );
        continue;
      }

      const afterProjectionCredential = await credentialReason();
      if (afterProjectionCredential !== null) {
        haltedReason = afterProjectionCredential;
        clients.push(
          clientResult(
            client,
            "not-attempted",
            projection,
            "not-run",
            afterProjectionCredential,
            projection === "changed",
          ),
        );
        continue;
      }
    }

    const local = await reconcileOneHost(
      dependencies,
      reconciliation,
      host,
      claim.cwd,
    );
    if (local.status === "restored") {
      clients.push(
        clientResult(
          client,
          "restored",
          projection,
          "not-run",
          "configuration-restored",
          projection === "changed",
        ),
      );
      continue;
    }
    if (local.status === "halt") {
      haltedReason = local.reason;
      haltedStateUncertain = local.configuration === "uncertain";
      clients.push(
        clientResult(
          client,
          local.configuration,
          projection,
          "not-run",
          local.reason,
          projection === "changed",
        ),
      );
      continue;
    }

    const beforeMcpCredential = await credentialReason();
    if (beforeMcpCredential !== null) {
      haltedReason = beforeMcpCredential;
      clients.push(
        clientResult(
          client,
          local.configuration,
          projection,
          "not-run",
          beforeMcpCredential,
          local.configuration === "changed" || projection === "changed",
        ),
      );
      continue;
    }

    const verified = await verifyHostMcpInventory(
      dependencies.verification[client],
      verificationRequest(
        host,
        local.inspection,
        claim.credential.agent_id,
        claim.cwd,
      ),
    );
    const restartRequired =
      local.configuration === "changed" || projection === "changed";
    clients.push(
      clientResult(
        client,
        local.configuration,
        projection,
        verified.status === "verified" ? "verified" : "failed",
        verified.status === "verified"
          ? null
          : verified.reason === "unexpected-tool-inventory"
            ? "unexpected-mcp-tool-inventory"
            : verified.reason === "agent-identity-mismatch"
              ? "mcp-agent-identity-mismatch"
            : "mcp-initialization-unavailable",
        restartRequired,
      ),
    );
  }

  const finalCredential = await credentialReason();
  if (finalCredential !== null) {
    haltedReason = finalCredential;
  }
  const agent =
    finalCredential === null
      ? await verifyAgent(dependencies, claim.credential)
      : persistedAgent(claim.credential);
  const frozenClients = Object.freeze([...clients]);
  return deepFreeze({
    status: overallStatus(
      frozenClients,
      agent.verification,
      haltedReason,
    ),
    credential: "verified" as const,
    agent,
    clients: frozenClients,
  });
}

function persistedAgent(
  credential: ActiveCredentialV1,
): Exclude<SetupHostExecutionResult, { status: "precondition-failed" }>["agent"] {
  return Object.freeze({
    id: credential.agent_id,
    name: credential.agent_name,
    username: credential.username,
    verification: "unavailable" as const,
  });
}

function guardedClients(
  claim: SetupHostConfigurationClaim,
  operationStarted: boolean,
  reason:
    | "credential-state-changed"
    | "credential-state-unavailable"
    | "credential-busy"
    | "configuration-busy",
): readonly SetupHostClientExecutionResult[] {
  const executable = new Set(
    claim.plan.execution.hostReconciliation.hosts.map(({ host }) => host),
  );
  return Object.freeze(
    claim.plan.preview.selectedClients.map((client) => {
      if (!executable.has(client)) {
        return clientResult(
          client,
          "absent",
          "not-applicable",
          "not-run",
          null,
          false,
        );
      }
      return clientResult(
        client,
        operationStarted ? "uncertain" : "not-attempted",
        client === "codex"
          ? operationStarted
            ? "uncertain"
            : "not-attempted"
          : "not-applicable",
        "not-run",
        reason,
        false,
      );
    }),
  );
}

function guardedFailureResult(
  claim: SetupHostConfigurationClaim,
  status: "busy" | "state-changed" | "unavailable",
  operationStarted = false,
): Exclude<SetupHostExecutionResult, { status: "precondition-failed" }> {
  const reason =
    status === "state-changed"
      ? ("credential-state-changed" as const)
      : status === "unavailable"
        ? ("credential-state-unavailable" as const)
        : ("credential-busy" as const);
  return deepFreeze({
    status: status === "busy" ? ("busy" as const) : ("replan-required" as const),
    credential: status,
    agent: persistedAgent(claim.credential),
    clients: guardedClients(claim, operationStarted, reason),
  });
}

function credentialSessionResult(
  claim: SetupHostConfigurationClaim,
  result: SetupCredentialSessionResult<
    Exclude<SetupHostExecutionResult, { status: "precondition-failed" }>
  >,
): Exclude<SetupHostExecutionResult, { status: "precondition-failed" }> {
  if (result.status === "completed") {
    return result.value;
  }
  if (result.status === "busy") {
    return guardedFailureResult(claim, "busy");
  }
  if (
    result.operation === "started" &&
    result.completed
  ) {
    return deepFreeze({
      ...result.value,
      status: "replan-required" as const,
      credential: result.status,
    });
  }
  return guardedFailureResult(
    claim,
    result.status,
    result.operation === "started",
  );
}

export function createSetupHostExecutionAuthority(
  rawDependencies: SetupHostExecutionDependencies,
  credentialSession: SetupCredentialSessionAuthority,
): SetupHostExecutionAuthority {
  const dependencies = normalizeDependencies(
    rawDependencies,
    credentialSession,
  );
  const token = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(token, "toJSON", {
    configurable: false,
    enumerable: false,
    value: TOKEN_TO_JSON,
    writable: false,
  });
  let authority: SetupHostExecutionAuthority;
  Object.defineProperty(token, "createAttempt", {
    configurable: false,
    enumerable: false,
    value: (
      plan: SetupPreparedPlan<SetupApplyPlan>,
      grant: SetupHostConfigurationGrant,
    ): SetupHostExecutionAttempt => {
      let state: "ready" | "running" | "settled" = "ready";
      return Object.freeze({
        async execute(): Promise<SetupHostExecutionResult> {
          if (state !== "ready") {
            return PRECONDITION_FAILED;
          }
          state = "running";
          let claim: SetupHostConfigurationClaim | undefined;
          try {
            claim = claimSetupHostConfigurationGrant(
              grant,
              authority,
              plan,
            );
          } catch {
            claim = undefined;
          }
          if (claim === undefined) {
            state = "settled";
            return PRECONDITION_FAILED;
          }
          try {
            const guarded = await dependencies.credentialSession.run(
              Object.freeze({
                canonicalDirectory: claim.canonicalDirectory,
                expectedCredential: claim.credential,
                evidence: claim.credentialEvidence,
              }),
              (guard) => executeClaim(dependencies, claim, guard),
            );
            return credentialSessionResult(claim, guarded);
          } catch {
            return PRECONDITION_FAILED;
          } finally {
            state = "settled";
          }
        },
        discard(): SetupRegistrationExecutionDiscardResult {
          if (state !== "ready") {
            return PRECONDITION_FAILED;
          }
          state = "settled";
          return discardSetupHostConfigurationGrant(grant).status ===
            "discarded"
            ? DISCARDED
            : PRECONDITION_FAILED;
        },
      });
    },
    writable: false,
  });
  authority = Object.freeze(token) as unknown as SetupHostExecutionAuthority;
  OWNED_AUTHORITIES.set(authority, dependencies);
  return authority;
}

export function isOwnedSetupHostExecutionAuthority(
  value: unknown,
): value is SetupHostExecutionAuthority {
  return (
    typeof value === "object" &&
    value !== null &&
    OWNED_AUTHORITIES.has(value as SetupHostExecutionAuthority)
  );
}
