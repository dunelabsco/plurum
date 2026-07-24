import { describe, expect, it } from "vitest";

import { nodeHash } from "../src/adapters/node/hash.js";
import { createSetupApprovalAuthority } from "../src/commands/setup-approval.js";
import type { SetupPreparedPlan } from "../src/commands/setup-approval.js";
import type { SetupApplyPlan } from "../src/commands/setup-apply-plan.js";
import {
  createSetupInputFreePlanPresenter,
  createSetupInteractiveSessionPorts,
  type SetupConfirmationResult,
} from "../src/commands/setup-confirmation.js";
import {
  renderSetupApplyPlan,
  renderSetupHostExecutionResult,
} from "../src/commands/setup-output.js";
import { createSetupPreflightSnapshot } from "../src/commands/setup-preflight.js";
import type {
  SetupHostExecutionDependencies,
  SetupHostExecutionResult,
} from "../src/commands/setup-host-execution.js";
import type {
  CodexCredentialContainmentAdapter,
  CodexCredentialContainmentObservation,
} from "../src/credentials/codex-containment.js";
import {
  CODEX_CREDENTIAL_CONTAINMENT_ARCHITECTURE,
  revalidateCodexCredentialContainment,
} from "../src/credentials/codex-containment.js";
import type {
  CodexDotenvNativeAdapter,
  CodexDotenvNativeEvidence,
} from "../src/credentials/codex-dotenv-contracts.js";
import { createCodexDotenvProjectionAdapter } from "../src/credentials/codex-dotenv-projection.js";
import {
  CodexDotenvSetupObservationError,
  createCodexDotenvSetupObservationAuthority,
} from "../src/credentials/codex-dotenv-setup-observation.js";
import type { LegacyCredentialReadAdapter } from "../src/credentials/legacy-reader-contracts.js";
import { DEFAULT_API_ORIGIN } from "../src/credentials/origin.js";
import {
  serializeCredentialDocument,
  validateCredentialDocument,
  type ActiveCredentialV1,
} from "../src/credentials/schema.js";
import { createCredentialStoreObservationAuthority } from "../src/credentials/store-observer.js";
import type {
  HostAdapterMap,
  HostConfiguration,
  HostExecutableAttestation,
  HostId,
  HostInspection,
  HostMutationAdapter,
  HostMutationSupport,
} from "../src/hosts/contracts.js";
import {
  CLAUDE_CODE_DESIRED_CONFIGURATION,
  CLAUDE_CODE_MUTATION_SUPPORT,
} from "../src/hosts/claude-code/configuration.js";
import {
  CODEX_DESIRED_CONFIGURATION,
  CODEX_MUTATION_SUPPORT,
} from "../src/hosts/codex/configuration.js";
import {
  PLURUM_MCP_TOOL_NAMES,
  verifyHostMcpInventory,
  type HostMcpVerificationAdapter,
  type HostMcpVerificationRequest,
} from "../src/hosts/mcp-verification.js";
import { setupScope } from "../src/system/scopes.js";
import type {
  NetworkAdapter,
  NetworkRequest,
  NetworkResponse,
  SystemCapabilities,
} from "../src/system/contracts.js";
import { createInMemoryCredentialMutationStore } from "./support/in-memory-credential-mutation-store.js";
import { createInMemoryCredentialObservationStore } from "./support/in-memory-credential-observation-store.js";
import { createInMemoryReconciliationJournal } from "./support/in-memory-reconciliation-journal.js";
import { createTestSystem } from "./support/system.js";

const KEY = `plrm_live_${"H".repeat(43)}`;
const OTHER_KEY = `plrm_live_${"J".repeat(43)}`;
const AGENT_ID = "00000000-0000-4000-8000-000000000081";
const OTHER_AGENT_ID = "00000000-0000-4000-8000-000000000082";
const OPERATION_IDS = Object.freeze([
  "123e4567-e89b-42d3-a456-426614174080",
  "123e4567-e89b-42d3-a456-426614174081",
  "123e4567-e89b-42d3-a456-426614174082",
]);
const CREATED_AT = "2026-07-21T13:14:15.123Z";
const CANARY_PATH = "/isolated/neutral";

function jsonResponse(status: number, value: unknown): NetworkResponse {
  return Object.freeze({
    status,
    headers: Object.freeze({ "content-type": "application/json" }),
    body: new TextEncoder().encode(JSON.stringify(value)),
  });
}

function activeCredential(): ActiveCredentialV1 {
  const credential = validateCredentialDocument({
    schema_version: 1,
    state: "active",
    api_origin: DEFAULT_API_ORIGIN,
    api_key: KEY,
    agent_id: AGENT_ID,
    agent_name: "Plurum Agent",
    username: "plurum-agent",
    registration_request_id: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    activated_at: CREATED_AT,
  });
  if (credential.state !== "active") {
    throw new Error("expected active credential fixture");
  }
  return credential;
}

function otherActiveCredential(): ActiveCredentialV1 {
  const credential = validateCredentialDocument({
    schema_version: 1,
    state: "active",
    api_origin: DEFAULT_API_ORIGIN,
    api_key: OTHER_KEY,
    agent_id: OTHER_AGENT_ID,
    agent_name: "Other Agent",
    username: "other-agent",
    registration_request_id: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    activated_at: CREATED_AT,
  });
  if (credential.state !== "active") {
    throw new Error("expected other active credential fixture");
  }
  return credential;
}

function createNetwork(events: string[], hasExistingCredential = true) {
  let calls = 0;
  let profileName = "Plurum Agent";
  let finalMode: "normal" | "invalid" | "unavailable" | "mismatch" =
    "normal";
  const activeKeys = new Set<string>(hasExistingCredential ? [KEY] : []);
  let candidateKey: string | undefined;
  const adapter: NetworkAdapter = Object.freeze<NetworkAdapter>({
    async request(request: NetworkRequest) {
      calls += 1;
      if (request.url === `${DEFAULT_API_ORIGIN}/api/v1/agents/me`) {
        events.push("agent:verify");
        expect(request.method).toBe("GET");
        const authorization = request.headers.Authorization;
        if (
          typeof authorization !== "string" ||
          !authorization.startsWith("Bearer ")
        ) {
          throw new Error("missing fake bearer credential");
        }
        const key = authorization.slice("Bearer ".length);
        candidateKey = key;
        if (finalMode === "invalid") {
          return jsonResponse(401, { error: "invalid" });
        }
        if (finalMode === "unavailable") {
          return jsonResponse(503, { error: "unavailable" });
        }
        return activeKeys.has(key)
          ? jsonResponse(200, {
              id: finalMode === "mismatch" ? OTHER_AGENT_ID : AGENT_ID,
              name: profileName,
              username: "plurum-agent",
              is_active: true,
            })
          : jsonResponse(401, { error: "invalid" });
      }
      if (
        request.method === "GET" &&
        request.url.startsWith(
          `${DEFAULT_API_ORIGIN}/api/v1/agents/check-username?username=`,
        )
      ) {
        events.push("agent:username");
        return jsonResponse(200, { available: true, suggestions: [] });
      }
      if (
        request.method === "POST" &&
        request.url === `${DEFAULT_API_ORIGIN}/api/v1/agents/register/cli`
      ) {
        events.push("agent:register");
        if (candidateKey === undefined) {
          throw new Error("missing candidate key validation");
        }
        activeKeys.add(candidateKey);
        return jsonResponse(200, {
          agent_id: AGENT_ID,
          disposition: "created",
        });
      }
      throw new Error("unexpected fake network request");
    },
  });
  return Object.freeze({
    adapter,
    control: Object.freeze({
      calls: () => calls,
      rename: (value: string) => {
        profileName = value;
      },
      finalMode: (
        value: "normal" | "invalid" | "unavailable" | "mismatch",
      ) => {
        finalMode = value;
      },
    }),
  });
}

