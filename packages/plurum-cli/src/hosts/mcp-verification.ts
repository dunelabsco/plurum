import type {
  HostConfiguration,
  HostId,
} from "./contracts.js";
import {
  containsHostControlCharacter,
  containsHostSensitiveMaterial,
} from "./privacy.js";

export const PLURUM_MCP_TOOL_NAMES = Object.freeze([
  "plurum_search",
  "plurum_get_experience",
  "plurum_get_artifact",
  "plurum_publish",
  "plurum_report_outcome",
  "plurum_archive",
  "plurum_vote",
] as const);

export type PlurumMcpToolName =
  (typeof PLURUM_MCP_TOOL_NAMES)[number];

export interface HostMcpVerificationRequest {
  readonly host: HostId;
  readonly scope: "user";
  readonly endpoint: string;
  readonly executableRevision: string;
  readonly expectedStateRevision: string;
  readonly expectedConfiguration: HostConfiguration;
  readonly expectedTools: readonly PlurumMcpToolName[];
  readonly expectedAgentId: string;
  readonly excludedProjectDirectory: string;
}

export type HostMcpVerificationObservation =
  | Readonly<{
      readonly status: "initialized";
      readonly tools: readonly string[];
      /* Derived from the same authenticated MCP exchange as initialize and
       * tools/list, never from a separate REST request or caller assertion. */
      readonly authenticatedAgentId: string;
    }>
  | Readonly<{ readonly status: "unavailable" }>;

/*
 * The native verifier owns host-session startup, bounded output, strict MCP
 * initialization, authentication, and tools/list parsing. It receives no
 * credential: each host must use only its already-approved user configuration.
 */
export interface HostMcpVerificationAdapter {
  verify(
    request: HostMcpVerificationRequest,
  ): Promise<HostMcpVerificationObservation>;
}

export type HostMcpVerificationResult =
  | Readonly<{ readonly status: "verified" }>
  | Readonly<{
      readonly status: "failed";
      readonly reason:
        | "initialization-unavailable"
        | "agent-identity-mismatch"
        | "unexpected-tool-inventory";
    }>;

const INITIALIZATION_UNAVAILABLE = Object.freeze({
  status: "failed" as const,
  reason: "initialization-unavailable" as const,
});
const UNEXPECTED_TOOL_INVENTORY = Object.freeze({
  status: "failed" as const,
  reason: "unexpected-tool-inventory" as const,
});
const AGENT_IDENTITY_MISMATCH = Object.freeze({
  status: "failed" as const,
  reason: "agent-identity-mismatch" as const,
});
const VERIFIED = Object.freeze({ status: "verified" as const });
const MAX_TOOL_NAME_CHARACTERS = 128;
const AGENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function exactInventory(value: unknown): boolean {
  let names: readonly string[];
  try {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0
    ) {
      return false;
    }
    const properties = Object.getOwnPropertyNames(value);
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (
      length === undefined ||
      !Object.hasOwn(length, "value") ||
      length.value !== PLURUM_MCP_TOOL_NAMES.length ||
      properties.length !== PLURUM_MCP_TOOL_NAMES.length + 1
    ) {
      return false;
    }
    const copied: string[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(
        value,
        String(index),
      );
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        return false;
      }
      copied.push(descriptor.value as string);
    }
    names = copied;
  } catch {
    return false;
  }
  const unique = new Set<string>();
  for (const entry of names) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > MAX_TOOL_NAME_CHARACTERS ||
      containsHostControlCharacter(entry) ||
      containsHostSensitiveMaterial(entry)
    ) {
      return false;
    }
    unique.add(entry);
  }
  return (
    unique.size === PLURUM_MCP_TOOL_NAMES.length &&
    PLURUM_MCP_TOOL_NAMES.every((name) => unique.has(name))
  );
}

function snapshotObservation(
  value: unknown,
): HostMcpVerificationObservation | undefined {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0
    ) {
      return undefined;
    }
    const names = Object.getOwnPropertyNames(value);
    const status = Object.getOwnPropertyDescriptor(value, "status");
    if (
      status === undefined ||
      !Object.hasOwn(status, "value") ||
      status.enumerable !== true ||
      status.get !== undefined ||
      status.set !== undefined
    ) {
      return undefined;
    }
    if (status.value === "unavailable" && names.length === 1) {
      return Object.freeze({ status: "unavailable" as const });
    }
    if (
      status.value !== "initialized" ||
      names.length !== 3 ||
      !names.includes("tools") ||
      !names.includes("authenticatedAgentId")
    ) {
      return undefined;
    }
    const tools = Object.getOwnPropertyDescriptor(value, "tools");
    const authenticatedAgentId = Object.getOwnPropertyDescriptor(
      value,
      "authenticatedAgentId",
    );
    if (
      tools === undefined ||
      !Object.hasOwn(tools, "value") ||
      tools.enumerable !== true ||
      tools.get !== undefined ||
      tools.set !== undefined ||
      authenticatedAgentId === undefined ||
      !Object.hasOwn(authenticatedAgentId, "value") ||
      authenticatedAgentId.enumerable !== true ||
      authenticatedAgentId.get !== undefined ||
      authenticatedAgentId.set !== undefined ||
      typeof authenticatedAgentId.value !== "string" ||
      !AGENT_ID.test(authenticatedAgentId.value)
    ) {
      return undefined;
    }
    return Object.freeze({
      status: "initialized" as const,
      tools: tools.value as readonly string[],
      authenticatedAgentId: authenticatedAgentId.value,
    });
  } catch {
    return undefined;
  }
}

/*
 * Portable orchestration validates the exact inventory itself. A verifier may
 * never turn a successful initialization with extra, missing, duplicated, or
 * malformed tools into setup success.
 */
export async function verifyHostMcpInventory(
  adapter: HostMcpVerificationAdapter,
  request: HostMcpVerificationRequest,
): Promise<HostMcpVerificationResult> {
  let rawObservation: unknown;
  try {
    rawObservation = await adapter.verify(request);
  } catch {
    return INITIALIZATION_UNAVAILABLE;
  }
  const observation = snapshotObservation(rawObservation);
  if (
    observation === undefined ||
    observation.status !== "initialized"
  ) {
    return INITIALIZATION_UNAVAILABLE;
  }
  if (
    typeof request.expectedAgentId !== "string" ||
    !AGENT_ID.test(request.expectedAgentId) ||
    observation.authenticatedAgentId !== request.expectedAgentId
  ) {
    return AGENT_IDENTITY_MISMATCH;
  }
  return exactInventory(observation.tools)
    ? VERIFIED
    : UNEXPECTED_TOOL_INVENTORY;
}
