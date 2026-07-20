import {
  registerCliAgent,
  type CliAgentRegistrationResult,
} from "../api/agent-registration.js";
import {
  validateAgentCredential,
  type ValidatedAgentIdentity,
} from "../api/agent-validation.js";
import { CredentialError } from "../credentials/errors.js";
import type { ApiOriginPolicy } from "../credentials/origin.js";
import type { CredentialLocations } from "../credentials/paths.js";
import {
  type ActiveCredentialV1,
  type AgentName,
  type PendingCredentialV1,
  type RegistrationRequestId,
  type Username,
  validateCredentialDocument,
} from "../credentials/schema.js";
import {
  runExclusiveCredentialRegistration,
  type ExclusiveCredentialRegistrationSession,
} from "../credentials/store-writer.js";
import type {
  ClockAdapter,
  HashAdapter,
  NetworkAdapter,
  RandomAdapter,
} from "../system/contracts.js";
import {
  deriveRegistrationKeyCommitment,
  generateRegistrationKeyMaterial,
} from "./key-material.js";
import type { CredentialStoreMutationAdapter } from "../credentials/store-mutation-contracts.js";

export interface RecoverableRegistrationDependencies {
  readonly storage: CredentialStoreMutationAdapter;
  readonly network: NetworkAdapter;
  readonly clock: ClockAdapter;
  readonly random: RandomAdapter;
  readonly hash: HashAdapter;
}

export interface UsernameConflictRetryDependencies {
  readonly storage: CredentialStoreMutationAdapter;
  readonly clock: ClockAdapter;
  readonly random: Pick<RandomAdapter, "uuid">;
}

export interface RecoverableRegistrationInput {
  readonly apiOrigin: PendingCredentialV1["api_origin"];
  readonly agentName: AgentName;
  readonly username: Username;
}

export interface RegisteredAgentIdentity {
  readonly id: string;
  readonly name: string;
  readonly username: string | null;
}

export type RecoverableRegistrationResult =
  | Readonly<{
      status: "active";
      source: "existing" | "created" | "replayed" | "recovered";
      agent: RegisteredAgentIdentity;
    }>
  | Readonly<{
      status: "retryable";
      reason:
        | "credential_store_unavailable"
        | "rate_limit"
        | "registration_unavailable"
        | "verification_unavailable";
    }>
  | Readonly<{
      status: "blocked";
      reason:
        | "active_credential_invalid"
        | "credential_conflict"
        | "credential_verification_failed"
        | "idempotency_conflict"
        | "identity_mismatch"
        | "local_credential_conflict"
        | "username_unavailable";
    }>
  | Readonly<{ status: "busy" }>;

export type UsernameConflictRetryResult =
  | Readonly<{ status: "ready" }>
  | Readonly<{
      status: "blocked";
      reason:
        | "local_credential_conflict"
        | "no_pending_registration";
    }>
  | Readonly<{
      status: "retryable";
      reason: "credential_store_unavailable";
    }>
  | Readonly<{ status: "busy" }>;

interface PreparedRegistration {
  readonly dependencies: RecoverableRegistrationDependencies;
  readonly locations: Pick<CredentialLocations, "directory">;
  readonly input: RecoverableRegistrationInput;
  readonly originPolicy: ApiOriginPolicy;
}

const BUSY: RecoverableRegistrationResult = Object.freeze({
  status: "busy",
});
const STORE_UNAVAILABLE: RecoverableRegistrationResult = Object.freeze({
  status: "retryable",
  reason: "credential_store_unavailable",
});
const REGISTRATION_UNAVAILABLE: RecoverableRegistrationResult = Object.freeze({
  status: "retryable",
  reason: "registration_unavailable",
});
const VERIFICATION_UNAVAILABLE: RecoverableRegistrationResult = Object.freeze({
  status: "retryable",
  reason: "verification_unavailable",
});
const RATE_LIMIT: RecoverableRegistrationResult = Object.freeze({
  status: "retryable",
  reason: "rate_limit",
});
const IDENTITY_MISMATCH: RecoverableRegistrationResult = Object.freeze({
  status: "blocked",
  reason: "identity_mismatch",
});
const VERIFICATION_FAILED: RecoverableRegistrationResult = Object.freeze({
  status: "blocked",
  reason: "credential_verification_failed",
});
const ACTIVE_CREDENTIAL_INVALID: RecoverableRegistrationResult =
  Object.freeze({
    status: "blocked",
    reason: "active_credential_invalid",
  });