function absentConfiguration(): HostConfiguration {
  return Object.freeze({
    marketplace: Object.freeze({ status: "absent" as const }),
    plugin: Object.freeze({ status: "absent" as const }),
    pluginMcp: Object.freeze({ status: "absent" as const }),
    directMcp: Object.freeze({ status: "absent" as const }),
  });
}

function executable(host: HostId): HostExecutableAttestation {
  const path = host === "claude-code" ? "/trusted/claude" : "/trusted/codex";
  return Object.freeze({
    sourcePath: path,
    resolvedPath: path,
    revision: `${host}-executable-revision`,
    chain: Object.freeze([
      Object.freeze({
        path,
        kind: "binary" as const,
        owner: "current-user" as const,
        access: "not-broadly-writable" as const,
        binding: "canonical" as const,
        link: "direct" as const,
        revision: `${host}-chain-revision`,
      }),
    ]),
    launch: Object.freeze({
      executable: path,
      argumentPrefix: Object.freeze([]),
      shell: false as const,
    }),
  });
}

interface FakeHost {
  readonly adapter: HostMutationAdapter;
  readonly control: Readonly<{
    applyCalls(): number;
    rollbackCalls(): number;
    inspectionCalls(): number;
    configuration(): HostConfiguration;
    failApply(call: number | null): void;
    setVersion(version: string): void;
  }>;
}

function createHost(
  host: HostId,
  support: HostMutationSupport,
  minimumVersion: string,
  events: string[],
  installed = true,
): FakeHost {
  let configuration = structuredClone(absentConfiguration());
  let revision = `${host}-state-0`;
  let revisionCounter = 0;
  let applyCalls = 0;
  let rollbackCalls = 0;
  let inspectionCalls = 0;
  let failApplyCall: number | null = null;
  let detectedVersion = minimumVersion;

  function advance(next: HostConfiguration): string {
    configuration = structuredClone(next);
    revisionCounter += 1;
    revision = `${host}-state-${revisionCounter}`;
    return revision;
  }

  const adapter: HostMutationAdapter = Object.freeze<HostMutationAdapter>({
    async inspect(request) {
      inspectionCalls += 1;
      events.push(`${host}:inspect`);
      expect(request).toEqual({
        host,
        scope: "user",
        excludedProjectDirectory: CANARY_PATH,
      });
      if (!installed) {
        return Object.freeze({ host, status: "absent" as const });
      }
      return Object.freeze({
        host,
        status: "available" as const,
        executable: executable(host),
        version: detectedVersion,
        state: Object.freeze({
          revision,
          configuration: structuredClone(configuration),
        }),
        mutationSupport: support,
      });
    },
    async apply(request) {
      applyCalls += 1;
      events.push(`${host}:apply:${applyCalls}`);
      expect(request.host).toBe(host);
      expect(request.expectedBeforeRevision).toBe(revision);
      expect(request.expectedBefore).toEqual(configuration);
      if (failApplyCall === applyCalls) {
        return Object.freeze({ status: "failed" as const });
      }
      return Object.freeze({
        status: "changed" as const,
        stateRevision: advance(request.action.after),
      });
    },
    async rollback(request) {
      rollbackCalls += 1;
      events.push(`${host}:rollback:${rollbackCalls}`);
      expect(request.host).toBe(host);
      expect(request.expectedAfterRevision).toBe(revision);
      expect(request.expectedAfter).toEqual(configuration);
      return Object.freeze({
        status: "changed" as const,
        stateRevision: advance(request.action.before),
      });
    },
  });
  return Object.freeze({
    adapter,
    control: Object.freeze({
      applyCalls: () => applyCalls,
      rollbackCalls: () => rollbackCalls,
      inspectionCalls: () => inspectionCalls,
      configuration: () => structuredClone(configuration),
      failApply: (call: number | null) => {
        failApplyCall = call;
      },
      setVersion: (version: string) => {
        detectedVersion = version;
      },
    }),
  });
}

function createProjection(events: string[]) {
  let status: CodexDotenvNativeEvidence["status"] = "absent";
  let revision = "projection-revision-0";
  let synchronizeCalls = 0;
  let observeCalls = 0;
  type ProjectionMode =
    | "normal"
    | "converged-unowned"
    | "indeterminate"
    | "invalid-unchanged";
  let mode: ProjectionMode = "normal";
  const native: CodexDotenvNativeAdapter =
    Object.freeze<CodexDotenvNativeAdapter>({
    async observe() {
      observeCalls += 1;
      events.push("codex:projection-observe");
      return Object.freeze({ revision, status });
    },
    async synchronize(request) {
      synchronizeCalls += 1;
      events.push("codex:projection-synchronize");
      if (
        request.expectedRevision !== revision ||
        request.expectedStatus !== status
      ) {
        return Object.freeze({ status: "precondition-failed" as const });
      }
      if (mode === "converged-unowned") {
        status = "exact";
        revision = `projection-raced-${synchronizeCalls}`;
        return Object.freeze({ status: "precondition-failed" as const });
      }
      if (mode === "indeterminate") {
        status = "mismatched";
        revision = `projection-uncertain-${synchronizeCalls}`;
        return Object.freeze({ status: "failed" as const });
      }
      if (mode === "invalid-unchanged") {
        return Object.freeze({
          status: "completed" as const,
          disposition: "unchanged" as const,
          stateRevision: revision,
        });
      }
      if (status === "exact") {
        return Object.freeze({
          status: "completed" as const,
          disposition: "unchanged" as const,
          stateRevision: revision,
        });
      }
      status = "exact";
      revision = `projection-revision-${synchronizeCalls}`;
      return Object.freeze({
        status: "completed" as const,
        disposition: "changed" as const,
        stateRevision: revision,
      });
    },
    });
  return Object.freeze({
    adapter: createCodexDotenvProjectionAdapter(native),
    control: Object.freeze({
      status: () => status,
      observeCalls: () => observeCalls,
      synchronizeCalls: () => synchronizeCalls,
      mode: (value: ProjectionMode) => {
        mode = value;
      },
    }),
  });
}

function createContainment(events: string[]) {
  let calls = 0;
  let next: CodexCredentialContainmentObservation = Object.freeze({
    status: "accepted" as const,
    decisionRevision: "containment-policy-1",
  });
  let sequence: readonly CodexCredentialContainmentObservation[] | null = null;
  const adapter: CodexCredentialContainmentAdapter =
    Object.freeze<CodexCredentialContainmentAdapter>({
    async revalidate(request) {
      calls += 1;
      events.push(`codex:containment:${calls}`);
      expect(request.host).toBe("codex");
      expect(request.expectedTools).toBe(PLURUM_MCP_TOOL_NAMES);
      return sequence?.[calls - 1] ?? next;
    },
    });
  return Object.freeze({
    adapter,
    control: Object.freeze({
      calls: () => calls,
      set: (value: CodexCredentialContainmentObservation) => {
        next = value;
        sequence = null;
      },
      sequence: (value: readonly CodexCredentialContainmentObservation[]) => {
        sequence = Object.freeze([...value]);
      },
    }),
  });
}

function createVerifier(host: HostId, events: string[]) {
  let calls = 0;
  let tools: readonly string[] = PLURUM_MCP_TOOL_NAMES;
  let authenticatedAgentId = AGENT_ID;
  let mode: "initialized" | "unavailable" | "throw" = "initialized";
  let beforeVerify: (() => void) | null = null;
  const requests: HostMcpVerificationRequest[] = [];
  const adapter: HostMcpVerificationAdapter =
    Object.freeze<HostMcpVerificationAdapter>({
    async verify(request) {
      calls += 1;
      events.push(`${host}:mcp`);
      requests.push(request);
      expect(request.host).toBe(host);
      expect(request.expectedTools).toBe(PLURUM_MCP_TOOL_NAMES);
      expect(request.expectedAgentId).toBe(AGENT_ID);
      expect(JSON.stringify(request)).not.toContain(KEY);
      beforeVerify?.();
      if (mode === "throw") {
        throw new Error("simulated MCP verifier failure");
      }
      if (mode === "unavailable") {
        return Object.freeze({ status: "unavailable" as const });
      }
      return Object.freeze({
        status: "initialized" as const,
        tools: Object.freeze([...tools]),
        authenticatedAgentId,
      });
    },
    });
  return Object.freeze({
    adapter,
    control: Object.freeze({
      calls: () => calls,
      requests: () => Object.freeze([...requests]),
      tools: (value: readonly string[]) => {
        tools = value;
      },
      authenticatedAgentId: (value: string) => {
        authenticatedAgentId = value;
      },
      mode: (value: "initialized" | "unavailable" | "throw") => {
        mode = value;
      },
      beforeVerify: (callback: (() => void) | null) => {
        beforeVerify = callback;
      },
    }),
  });
}

