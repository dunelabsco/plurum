import {
  setupDisplayText,
  type SetupCommandPreview,
  type SetupDryRunPreflight,
  type SetupHostPreview,
  type SetupMutationPreview,
} from "./setup-preflight.js";
import {
  publicSetupApplyPreview,
  type SetupApplyPlan,
  type SetupApplyPreview,
} from "./setup-apply-plan.js";
import type { SetupPreparedPlan } from "./setup-approval.js";

const MAX_PREFLIGHT_OUTPUT_BYTES = 256 * 1024;
const UTF8_ENCODER = new TextEncoder();

function quoted(value: string): string {
  return JSON.stringify(setupDisplayText(value));
}

function command(value: SetupCommandPreview): string {
  setupDisplayText(value.executable);
  for (const argument of value.arguments) {
    setupDisplayText(argument);
  }
  return JSON.stringify({
    executable: value.executable,
    arguments: value.arguments,
    shell: value.shell,
    scope: value.scope,
  });
}

function stringArray(values: readonly string[]): string {
  return JSON.stringify(
    values.map((value) => setupDisplayText(value)),
  );
}

function appendHosts(
  lines: string[],
  hosts: readonly SetupHostPreview[],
  mutations: readonly SetupMutationPreview[],
): void {
  for (const host of hosts) {
    lines.push(
      `  ${host.client}:`,
      `    status: ${host.classification}`,
      `    detected version: ${
        host.detectedVersion === null
          ? "not available"
          : quoted(host.detectedVersion)
      }`,
      `    minimum version: ${quoted(host.minimumVersion)}`,
    );
    if (host.executable === null) {
      lines.push("    executable: not available");
    } else {
      lines.push(
        `    discovered path: ${quoted(host.executable.sourcePath)}`,
        `    resolved path: ${quoted(host.executable.resolvedPath)}`,
        `    launch executable: ${quoted(host.executable.launchExecutable)}`,
        `    launch argument prefix: ${stringArray(host.executable.argumentPrefix)}`,
        "    shell: false",
      );
    }
    lines.push(
      `    marketplace: ${quoted(host.desired.marketplace.source)}`,
      `    plugin: ${quoted(host.desired.plugin.source)}`,
      `    plugin version: ${quoted(host.desired.plugin.version)}`,
      `    compatible plugin range: ${quoted(
        `${host.desired.plugin.compatibleMinimum} <= version < ${host.desired.plugin.compatibleMaximumExclusive}`,
      )}`,
      `    plugin MCP: ${quoted(host.desired.mcp.endpoint)}`,
      `    explanation: ${quoted(host.explanation)}`,
    );

    const hostMutations = mutations.filter(
      ({ client }) => client === host.client,
    );
    if (hostMutations.length === 0) {
      lines.push("    mutations: none");
    } else {
      lines.push(
        "    mutations (apply in listed order; rollback in reverse order):",
      );
      for (const mutation of hostMutations) {
        lines.push(
          `      - ${setupDisplayText(mutation.id, 256)}: ${quoted(mutation.description)}`,
          `        apply: ${command(mutation.apply)}`,
          `        rollback (${setupDisplayText(mutation.rollbackKind, 128)}): ${command(mutation.rollback)}`,
        );
      }
    }
  }
}

function boundedOutput(lines: readonly string[]): string {
  const output = lines.join("\n");
  if (UTF8_ENCODER.encode(output).byteLength > MAX_PREFLIGHT_OUTPUT_BYTES) {
    throw new Error("Setup plan output exceeded its safe bound.");
  }
  return output;
}

export function renderSetupDryRunPreflight(
  result: SetupDryRunPreflight,
): string {
  const lines = [
    "Plurum setup preflight",
    "",
    `mode: ${result.mode}`,
    `requested client: ${quoted(result.requestedTarget)}`,
    `selected clients: ${JSON.stringify(result.selectedClients)}`,
    `api origin: ${quoted(result.services.apiOrigin)}`,
    `mcp endpoint: ${quoted(result.services.mcpEndpoint)}`,
    "credential: not inspected (dry-run)",
    "",
    "credential destinations for a future confirmed setup:",
  ];

  for (const destination of result.destinations) {
    lines.push(
      `  - ${destination.kind} (${destination.futureEffect}): ${quoted(destination.path)}`,
    );
  }

  lines.push("", "clients:");
  appendHosts(lines, result.hosts, result.mutations);

  lines.push(
    "",
    `readiness: ${result.readiness}`,
    "confirmation: not requested for dry-run; apply requires confirmation",
    "No changes were made.",
    "",
  );
  return boundedOutput(lines);
}