const LOCAL_CREDENTIAL_CONFLICT: RecoverableRegistrationResult =
  Object.freeze({
    status: "blocked",
    reason: "local_credential_conflict",
  });
const USERNAME_RETRY_READY: UsernameConflictRetryResult = Object.freeze({
  status: "ready",
});
const USERNAME_RETRY_NO_PENDING: UsernameConflictRetryResult =
  Object.freeze({
    status: "blocked",
    reason: "no_pending_registration",
  });
const USERNAME_RETRY_LOCAL_CONFLICT: UsernameConflictRetryResult =
  Object.freeze({
    status: "blocked",
    reason: "local_credential_conflict",
  });
const USERNAME_RETRY_STORE_UNAVAILABLE: UsernameConflictRetryResult =
  Object.freeze({
    status: "retryable",
    reason: "credential_store_unavailable",
  });
const USERNAME_RETRY_BUSY: UsernameConflictRetryResult = Object.freeze({
  status: "busy",
});

function prepare(
  dependencies: RecoverableRegistrationDependencies,
  locations: Pick<CredentialLocations, "directory">,
  input: RecoverableRegistrationInput,
  originPolicy: ApiOriginPolicy,
): PreparedRegistration {
  if (
    originPolicy !== "https-only" &&
    originPolicy !== "explicit-loopback-development"
  ) {
    throw new CredentialError("invalid_api_origin");
  }
  return Object.freeze({
    dependencies: Object.freeze({
      storage: dependencies.storage,
      network: dependencies.network,
      clock: dependencies.clock,
      random: dependencies.random,
      hash: dependencies.hash,
    }),
    locations: Object.freeze({ directory: `${locations.directory}` }),
    input: Object.freeze({
      apiOrigin: input.apiOrigin,
      agentName: input.agentName,
      username: input.username,
    }),
    originPolicy,
  });
}

function safeAgent(
  agent: ValidatedAgentIdentity | ActiveCredentialV1,
): RegisteredAgentIdentity {
  if ("agent_id" in agent) {
    return Object.freeze({
      id: agent.agent_id,
      name: agent.agent_name,
      username: agent.username,
    });
  }
  return Object.freeze({
    id: agent.id,
    name: agent.name,
    username: agent.username,
  });
}

function activeResult(
  source: Extract<
    RecoverableRegistrationResult,
    { status: "active" }
  >["source"],
  agent: ValidatedAgentIdentity | ActiveCredentialV1,
): RecoverableRegistrationResult {
  return Object.freeze({
    status: "active",
    source,
    agent: safeAgent(agent),
  });
}

function identityMatches(
  pending: PendingCredentialV1,
  agent: ValidatedAgentIdentity,
  expectedAgentId?: string,
): boolean {
  return (
    agent.name === pending.agent_name &&
    agent.username === pending.username &&
    (expectedAgentId === undefined || agent.id === expectedAgentId)
  );
}

function activeIdentityMatches(
  credential: ActiveCredentialV1,
  agent: ValidatedAgentIdentity,
): boolean {
  return (
    credential.agent_id === agent.id &&
    credential.agent_name === agent.name &&
    credential.username === agent.username
  );
}

async function activateVerified(
  session: ExclusiveCredentialRegistrationSession,
  pending: PendingCredentialV1,
  agent: ValidatedAgentIdentity,
  source: Extract<
    RecoverableRegistrationResult,
    { status: "active" }
  >["source"],
  expectedAgentId?: string,
): Promise<RecoverableRegistrationResult> {
  if (!identityMatches(pending, agent, expectedAgentId)) {
    return IDENTITY_MISMATCH;
  }
  await session.activateExactPending(pending, agent);
  return activeResult(source, agent);
}

