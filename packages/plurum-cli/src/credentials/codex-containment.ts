import type { HostConfiguration } from "../hosts/contracts.js";
import type { PlurumMcpToolName } from "../hosts/mcp-verification.js";
import {
  containsHostControlCharacter,
  containsHostSensitiveMaterial,
} from "../hosts/privacy.js";

export const CODEX_CREDENTIAL_CONTAINMENT_ARCHITECTURE =
  "dotenv-bearer-token-env-var" as const;

export interface CodexCredentialContainmentRequest {
  readonly host: "codex";
  readonly scope: "user";
  readonly architecture: typeof CODEX_CREDENTIAL_CONTAINMENT_ARCHITECTURE;
  readonly endpoint: string;
  readonly executableRevision: string;
  readonly expectedConfiguration: HostConfiguration;
  readonly expectedTools: readonly PlurumMcpToolName[];
  readonly excludedProjectDirectory: string;
}

export type CodexCredentialContainmentObservation =
  | Readonly<{
      readonly status: "accepted";
      /*
       * Opaque, non-secret revision of the reviewed native containment policy
       * and lifecycle matrix. Portable orchestration only validates its safe
       * shape; production decides what exact evidence may mint it.
       */
      readonly decisionRevision: string;
    }>
  | Readonly<{ readonly status: "rejected" }>
  | Readonly<{ readonly status: "unavailable" }>;

/*
 * No production implementation is wired while the Codex containment release
 * gate is open. A future native implementation must revalidate current Codex
 * behavior immediately before any credential projection or plugin mutation.
 */
export interface CodexCredentialContainmentAdapter {
  revalidate(
    request: CodexCredentialContainmentRequest,
  ): Promise<CodexCredentialContainmentObservation>;
}

export type CodexCredentialContainmentResult =
  | Readonly<{
      readonly status: "accepted";
      readonly decisionRevision: string;
    }>
  | Readonly<{
      readonly status: "blocked";
      readonly reason: "rejected" | "unavailable";
    }>;

const SAFE_REVISION = /^[A-Za-z0-9._~:+@=-]{1,512}$/u;
const REJECTED = Object.freeze({
  status: "blocked" as const,
  reason: "rejected" as const,
});
const UNAVAILABLE = Object.freeze({
  status: "blocked" as const,
  reason: "unavailable" as const,
});

function snapshotObservation(
  value: unknown,
): CodexCredentialContainmentObservation | undefined {
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
    if (
      (status.value === "rejected" || status.value === "unavailable") &&
      names.length === 1
    ) {
      return Object.freeze({ status: status.value });
    }
    if (
      status.value !== "accepted" ||
      names.length !== 2 ||
      !names.includes("decisionRevision")
    ) {
      return undefined;
    }
    const revision = Object.getOwnPropertyDescriptor(
      value,
      "decisionRevision",
    );
    if (
      revision === undefined ||
      !Object.hasOwn(revision, "value") ||
      revision.enumerable !== true ||
      revision.get !== undefined ||
      revision.set !== undefined
    ) {
      return undefined;
    }
    return Object.freeze({
      status: "accepted" as const,
      decisionRevision: revision.value as string,
    });
  } catch {
    return undefined;
  }
}

export async function revalidateCodexCredentialContainment(
  adapter: CodexCredentialContainmentAdapter,
  request: CodexCredentialContainmentRequest,
): Promise<CodexCredentialContainmentResult> {
  let rawObservation: unknown;
  try {
    rawObservation = await adapter.revalidate(request);
  } catch {
    return UNAVAILABLE;
  }
  const observation = snapshotObservation(rawObservation);
  if (observation?.status === "rejected") {
    return REJECTED;
  }
  if (
    observation?.status !== "accepted" ||
    typeof observation.decisionRevision !== "string" ||
    !SAFE_REVISION.test(observation.decisionRevision) ||
    containsHostControlCharacter(observation.decisionRevision) ||
    containsHostSensitiveMaterial(observation.decisionRevision)
  ) {
    return UNAVAILABLE;
  }
  return Object.freeze({
    status: "accepted" as const,
    decisionRevision: observation.decisionRevision,
  });
}