function credentialBytes(credential: ActiveCredentialV1): Uint8Array {
  return new TextEncoder().encode(serializeCredentialDocument(credential));
}

interface PreparedRun {
  readonly authority: ReturnType<
    typeof createCodexDotenvSetupObservationAuthority
  >;
  readonly plan: SetupPreparedPlan<SetupApplyPlan>;
  readonly confirmation: SetupConfirmationResult;
}

function createHarness(
  options: Readonly<{
    readonly target?: "all" | HostId;
    readonly absentHosts?: readonly HostId[];
    readonly newRegistration?: boolean;
    readonly journalBusyAtAcquire?: number;
    readonly journalThrowAtAcquire?: number;
    readonly journalReplaceConflictAt?: number;
    readonly credentialReleaseFailureAt?: number;
    readonly credentialBusyAtObservedAcquire?: number;
    readonly nonceFailureAt?: number;
  }> = {},
) {
  const events: string[] = [];
  const claude = createHost(
    "claude-code",
    CLAUDE_CODE_MUTATION_SUPPORT,
    CLAUDE_CODE_DESIRED_CONFIGURATION.minimumHostVersion,
    events,
    !options.absentHosts?.includes("claude-code"),
  );
  const codex = createHost(
    "codex",
    CODEX_MUTATION_SUPPORT,
    CODEX_DESIRED_CONFIGURATION.minimumHostVersion,
    events,
    !options.absentHosts?.includes("codex"),
  );
  const base = createTestSystem();
  const rawHosts: HostAdapterMap<HostMutationAdapter> = Object.freeze({
    "claude-code": claude.adapter,
    codex: codex.adapter,
  });
  const system: SystemCapabilities = Object.freeze({
    ...base,
    hosts: Object.freeze({
      inspection: rawHosts,
      mutation: rawHosts,
    }),
  });
  const network = createNetwork(events, options.newRegistration !== true);
  const projection = createProjection(events);
  const containment = createContainment(events);
  const claudeVerifier = createVerifier("claude-code", events);
  const codexVerifier = createVerifier("codex", events);
  const verification: HostAdapterMap<HostMcpVerificationAdapter> =
    Object.freeze({
      "claude-code": claudeVerifier.adapter,
      codex: codexVerifier.adapter,
    });
  const journalOptions = Object.freeze({
    ...(options.journalBusyAtAcquire === undefined
      ? {}
      : { busyAtAcquire: options.journalBusyAtAcquire }),
    ...(options.journalThrowAtAcquire === undefined
      ? {}
      : { throwAtAcquire: options.journalThrowAtAcquire }),
    ...(options.journalReplaceConflictAt === undefined
      ? {}
      : { replaceConflictAt: options.journalReplaceConflictAt }),
  });
  const journal = createInMemoryReconciliationJournal(journalOptions);
  const initial =
    options.newRegistration === true
      ? undefined
      : credentialBytes(activeCredential());
  const mutation = createInMemoryCredentialMutationStore({
    ...(initial === undefined ? {} : { initialCredential: initial }),
    ...(options.credentialReleaseFailureAt === undefined
      ? {}
      : { failReleaseAt: options.credentialReleaseFailureAt }),
    ...(options.credentialBusyAtObservedAcquire === undefined
      ? {}
      : {
          busyObservedLeaseAtAcquire:
            options.credentialBusyAtObservedAcquire,
        }),
  });
  initial?.fill(0);
  let nonceCounter = 0;
  let randomCounter = 0;
  const nonce = Object.freeze({
    uuid(): string {
      nonceCounter += 1;
      if (options.nonceFailureAt === nonceCounter) {
        throw new Error("simulated nonce failure");
      }
      return `00000000-0000-4000-8000-${(900 + nonceCounter)
        .toString()
        .padStart(12, "0")}`;
    },
  });
  const random = Object.freeze({
    bytes(length: number): Uint8Array {
      return new Uint8Array(length).fill(0x52);
    },
    uuid(): string {
      randomCounter += 1;
      return `00000000-0000-4000-8000-${(700 + randomCounter)
        .toString()
        .padStart(12, "0")}`;
    },
  });
  const clock = Object.freeze({ now: () => Date.parse(CREATED_AT) });
  const legacy: LegacyCredentialReadAdapter = Object.freeze({
    async read() {
      return Object.freeze({ status: "missing" as const });
    },
  });

  function observationStore() {
    return createCredentialStoreObservationAuthority(
      createInMemoryCredentialObservationStore({
        directoryMissing() {
          const bytes = mutation.control.readDurableCredential();
          try {
            return bytes === undefined;
          } finally {
            bytes?.fill(0);
          }
        },
        credentialBytes() {
          return mutation.control.readDurableCredential();
        },
        finishEvidence() {
          return mutation.control.observeWholePass();
        },
      }).adapter,
    );
  }

  async function prepare(
    operationIndex: number,
    foreignMutationAuthority?: HostAdapterMap<HostMutationAdapter>,
  ): Promise<PreparedRun> {
    const scope = setupScope(system);
    const preflight = await createSetupPreflightSnapshot(
      options.target ?? "all",
      scope,
    );
    const hostExecution: SetupHostExecutionDependencies = Object.freeze({
      hosts: foreignMutationAuthority ?? scope.hosts.mutation,
      journal: journal.store,
      verification,
      containment: containment.adapter,
      nonce,
      network: network.adapter,
    });
    const execution = Object.freeze({
      storage: mutation.adapter,
      network: network.adapter,
      clock,
      random,
      hash: nodeHash,
    });
    const authority = createCodexDotenvSetupObservationAuthority({
      approval: createSetupApprovalAuthority(),
      store: observationStore(),
      discovery: Object.freeze({
        credentialEnvironment: Object.freeze({
          read: () => Object.freeze({}),
        }),
        legacyStore: legacy,
        network: network.adapter,
        hash: nodeHash,
        platform: scope.platform,
      }),
      execution,
      hostExecution,
      codexProjection: projection.adapter,
      preflight,
    });
    const inspected = await authority.inspect();
    if (inspected.status !== "available") {
      throw new Error("expected available setup observation");
    }
    const operationId =
      OPERATION_IDS[operationIndex] ?? OPERATION_IDS[0];
    if (operationId === undefined) {
      throw new Error("missing operation id fixture");
    }
    const durableCredential = mutation.control.readDurableCredential();
    const needsRegistration =
      options.newRegistration === true && durableCredential === undefined;
    durableCredential?.fill(0);
    const prepared = await authority.prepare({
      identity: inspected.identity,
      decision: Object.freeze({
        selectedCandidateId: null,
        registration: needsRegistration
            ? Object.freeze({
                agentName: "Plurum Agent",
                username: "plurum-agent",
              })
            : null,
      }),
      operationId,
      createdAt: CREATED_AT,
    });
    if (prepared.status !== "prepared") {
      throw new Error(`expected prepared setup: ${prepared.status}`);
    }
    const confirmation =
      prepared.plan.preview.confirmation === "required"
        ? await (() => {
            const ports = createSetupInteractiveSessionPorts(
              async () => "presented",
              async () => "confirmed",
            );
            return authority
              .createConfirmation(
                prepared.plan,
                prepared.sidecar,
                "interactive",
                ports.presenter,
                ports.confirmation,
              )
              .authorize();
          })()
        : await authority
            .createConfirmation(
              prepared.plan,
              prepared.sidecar,
              "assume-yes",
              createSetupInputFreePlanPresenter(
                async () => "presented",
              ),
              null,
            )
            .authorize();
    return Object.freeze({
      authority,
      plan: prepared.plan,
      confirmation,
    });
  }

  async function register(prepared: PreparedRun) {
    if (prepared.confirmation.status !== "approved") {
      throw new Error("expected approved mutation plan");
    }
    const registration = await prepared.authority
      .createRegistrationExecution(
        prepared.plan,
        prepared.confirmation.grant,
      )
      .execute();
    if (registration.status !== "ready") {
      throw new Error(`expected ready registration: ${registration.status}`);
    }
    return registration;
  }

  async function execute(operationIndex = 0) {
    const prepared = await prepare(operationIndex);
    const registration = await register(prepared);
    const result = await prepared.authority
      .createHostExecution(prepared.plan, registration.grant)
      .execute();
    return Object.freeze({ prepared, registration, result });
  }

  return Object.freeze({
    events,
    system,
    claude,
    codex,
    network,
    projection,
    containment,
    claudeVerifier,
    codexVerifier,
    journal,
    mutation,
    prepare,
    register,
    execute,
  });
}