function pendingCredential(
  prepared: PreparedRegistration,
  createdAt: PendingCredentialV1["created_at"],
): PendingCredentialV1 {
  const material = generateRegistrationKeyMaterial(
    prepared.dependencies.random,
    prepared.dependencies.hash,
  );
  const requestId = prepared.dependencies.random.uuid();
  const candidate = validateCredentialDocument(
    {
      schema_version: 1,
      state: "pending",
      api_origin: prepared.input.apiOrigin,
      api_key: material.apiKey,
      agent_id: null,
      agent_name: prepared.input.agentName,
      username: prepared.input.username,
      registration_request_id:
        requestId as RegistrationRequestId,
      created_at: createdAt,
      updated_at: createdAt,
      activated_at: null,
    },
    prepared.originPolicy,
  );
  if (candidate.state !== "pending") {
    throw new CredentialError("invalid_credential_document");
  }
  return candidate;
}

function conflictResult(
  result: Extract<CliAgentRegistrationResult, { status: "conflict" }>,
): RecoverableRegistrationResult {
  return Object.freeze({
    status: "blocked",
    reason: result.reason,
  });
}

async function verifyAfterRegistration(
  prepared: PreparedRegistration,
  session: ExclusiveCredentialRegistrationSession,
  pending: PendingCredentialV1,
  registration: CliAgentRegistrationResult,
): Promise<RecoverableRegistrationResult> {
  if (
    registration.status === "retryable" &&
    registration.reason === "rate_limit"
  ) {
    return RATE_LIMIT;
  }
  if (registration.status === "conflict") {
    return conflictResult(registration);
  }

  const validation = await validateAgentCredential(
    prepared.dependencies.network,
    pending.api_origin,
    pending.api_key,
    prepared.originPolicy,
  );
  if (validation.status === "indeterminate") {
    return VERIFICATION_UNAVAILABLE;
  }
  if (validation.status === "invalid") {
    return registration.status === "success"
      ? VERIFICATION_FAILED
      : REGISTRATION_UNAVAILABLE;
  }

  return activateVerified(
    session,
    pending,
    validation.agent,
    registration.status === "success"
      ? registration.disposition
      : "recovered",
    registration.status === "success"
      ? registration.agentId
      : undefined,
  );
}

async function operate(
  prepared: PreparedRegistration,
  session: ExclusiveCredentialRegistrationSession,
): Promise<RecoverableRegistrationResult> {
  const stored = await session.readOrCreatePending((createdAt) =>
    pendingCredential(prepared, createdAt),
  );
  if (stored.status === "existing-active") {
    const validation = await validateAgentCredential(
      prepared.dependencies.network,
      stored.credential.api_origin,
      stored.credential.api_key,
      prepared.originPolicy,
    );
    if (validation.status === "indeterminate") {
      return VERIFICATION_UNAVAILABLE;
    }
    if (validation.status === "invalid") {
      return ACTIVE_CREDENTIAL_INVALID;
    }
    return activeIdentityMatches(
      stored.credential,
      validation.agent,
    )
      ? activeResult("existing", validation.agent)
      : IDENTITY_MISMATCH;
  }

  const pending = stored.credential;
  const initialValidation = await validateAgentCredential(
    prepared.dependencies.network,
    pending.api_origin,
    pending.api_key,
    prepared.originPolicy,
  );
  if (initialValidation.status === "valid") {
    return activateVerified(
      session,
      pending,
      initialValidation.agent,
      "recovered",
    );
  }
  if (initialValidation.status === "indeterminate") {
    return VERIFICATION_UNAVAILABLE;
  }

  const commitment = deriveRegistrationKeyCommitment(
    pending.api_key,
    prepared.dependencies.hash,
  );
  const registration = await registerCliAgent(
    prepared.dependencies.network,
    Object.freeze({
      apiOrigin: pending.api_origin,
      agentName: pending.agent_name,
      username: pending.username,
      registrationRequestId: pending.registration_request_id,
      apiKeyHash: commitment.apiKeyHash,
      apiKeyPrefix: commitment.apiKeyPrefix,
    }),
    prepared.originPolicy,
  );
  return verifyAfterRegistration(
    prepared,
    session,
    pending,
    registration,
  );
}

