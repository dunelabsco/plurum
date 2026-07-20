import {
  setupDisplayText,
  type SetupCommandPreview,
  type SetupDryRunPreflight,
} from "./setup-preflight.js";

const MAX_PREFLIGHT_OUTPUT_CHARACTERS = 256 * 1024;

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
  for (const host of result.hosts) {
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
        `    launch argument prefix: ${JSON.stringify(host.executable.argumentPrefix)}`,
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

    const mutations = result.mutations.filter(
      ({ client }) => client === host.client,
    );
    if (mutations.length === 0) {
      lines.push("    mutations: none");
    } else {
      lines.push(
        "    mutations (apply in listed order; rollback in reverse order):",
      );
      for (const mutation of mutations) {
        lines.push(
          `      - ${mutation.id}: ${quoted(mutation.description)}`,
          `        apply: ${command(mutation.apply)}`,
          `        rollback (${mutation.rollbackKind}): ${command(mutation.rollback)}`,
        );
      }
    }
  }

  lines.push(
    "",
    `readiness: ${result.readiness}`,
    "confirmation: not requested for dry-run; apply requires confirmation",
    "No changes were made.",
    "",
  );
  const output = lines.join("\n");
  if (output.length > MAX_PREFLIGHT_OUTPUT_CHARACTERS) {
    throw new Error("Setup preflight output exceeded its safe bound.");
  }
  return output;
}