function client(
  result: SetupHostExecutionResult,
  host: HostId,
) {
  if (result.status === "precondition-failed") {
    throw new Error("unexpected precondition failure");
  }
  const found = result.clients.find(({ client }) => client === host);
  if (found === undefined) {
    throw new Error(`missing ${host} result`);
  }
  return found;
}

describe("setup host orchestration", () => {
  it("configures, freshly reinspects, and verifies both hosts in canonical order", async () => {
    const harness = createHarness();

    const { result } = await harness.execute();

    expect(result.status).toBe("complete");
    if (result.status === "precondition-failed") {
      throw new Error("unexpected precondition failure");
    }
    expect(result.agent).toEqual({
      id: AGENT_ID,
      name: "Plurum Agent",
      username: "plurum-agent",
      verification: "verified",
    });
    expect(client(result, "claude-code")).toMatchObject({
      configuration: "changed",
      projection: "not-applicable",
      mcp: "verified",
      reason: null,
      restartRequired: true,
    });
    expect(client(result, "codex")).toMatchObject({
      configuration: "changed",
      projection: "changed",
      mcp: "verified",
      reason: null,
      restartRequired: true,
    });
    expect(harness.containment.control.calls()).toBe(2);
    expect(harness.projection.control.synchronizeCalls()).toBe(1);
    expect(harness.claudeVerifier.control.calls()).toBe(1);
    expect(harness.codexVerifier.control.calls()).toBe(1);
    expect(harness.journal.control.hasJournal()).toBe(false);
    expect(harness.journal.control.acquireCalls()).toBe(2);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.clients)).toBe(true);

    const events = harness.events;
    expect(events.indexOf("claude-code:mcp")).toBeGreaterThan(
      events.findLastIndex((entry) => entry.startsWith("claude-code:apply")),
    );
    expect(events.indexOf("codex:containment:1")).toBeLessThan(
      events.indexOf("codex:projection-synchronize"),
    );
    expect(events.indexOf("codex:projection-synchronize")).toBeLessThan(
      events.indexOf("codex:containment:2"),
    );
    expect(events.indexOf("codex:containment:2")).toBeLessThan(
      events.findIndex((entry) => entry.startsWith("codex:apply")),
    );
    expect(events.indexOf("codex:mcp")).toBeGreaterThan(
      events.findLastIndex((entry) => entry.startsWith("codex:apply")),
    );
    expect(events.at(-1)).toBe("agent:verify");

    const output = renderSetupHostExecutionResult(result);
    expect(output).toContain("Plurum setup complete");
    expect(output).toContain("exact seven Plurum tools");
    expect(output).toContain("start a new Claude Code task");
    expect(output).toContain("start a new Codex task");
    expect(output).not.toContain("restart the computer");
    expect(output).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain("/trusted/");
  });

  it.each([
    ["claude-code", "codex"],
    ["codex", "claude-code"],
  ] as const)("configures only the selected %s client", async (target, other) => {
    const harness = createHarness({ target });

    const { result } = await harness.execute();

    expect(result.status).toBe("complete");
    if (result.status === "precondition-failed") {
      throw new Error("unexpected precondition failure");
    }
    expect(result.clients.map(({ client: id }) => id)).toEqual([target]);
    expect(client(result, target).mcp).toBe("verified");
    expect(
      other === "claude-code"
        ? harness.claude.control.applyCalls()
        : harness.codex.control.applyCalls(),
    ).toBe(0);
    expect(
      other === "claude-code"
        ? harness.claudeVerifier.control.calls()
        : harness.codexVerifier.control.calls(),
    ).toBe(0);
    if (target === "claude-code") {
      expect(harness.containment.control.calls()).toBe(0);
      expect(harness.projection.control.synchronizeCalls()).toBe(0);
    }
  });

  it.each(["claude-code", "codex"] as const)(
    "keeps an absent %s client informational when the other client verifies",
    async (absentHost) => {
      const harness = createHarness({ absentHosts: [absentHost] });
      const presentHost = absentHost === "claude-code" ? "codex" : "claude-code";

      const { result } = await harness.execute();

      expect(result.status).toBe("complete");
      expect(client(result, absentHost)).toMatchObject({
        configuration: "absent",
        projection: "not-applicable",
        mcp: "not-run",
        reason: null,
      });
      expect(client(result, presentHost).mcp).toBe("verified");
      if (absentHost === "codex") {
        expect(harness.containment.control.calls()).toBe(0);
        expect(harness.projection.control.synchronizeCalls()).toBe(0);
      }
    },
  );

  it("keeps Claude configured when Codex restores a clean failed mutation", async () => {
    const harness = createHarness();
    harness.codex.control.failApply(2);

    const { result } = await harness.execute();

    expect(result.status).toBe("partial");
    expect(client(result, "claude-code")).toMatchObject({
      configuration: "changed",
      mcp: "verified",
    });
    expect(client(result, "codex")).toMatchObject({
      configuration: "restored",
      projection: "changed",
      mcp: "not-run",
      reason: "configuration-restored",
    });
    expect(harness.codex.control.rollbackCalls()).toBeGreaterThan(0);
    expect(harness.codex.control.configuration()).toEqual(
      absentConfiguration(),
    );
    expect(harness.codexVerifier.control.calls()).toBe(0);
    expect(harness.projection.control.status()).toBe("exact");
    expect(harness.journal.control.hasJournal()).toBe(false);
    const output = renderSetupHostExecutionResult(result);
    expect(output).toContain("Working client configuration has been preserved");
    expect(output).not.toContain("next step for Codex");
    expect(output).not.toContain(KEY);
  });

  it("continues to Codex after Claude is restored exactly", async () => {
    const harness = createHarness();
    harness.claude.control.failApply(2);

    const { result } = await harness.execute();

    expect(result.status).toBe("partial");
    expect(client(result, "claude-code")).toMatchObject({
      configuration: "restored",
      mcp: "not-run",
      reason: "configuration-restored",
    });
    expect(client(result, "codex")).toMatchObject({
      configuration: "changed",
      projection: "changed",
      mcp: "verified",
      reason: null,
    });
    expect(harness.claude.control.configuration()).toEqual(
      absentConfiguration(),
    );
    expect(harness.containment.control.calls()).toBe(2);
    expect(harness.codex.control.applyCalls()).toBeGreaterThan(0);
    expect(harness.codexVerifier.control.calls()).toBe(1);
    expect(harness.journal.control.hasJournal()).toBe(false);
  });

  it("settles both clean rollbacks without retaining a reconciliation journal", async () => {
    const harness = createHarness();
    harness.claude.control.failApply(2);
    harness.codex.control.failApply(2);

    const { result } = await harness.execute();

    expect(result.status).toBe("failed");
    expect(client(result, "claude-code")).toMatchObject({
      configuration: "restored",
      projection: "not-applicable",
      mcp: "not-run",
      reason: "configuration-restored",
    });
    expect(client(result, "codex")).toMatchObject({
      configuration: "restored",
      projection: "changed",
      mcp: "not-run",
      reason: "configuration-restored",
    });
    expect(harness.claude.control.configuration()).toEqual(
      absentConfiguration(),
    );
    expect(harness.codex.control.configuration()).toEqual(
      absentConfiguration(),
    );
    expect(harness.journal.control.hasJournal()).toBe(false);
    expect(harness.claudeVerifier.control.calls()).toBe(0);
    expect(harness.codexVerifier.control.calls()).toBe(0);
  });

  it("halts later hosts when the earlier reconciliation state is uncertain", async () => {
    const harness = createHarness({ journalReplaceConflictAt: 2 });

    const { result } = await harness.execute();

    expect(result.status).toBe("replan-required");
    expect(client(result, "claude-code")).toMatchObject({
      configuration: "uncertain",
      mcp: "not-run",
      reason: "configuration-state-changed",
    });
    expect(client(result, "codex")).toMatchObject({
      configuration: "not-attempted",
      projection: "not-attempted",
      mcp: "not-run",
      reason: "earlier-state-uncertain",
    });
    expect(harness.containment.control.calls()).toBe(0);
    expect(harness.projection.control.synchronizeCalls()).toBe(0);
    expect(harness.codex.control.applyCalls()).toBe(0);
    expect(harness.codexVerifier.control.calls()).toBe(0);
    expect(renderSetupHostExecutionResult(result)).toContain(
      "configuration state is uncertain",
    );
  });

  it("requires a fresh plan when the approved host version drifts before MCP startup", async () => {
    const harness = createHarness();
    const prepared = await harness.prepare(0);
    const registration = await harness.register(prepared);
    harness.claude.control.setVersion("99.0.0");

    const result = await prepared.authority
      .createHostExecution(prepared.plan, registration.grant)
      .execute();

    expect(result.status).toBe("replan-required");
    expect(client(result, "claude-code")).toMatchObject({
      configuration: "uncertain",
      mcp: "not-run",
      reason: "post-configuration-drift",
    });
    expect(client(result, "codex")).toMatchObject({
      configuration: "not-attempted",
      projection: "not-attempted",
      mcp: "not-run",
      reason: "earlier-state-uncertain",
    });
    expect(harness.claudeVerifier.control.calls()).toBe(0);
    expect(harness.containment.control.calls()).toBe(0);
    expect(harness.codex.control.applyCalls()).toBe(0);
  });

  it("reports a first-host journal lock as busy without reaching Codex", async () => {
    const harness = createHarness({ journalBusyAtAcquire: 1 });

    const { result } = await harness.execute();

    expect(result.status).toBe("busy");
    if (result.status === "precondition-failed") {
      throw new Error("unexpected precondition failure");
    }
    expect(result.credential).toBe("verified");
    expect(client(result, "claude-code")).toMatchObject({
      configuration: "not-attempted",
      mcp: "not-run",
      reason: "configuration-busy",
    });
    expect(client(result, "codex")).toMatchObject({
      configuration: "not-attempted",
      projection: "not-attempted",
      mcp: "not-run",
      reason: "configuration-busy",
    });
    expect(harness.containment.control.calls()).toBe(0);
    expect(harness.projection.control.synchronizeCalls()).toBe(0);
    expect(harness.claude.control.applyCalls()).toBe(0);
    expect(harness.codex.control.applyCalls()).toBe(0);
    expect(harness.claudeVerifier.control.calls()).toBe(0);
    expect(harness.codexVerifier.control.calls()).toBe(0);
    const output = renderSetupHostExecutionResult(result);
    expect(output).not.toContain("start a new");
    expect(output).not.toContain("configuration has been preserved");
  });

  it("preserves the first verified host when the second journal is busy", async () => {
    const harness = createHarness({ journalBusyAtAcquire: 2 });

    const { result } = await harness.execute();

    expect(result.status).toBe("partial");
    expect(client(result, "claude-code")).toMatchObject({
      configuration: "changed",
      mcp: "verified",
      reason: null,
    });
    expect(client(result, "codex")).toMatchObject({
      configuration: "not-attempted",
      projection: "changed",
      mcp: "not-run",
      reason: "configuration-busy",
    });
    expect(harness.codex.control.applyCalls()).toBe(0);
    expect(harness.codexVerifier.control.calls()).toBe(0);
    const output = renderSetupHostExecutionResult(result);
    expect(output).toContain("Working client configuration has been preserved");
    expect(output).not.toContain("next step for Codex");
  });

  it("requires replanning when the final host journal becomes indeterminate", async () => {
    const harness = createHarness({ journalThrowAtAcquire: 2 });

    const { result } = await harness.execute();

    expect(result.status).toBe("replan-required");
    expect(client(result, "claude-code")).toMatchObject({
      configuration: "changed",
      mcp: "verified",
    });
    expect(client(result, "codex")).toMatchObject({
      configuration: "uncertain",
      projection: "changed",
      mcp: "not-run",
      reason: "configuration-unavailable",
    });
    expect(harness.codex.control.applyCalls()).toBe(0);
    expect(harness.codexVerifier.control.calls()).toBe(0);
    expect(renderSetupHostExecutionResult(result)).toContain(
      "configuration state is uncertain",
    );
  });

  it("reports a pre-mutation nonce failure without claiming uncertain state", async () => {
    const harness = createHarness({
      target: "claude-code",
      nonceFailureAt: 1,
    });

    const { result } = await harness.execute();

    expect(result.status).toBe("failed");
    expect(client(result, "claude-code")).toMatchObject({
      configuration: "not-attempted",
      mcp: "not-run",
      reason: "configuration-unavailable",
    });
    expect(harness.journal.control.acquireCalls()).toBe(0);
    expect(harness.claude.control.applyCalls()).toBe(0);
    expect(renderSetupHostExecutionResult(result)).not.toContain(
      "configuration state is uncertain",
    );
  });

  it("requires a fresh plan when a journal acquisition becomes indeterminate", async () => {
    const harness = createHarness({
      target: "claude-code",
      journalThrowAtAcquire: 1,
    });

    const { result } = await harness.execute();

    expect(result.status).toBe("replan-required");
    expect(client(result, "claude-code")).toMatchObject({
      configuration: "uncertain",
      mcp: "not-run",
      reason: "configuration-unavailable",
    });
    expect(harness.claude.control.applyCalls()).toBe(0);
    expect(renderSetupHostExecutionResult(result)).toContain(
      "configuration state is uncertain",
    );
  });

  it("reports a busy credential lease without blaming host configuration", async () => {
    const harness = createHarness({ credentialBusyAtObservedAcquire: 2 });

    const { result } = await harness.execute();

    expect(result.status).toBe("busy");
    if (result.status === "precondition-failed") {
      throw new Error("unexpected precondition failure");
    }
    expect(result.credential).toBe("busy");
    expect(result.clients).toEqual([
      expect.objectContaining({
        client: "claude-code",
        configuration: "not-attempted",
        reason: "credential-busy",
      }),
      expect.objectContaining({
        client: "codex",
        configuration: "not-attempted",
        reason: "credential-busy",
      }),
    ]);
    expect(harness.journal.control.acquireCalls()).toBe(0);
    expect(harness.claude.control.applyCalls()).toBe(0);
    expect(harness.codex.control.applyCalls()).toBe(0);
    expect(renderSetupHostExecutionResult(result)).toContain(
      "credential state: busy",
    );
  });

  it("rejects a canonical agent replacement before every host side effect", async () => {
    const harness = createHarness();
    const prepared = await harness.prepare(0);
    const registration = await harness.register(prepared);
    const replacement = credentialBytes(otherActiveCredential());
    try {
      harness.mutation.control.replaceCredentialUnrelated(replacement);
    } finally {
      replacement.fill(0);
    }

    const result = await prepared.authority
      .createHostExecution(prepared.plan, registration.grant)
      .execute();

    expect(result.status).toBe("replan-required");
    if (result.status === "precondition-failed") {
      throw new Error("unexpected precondition failure");
    }
    expect(result.credential).toBe("state-changed");
    expect(result.agent.verification).toBe("unavailable");
    expect(client(result, "claude-code")).toMatchObject({
      configuration: "not-attempted",
      reason: "credential-state-changed",
    });
    expect(client(result, "codex")).toMatchObject({
      configuration: "not-attempted",
      projection: "not-attempted",
      reason: "credential-state-changed",
    });
    expect(harness.containment.control.calls()).toBe(0);
    expect(harness.projection.control.synchronizeCalls()).toBe(0);
    expect(harness.journal.control.acquireCalls()).toBe(0);
    expect(harness.claude.control.applyCalls()).toBe(0);
    expect(harness.codex.control.applyCalls()).toBe(0);
    expect(harness.claudeVerifier.control.calls()).toBe(0);
    expect(harness.codexVerifier.control.calls()).toBe(0);
    const output = renderSetupHostExecutionResult(result);
    expect(output).not.toContain(KEY);
    expect(output).not.toContain(OTHER_KEY);
    expect(output).not.toContain("start a new");
  });

  it("stops later hosts when the canonical agent changes during verification", async () => {
    const harness = createHarness();
    harness.claudeVerifier.control.beforeVerify(() => {
      const replacement = credentialBytes(otherActiveCredential());
      try {
        harness.mutation.control.replaceCredentialUnrelated(replacement);
      } finally {
        replacement.fill(0);
      }
      harness.claudeVerifier.control.beforeVerify(null);
    });

    const { result } = await harness.execute();

    expect(result.status).toBe("replan-required");
    if (result.status === "precondition-failed") {
      throw new Error("unexpected precondition failure");
    }
    expect(result.credential).toBe("state-changed");
    expect(client(result, "claude-code")).toMatchObject({
      configuration: "changed",
      mcp: "verified",
    });
    expect(client(result, "codex")).toMatchObject({
      configuration: "not-attempted",
      projection: "not-attempted",
      mcp: "not-run",
      reason: "credential-state-changed",
    });
    expect(harness.containment.control.calls()).toBe(0);
    expect(harness.projection.control.synchronizeCalls()).toBe(0);
    expect(harness.codex.control.applyCalls()).toBe(0);
    expect(harness.codexVerifier.control.calls()).toBe(0);
    expect(renderSetupHostExecutionResult(result)).not.toContain(
      "next step for Claude Code",
    );
  });

  it("withholds completion when the credential lease cannot be released", async () => {
    const harness = createHarness({ credentialReleaseFailureAt: 2 });

    const { result } = await harness.execute();

    expect(result.status).toBe("replan-required");
    if (result.status === "precondition-failed") {
      throw new Error("unexpected precondition failure");
    }
    expect(result.credential).toBe("unavailable");
    expect(result.agent.verification).toBe("verified");
    expect(client(result, "claude-code")).toMatchObject({
      configuration: "changed",
      mcp: "verified",
    });
    expect(client(result, "codex")).toMatchObject({
      configuration: "changed",
      projection: "changed",
      mcp: "verified",
    });
    const output = renderSetupHostExecutionResult(result);
    expect(output).toContain("Working client configuration has been preserved");
    expect(output).not.toContain("start a new");
    expect(output).not.toContain(KEY);
  });

  it("completes a deferred Codex projection only after registration is durable", async () => {
    const harness = createHarness({ newRegistration: true });

    const { result } = await harness.execute();

    expect(result.status).toBe("complete");
    expect(client(result, "codex")).toMatchObject({
      configuration: "changed",
      projection: "changed",
      mcp: "verified",
    });
    const events = harness.events;
    expect(events.indexOf("agent:register")).toBeGreaterThan(-1);
    expect(events.indexOf("agent:register")).toBeLessThan(
      events.indexOf("codex:projection-synchronize"),
    );
    expect(harness.projection.control.synchronizeCalls()).toBe(1);
    const durable = harness.mutation.control.readDurableCredential();
    expect(durable).toBeDefined();
    expect(new TextDecoder().decode(durable)).not.toContain(KEY);
    durable?.fill(0);
  });

  it("does no Codex mutation when containment is rejected", async () => {
    const harness = createHarness();
    harness.containment.control.set(
      Object.freeze({ status: "rejected" as const }),
    );

    const { result } = await harness.execute();

    expect(result.status).toBe("partial");
    expect(client(result, "claude-code").mcp).toBe("verified");
    expect(client(result, "codex")).toMatchObject({
      configuration: "not-attempted",
      projection: "not-attempted",
      mcp: "not-run",
      reason: "containment-rejected",
    });
    expect(harness.projection.control.synchronizeCalls()).toBe(0);
    expect(harness.codex.control.applyCalls()).toBe(0);
    expect(harness.codex.control.rollbackCalls()).toBe(0);
    expect(harness.codexVerifier.control.calls()).toBe(0);
    expect(harness.journal.control.acquireCalls()).toBe(1);
  });

  it("fails a Codex-only setup before projection when containment is rejected", async () => {
    const harness = createHarness({ target: "codex" });
    harness.containment.control.set(
      Object.freeze({ status: "rejected" as const }),
    );

    const { result } = await harness.execute();

    expect(result.status).toBe("failed");
    if (result.status === "precondition-failed") {
      throw new Error("unexpected precondition failure");
    }
    expect(result.clients).toHaveLength(1);
    expect(client(result, "codex")).toMatchObject({
      configuration: "not-attempted",
      projection: "not-attempted",
      mcp: "not-run",
      reason: "containment-rejected",
    });
    expect(harness.projection.control.synchronizeCalls()).toBe(0);
    expect(harness.journal.control.acquireCalls()).toBe(0);
    expect(harness.codex.control.applyCalls()).toBe(0);
    expect(harness.codexVerifier.control.calls()).toBe(0);
  });

  it("preserves local configuration and continues when one MCP check fails", async () => {
    const harness = createHarness();
    harness.claudeVerifier.control.tools(
      PLURUM_MCP_TOOL_NAMES.slice(0, -1),
    );

    const { result } = await harness.execute();

    expect(result.status).toBe("partial");
    expect(client(result, "claude-code")).toMatchObject({
      configuration: "changed",
      mcp: "failed",
      reason: "unexpected-mcp-tool-inventory",
    });
    expect(client(result, "codex")).toMatchObject({
      configuration: "changed",
      mcp: "verified",
    });
    expect(harness.claude.control.rollbackCalls()).toBe(0);
    expect(harness.codexVerifier.control.calls()).toBe(1);
  });

  it.each(["throw", "unavailable", "malformed-agent"] as const)(
    "fails closed when one MCP verifier returns %s",
    async (mode) => {
      const harness = createHarness();
      if (mode === "malformed-agent") {
        harness.claudeVerifier.control.authenticatedAgentId("not-an-agent-id");
      } else {
        harness.claudeVerifier.control.mode(mode);
      }

      const { result } = await harness.execute();

      expect(result.status).toBe("partial");
      expect(client(result, "claude-code")).toMatchObject({
        configuration: "changed",
        mcp: "failed",
        reason: "mcp-initialization-unavailable",
      });
      expect(client(result, "codex")).toMatchObject({
        configuration: "changed",
        mcp: "verified",
      });
      expect(harness.codexVerifier.control.calls()).toBe(1);
      expect(renderSetupHostExecutionResult(result)).not.toContain(
        "next step for Claude Code",
      );
    },
  );

  it("requires the MCP session to attest the approved agent identity", async () => {
    const harness = createHarness();
    harness.claudeVerifier.control.authenticatedAgentId(OTHER_AGENT_ID);

    const { result } = await harness.execute();

    expect(result.status).toBe("replan-required");
    expect(client(result, "claude-code")).toMatchObject({
      configuration: "changed",
      mcp: "failed",
      reason: "mcp-agent-identity-mismatch",
    });
    expect(client(result, "codex")).toMatchObject({
      configuration: "changed",
      mcp: "verified",
    });
    expect(harness.claude.control.rollbackCalls()).toBe(0);
    expect(harness.codexVerifier.control.calls()).toBe(1);
    expect(renderSetupHostExecutionResult(result)).not.toContain(
      "next step for Claude Code",
    );
  });

  it("requires the same accepted containment decision again before Codex mutation", async () => {
    const harness = createHarness();
    harness.containment.control.sequence([
      Object.freeze({
        status: "accepted" as const,
        decisionRevision: "containment-policy-1",
      }),
      Object.freeze({
        status: "accepted" as const,
        decisionRevision: "containment-policy-2",
      }),
    ]);

    const { result } = await harness.execute();

    expect(result.status).toBe("replan-required");
    expect(client(result, "claude-code").mcp).toBe("verified");
    expect(client(result, "codex")).toMatchObject({
      configuration: "not-attempted",
      projection: "changed",
      mcp: "not-run",
      reason: "containment-changed",
    });
    expect(harness.projection.control.synchronizeCalls()).toBe(1);
    expect(harness.codex.control.applyCalls()).toBe(0);
    expect(harness.codexVerifier.control.calls()).toBe(0);
  });

  it("requires a fresh plan when Codex projection converges without owned mutation evidence", async () => {
    const harness = createHarness();
    harness.projection.control.mode("converged-unowned");

    const { result } = await harness.execute();

    expect(result.status).toBe("replan-required");
    expect(client(result, "claude-code").mcp).toBe("verified");
    expect(client(result, "codex")).toMatchObject({
      configuration: "not-attempted",
      projection: "failed",
      mcp: "not-run",
      reason: "credential-projection-state-changed",
    });
    expect(harness.codex.control.applyCalls()).toBe(0);
    expect(harness.codexVerifier.control.calls()).toBe(0);
  });

  it("requires a fresh plan when the Codex projection outcome is indeterminate", async () => {
    const harness = createHarness();
    harness.projection.control.mode("indeterminate");

    const { result } = await harness.execute();

    expect(result.status).toBe("replan-required");
    expect(client(result, "claude-code").mcp).toBe("verified");
    expect(client(result, "codex")).toMatchObject({
      configuration: "not-attempted",
      projection: "failed",
      mcp: "not-run",
      reason: "credential-projection-state-changed",
    });
    expect(harness.codex.control.applyCalls()).toBe(0);
    expect(harness.codexVerifier.control.calls()).toBe(0);
  });

  it("burns a host grant on a wrong plan before every side effect", async () => {
    const harness = createHarness();
    const prepared = await harness.prepare(0);
    if (prepared.confirmation.status !== "approved") {
      throw new Error("expected approved plan");
    }
    const registration = await prepared.authority
      .createRegistrationExecution(
        prepared.plan,
        prepared.confirmation.grant,
      )
      .execute();
    if (registration.status !== "ready") {
      throw new Error("expected host grant");
    }
    const wrongPlan = Object.freeze({
      ...prepared.plan,
    }) as typeof prepared.plan;

    await expect(
      prepared.authority
        .createHostExecution(wrongPlan, registration.grant)
        .execute(),
    ).resolves.toEqual({ status: "precondition-failed" });
    await expect(
      prepared.authority
        .createHostExecution(prepared.plan, registration.grant)
        .execute(),
    ).resolves.toEqual({ status: "precondition-failed" });
    expect(harness.containment.control.calls()).toBe(0);
    expect(harness.projection.control.synchronizeCalls()).toBe(0);
    expect(harness.journal.control.acquireCalls()).toBe(0);
    expect(harness.claude.control.applyCalls()).toBe(0);
    expect(harness.codex.control.applyCalls()).toBe(0);
    expect(harness.claudeVerifier.control.calls()).toBe(0);
    expect(harness.codexVerifier.control.calls()).toBe(0);
  });

  it("makes a fresh second invocation an exact no-op early exit", async () => {
    const harness = createHarness();
    const first = await harness.execute(0);
    expect(first.result.status).toBe("complete");

    const before = Object.freeze({
      credential: harness.mutation.control.readDurableCredential(),
      claude: harness.claude.control.configuration(),
      codex: harness.codex.control.configuration(),
      claudeApply: harness.claude.control.applyCalls(),
      codexApply: harness.codex.control.applyCalls(),
      synchronize: harness.projection.control.synchronizeCalls(),
      journalAcquires: harness.journal.control.acquireCalls(),
      journalWrites: harness.journal.control.replaceCalls(),
      claudeMcp: harness.claudeVerifier.control.calls(),
      codexMcp: harness.codexVerifier.control.calls(),
      storeOperations: harness.mutation.trace.operations().length,
    });

    const second = await harness.prepare(1);
    expect(second.plan.preview.readiness).toBe("no-op");
    expect(second.plan.preview.mutations).toEqual([]);
    expect(second.confirmation).toEqual({ status: "not-required" });
    expect(renderSetupApplyPlan(second.plan)).toContain(
      "confirmation: not required; this plan has no changes",
    );
    expect(renderSetupApplyPlan(second.plan)).not.toContain(
      "exact seven Plurum tools",
    );
    expect(renderSetupApplyPlan(second.plan)).not.toContain(
      "start a new",
    );

    const afterCredential = harness.mutation.control.readDurableCredential();
    expect(afterCredential).toEqual(before.credential);
    before.credential?.fill(0);
    afterCredential?.fill(0);
    expect(harness.claude.control.configuration()).toEqual(before.claude);
    expect(harness.codex.control.configuration()).toEqual(before.codex);
    expect(harness.claude.control.applyCalls()).toBe(before.claudeApply);
    expect(harness.codex.control.applyCalls()).toBe(before.codexApply);
    expect(harness.projection.control.synchronizeCalls()).toBe(
      before.synchronize,
    );
    expect(harness.journal.control.acquireCalls()).toBe(
      before.journalAcquires,
    );
    expect(harness.journal.control.replaceCalls()).toBe(
      before.journalWrites,
    );
    expect(harness.claudeVerifier.control.calls()).toBe(before.claudeMcp);
    expect(harness.codexVerifier.control.calls()).toBe(before.codexMcp);
    expect(
      harness.mutation.trace.operations().slice(before.storeOperations),
    ).toEqual(["control:observe-whole-pass"]);
  });

  it("makes an installed healthy host plus an absent host a no-op on rerun", async () => {
    const harness = createHarness({ absentHosts: ["codex"] });
    const first = await harness.execute(0);
    expect(first.result.status).toBe("complete");
    expect(client(first.result, "claude-code").mcp).toBe("verified");
    expect(client(first.result, "codex").configuration).toBe("absent");

    const before = Object.freeze({
      applyCalls: harness.claude.control.applyCalls(),
      journalAcquires: harness.journal.control.acquireCalls(),
      mcpCalls: harness.claudeVerifier.control.calls(),
      storeOperations: harness.mutation.trace.operations().length,
    });
    const second = await harness.prepare(1);

    expect(second.plan.preview.readiness).toBe("no-op");
    expect(second.plan.preview.mutations).toEqual([]);
    expect(second.confirmation).toEqual({ status: "not-required" });
    expect(harness.claude.control.applyCalls()).toBe(before.applyCalls);
    expect(harness.journal.control.acquireCalls()).toBe(
      before.journalAcquires,
    );
    expect(harness.claudeVerifier.control.calls()).toBe(before.mcpCalls);
    expect(
      harness.mutation.trace.operations().slice(before.storeOperations),
    ).toEqual(["control:observe-whole-pass"]);
  });

  it("falls back to approved labels when a late profile rename is not render-safe", async () => {
    const harness = createHarness();
    const prepared = await harness.prepare(0);
    const registration = await harness.register(prepared);
    harness.network.control.rename("password=example");

    const result = await prepared.authority
      .createHostExecution(prepared.plan, registration.grant)
      .execute();

    expect(result.status).toBe("complete");
    if (result.status === "precondition-failed") {
      throw new Error("unexpected precondition failure");
    }
    expect(result.agent).toEqual({
      id: AGENT_ID,
      name: "Plurum Agent",
      username: "plurum-agent",
      verification: "verified",
    });
    expect(() => renderSetupHostExecutionResult(result)).not.toThrow();
    expect(renderSetupHostExecutionResult(result)).not.toContain(
      "password=example",
    );
  });

  it.each([
    ["invalid", "invalid", "replan-required"],
    ["mismatch", "mismatch", "replan-required"],
    ["unavailable", "unavailable", "partial"],
  ] as const)(
    "reports a final agent identity that becomes %s",
    async (mode, verification, status) => {
      const harness = createHarness();
      const prepared = await harness.prepare(0);
      const registration = await harness.register(prepared);
      harness.network.control.finalMode(mode);

      const result = await prepared.authority
        .createHostExecution(prepared.plan, registration.grant)
        .execute();

      expect(result.status).toBe(status);
      if (result.status === "precondition-failed") {
        throw new Error("unexpected precondition failure");
      }
      expect(result.agent.verification).toBe(verification);
      expect(result.clients.every(({ mcp }) => mcp === "verified")).toBe(true);
      expect(renderSetupHostExecutionResult(result)).not.toContain(
        "next step",
      );
    },
  );

  it("rejects a recomposed mutation authority before setup inspection", async () => {
    const harness = createHarness();
    const foreignScope = setupScope(harness.system);

    await expect(
      harness.prepare(0, foreignScope.hosts.mutation),
    ).rejects.toBeInstanceOf(CodexDotenvSetupObservationError);
    expect(harness.containment.control.calls()).toBe(0);
    expect(harness.journal.control.acquireCalls()).toBe(0);
    expect(harness.claude.control.applyCalls()).toBe(0);
    expect(harness.codex.control.applyCalls()).toBe(0);
  });
});