export async function runRecoverableAgentRegistration(
  dependencies: RecoverableRegistrationDependencies,
  locations: Pick<CredentialLocations, "directory">,
  input: RecoverableRegistrationInput,
  originPolicy: ApiOriginPolicy = "https-only",
): Promise<RecoverableRegistrationResult> {
  let prepared: PreparedRegistration;
  try {
    prepared = prepare(
      dependencies,
      locations,
      input,
      originPolicy,
    );
  } catch {
    return REGISTRATION_UNAVAILABLE;
  }

  try {
    return await runExclusiveCredentialRegistration(
      {
        storage: prepared.dependencies.storage,
        random: prepared.dependencies.random,
        clock: prepared.dependencies.clock,
      },
      prepared.locations,
      (session) => operate(prepared, session),
      prepared.originPolicy,
    );
  } catch (error) {
    if (
      error instanceof CredentialError &&
      error.code === "credential_store_busy"
    ) {
      return BUSY;
    }
    if (
      error instanceof CredentialError &&
      error.code === "credential_store_conflict"
    ) {
      return LOCAL_CREDENTIAL_CONFLICT;
    }
    if (error instanceof CredentialError) {
      return STORE_UNAVAILABLE;
    }
    return REGISTRATION_UNAVAILABLE;
  }
}

/*
 * This is an explicit recovery action, not an automatic response to a pending
 * credential. Callers may invoke it only after the server definitively reports
 * username_unavailable and the user chooses a different username. The key is
 * preserved while a new request ID prevents the old idempotency payload from
 * being reinterpreted.
 */
export async function prepareUsernameConflictRetry(
  dependencies: UsernameConflictRetryDependencies,
  locations: Pick<CredentialLocations, "directory">,
  username: Username,
  originPolicy: ApiOriginPolicy = "https-only",
): Promise<UsernameConflictRetryResult> {
  let prepared: Readonly<{
    storage: CredentialStoreMutationAdapter;
    clock: ClockAdapter;
    random: Pick<RandomAdapter, "uuid">;
    locations: Pick<CredentialLocations, "directory">;
    username: Username;
  }>;
  try {
    if (
      originPolicy !== "https-only" &&
      originPolicy !== "explicit-loopback-development"
    ) {
      return USERNAME_RETRY_LOCAL_CONFLICT;
    }
    prepared = Object.freeze({
      storage: dependencies.storage,
      clock: dependencies.clock,
      random: dependencies.random,
      locations: Object.freeze({
        directory: `${locations.directory}`,
      }),
      username,
    });
  } catch {
    return USERNAME_RETRY_STORE_UNAVAILABLE;
  }

  try {
    return await runExclusiveCredentialRegistration(
      {
        storage: prepared.storage,
        clock: prepared.clock,
        random: prepared.random,
      },
      prepared.locations,
      async (session) => {
        const result = await session.replaceUsernameAfterConflict(
          prepared.username,
          () =>
            prepared.random.uuid() as RegistrationRequestId,
        );
        return result.status === "no-pending"
          ? USERNAME_RETRY_NO_PENDING
          : USERNAME_RETRY_READY;
      },
      originPolicy,
    );
  } catch (error) {
    if (
      error instanceof CredentialError &&
      error.code === "credential_store_busy"
    ) {
      return USERNAME_RETRY_BUSY;
    }
    if (
      error instanceof CredentialError &&
      error.code === "credential_store_conflict"
    ) {
      return USERNAME_RETRY_LOCAL_CONFLICT;
    }
    return USERNAME_RETRY_STORE_UNAVAILABLE;
  }
}