function appendCredential(
  lines: string[],
  credential: SetupApplyPreview["credential"],
): void {
  const resolution = credential.resolution;
  lines.push(
    "credential:",
    "  status: resolved",
    `  destination: ${quoted(credential.destination)}`,
    `  disposition: ${setupDisplayText(resolution.disposition, 128)}`,
    `  acquisition: ${setupDisplayText(resolution.acquisition, 128)}`,
    `  canonical effect: ${setupDisplayText(resolution.canonicalEffect, 128)}`,
    `  reason: ${setupDisplayText(resolution.reason, 128)}`,
    `  api origin: ${quoted(resolution.apiOrigin)}`,
    `  invalid sources: ${stringArray(resolution.invalidSources)}`,
  );

  if (resolution.acquisition === "existing") {
    lines.push(
      `  selection: ${quoted(resolution.credential.selectionId)}`,
      `  fingerprint: ${quoted(resolution.credential.fingerprint)}`,
      `  sources: ${stringArray(resolution.credential.sources)}`,
      `  agent id: ${quoted(resolution.credential.agent.id)}`,
      `  agent name: ${quoted(resolution.credential.agent.name)}`,
      `  username: ${
        resolution.credential.agent.username === null
          ? "not set"
          : quoted(resolution.credential.agent.username)
      }`,
    );
  } else {
    lines.push(
      `  registration mode: ${setupDisplayText(resolution.registration.mode, 128)}`,
      `  agent name: ${quoted(resolution.registration.agent.name)}`,
      `  username: ${quoted(resolution.registration.agent.username)}`,
    );
    if (resolution.acquisition === "resume-registration") {
      lines.push(
        `  next step: ${setupDisplayText(resolution.registration.nextStep, 128)}`,
        `  fingerprint: ${quoted(resolution.registration.fingerprint)}`,
        `  sources: ${stringArray(resolution.registration.sources)}`,
      );
    }
  }

  if (credential.codexProjection !== null) {
    lines.push(
      "codex credential projection:",
      `  method: ${setupDisplayText(credential.codexProjection.method, 128)}`,
      `  effect: ${setupDisplayText(credential.codexProjection.effect, 128)}`,
      `  reason: ${setupDisplayText(credential.codexProjection.reason, 128)}`,
      `  disclosure: ${quoted(credential.codexProjection.disclosure)}`,
    );
  }
}

/* Render only the public preview of the exact authority-prepared plan. */
export function renderSetupApplyPlan(
  plan: SetupPreparedPlan<SetupApplyPlan>,
): string {
  const preview = publicSetupApplyPreview(plan);
  const lines = [
    "Plurum setup plan",
    "",
    `mode: ${preview.mode}`,
    `requested client: ${quoted(preview.requestedTarget)}`,
    `selected clients: ${stringArray(preview.selectedClients)}`,
    `api origin: ${quoted(preview.services.apiOrigin)}`,
    `mcp endpoint: ${quoted(preview.services.mcpEndpoint)}`,
    "",
  ];
  appendCredential(lines, preview.credential);

  lines.push("", "execution locations:");
  for (const location of preview.paths) {
    lines.push(
      `  - ${setupDisplayText(location.kind, 128)}: ${quoted(location.path)}`,
    );
  }

  lines.push("", "clients:");
  appendHosts(lines, preview.hosts, preview.mutations);
  lines.push(
    "",
    `readiness: ${preview.readiness}`,
    preview.confirmation === "required"
      ? "confirmation: required before any change"
      : "confirmation: not required; this plan has no changes",
    "No changes have been made.",
    "",
  );
  return boundedOutput(lines);
}