describe("MCP inventory normalization", () => {
  const request = Object.freeze({
    host: "codex" as const,
    scope: "user" as const,
    endpoint: CODEX_DESIRED_CONFIGURATION.mcp.endpoint,
    executableRevision: "codex-executable-revision",
    expectedStateRevision: "codex-state-revision",
    expectedConfiguration: absentConfiguration(),
    expectedTools: PLURUM_MCP_TOOL_NAMES,
    expectedAgentId: AGENT_ID,
    excludedProjectDirectory: CANARY_PATH,
  });

  it("accepts exactly seven unique tools in arbitrary order", async () => {
    const adapter: HostMcpVerificationAdapter = Object.freeze({
      async verify() {
        return Object.freeze({
          status: "initialized" as const,
          tools: Object.freeze([...PLURUM_MCP_TOOL_NAMES].reverse()),
          authenticatedAgentId: AGENT_ID,
        });
      },
    });
    await expect(verifyHostMcpInventory(adapter, request)).resolves.toEqual({
      status: "verified",
    });
  });

  it("rejects a different agent identity from the authenticated MCP exchange", async () => {
    const adapter: HostMcpVerificationAdapter = Object.freeze({
      async verify() {
        return Object.freeze({
          status: "initialized" as const,
          tools: PLURUM_MCP_TOOL_NAMES,
          authenticatedAgentId: OTHER_AGENT_ID,
        });
      },
    });
    await expect(verifyHostMcpInventory(adapter, request)).resolves.toEqual({
      status: "failed",
      reason: "agent-identity-mismatch",
    });
  });

  it.each([
    PLURUM_MCP_TOOL_NAMES.slice(0, -1),
    [...PLURUM_MCP_TOOL_NAMES, "plurum_extra"],
    [...PLURUM_MCP_TOOL_NAMES.slice(0, -1), "plurum_search"],
    PLURUM_MCP_TOOL_NAMES.map((name, index) =>
      index === 0 ? name.toUpperCase() : name,
    ),
  ])("rejects a non-exact inventory", async (tools) => {
    const adapter: HostMcpVerificationAdapter = Object.freeze({
      async verify() {
        return Object.freeze({
          status: "initialized" as const,
          tools: Object.freeze([...tools]),
          authenticatedAgentId: AGENT_ID,
        });
      },
    });
    await expect(verifyHostMcpInventory(adapter, request)).resolves.toEqual({
      status: "failed",
      reason: "unexpected-tool-inventory",
    });
  });

  it("rejects accessor and extra-field observations without reflecting them", async () => {
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "status", {
      enumerable: true,
      value: "initialized",
    });
    Object.defineProperty(accessor, "tools", {
      enumerable: true,
      get() {
        throw new Error(KEY);
      },
    });
    Object.defineProperty(accessor, "extra", {
      enumerable: true,
      value: KEY,
    });
    const adapter: HostMcpVerificationAdapter = Object.freeze({
      async verify() {
        return accessor as never;
      },
    });
    const result = await verifyHostMcpInventory(adapter, request);
    expect(result).toEqual({
      status: "failed",
      reason: "initialization-unavailable",
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});

describe("Codex containment normalization", () => {
  const request = Object.freeze({
    host: "codex" as const,
    scope: "user" as const,
    architecture: CODEX_CREDENTIAL_CONTAINMENT_ARCHITECTURE,
    endpoint: CODEX_DESIRED_CONFIGURATION.mcp.endpoint,
    executableRevision: "codex-executable-revision",
    expectedConfiguration: absentConfiguration(),
    expectedTools: PLURUM_MCP_TOOL_NAMES,
    excludedProjectDirectory: CANARY_PATH,
  });

  it("accepts only a bounded non-secret decision revision", async () => {
    const adapter: CodexCredentialContainmentAdapter =
      Object.freeze<CodexCredentialContainmentAdapter>({
        async revalidate() {
          return Object.freeze({
            status: "accepted" as const,
            decisionRevision: "reviewed-policy-1",
          });
        },
      });
    await expect(
      revalidateCodexCredentialContainment(adapter, request),
    ).resolves.toEqual({
      status: "accepted",
      decisionRevision: "reviewed-policy-1",
    });
  });

  it.each([
    `revision-${KEY}`,
    "revision\nunsafe",
    "",
  ])("rejects an unsafe decision revision", async (decisionRevision) => {
    const adapter: CodexCredentialContainmentAdapter =
      Object.freeze<CodexCredentialContainmentAdapter>({
        async revalidate() {
          return Object.freeze({
            status: "accepted" as const,
            decisionRevision,
          });
        },
      });
    const result = await revalidateCodexCredentialContainment(
      adapter,
      request,
    );
    expect(result).toEqual({ status: "blocked", reason: "unavailable" });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("rejects accessor and extra-field containment results", async () => {
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "status", {
      enumerable: true,
      value: "accepted",
    });
    Object.defineProperty(hostile, "decisionRevision", {
      enumerable: true,
      get() {
        throw new Error(KEY);
      },
    });
    Object.defineProperty(hostile, "extra", {
      enumerable: true,
      value: KEY,
    });
    const adapter: CodexCredentialContainmentAdapter =
      Object.freeze<CodexCredentialContainmentAdapter>({
        async revalidate() {
          return hostile as never;
        },
      });
    const result = await revalidateCodexCredentialContainment(
      adapter,
      request,
    );
    expect(result).toEqual({ status: "blocked", reason: "unavailable" });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});
