import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parseAst } from "rolldown/parseAst";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoot = join(packageRoot, "src");

const allowedExternalImports = new Map([
  ["src/cli.ts", new Map([["node:util", ["parseArgs"]]])],
  [
    "src/adapters/node/random.ts",
    new Map([["node:crypto", ["randomBytes", "randomUUID"]]]),
  ],
  [
    "src/adapters/node/hash.ts",
    new Map([["node:crypto", ["createHash"]]]),
  ],
  [
    "src/adapters/node/network.ts",
    new Map([["node:timers", ["clearTimeout", "setTimeout"]]]),
  ],
  [
    "src/adapters/node/setup-interaction.ts",
    new Map([["node:timers", ["setImmediate"]]]),
  ],
  [
    "src/adapters/node/setup-credential-input.ts",
    new Map([["node:timers", ["setImmediate"]]]),
  ],
  [
    "src/adapters/node/credential-environment.ts",
    new Map([["node:process", ["default:process"]]]),
  ],
  [
    "src/adapters/node/platform.ts",
    new Map([
      ["node:path", ["posix", "win32"]],
      ["node:process", ["default:process"]],
    ]),
  ],
]);

const allowedProcessMembers = new Map([
  [
    "src/adapters/node/process-runtime.ts",
    new Set(["stdin", "stdout", "stderr"]),
  ],
  ["src/index.ts", new Set(["argv", "exitCode", "stderr"])],
  ["src/adapters/node/credential-environment.ts", new Set(["env"])],
  [
    "src/adapters/node/platform.ts",
    new Set([
      "platform",
      "arch",
      "cwd",
      "env",
      "getuid",
      "geteuid",
      "getgid",
      "getegid",
      "getgroups",
    ]),
  ],
]);

const reservedGlobals = new Map([
  ["require", "commonjs-require"],
  ["module", "commonjs-require"],
  ["createRequire", "commonjs-require"],
  ["fetch", "network-global"],
  ["WebSocket", "network-global"],
  ["EventSource", "network-global"],
  ["crypto", "random-global"],
  ["setTimeout", "timer-global"],
  ["setInterval", "timer-global"],
  ["setImmediate", "timer-global"],
  ["queueMicrotask", "timer-global"],
  ["Function", "dynamic-code"],
  ["eval", "dynamic-code"],
  ["Reflect", "dynamic-code"],
  ["Bun", "runtime-global"],
  ["Deno", "runtime-global"],
  ["console", "diagnostic-global"],
]);
const unwiredNativeBoundaryStem =
  "src/adapters/node/native-credential-store";
const codexCredentialBoundaryStem = "src/credentials/codex-dotenv";
const exactCodexCredentialBoundaryImports = new Map([
  [
    "src/commands/setup-host-execution.ts",
    new Map([
      [
        "src/credentials/codex-dotenv-contracts.js",
        [
          "type:CodexDotenvProjectionAdapter",
          "type:CodexDotenvProjectionIdentity",
        ],
      ],
      [
        "src/credentials/codex-dotenv-projection.js",
        ["isOwnedCodexDotenvProjectionAdapter"],
      ],
    ]),
  ],
  [
    "src/commands/status-observation.ts",
    new Map([
      [
        "src/credentials/codex-dotenv-status.js",
        [
          "observeCodexDotenvStatus",
          "type:CodexDotenvStatusObservationAdapter",
        ],
      ],
    ]),
  ],
]);
const exactHostExecutionDisplayImports = new Map([
  ["src/commands/setup-display.js", ["setupDisplayText"]],
]);
const diagnosticReadOnlyFiles = new Set([
  "src/hosts/status.ts",
  "src/api/reachability.ts",
  "src/credentials/codex-dotenv-status.ts",
  "src/system/runtime-support.ts",
]);
const diagnosticReflectionMembers = new Map([
  ["src/api/reachability.ts", new Set(["ownKeys"])],
  ["src/commands/doctor-output.ts", new Set(["ownKeys"])],
  ["src/credentials/codex-dotenv-status.ts", new Set(["ownKeys"])],
  ["src/system/runtime-support.ts", new Set(["apply", "ownKeys"])],
]);
const diagnosticForbiddenModuleStems = Object.freeze([
  "src/api/agent-registration",
  "src/api/agent-username",
  "src/credentials/codex-containment",
  "src/credentials/codex-dotenv-projection",
  "src/credentials/codex-dotenv-setup-observation",
  "src/credentials/store-mutation-contracts",
  "src/credentials/store-observer",
  "src/credentials/store-transaction",
  "src/credentials/store-writer",
  "src/hosts/claude-code/adapter",
  "src/hosts/claude-code/commands",
  "src/hosts/codex/adapter",
  "src/hosts/codex/commands",
  "src/hosts/mcp-verification",
  "src/hosts/process-policy",
  "src/hosts/reconciler",
  "src/system/host-mutation-boundary",
]);
const diagnosticForbiddenSystemContractBindings = new Set([
  "DirectoryHandleAdapter",
  "FileSystemAdapter",
  "HostCapabilities",
  "NetworkAdapter",
  "NetworkRequest",
  "PlanningCapabilities",
  "ProcessAdapter",
  "ProcessRequest",
  "ProcessResult",
  "RandomAdapter",
  "SetupCapabilities",
  "SetupPreflightCapabilities",
  "SystemCapabilities",
  "WritableFileHandleAdapter",
]);
const diagnosticForbiddenHostContractBindings = new Set([
  "HostAction",
  "HostActionKind",
  "HostApplyRequest",
  "HostMutationAdapter",
  "HostMutationResult",
  "HostRollbackRecipe",
  "HostRollbackRequest",
  "ReconciliationPlan",
]);
const exactStatusCodexContractImports = Object.freeze([
  "CODEX_DOTENV_PROJECTION_STATUSES",
  "type:CodexDotenvProjectionStatus",
]);
const exactDiagnosticRuntimeImports = Object.freeze([
  "type:DiagnosticRuntime",
]);
const exactDoctorReviewedImports = new Map([
  [
    "src/commands/doctor-observation.ts",
    new Map([
      [
        "src/commands/status-observation.js",
        ["observeStatus", "type:StatusObservationDependencies"],
      ],
      [
        "src/api/reachability.js",
        [
          "probeMcpAuthenticationBoundary",
          "type:McpAuthenticationBoundaryResult",
        ],
      ],
      [
        "src/system/runtime-support.js",
        [
          "observeRuntimePlatformSupport",
          "type:RuntimePlatformSupportResult",
          "type:RuntimeSupportObservationAdapter",
        ],
      ],
      [
        "src/hosts/claude-code/configuration.js",
        ["CLAUDE_CODE_PLUGIN_VERSION"],
      ],
      [
        "src/hosts/codex/configuration.js",
        ["CODEX_PLUGIN_VERSION"],
      ],
      [
        "src/hosts/contracts.js",
        ["HOST_IDS", "type:HostId"],
      ],
      [
        "src/hosts/version.js",
        ["compareCanonicalVersions"],
      ],
      [
        "src/commands/status-contracts.js",
        ["type:StatusReportV1"],
      ],
    ]),
  ],
  [
    "src/commands/doctor-contracts.ts",
    new Map([
      [
        "src/commands/status-contracts.js",
        ["type:StatusJsonSuccessEnvelope", "type:StatusReportV1"],
      ],
      [
        "src/api/reachability.js",
        ["type:McpAuthenticationBoundaryResult"],
      ],
      [
        "src/system/runtime-support.js",
        ["type:RuntimePlatformSupportResult"],
      ],
      [
        "src/hosts/contracts.js",
        ["type:HostId"],
      ],
    ]),
  ],
  [
    "src/commands/doctor-output.ts",
    new Map([
      [
        "src/commands/status-output.js",
        ["createStatusJsonEnvelope"],
      ],
      [
        "src/system/runtime-support.js",
        [
          "RECOGNIZED_RUNTIME_TARGETS",
          "RELEASED_RUNTIME_TARGETS",
          "type:ReleasedRuntimePlatformTarget",
          "type:RuntimePlatformTarget",
        ],
      ],
      [
        "src/hosts/claude-code/configuration.js",
        [
          "CLAUDE_CODE_MINIMUM_VERSION",
          "CLAUDE_CODE_PLUGIN_COMPATIBLE_MAXIMUM_EXCLUSIVE",
          "CLAUDE_CODE_PLUGIN_VERSION",
        ],
      ],
      [
        "src/hosts/codex/configuration.js",
        [
          "CODEX_MINIMUM_VERSION",
          "CODEX_PLUGIN_COMPATIBLE_MAXIMUM_EXCLUSIVE",
          "CODEX_PLUGIN_VERSION",
        ],
      ],
      [
        "src/hosts/version.js",
        ["compareCanonicalVersions"],
      ],
    ]),
  ],
]);
const exactDiagnosticHelperImports = new Map([
  [
    "src/api/reachability.ts",
    new Map([
      [
        "src/credentials/origin.js",
        ["normalizeApiOrigin", "type:ApiOrigin", "type:ApiOriginPolicy"],
      ],
      [
        "src/data/strict-json-object.js",
        ["parseStrictJsonObject"],
      ],
      [
        "src/data/uint8-array.js",
        ["copyUint8Array", "intrinsicUint8ArrayByteLength"],
      ],
      [
        "src/system/contracts.js",
        ["type:ReadOnlyNetworkAdapter", "type:ReadOnlyNetworkRequest"],
      ],
    ]),
  ],
  ["src/system/runtime-support.ts", new Map()],
]);
const sourceModuleExtensions = Object.freeze([
  "",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);
const restrictedCapabilityImports = Object.freeze([
  Object.freeze({
    module: "src/commands/setup-approval",
    binding: "mintSetupApproval",
    allowedFiles: new Set(["src/commands/setup-confirmation.ts"]),
  }),
  Object.freeze({
    module: "src/commands/setup-execution-authority",
    binding: "claimSetupExecutionSidecar",
    allowedFiles: new Set(["src/commands/setup-confirmation.ts"]),
  }),
  Object.freeze({
    module: "src/commands/setup-execution-authority",
    binding: "claimSetupExecutionGrant",
    allowedFiles: new Set([
      "src/commands/setup-registration-execution.ts",
    ]),
  }),
  Object.freeze({
    module: "src/commands/setup-confirmation",
    binding: "createSetupConfirmationAttempt",
    allowedFiles: new Set([
      "src/credentials/codex-dotenv-setup-observation.ts",
    ]),
  }),
  Object.freeze({
    module: "src/commands/setup-confirmation",
    binding: "createSetupInputFreePlanPresenter",
    allowedFiles: new Set([
      "src/adapters/node/setup-interaction.ts",
    ]),
  }),
  Object.freeze({
    module: "src/commands/setup-confirmation",
    binding: "createSetupInteractiveSessionPorts",
    allowedFiles: new Set([
      "src/adapters/node/setup-credential-input.ts",
      "src/adapters/node/setup-interaction.ts",
    ]),
  }),
  Object.freeze({
    module: "src/commands/setup-credential-input",
    binding: "retainFramedSetupCredentialInput",
    allowedFiles: new Set([
      "src/adapters/node/setup-credential-input.ts",
    ]),
  }),
  Object.freeze({
    module: "src/commands/setup-credential-input",
    binding: "claimSetupCredentialInputBytes",
    allowedFiles: new Set([
      "src/commands/setup-registration-execution.ts",
    ]),
  }),
  Object.freeze({
    module: "src/commands/setup-registration-execution",
    binding: "transferSetupProtectedCredentialInput",
    allowedFiles: new Set([
      "src/credentials/codex-dotenv-setup-observation.ts",
    ]),
  }),
  Object.freeze({
    module: "src/commands/setup-registration-execution",
    binding: "claimSetupUsernameConflictContinuation",
    allowedFiles: new Set([
      "src/credentials/codex-dotenv-setup-observation.ts",
    ]),
  }),
  Object.freeze({
    module: "src/commands/setup-registration-execution",
    binding: "discardSetupUsernameConflictContinuation",
    allowedFiles: new Set([
      "src/credentials/codex-dotenv-setup-observation.ts",
    ]),
  }),
  Object.freeze({
    module: "src/commands/setup-secret-lease",
    binding: "createSetupSecretLease",
    allowedFiles: new Set([
      "src/commands/setup-registration-execution.ts",
    ]),
  }),
  Object.freeze({
    module: "src/commands/setup-secret-lease",
    binding: "copySetupSecretLeaseBytes",
    allowedFiles: new Set([
      "src/credentials/codex-dotenv-setup-observation.ts",
    ]),
  }),
  Object.freeze({
    module: "src/commands/setup-secret-lease",
    binding: "claimSetupSecretLeaseBytes",
    allowedFiles: new Set([
      "src/commands/setup-registration-execution.ts",
    ]),
  }),
  Object.freeze({
    module: "src/commands/setup-secret-lease",
    binding: "discardSetupSecretLease",
    allowedFiles: new Set([
      "src/commands/setup-execution-authority.ts",
      "src/commands/setup-registration-execution.ts",
      "src/credentials/codex-dotenv-setup-observation.ts",
    ]),
  }),
  Object.freeze({
    module: "src/commands/setup-secret-lease",
    binding: "isOwnedSetupSecretLease",
    allowedFiles: new Set([
      "src/commands/setup-execution-authority.ts",
      "src/credentials/codex-dotenv-setup-observation.ts",
    ]),
  }),
  Object.freeze({
    module: "src/commands/setup-registration-execution",
    binding: "createSetupRegistrationExecutionAttempt",
    allowedFiles: new Set([
      "src/credentials/codex-dotenv-setup-observation.ts",
    ]),
  }),
  Object.freeze({
    module: "src/commands/setup-registration-execution",
    binding: "claimSetupHostConfigurationGrant",
    allowedFiles: new Set([
      "src/commands/setup-host-execution.ts",
    ]),
  }),
  Object.freeze({
    module: "src/commands/setup-host-execution",
    binding: "createSetupHostExecutionAuthority",
    allowedFiles: new Set([
      "src/credentials/codex-dotenv-setup-observation.ts",
    ]),
  }),
  Object.freeze({
    module: "src/commands/setup-credential-session",
    binding: "createSetupCredentialSessionAuthority",
    allowedFiles: new Set([
      "src/credentials/codex-dotenv-setup-observation.ts",
    ]),
  }),
  Object.freeze({
    module: "src/commands/setup-credential-session",
    binding: "isOwnedSetupCredentialSessionAuthority",
    allowedFiles: new Set([
      "src/commands/setup-host-execution.ts",
      "src/credentials/codex-dotenv-setup-observation.ts",
    ]),
  }),
  Object.freeze({
    module: "src/commands/setup-preflight",
    binding: "isRetainedSetupPreflightHostAuthority",
    allowedFiles: new Set([
      "src/credentials/codex-dotenv-setup-observation.ts",
    ]),
  }),
  Object.freeze({
    module: "src/commands/setup-preflight",
    binding: "createSetupPreflightSnapshot",
    allowedFiles: new Set(),
  }),
  Object.freeze({
    module: "src/hosts/planner",
    binding: "createHostPreflightPlan",
    allowedFiles: new Set([
      "src/commands/setup-preflight.ts",
      "src/hosts/status.ts",
    ]),
  }),
  Object.freeze({
    module: "src/hosts/reconciler",
    binding: "acquireAndReconcileSelectedHostPlanSettled",
    allowedFiles: new Set([
      "src/commands/setup-host-execution.ts",
    ]),
  }),
  Object.freeze({
    module: "src/credentials/store-observer",
    binding: "claimCredentialStoreObservationEvidence",
    allowedFiles: new Set([
      "src/commands/setup-registration-execution.ts",
    ]),
  }),
  Object.freeze({
    module: "src/credentials/store-writer",
    binding: "runExclusiveObservedCredentialSetup",
    allowedFiles: new Set([
      "src/commands/setup-credential-session.ts",
      "src/commands/setup-registration-execution.ts",
    ]),
  }),
  Object.freeze({
    module: "src/adapters/node/setup-credential-input",
    binding: "createNodeSetupExplicitCredentialInput",
    allowedFiles: new Set([
      "src/adapters/node/production.ts",
    ]),
  }),
  Object.freeze({
    module: "src/adapters/node/setup-credential-input",
    binding: "createNodeSetupProtectedInteractiveSession",
    allowedFiles: new Set([
      "src/adapters/node/production.ts",
    ]),
  }),
]);

function resolvedRelativeModule(relativePath, specifier) {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  return posix.normalize(
    posix.join(posix.dirname(relativePath), specifier),
  );
}

function moduleMatchesStem(resolvedModule, stem) {
  return sourceModuleExtensions.some(
    (extension) => resolvedModule === `${stem}${extension}`,
  );
}

function isStatusDiagnosticFile(relativePath) {
  return /^src\/commands\/status(?:-[a-z0-9-]+)?\.ts$/u.test(relativePath);
}

function isDoctorDiagnosticFile(relativePath) {
  return /^src\/commands\/doctor(?:-[a-z0-9-]+)?\.ts$/u.test(relativePath);
}

function isDiagnosticReadOnlyFile(relativePath) {
  return (
    diagnosticReadOnlyFiles.has(relativePath) ||
    isStatusDiagnosticFile(relativePath) ||
    isDoctorDiagnosticFile(relativePath)
  );
}

function isDiagnosticRenderFile(relativePath) {
  return /^src\/commands\/(?:status|doctor)-(?:output|render(?:-[a-z0-9-]+)?)\.ts$/u.test(
    relativePath,
  );
}

function isDoctorPrivateModule(resolvedModule) {
  if (resolvedModule === undefined) {
    return false;
  }
  return (
    resolvedModule.startsWith("src/credentials/") ||
    resolvedModule.startsWith("src/registration/") ||
    resolvedModule.startsWith("src/api/") ||
    moduleMatchesStem(resolvedModule, "src/commands/status") ||
    resolvedModule.startsWith("src/commands/status-") ||
    (resolvedModule.startsWith("src/hosts/") &&
      ![
        "src/hosts/contracts",
        "src/hosts/privacy",
        "src/hosts/status",
      ].some((stem) => moduleMatchesStem(resolvedModule, stem))) ||
    (resolvedModule.startsWith("src/system/") &&
      !moduleMatchesStem(resolvedModule, "src/system/contracts") &&
      !moduleMatchesStem(resolvedModule, "src/system/runtime-support"))
  );
}

function isDoctorReviewedModule(resolvedModule) {
  if (resolvedModule === undefined) {
    return false;
  }
  return [
    "src/api/reachability",
    "src/commands/status-contracts",
    "src/commands/status-observation",
    "src/commands/status-output",
    "src/hosts/claude-code/configuration",
    "src/hosts/codex/configuration",
    "src/hosts/contracts",
    "src/hosts/version",
    "src/system/runtime-support",
  ].some((stem) => moduleMatchesStem(resolvedModule, stem));
}

function isDiagnosticForbiddenModule(resolvedModule) {
  if (resolvedModule === undefined) {
    return false;
  }
  return (
    resolvedModule.startsWith("src/adapters/node/") ||
    resolvedModule.startsWith("src/registration/") ||
    moduleMatchesStem(resolvedModule, "src/commands/setup") ||
    resolvedModule.startsWith("src/commands/setup-") ||
    /^src\/hosts\/journal-/u.test(resolvedModule) ||
    moduleMatchesStem(resolvedModule, "src/system/denied") ||
    moduleMatchesStem(resolvedModule, "src/system/scopes") ||
    diagnosticForbiddenModuleStems.some((stem) =>
      moduleMatchesStem(resolvedModule, stem),
    )
  );
}

function exactDoctorReviewedImport(relativePath, resolvedModule, declaration) {
  const expected = exactDoctorReviewedImports
    .get(relativePath)
    ?.get(resolvedModule);
  if (expected === undefined || declaration?.type !== "ImportDeclaration") {
    return false;
  }
  return (
    JSON.stringify(importBindings(declaration)) ===
    JSON.stringify([...expected].sort())
  );
}

function exactDiagnosticHelperImport(relativePath, resolvedModule, declaration) {
  const expected = exactDiagnosticHelperImports
    .get(relativePath)
    ?.get(resolvedModule);
  if (expected === undefined || declaration?.type !== "ImportDeclaration") {
    return false;
  }
  return (
    JSON.stringify(importBindings(declaration)) ===
    JSON.stringify([...expected].sort())
  );
}

function importedBindingName(specifier) {
  return specifier.type === "ImportSpecifier"
    ? (specifier.imported.name ?? specifier.imported.value)
    : undefined;
}

function restrictionsForModule(resolvedModule) {
  if (resolvedModule === undefined) {
    return [];
  }
  return restrictedCapabilityImports.filter(({ module }) =>
    moduleMatchesStem(resolvedModule, module),
  );
}

function isUnwiredNativeBoundaryModule(resolvedModule) {
  return sourceModuleExtensions.some(
    (extension) => resolvedModule === `${unwiredNativeBoundaryStem}${extension}`,
  );
}

function isExactRuntimeObservationReflectApply(
  relativePath,
  member,
  call,
  awaited,
  snapshot,
) {
  return (
    relativePath === "src/system/runtime-support.ts" &&
    member?.type === "MemberExpression" &&
    member.computed === false &&
    member.optional === false &&
    member.object.type === "Identifier" &&
    member.object.name === "Reflect" &&
    member.property.type === "Identifier" &&
    member.property.name === "apply" &&
    call?.type === "CallExpression" &&
    call.callee === member &&
    call.optional === false &&
    call.arguments.length === 3 &&
    call.arguments[0]?.type === "Identifier" &&
    call.arguments[0].name === "observe" &&
    call.arguments[1]?.type === "Identifier" &&
    call.arguments[1].name === "adapter" &&
    call.arguments[2]?.type === "ArrayExpression" &&
    call.arguments[2].elements.length === 0 &&
    awaited?.type === "AwaitExpression" &&
    awaited.argument === call &&
    snapshot?.type === "CallExpression" &&
    snapshot.optional === false &&
    snapshot.callee.type === "Identifier" &&
    snapshot.callee.name === "snapshotObservation" &&
    snapshot.arguments.length === 1 &&
    snapshot.arguments[0] === awaited
  );
}

function isAllowedBoundaryReflectReference(
  relativePath,
  node,
  parent,
  ancestors,
) {
  if (
    parent?.type === "MemberExpression" &&
    parent.object === node &&
    parent.computed === false &&
    parent.property.type === "Identifier" &&
    parent.property.name === "apply" &&
    relativePath === "src/system/runtime-support.ts"
  ) {
    return isExactRuntimeObservationReflectApply(
      relativePath,
      parent,
      ancestors.at(-2),
      ancestors.at(-3),
      ancestors.at(-4),
    );
  }
  const allowedMembers =
    relativePath === "src/adapters/node/native-credential-store.ts"
      ? ["apply", "ownKeys"]
      : diagnosticReflectionMembers.has(relativePath)
        ? [...diagnosticReflectionMembers.get(relativePath)]
      : [
            "src/credentials/codex-dotenv-projection.ts",
            "src/hosts/codex/adapter.ts",
            "src/hosts/codex/output.ts",
          ].includes(relativePath)
        ? ["ownKeys"]
      : relativePath === "src/data/uint8-array.ts"
        ? ["apply"]
        : [];
  return (
    node.name === "Reflect" &&
    parent?.type === "MemberExpression" &&
    parent.object === node &&
    parent.computed === false &&
    parent.optional === false &&
    parent.property.type === "Identifier" &&
    allowedMembers.includes(parent.property.name)
  );
}

function isAllowedNetworkFetchReference(
  relativePath,
  node,
  parent,
  key,
  ancestors,
) {
  const call = ancestors.at(-1);
  const declarator = ancestors.at(-2);
  const declaration = ancestors.at(-3);
  const exported = ancestors.at(-4);
  const program = ancestors.at(-5);
  return (
    relativePath === "src/adapters/node/network.ts" &&
    node.name === "fetch" &&
    key === "arguments" &&
    call === parent &&
    parent?.type === "CallExpression" &&
    parent.optional === false &&
    parent.arguments.length === 1 &&
    parent.arguments[0] === node &&
    parent.callee.type === "Identifier" &&
    parent.callee.name === "createNodeNetwork" &&
    declarator?.type === "VariableDeclarator" &&
    declarator.id.type === "Identifier" &&
    declarator.id.name === "nodeNetwork" &&
    declarator.init === parent &&
    declaration?.type === "VariableDeclaration" &&
    declaration.kind === "const" &&
    declaration.declarations.length === 1 &&
    declaration.declarations[0] === declarator &&
    exported?.type === "ExportNamedDeclaration" &&
    exported.declaration === declaration &&
    program?.type === "Program"
  );
}

function normalizedRelative(filePath) {
  return relative(packageRoot, filePath).split(sep).join("/");
}

function walkSource(directory, result = { files: [], findings: [] }) {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const target = join(directory, entry.name);
    const metadata = lstatSync(target);
    if (metadata.isSymbolicLink()) {
      result.findings.push({
        file: normalizedRelative(target),
        line: 1,
        column: 1,
        rule: "source-symlink",
        reason: "production source paths must not be symbolic links",
      });
    } else if (entry.isDirectory()) {
      walkSource(target, result);
    } else if (/\.(?:ts|tsx|mts|cts)$/u.test(entry.name)) {
      const relativeTarget = normalizedRelative(target);
      if (relativeTarget !== relativeTarget.toLowerCase()) {
        result.findings.push({
          file: relativeTarget,
          line: 1,
          column: 1,
          rule: "source-casing",
          reason: "production source paths must use canonical lowercase casing",
        });
      }
      result.files.push(target);
    }
  }
  return result;
}

function isExternalSpecifier(specifier) {
  return !specifier.startsWith(".") && !specifier.startsWith("/");
}

function importBindings(node) {
  if (node.specifiers.length === 0) {
    return ["side-effect"];
  }
  return node.specifiers
    .map((specifier) => {
      if (specifier.type === "ImportDefaultSpecifier") {
        return `default:${specifier.local.name}`;
      }
      if (specifier.type === "ImportNamespaceSpecifier") {
        return `namespace:${specifier.local.name}`;
      }
      const imported = specifier.imported.name ?? specifier.imported.value;
      const typeOnly =
        node.importKind === "type" || specifier.importKind === "type";
      return typeOnly ? `type:${imported}` : imported;
    })
    .sort();
}

function isTypeOnlyImport(node) {
  return (
    node.importKind === "type" ||
    (node.specifiers.length > 0 &&
      node.specifiers.every(
        (specifier) =>
          specifier.type === "ImportSpecifier" && specifier.importKind === "type",
      ))
  );
}

function isNode(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.type === "string" &&
    Number.isInteger(value.start)
  );
}

function isIdentifierReference(node, parent, key) {
  if (parent === undefined) {
    return true;
  }
  if (parent.type === "MemberExpression" && key === "property" && !parent.computed) {
    return false;
  }
  if (
    [
      "ImportSpecifier",
      "ImportDefaultSpecifier",
      "ImportNamespaceSpecifier",
      "ExportSpecifier",
      "TSTypeReference",
      "TSQualifiedName",
    ].includes(parent.type)
  ) {
    return false;
  }
  if (
    [
      "VariableDeclarator",
      "FunctionDeclaration",
      "FunctionExpression",
      "ClassDeclaration",
      "ClassExpression",
      "TSInterfaceDeclaration",
      "TSTypeAliasDeclaration",
      "TSModuleDeclaration",
    ].includes(parent.type) &&
    (key === "id" || key === "name")
  ) {
    return false;
  }
  if (
    [
      "Property",
      "MethodDefinition",
      "PropertyDefinition",
      "TSPropertySignature",
      "TSMethodSignature",
    ].includes(parent.type) &&
    key === "key" &&
    !parent.computed
  ) {
    return false;
  }
  return true;
}

function scanText(relativePath, text) {
  let program;
  try {
    program = parseAst(text, { lang: "ts" }, relativePath);
  } catch {
    return [
      {
        file: relativePath,
        line: 1,
        column: 1,
        rule: "parse-error",
        reason: "production source must be parseable by the capability verifier",
      },
    ];
  }

  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      lineStarts.push(index + 1);
    }
  }
  const findings = [];
  const seen = new Set();
  const restrictedLocalBindings = new Map();
  const doctorReviewedLocalBindings = new Set();

  function location(offset) {
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (lineStarts[middle] <= offset) {
        low = middle;
      } else {
        high = middle;
      }
    }
    return { line: low + 1, column: offset - lineStarts[low] + 1 };
  }

  function report(node, rule, reason) {
    const position = location(node.start);
    const key = `${position.line}:${position.column}:${rule}:${reason}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    findings.push({ file: relativePath, ...position, rule, reason });
  }

  function validateRestrictedImport(node) {
    const restrictions = restrictionsForModule(
      resolvedRelativeModule(relativePath, node.source.value),
    );
    if (restrictions.length === 0 || node.importKind === "type") {
      return;
    }
    for (const specifier of node.specifiers) {
      if (specifier.type === "ImportNamespaceSpecifier") {
        report(
          specifier,
          "setup-authorization-boundary",
          "authorization capabilities require exact reviewed imports",
        );
        continue;
      }
      if (
        specifier.type !== "ImportSpecifier" ||
        specifier.importKind === "type"
      ) {
        continue;
      }
      const imported =
        specifier.imported.name ?? specifier.imported.value;
      const restriction = restrictions.find(
        ({ binding }) => binding === imported,
      );
      if (restriction === undefined) {
        continue;
      }
      if (!restriction.allowedFiles.has(relativePath)) {
        report(
          specifier,
          "setup-authorization-boundary",
          "authorization capabilities may only enter their exact reviewed composition boundary",
        );
      } else {
        restrictedLocalBindings.set(specifier.local.name, restriction);
      }
    }
  }

  function validateRestrictedReexport(node) {
    if (node.source === null || node.source === undefined) {
      if (node.type === "ExportNamedDeclaration") {
        for (const specifier of node.specifiers) {
          if (
            specifier.exportKind !== "type" &&
            restrictedLocalBindings.has(specifier.local.name)
          ) {
            report(
              specifier,
              "setup-authorization-boundary",
              "authorization capabilities must not be re-exported",
            );
          }
        }
      }
      return;
    }
    const restrictions = restrictionsForModule(
      resolvedRelativeModule(relativePath, node.source.value),
    );
    if (restrictions.length === 0 || node.exportKind === "type") {
      return;
    }
    if (node.type === "ExportAllDeclaration") {
      report(
        node,
        "setup-authorization-boundary",
        "authorization capability modules must not be wildcard re-exported",
      );
      return;
    }
    for (const specifier of node.specifiers) {
      const imported = specifier.local.name ?? specifier.local.value;
      if (
        specifier.exportKind !== "type" &&
        restrictions.some(({ binding }) => binding === imported)
      ) {
        report(
          specifier,
          "setup-authorization-boundary",
          "authorization capabilities must not be re-exported",
        );
      }
    }
  }

  function validateDiagnosticReadOnlyImport(
    sourceNode,
    resolvedModule,
    declaration,
  ) {
    if (!isDiagnosticReadOnlyFile(relativePath) || resolvedModule === undefined) {
      return;
    }

    const reportBoundary = (reason) =>
      report(sourceNode, "diagnostic-read-only-boundary", reason);

    if (isDiagnosticForbiddenModule(resolvedModule)) {
      reportBoundary(
        "diagnostic modules must not import setup, registration, mutation, reconciliation, journal, process, random, native adapter, or host MCP verification capabilities",
      );
      return;
    }

    if (exactDiagnosticHelperImports.has(relativePath)) {
      if (!exactDiagnosticHelperImport(relativePath, resolvedModule, declaration)) {
        reportBoundary(
          "reviewed diagnostic helpers may import only their exact read-only dependencies",
        );
      }
      return;
    }

    if (
      isDoctorDiagnosticFile(relativePath) &&
      isDoctorReviewedModule(resolvedModule)
    ) {
      if (!exactDoctorReviewedImport(relativePath, resolvedModule, declaration)) {
        reportBoundary(
          "doctor modules may import reviewed status, runtime-support, and MCP probe helpers only through exact file and binding allowlists",
        );
      }
      return;
    }

    if (
      isDoctorDiagnosticFile(relativePath) &&
      isDoctorPrivateModule(resolvedModule)
    ) {
      reportBoundary(
        "doctor modules must not import private credential, API, host, or system implementation modules",
      );
      return;
    }

    if (
      isDiagnosticRenderFile(relativePath) &&
      (resolvedModule.startsWith("src/credentials/") ||
        resolvedModule.startsWith("src/api/") ||
        moduleMatchesStem(
          resolvedModule,
          "src/commands/status-observation"
        ) ||
        moduleMatchesStem(
          resolvedModule,
          "src/commands/doctor-observation",
        ))
    ) {
      reportBoundary(
        "diagnostic renderers may consume only public doctor or status contracts, not observation or secret-bearing modules",
      );
      return;
    }

    if (
      moduleMatchesStem(
        resolvedModule,
        "src/credentials/codex-dotenv-contracts",
      )
    ) {
      if (
        relativePath !== "src/credentials/codex-dotenv-status.ts" ||
        declaration?.type !== "ImportDeclaration" ||
        JSON.stringify(importBindings(declaration)) !==
          JSON.stringify([...exactStatusCodexContractImports].sort())
      ) {
        reportBoundary(
          "diagnostics may import only the reviewed read-only Codex projection status symbols",
        );
      }
      return;
    }

    const broadContract = moduleMatchesStem(
      resolvedModule,
      "src/system/contracts",
    )
      ? diagnosticForbiddenSystemContractBindings
      : moduleMatchesStem(resolvedModule, "src/hosts/contracts")
        ? diagnosticForbiddenHostContractBindings
        : null;
    if (broadContract !== null) {
      if (declaration?.type !== "ImportDeclaration") {
        reportBoundary(
          "diagnostic modules must not re-export broad capability contracts",
        );
        return;
      }
      if (declaration.specifiers.length === 0) {
        reportBoundary(
          "diagnostic modules require exact named imports from broad capability contracts",
        );
        return;
      }
      for (const specifier of declaration.specifiers) {
        const imported = importedBindingName(specifier);
        if (
          imported === undefined ||
          broadContract.has(imported)
        ) {
          reportBoundary(
            "diagnostic modules must not import mutation-capable, POST-capable network, process, random, or full-system contracts",
          );
          return;
        }
      }
    }

    if (moduleMatchesStem(resolvedModule, "src/runtime")) {
      if (
        !isDiagnosticRenderFile(relativePath) ||
        declaration?.type !== "ImportDeclaration" ||
        JSON.stringify(importBindings(declaration)) !==
          JSON.stringify(exactDiagnosticRuntimeImports)
      ) {
        reportBoundary(
          "only diagnostic renderers may type-import the exact DiagnosticRuntime contract; CliRuntime and runtime values are forbidden",
        );
      }
      return;
    }
  }

  function validateModule(node, specifier, importNode) {
    let resolvedModule;
    if (specifier.toLowerCase().endsWith(".node")) {
      report(
        node,
        "native-binary-import",
        "native binaries require a separately reviewed fixed-package bridge",
      );
    }
    if (specifier.startsWith(".")) {
      const sourceDirectory = posix.dirname(relativePath);
      resolvedModule = posix.normalize(posix.join(sourceDirectory, specifier));
      const relativeModule = posix.relative(sourceDirectory, resolvedModule);
      const canonicalSpecifier = relativeModule.startsWith(".")
        ? relativeModule
        : `./${relativeModule}`;
      if (
        /[%\\?#\0]/u.test(specifier) ||
        specifier !== canonicalSpecifier ||
        specifier !== specifier.toLowerCase() ||
        (resolvedModule !== "src" && !resolvedModule.startsWith("src/"))
      ) {
        report(
          node,
          "source-boundary",
          "relative imports must resolve canonically within production source",
        );
      }
    } else if (specifier.startsWith("/")) {
      report(
        node,
        "source-boundary",
        "absolute imports are outside the production source boundary",
      );
    }

    if (isExternalSpecifier(specifier)) {
      const allowed = allowedExternalImports.get(relativePath)?.get(specifier);
      const actual = importNode === undefined ? [] : importBindings(importNode);
      if (
        allowed === undefined ||
        JSON.stringify(actual) !== JSON.stringify([...allowed].sort())
      ) {
        report(
          node,
          "external-module",
          "external modules require an exact file and binding allowlist",
        );
      }
    }

    validateDiagnosticReadOnlyImport(node, resolvedModule, importNode);

    if (resolvedModule?.startsWith("src/adapters/node/")) {
      const insideAdapter = relativePath.startsWith("src/adapters/node/");
      const approvedBridge =
        relativePath === "src/index.ts" &&
        resolvedModule === "src/adapters/node/process-runtime.js" &&
        specifier === "./adapters/node/process-runtime.js";
      if (!insideAdapter && !approvedBridge) {
        report(
          node,
          "adapter-boundary",
          "Node adapters may only be composed by the executable entrypoint",
        );
      }
    }

    if (
      resolvedModule !== undefined &&
      isUnwiredNativeBoundaryModule(resolvedModule)
    ) {
      report(
        node,
        "native-credential-wiring",
        "the native credential boundary must remain unwired until native platform suites pass",
      );
    }

    if (
      resolvedModule?.startsWith(codexCredentialBoundaryStem) &&
      relativePath.startsWith("src/hosts/")
    ) {
      report(
        node,
        "codex-credential-boundary",
        "semantic host adapters must not import the secret-bearing Codex credential projection",
      );
    }

    if (
      resolvedModule?.startsWith(codexCredentialBoundaryStem) &&
      !relativePath.startsWith(codexCredentialBoundaryStem)
    ) {
      const allowed = exactCodexCredentialBoundaryImports
        .get(relativePath)
        ?.get(resolvedModule);
      const actual = importNode === undefined ? [] : importBindings(importNode);
      if (
        allowed === undefined ||
        JSON.stringify(actual) !== JSON.stringify([...allowed].sort())
      ) {
        report(
          node,
          "codex-credential-wiring",
          "the Codex credential family requires an exact reviewed import boundary",
        );
      }
    }

    if (
      relativePath === "src/commands/setup-host-execution.ts" &&
      resolvedModule !== undefined &&
      moduleMatchesStem(resolvedModule, "src/hosts/planner")
    ) {
      report(
        node,
        "post-approval-replanning",
        "host execution must verify the exact approved postcondition without replanning",
      );
    }

    if (
      relativePath === "src/commands/setup-host-execution.ts" &&
      resolvedModule !== undefined &&
      moduleMatchesStem(resolvedModule, "src/commands/setup-preflight")
    ) {
      report(
        node,
        "post-approval-replanning",
        "host execution must not import the preflight planning boundary",
      );
    }

    if (
      relativePath === "src/commands/setup-host-execution.ts" &&
      resolvedModule !== undefined &&
      moduleMatchesStem(resolvedModule, "src/commands/setup-display")
    ) {
      const allowed = exactHostExecutionDisplayImports.get(resolvedModule);
      const actual = importNode === undefined ? [] : importBindings(importNode);
      if (
        allowed === undefined ||
        JSON.stringify(actual) !== JSON.stringify([...allowed].sort())
      ) {
        report(
          node,
          "post-approval-replanning",
          "host execution may import only the reviewed display sanitizer",
        );
      }
    }

    if (
      relativePath.startsWith("src/commands/") &&
      resolvedModule === "src/runtime.js" &&
      importNode !== undefined &&
      !isTypeOnlyImport(importNode)
    ) {
      report(
        node,
        "command-runtime",
        "commands may only type-import command runtime contracts",
      );
    }
  }

  function visit(node, parent, key, ancestors) {
    if (node.type === "ImportDeclaration") {
      validateModule(node.source, node.source.value, node);
      validateRestrictedImport(node);
      if (
        relativePath !== "src/index.ts" &&
        node.specifiers.some(
          (specifier) =>
            specifier.type === "ImportSpecifier" &&
            specifier.importKind !== "type" &&
            node.importKind !== "type" &&
            (specifier.imported.name ?? specifier.imported.value) ===
              "createProcessRuntime",
        )
      ) {
        report(
          node,
          "runtime-composition",
          "only the executable entrypoint may import createProcessRuntime",
        );
      }
    } else if (
      (node.type === "ExportAllDeclaration" ||
        node.type === "ExportNamedDeclaration") &&
      node.source !== null &&
      node.source !== undefined
    ) {
      validateModule(node.source, node.source.value, undefined);
      validateRestrictedReexport(node);
    } else if (node.type === "ExportNamedDeclaration") {
      validateRestrictedReexport(node);
      if (isDoctorDiagnosticFile(relativePath)) {
        for (const specifier of node.specifiers) {
          if (doctorReviewedLocalBindings.has(specifier.local.name)) {
            report(
              specifier,
              "diagnostic-read-only-boundary",
              "reviewed diagnostic helper bindings must not be re-exported",
            );
          }
        }
      }
    } else if (node.type === "TSImportEqualsDeclaration") {
      report(
        node,
        "commonjs-require",
        "CommonJS module loading is outside the capability boundary",
      );
    } else if (node.type === "ImportExpression") {
      report(
        node,
        "dynamic-import",
        "dynamic imports are outside the static capability boundary",
      );
    }

    if (
      isDiagnosticReadOnlyFile(relativePath) &&
      node.type === "Literal" &&
      node.value === "POST"
    ) {
      report(
        node,
        "diagnostic-read-only-boundary",
        "diagnostic modules must not construct POST-capable network requests",
      );
    }

    if (node.type === "CallExpression") {
      if (node.callee.type === "Identifier" && node.callee.name === "require") {
        report(
          node,
          "commonjs-require",
          "CommonJS module loading is outside the capability boundary",
        );
      }
      if (
        node.callee.type === "Identifier" &&
        (node.callee.name === "eval" || node.callee.name === "Function")
      ) {
        report(
          node,
          "dynamic-code",
          "dynamic code execution is outside the capability boundary",
        );
      }
      if (node.callee.type === "Identifier" && node.callee.name === "Date") {
        report(node, "clock-global", "wall-clock access must use the clock adapter");
      }
    }

    if (
      node.type === "NewExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "Function"
    ) {
      report(
        node,
        "dynamic-code",
        "dynamic code execution is outside the capability boundary",
      );
    }
    if (
      node.type === "NewExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "Date" &&
      node.arguments.length === 0
    ) {
      report(node, "clock-global", "wall-clock access must use the clock adapter");
    }

    if (node.type === "MemberExpression" && !node.computed) {
      const objectName =
        node.object.type === "Identifier" ? node.object.name : undefined;
      const propertyName =
        node.property.type === "Identifier" ? node.property.name : undefined;
      if (objectName === "Math" && propertyName === "random") {
        report(node, "random-global", "randomness must use the random adapter");
      }
      if (
        objectName === "Date" &&
        propertyName === "now" &&
        relativePath !== "src/adapters/node/clock.ts"
      ) {
        report(node, "clock-global", "wall-clock access must use the clock adapter");
      }
      if (objectName === "performance" && propertyName === "now") {
        report(node, "clock-global", "monotonic time must use an injected adapter");
      }
      if (objectName === "AbortSignal" && propertyName === "timeout") {
        report(node, "timer-global", "timeouts must use an injected adapter");
      }
    }

    if (node.type === "MemberExpression") {
      const objectName =
        node.object.type === "Identifier" ? node.object.name : undefined;
      const propertyName = node.computed
        ? node.property.type === "Literal"
          ? node.property.value
          : undefined
        : node.property.type === "Identifier"
          ? node.property.name
          : undefined;
      if (propertyName === "constructor" || propertyName === "__proto__") {
        report(
          node,
          "dynamic-code",
          "prototype constructors can bypass the capability boundary",
        );
      }
      if (
        objectName === "Object" &&
        [
          "getPrototypeOf",
          "getOwnPropertyDescriptor",
          "getOwnPropertyDescriptors",
          "setPrototypeOf",
        ].includes(propertyName) &&
        !(
          (([
              "src/adapters/node/native-credential-store.ts",
              "src/commands/setup-approval.ts",
              "src/commands/setup-credential-plan.ts",
              "src/commands/setup-host-execution.ts",
              "src/commands/setup-registration-execution.ts",
              "src/commands/doctor-output.ts",
              "src/api/reachability.ts",
              "src/credentials/codex-containment.ts",
              "src/credentials/codex-dotenv-projection.ts",
              "src/credentials/codex-dotenv-setup-observation.ts",
              "src/credentials/codex-dotenv-status.ts",
              "src/credentials/store-observer.ts",
              "src/data/uint8-array.ts",
              "src/hosts/claude-code/adapter.ts",
              "src/hosts/claude-code/output.ts",
              "src/hosts/codex/adapter.ts",
              "src/hosts/codex/output.ts",
              "src/hosts/mcp-verification.ts",
              "src/system/credential-environment.ts",
              "src/system/runtime-support.ts",
            ].includes(relativePath) &&
            ["getPrototypeOf", "getOwnPropertyDescriptor"].includes(
              propertyName,
            )) ||
            (relativePath ===
              "src/hosts/claude-code/headers-helper.ts" &&
              propertyName === "getOwnPropertyDescriptor") ||
            (relativePath ===
              "src/system/host-mutation-boundary.ts" &&
              propertyName === "getOwnPropertyDescriptor")) &&
          node.computed === false &&
          node.optional === false &&
          parent?.type === "CallExpression" &&
          parent.callee === node &&
          parent.optional === false
        )
      ) {
        report(
          node,
          "dynamic-code",
          "prototype reflection can bypass the capability boundary",
        );
      }
      if (node.computed && (objectName === "Date" || objectName === "Math")) {
        report(
          node,
          objectName === "Date" ? "clock-global" : "random-global",
          "computed global access can bypass the capability boundary",
        );
      }
      if (
        ([
            "src/adapters/node/native-credential-store.ts",
            "src/data/uint8-array.ts",
          ].includes(relativePath) ||
          diagnosticReflectionMembers.has(relativePath)) &&
        objectName === "Reflect" &&
        (relativePath === "src/adapters/node/native-credential-store.ts"
          ? ["apply", "ownKeys"]
          : diagnosticReflectionMembers.has(relativePath)
            ? [...diagnosticReflectionMembers.get(relativePath)]
          : ["apply"]
        ).includes(propertyName) &&
        !(
          node.computed === false &&
          node.optional === false &&
          parent?.type === "CallExpression" &&
          parent.callee === node &&
          parent.optional === false
        )
      ) {
        report(
          node,
          "dynamic-code",
          "Reflect methods are allowed only as direct noncomputed calls in approved boundaries",
        );
      }
    }

    if (
      node.type === "Property" &&
      parent?.type === "ObjectPattern"
    ) {
      const propertyName =
        node.key.type === "Identifier"
          ? node.key.name
          : node.key.type === "Literal"
            ? node.key.value
            : undefined;
      if (propertyName === "constructor" || propertyName === "__proto__") {
        report(
          node,
          "dynamic-code",
          "prototype destructuring can bypass the capability boundary",
        );
      }
    }

    if (node.type === "Identifier" && isIdentifierReference(node, parent, key)) {
      const restrictedCapability = restrictedLocalBindings.get(
        node.name,
      );
      if (
        restrictedCapability !== undefined &&
        !(
          parent?.type === "CallExpression" &&
          key === "callee" &&
          parent.callee === node &&
          parent.optional === false
        )
      ) {
        report(
          node,
          "setup-authorization-boundary",
          "authorization capabilities may only be invoked directly in their reviewed boundary",
        );
      } else if (node.name === "process") {
        const member =
          parent?.type === "MemberExpression" &&
          parent.object === node &&
          !parent.computed &&
          parent.property.type === "Identifier"
            ? parent.property.name
            : undefined;
        if (member === undefined || !allowedProcessMembers.get(relativePath)?.has(member)) {
          report(
            node,
            "process-global",
            "process access is restricted to exact composition members",
          );
        }
      } else if (node.name === "global" || node.name === "globalThis") {
        report(
          node,
          "global-object",
          "global object access can bypass the capability boundary",
        );
      } else if (node.name === "Date") {
        const allowedMember =
          parent?.type === "MemberExpression" &&
          parent.object === node &&
          !parent.computed &&
          parent.property.type === "Identifier" &&
          (["parse", "UTC"].includes(parent.property.name) ||
            (parent.property.name === "now" &&
              relativePath === "src/adapters/node/clock.ts"));
        const deterministicConstruction =
          parent?.type === "NewExpression" &&
          parent.callee === node &&
          parent.arguments.length > 0;
        if (!allowedMember && !deterministicConstruction) {
          report(node, "clock-global", "wall-clock access must use the clock adapter");
        }
      } else if (node.name === "Math") {
        const deterministicMember =
          parent?.type === "MemberExpression" &&
          parent.object === node &&
          !parent.computed &&
          parent.property.type === "Identifier" &&
          parent.property.name !== "random";
        if (!deterministicMember) {
          report(node, "random-global", "randomness must use the random adapter");
        }
      } else {
        const rule = reservedGlobals.get(node.name);
        const allowedBoundaryReflect =
          isAllowedBoundaryReflectReference(
            relativePath,
            node,
            parent,
            ancestors,
          );
        const allowedNetworkFetch = isAllowedNetworkFetchReference(
          relativePath,
          node,
          parent,
          key,
          ancestors,
        );
        if (
          rule !== undefined &&
          !allowedBoundaryReflect &&
          !allowedNetworkFetch
        ) {
          report(
            node,
            rule,
            "the global capability must be accessed through an injected adapter",
          );
        }
      }
    }

    for (const [childKey, value] of Object.entries(node)) {
      if (["type", "start", "end", "raw"].includes(childKey)) {
        continue;
      }
      if (Array.isArray(value)) {
        for (const child of value) {
          if (isNode(child)) {
            visit(child, node, childKey, [...ancestors, node]);
          }
        }
      } else if (isNode(value)) {
        visit(value, node, childKey, [...ancestors, node]);
      }
    }
  }

  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    const resolvedModule = resolvedRelativeModule(
      relativePath,
      statement.source.value,
    );
    if (
      isDoctorDiagnosticFile(relativePath) &&
      isDoctorReviewedModule(resolvedModule) &&
      exactDoctorReviewedImport(relativePath, resolvedModule, statement)
    ) {
      for (const specifier of statement.specifiers) {
        doctorReviewedLocalBindings.add(specifier.local.name);
      }
    }
    if (statement.importKind === "type") {
      continue;
    }
    const restrictions = restrictionsForModule(
      resolvedModule,
    );
    for (const specifier of statement.specifiers) {
      if (restrictions.length === 0) {
        continue;
      }
      if (specifier.type === "ImportNamespaceSpecifier") {
        restrictedLocalBindings.set(
          specifier.local.name,
          restrictions[0],
        );
        continue;
      }
      if (
        specifier.type === "ImportSpecifier" &&
        specifier.importKind !== "type"
      ) {
        const imported =
          specifier.imported.name ?? specifier.imported.value;
        const restriction = restrictions.find(
          ({ binding }) => binding === imported,
        );
        if (restriction !== undefined) {
          restrictedLocalBindings.set(
            specifier.local.name,
            restriction,
          );
        }
      }
    }
  }

  visit(program, undefined, undefined, []);
  return findings;
}

const negativeFixtures = [
  ["src/example.ts", 'import { readFile } from "node:fs/promises";', "external-module"],
  ["src/example.ts", 'import fs from "fs";', "external-module"],
  ["src/example.ts", 'export * from "node:https";', "external-module"],
  [
    "src/credentials/paths.ts",
    'import { posix } from "node:path";',
    "external-module",
  ],
  [
    "src/adapters/node/platform.ts",
    'import path from "node:path";',
    "external-module",
  ],
  [
    "src/adapters/node/platform.ts",
    'import * as path from "node:path";',
    "external-module",
  ],
  [
    "src/adapters/node/hash.ts",
    'import { randomBytes } from "node:crypto";',
    "external-module",
  ],
  [
    "src/example.ts",
    'import { createHash } from "node:crypto";',
    "external-module",
  ],
  [
    "src/adapters/node/hash.ts",
    'import crypto from "node:crypto";',
    "external-module",
  ],
  [
    "src/adapters/node/hash.ts",
    'import * as crypto from "node:crypto";',
    "external-module",
  ],
  ["src/example.ts", 'void import("node:child_process");', "dynamic-import"],
  ["src/example.ts", "const name = './local.js'; void import(name);", "dynamic-import"],
  ["src/example.ts", 'require("node:fs");', "commonjs-require"],
  [
    "src/example.ts",
    'require.call(null, "node:fs");',
    "commonjs-require",
  ],
  [
    "src/example.ts",
    '(0, require)("node:fs");',
    "commonjs-require",
  ],
  [
    "src/example.ts",
    'module.require("node:fs");',
    "commonjs-require",
  ],
  [
    "src/example.ts",
    'const load = createRequire(import.meta.url); load("node:fs");',
    "commonjs-require",
  ],
  [
    "src/example.ts",
    'process.dlopen({}, "./credential-store.node");',
    "process-global",
  ],
  [
    "src/adapters/node/example.ts",
    'import { createRequire } from "node:module";',
    "external-module",
  ],
  [
    "src/adapters/node/example.ts",
    'import "./credential-store.node";',
    "native-binary-import",
  ],
  [
    "src/commands/example.ts",
    'import "../adapters/node/production.js";',
    "adapter-boundary",
  ],
  [
    "src/commands/example.ts",
    'import "../adapters//node/production.js";',
    "adapter-boundary",
  ],
  [
    "src/commands/example.ts",
    'import "../ADAPTERS/NODE/production.js";',
    "source-boundary",
  ],
  [
    "src/runtime.ts",
    'import "./adapters/node/production.js";',
    "adapter-boundary",
  ],
  [
    "src/index.ts",
    'import "./adapters/node/production.js";',
    "adapter-boundary",
  ],
  [
    "src/runtime.ts",
    'import "./adapters/Node/production.js";',
    "source-boundary",
  ],
  [
    "src/adapters/node/production.ts",
    'import "./native-credential-store.js";',
    "native-credential-wiring",
  ],
  [
    "src/adapters/node/production.ts",
    'import "./native-credential-store";',
    "native-credential-wiring",
  ],
  [
    "src/adapters/node/production.ts",
    'import "./native-credential-store.ts";',
    "native-credential-wiring",
  ],
  [
    "src/adapters/node/production.ts",
    'export * from "./native-credential-store.mjs";',
    "native-credential-wiring",
  ],
  [
    "src/commands/setup.ts",
    'import { mintSetupApproval as mint } from "./setup-approval.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup-confirmation.ts",
    'import * as approval from "./setup-approval.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup.ts",
    'import { claimSetupExecutionSidecar } from "./setup-execution-authority.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup.ts",
    'import { claimSetupExecutionGrant } from "./setup-execution-authority.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup-registration-execution.ts",
    'import * as execution from "./setup-execution-authority.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup-registration-execution.ts",
    'import { claimSetupExecutionGrant } from "./setup-execution-authority.js"; const claim = claimSetupExecutionGrant;',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup-registration-execution.ts",
    'import { claimSetupExecutionGrant } from "./setup-execution-authority.js"; claimSetupExecutionGrant.call(undefined, {}, {}, {});',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup.ts",
    'export { claimSetupExecutionGrant } from "./setup-execution-authority.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup.ts",
    'import { createSetupConfirmationAttempt } from "./setup-confirmation.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup.ts",
    'import { retainFramedSetupCredentialInput } from "./setup-credential-input.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/adapters/node/setup-interaction.ts",
    'import { claimSetupCredentialInputBytes } from "../../commands/setup-credential-input.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup.ts",
    'import * as input from "./setup-credential-input.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup.ts",
    'export { claimSetupCredentialInputBytes } from "./setup-credential-input.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/adapters/node/setup-credential-input.ts",
    'import { retainFramedSetupCredentialInput } from "../../commands/setup-credential-input.js"; const retain = retainFramedSetupCredentialInput;',
    "setup-authorization-boundary",
  ],
  [
    "src/adapters/node/setup-credential-input.ts",
    'import { retainFramedSetupCredentialInput } from "../../commands/setup-credential-input.js"; retainFramedSetupCredentialInput.call(undefined, new Uint8Array(), "explicit-eof");',
    "setup-authorization-boundary",
  ],
  [
    "src/adapters/node/setup-interaction.ts",
    'import { createNodeSetupExplicitCredentialInput } from "./setup-credential-input.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup.ts",
    'import { transferSetupProtectedCredentialInput } from "./setup-registration-execution.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/credentials/codex-dotenv-setup-observation.ts",
    'import * as registration from "../commands/setup-registration-execution.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/credentials/codex-dotenv-setup-observation.ts",
    'import { transferSetupProtectedCredentialInput } from "../commands/setup-registration-execution.js"; const transfer = transferSetupProtectedCredentialInput;',
    "setup-authorization-boundary",
  ],
  [
    "src/credentials/codex-dotenv-setup-observation.ts",
    'import { transferSetupProtectedCredentialInput } from "../commands/setup-registration-execution.js"; transferSetupProtectedCredentialInput.call(undefined, {}, {}, {});',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup.ts",
    'export { transferSetupProtectedCredentialInput } from "./setup-registration-execution.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup.ts",
    'import { claimSetupUsernameConflictContinuation } from "./setup-registration-execution.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/credentials/codex-dotenv-setup-observation.ts",
    'import { claimSetupUsernameConflictContinuation } from "../commands/setup-registration-execution.js"; const claim = claimSetupUsernameConflictContinuation;',
    "setup-authorization-boundary",
  ],
  [
    "src/credentials/codex-dotenv-setup-observation.ts",
    'import { claimSetupUsernameConflictContinuation } from "../commands/setup-registration-execution.js"; claimSetupUsernameConflictContinuation.call(undefined, {}, {});',
    "setup-authorization-boundary",
  ],
  [
    "src/credentials/codex-dotenv-setup-observation.ts",
    'import { claimSetupUsernameConflictContinuation } from "../commands/setup-registration-execution.js"; claimSetupUsernameConflictContinuation.apply(undefined, [{}, {}]);',
    "setup-authorization-boundary",
  ],
  [
    "src/credentials/codex-dotenv-setup-observation.ts",
    'import { claimSetupUsernameConflictContinuation } from "../commands/setup-registration-execution.js"; claimSetupUsernameConflictContinuation?.({}, {});',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup.ts",
    'export { discardSetupUsernameConflictContinuation } from "./setup-registration-execution.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup.ts",
    'import { claimSetupSecretLeaseBytes } from "./setup-secret-lease.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup-registration-execution.ts",
    'import * as secretLease from "./setup-secret-lease.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup-registration-execution.ts",
    'import { claimSetupSecretLeaseBytes } from "./setup-secret-lease.js"; const claim = claimSetupSecretLeaseBytes;',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup-registration-execution.ts",
    'import { claimSetupSecretLeaseBytes } from "./setup-secret-lease.js"; claimSetupSecretLeaseBytes.call(undefined, {});',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup-registration-execution.ts",
    'import { claimSetupSecretLeaseBytes } from "./setup-secret-lease.js"; claimSetupSecretLeaseBytes.apply(undefined, [{}]);',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup.ts",
    'export { copySetupSecretLeaseBytes } from "./setup-secret-lease.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup.ts",
    'import { createSetupSecretLease, copySetupSecretLeaseBytes, discardSetupSecretLease, isOwnedSetupSecretLease } from "./setup-secret-lease.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup.ts",
    'import { createSetupRegistrationExecutionAttempt } from "./setup-registration-execution.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/credentials/codex-dotenv-setup-observation.ts",
    'import { createSetupRegistrationExecutionAttempt } from "../commands/setup-registration-execution.js"; const create = createSetupRegistrationExecutionAttempt;',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup.ts",
    'import { claimCredentialStoreObservationEvidence } from "../credentials/store-observer.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup-registration-execution.ts",
    'import * as observer from "../credentials/store-observer.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup-registration-execution.ts",
    'import { claimCredentialStoreObservationEvidence } from "../credentials/store-observer.js"; const claim = claimCredentialStoreObservationEvidence;',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup.ts",
    'import { runExclusiveObservedCredentialSetup } from "../credentials/store-writer.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup-registration-execution.ts",
    'import * as writer from "../credentials/store-writer.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup-registration-execution.ts",
    'import { runExclusiveObservedCredentialSetup } from "../credentials/store-writer.js"; const run = runExclusiveObservedCredentialSetup;',
    "setup-authorization-boundary",
  ],
  [
    "src/adapters/node/setup-interaction.ts",
    'import * as credentialInput from "./setup-credential-input.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/adapters/node/production.ts",
    'import { createNodeSetupProtectedInteractiveSession } from "./setup-credential-input.js"; const createSession = createNodeSetupProtectedInteractiveSession;',
    "setup-authorization-boundary",
  ],
  [
    "src/credentials/codex-dotenv-setup-observation.ts",
    'import { createSetupInputFreePlanPresenter } from "../commands/setup-confirmation.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/credentials/codex-dotenv-setup-observation.ts",
    'import { createSetupInteractiveSessionPorts } from "../commands/setup-confirmation.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup.ts",
    'export { mintSetupApproval as mint } from "./setup-approval.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup.ts",
    'export * from "./setup-approval.js";',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup-confirmation.ts",
    'import { mintSetupApproval as mint } from "./setup-approval.js"; export { mint };',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup-confirmation.ts",
    'import { mintSetupApproval } from "./setup-approval.js"; export default mintSetupApproval;',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup-confirmation.ts",
    'import { mintSetupApproval } from "./setup-approval.js"; const leak = mintSetupApproval; export default leak;',
    "setup-authorization-boundary",
  ],
  [
    "src/commands/setup-confirmation.ts",
    'import { mintSetupApproval } from "./setup-approval.js"; mintSetupApproval.call(undefined, {}, {});',
    "setup-authorization-boundary",
  ],
  [
    "src/hosts/codex/adapter.ts",
    'import "../../credentials/codex-dotenv.js";',
    "codex-credential-boundary",
  ],
  [
    "src/adapters/node/production.ts",
    'import "../../credentials/codex-dotenv-projection.js";',
    "codex-credential-wiring",
  ],
  [
    "src/credentials/bridge.ts",
    'export { createCodexDotenvProjectionAdapter } from "./codex-dotenv-projection.js";',
    "codex-credential-wiring",
  ],
  [
    "src/example.ts",
    'import "./credentials/codex-dotenv-contracts.js";',
    "codex-credential-wiring",
  ],
  [
    "src/commands/setup-host-execution.ts",
    'import { createCodexDotenvProjectionAdapter } from "../credentials/codex-dotenv-projection.js";',
    "codex-credential-wiring",
  ],
  [
    "src/commands/setup-host-execution.ts",
    'import { createCodexDotenvSetupObservationAuthority } from "../credentials/codex-dotenv-setup-observation.js";',
    "codex-credential-wiring",
  ],
  [
    "src/commands/setup-host-execution.ts",
    'import * as projection from "../credentials/codex-dotenv-projection.js"; void projection;',
    "codex-credential-wiring",
  ],
  [
    "src/commands/setup-host-execution.ts",
    'export { createCodexDotenvProjectionAdapter } from "../credentials/codex-dotenv-projection.js";',
    "codex-credential-wiring",
  ],
  [
    "src/commands/setup-host-execution.ts",
    'import { createHostPreflightPlan } from "../hosts/planner.js"; void createHostPreflightPlan;',
    "post-approval-replanning",
  ],
  [
    "src/commands/setup-host-execution.ts",
    'import { createSetupPreflightSnapshot } from "./setup-preflight.js"; void createSetupPreflightSnapshot;',
    "post-approval-replanning",
  ],
  [
    "src/commands/setup-host-execution.ts",
    'import * as display from "./setup-display.js"; void display;',
    "post-approval-replanning",
  ],
  [
    "src/adapters/node/production.ts",
    'import "./native-credential-store.jsx";',
    "native-credential-wiring",
  ],
  [
    "src/adapters/node/production.ts",
    'import "./native-credential-store.tsx";',
    "native-credential-wiring",
  ],
  ["src/example.ts", 'import "/tmp/outside.js";', "source-boundary"],
  ["src/example.ts", 'import "../outside.js";', "source-boundary"],
  ["src/example.ts", 'import "./module%2ejs";', "source-boundary"],
  [
    "src/example.ts",
    'import { createProcessRuntime } from "./runtime.js";',
    "runtime-composition",
  ],
  ["src/example.ts", "process.env.SECRET;", "process-global"],
  ["src/example.ts", 'globalThis["fetch"]("http://example.test");', "global-object"],
  ["src/example.ts", 'fetch("http://example.test");', "network-global"],
  [
    "src/adapters/node/network.ts",
    'fetch("https://example.test");',
    "network-global",
  ],
  [
    "src/adapters/node/network.ts",
    "const escapedFetch = fetch;",
    "network-global",
  ],
  [
    "src/adapters/node/network.ts",
    "function shadow(createNodeNetwork) { const nodeNetwork = createNodeNetwork(fetch); return nodeNetwork; }",
    "network-global",
  ],
  ["src/example.ts", "Date.now();", "clock-global"],
  ["src/example.ts", "new Date();", "clock-global"],
  ["src/example.ts", "Math.random();", "random-global"],
  ["src/example.ts", "setTimeout(() => {}, 1);", "timer-global"],
  ["src/example.ts", 'eval("1");', "dynamic-code"],
  ["src/example.ts", 'new Function("return 1");', "dynamic-code"],
  [
    "src/example.ts",
    'Function.call(null, "return process")();',
    "dynamic-code",
  ],
  [
    "src/example.ts",
    'Reflect.construct(Function, ["return process"])();',
    "dynamic-code",
  ],
  [
    "src/example.ts",
    "Reflect.apply(() => 1, undefined, []);",
    "dynamic-code",
  ],
  [
    "src/adapters/node/native-credential-store.ts",
    "Reflect['apply'](() => 1, undefined, []);",
    "dynamic-code",
  ],
  [
    "src/adapters/node/native-credential-store.ts",
    "Reflect['ownKeys']({});",
    "dynamic-code",
  ],
  [
    "src/adapters/node/native-credential-store.ts",
    "const apply = Reflect.apply; apply(() => 1, undefined, []);",
    "dynamic-code",
  ],
  [
    "src/data/uint8-array.ts",
    "Reflect['apply'](() => 1, undefined, []);",
    "dynamic-code",
  ],
  [
    "src/data/uint8-array.ts",
    "const apply = Reflect.apply; apply(() => 1, undefined, []);",
    "dynamic-code",
  ],
  [
    "src/data/uint8-array.ts",
    "Object['getPrototypeOf']({});",
    "dynamic-code",
  ],
  [
    "src/data/uint8-array.ts",
    "const getDescriptor = Object.getOwnPropertyDescriptor; getDescriptor({}, 'key');",
    "dynamic-code",
  ],
  [
    "src/system/credential-environment.ts",
    "Object['getPrototypeOf']({});",
    "dynamic-code",
  ],
  [
    "src/system/credential-environment.ts",
    "const getPrototype = Object.getPrototypeOf; getPrototype({});",
    "dynamic-code",
  ],
  [
    "src/system/credential-environment.ts",
    "Object['getOwnPropertyDescriptor']({}, 'key');",
    "dynamic-code",
  ],
  [
    "src/system/credential-environment.ts",
    "const getDescriptor = Object.getOwnPropertyDescriptor; getDescriptor({}, 'key');",
    "dynamic-code",
  ],
  [
    "src/commands/setup-approval.ts",
    "Object['getPrototypeOf']({});",
    "dynamic-code",
  ],
  [
    "src/commands/setup-approval.ts",
    "const getDescriptor = Object.getOwnPropertyDescriptor; getDescriptor({}, 'key');",
    "dynamic-code",
  ],
  [
    "src/commands/setup-approval.ts",
    "const getPrototype = Object.getPrototypeOf; getPrototype({});",
    "dynamic-code",
  ],
  [
    "src/commands/setup-approval.ts",
    "Object['getOwnPropertyDescriptor']({}, 'key');",
    "dynamic-code",
  ],
  [
    "src/commands/setup-approval.ts",
    "Object.getOwnPropertyDescriptors({});",
    "dynamic-code",
  ],
  [
    "src/commands/setup-approval.ts",
    "Object.setPrototypeOf({}, null);",
    "dynamic-code",
  ],
  [
    "src/commands/setup-credential-plan.ts",
    "Object['getPrototypeOf']({});",
    "dynamic-code",
  ],
  [
    "src/commands/setup-credential-plan.ts",
    "const getDescriptor = Object.getOwnPropertyDescriptor; getDescriptor({}, 'key');",
    "dynamic-code",
  ],
  [
    "src/credentials/store-observer.ts",
    "Object['getPrototypeOf']({});",
    "dynamic-code",
  ],
  [
    "src/credentials/store-observer.ts",
    "const getPrototype = Object.getPrototypeOf; getPrototype({});",
    "dynamic-code",
  ],
  [
    "src/credentials/store-observer.ts",
    "Object['getOwnPropertyDescriptor']({}, 'key');",
    "dynamic-code",
  ],
  [
    "src/credentials/store-observer.ts",
    "const getDescriptor = Object.getOwnPropertyDescriptor; getDescriptor({}, 'key');",
    "dynamic-code",
  ],
  [
    "src/credentials/codex-dotenv-setup-observation.ts",
    "Object['getPrototypeOf']({});",
    "dynamic-code",
  ],
  [
    "src/credentials/codex-dotenv-setup-observation.ts",
    "const getPrototype = Object.getPrototypeOf; getPrototype({});",
    "dynamic-code",
  ],
  [
    "src/credentials/codex-dotenv-setup-observation.ts",
    "Object['getOwnPropertyDescriptor']({}, 'key');",
    "dynamic-code",
  ],
  [
    "src/credentials/codex-dotenv-setup-observation.ts",
    "const getDescriptor = Object.getOwnPropertyDescriptor; getDescriptor({}, 'key');",
    "dynamic-code",
  ],
  [
    "src/hosts/claude-code/headers-helper.ts",
    "Object.getPrototypeOf({});",
    "dynamic-code",
  ],
  [
    "src/example.ts",
    "Object.getPrototypeOf(() => {}).call(null, 'return process')();",
    "dynamic-code",
  ],
  ["src/example.ts", "(() => {}).constructor('return process')();", "dynamic-code"],
  [
    "src/example.ts",
    "const { constructor: FunctionAlias } = () => {}; FunctionAlias('return process')();",
    "dynamic-code",
  ],
  [
    "src/example.ts",
    "const { ['__proto__']: prototype } = {}; void prototype;",
    "dynamic-code",
  ],
  ["src/example.ts", 'Date["now"]();', "clock-global"],
  ["src/example.ts", 'Math["random"]();', "random-global"],
  [
    "src/api/reachability.ts",
    "Object.getOwnPropertyDescriptors({});",
    "dynamic-code",
  ],
  [
    "src/api/reachability.ts",
    "Object.setPrototypeOf({}, null);",
    "dynamic-code",
  ],
  [
    "src/api/reachability.ts",
    "Reflect.apply(() => undefined, undefined, []);",
    "dynamic-code",
  ],
  [
    "src/api/reachability.ts",
    "const getPrototype = Object.getPrototypeOf; getPrototype({});",
    "dynamic-code",
  ],
  [
    "src/api/reachability.ts",
    'import * as origin from "../credentials/origin.js"; void origin;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/api/reachability.ts",
    'export { parseStrictJsonObject } from "../data/strict-json-object.js";',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/system/runtime-support.ts",
    'import type { ReadOnlyNetworkAdapter } from "./contracts.js"; type Network = ReadOnlyNetworkAdapter;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/status-observation.ts",
    'import { createSetupRegistrationExecutionAttempt } from "./setup-registration-execution.js";',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/status-observation.ts",
    'import { runExclusiveObservedCredentialSetup as observe } from "../credentials/store-writer.js"; void observe;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/status-observation.ts",
    'import * as journal from "../hosts/journal-codec.js"; void journal;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/status-observation.ts",
    'export * from "../hosts/codex/commands.js";',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/status-observation.ts",
    'import { nodeRandom } from "../adapters/node/random.js"; void nodeRandom;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/status-contracts.ts",
    'import type { ProcessAdapter as StatusProcess } from "../system/contracts.js"; type Process = StatusProcess;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/hosts/status.ts",
    'import type { HostMutationAdapter as Inspector } from "./contracts.js"; type Adapter = Inspector;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/status-observation.ts",
    'import * as projection from "../credentials/codex-dotenv-projection.js"; void projection;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/credentials/codex-dotenv-status.ts",
    'import * as contracts from "./codex-dotenv-contracts.js"; void contracts;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/credentials/codex-dotenv-status.ts",
    'export type { CodexDotenvProjectionAdapter } from "./codex-dotenv-contracts.js";',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/status-output.ts",
    'import type { ResolvedCredential } from "../credentials/discovery.js"; type Credential = ResolvedCredential;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/status-output.ts",
    'import type { ApiKey as DisplayKey } from "../credentials/schema.js"; type Key = DisplayKey;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/status-output.ts",
    'import * as discovery from "../credentials/discovery.js"; void discovery;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/status-output.ts",
    'export * from "../credentials/discovery.js";',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/status-output.ts",
    'import { observeStatus } from "./status-observation.js"; void observeStatus;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/status-output.ts",
    'import type { CliRuntime } from "../runtime.js"; type Runtime = CliRuntime;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/status-output.ts",
    'import type { DiagnosticRuntime, CliRuntime } from "../runtime.js"; type Runtime = DiagnosticRuntime & CliRuntime;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/status-output.ts",
    'import { DiagnosticRuntime } from "../runtime.js"; void DiagnosticRuntime;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/status-observation.ts",
    'import type { DiagnosticRuntime } from "../runtime.js"; type Runtime = DiagnosticRuntime;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/status-contracts.ts",
    'export type { DiagnosticRuntime } from "../runtime.js";',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-observation.ts",
    'import { createSetupRegistrationExecutionAttempt as inspect } from "./setup-registration-execution.js"; void inspect;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-observation.ts",
    'import { registerAgent as observe } from "../api/agent-registration.js"; void observe;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-contracts.ts",
    'import type { ResolvedCredential as PublicCredential } from "../credentials/discovery.js"; type Credential = PublicCredential;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-observation.ts",
    'import { createHostPreflightPlan as diagnose } from "../hosts/planner.js"; void diagnose;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-observation.ts",
    'import type { HostMcpVerificationAdapter as DiagnosticMcp } from "../hosts/mcp-verification.js"; type Mcp = DiagnosticMcp;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-observation.ts",
    'export * from "../hosts/mcp-verification.js";',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-observation.ts",
    'import { doctorScope as observe } from "../system/scopes.js"; void observe;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-observation.ts",
    'import type { NetworkAdapter as ReadOnlyNetwork } from "../system/contracts.js"; type Network = ReadOnlyNetwork;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-observation.ts",
    'import type { NetworkRequest as SafeRequest } from "../system/contracts.js"; type Request = SafeRequest;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-observation.ts",
    'import type { FileSystemAdapter as ReadOnlyFiles } from "../system/contracts.js"; type Files = ReadOnlyFiles;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-observation.ts",
    'import type { RandomAdapter as DeterministicInput } from "../system/contracts.js"; type Random = DeterministicInput;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-observation.ts",
    'import type { HostMutationAdapter as InspectionOnlyHost } from "../hosts/contracts.js"; type Host = InspectionOnlyHost;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-observation.ts",
    'import { createDeniedSystemCapabilities as system } from "../system/denied.js"; void system;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-observation.ts",
    'import { createNativeCredentialStore as store } from "../adapters/node/native-credential-store.js"; void store;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-observation.ts",
    'import { createStatusCommand as observe } from "./status.js"; void observe;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-contracts.ts",
    'export type { NetworkAdapter as DoctorNetwork } from "../system/contracts.js";',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-observation.ts",
    'const request = { method: "POST" as const }; void request;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-output.ts",
    'import type { CliRuntime as DiagnosticRuntime } from "../runtime.js"; type Runtime = DiagnosticRuntime;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-output.ts",
    'import { DiagnosticRuntime } from "../runtime.js"; void DiagnosticRuntime;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-observation.ts",
    'import type { DiagnosticRuntime } from "../runtime.js"; type Runtime = DiagnosticRuntime;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-output.ts",
    'import { observeStatus as createStatusJsonEnvelope } from "./status-observation.js"; void createStatusJsonEnvelope;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-output.ts",
    'import { renderStatusJson } from "./status-output.js"; void renderStatusJson;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-output.ts",
    'import { SUPPORTED_NODE_RUNTIME_RANGES } from "../system/runtime-support.js"; void SUPPORTED_NODE_RUNTIME_RANGES;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-output.ts",
    'import * as claudeConfiguration from "../hosts/claude-code/configuration.js"; void claudeConfiguration;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-output.ts",
    'export * from "../hosts/claude-code/configuration.js";',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-output.ts",
    'import { CLAUDE_CODE_PLUGIN_VERSION } from "../hosts/claude-code/configuration.js"; void CLAUDE_CODE_PLUGIN_VERSION;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-output.ts",
    'export { CLAUDE_CODE_MINIMUM_VERSION as minimumVersion } from "../hosts/claude-code/configuration.js";',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-output.ts",
    'import { CODEX_DESIRED_CONFIGURATION, CODEX_MINIMUM_VERSION, CODEX_PLUGIN_COMPATIBLE_MAXIMUM_EXCLUSIVE, CODEX_PLUGIN_VERSION } from "../hosts/codex/configuration.js"; void CODEX_DESIRED_CONFIGURATION; void CODEX_MINIMUM_VERSION; void CODEX_PLUGIN_COMPATIBLE_MAXIMUM_EXCLUSIVE; void CODEX_PLUGIN_VERSION;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-output.ts",
    'export { compareCanonicalVersions as compareVersions } from "../hosts/version.js";',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-output.ts",
    'import { compareCanonicalVersions as compareVersions } from "../hosts/version.js"; export { compareVersions };',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-output.ts",
    'export * from "./status-output.js";',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-output.ts",
    'import { createStatusJsonEnvelope as envelope } from "./status-output.js"; export { envelope };',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-observation.ts",
    'import * as status from "./status-observation.js"; void status;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-observation.ts",
    'import { observeStatus, type StatusObservationDependencies, type PrivateStatusState } from "./status-observation.js"; void observeStatus; type State = [StatusObservationDependencies, PrivateStatusState];',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-observation.ts",
    'import { probeApiReachability } from "../api/reachability.js"; void probeApiReachability;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-contracts.ts",
    'export type { McpAuthenticationBoundaryResult } from "../api/reachability.js";',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/commands/doctor-observation.ts",
    'import { observeRuntimePlatformSupport, type RuntimePlatformSupportResult } from "../system/runtime-support.js"; void observeRuntimePlatformSupport; type Result = RuntimePlatformSupportResult;',
    "diagnostic-read-only-boundary",
  ],
  [
    "src/system/runtime-support.ts",
    'Reflect["apply"](() => undefined, undefined, []);',
    "dynamic-code",
  ],
  [
    "src/system/runtime-support.ts",
    'const apply = Reflect.apply; apply(() => undefined, undefined, []);',
    "dynamic-code",
  ],
  [
    "src/system/runtime-support.ts",
    'Object["getPrototypeOf"]({});',
    "dynamic-code",
  ],
  [
    "src/system/runtime-support.ts",
    'async function check(adapter: object) { const observe = () => undefined; await Reflect.apply(observe, adapter, []); }',
    "dynamic-code",
  ],
  [
    "src/commands/doctor-output.ts",
    'Reflect["ownKeys"]({});',
    "dynamic-code",
  ],
  [
    "src/commands/doctor-output.ts",
    'const ownKeys = Reflect.ownKeys; ownKeys({});',
    "dynamic-code",
  ],
  [
    "src/commands/doctor-output.ts",
    'Object["getOwnPropertyDescriptor"]({}, "value");',
    "dynamic-code",
  ],
];

const positiveFixtures = [
  ["src/cli.ts", 'import { parseArgs } from "node:util"; parseArgs({ args: [] });'],
  [
    "src/adapters/node/random.ts",
    'import { randomBytes, randomUUID } from "node:crypto"; randomBytes(1); randomUUID();',
  ],
  [
    "src/adapters/node/hash.ts",
    'import { createHash } from "node:crypto"; createHash("sha256");',
  ],
  [
    "src/adapters/node/network.ts",
    'import { clearTimeout as cancelTimer, setTimeout as scheduleTimer } from "node:timers"; export const nodeNetwork = createNodeNetwork(fetch); cancelTimer(scheduleTimer(() => {}, 1));',
  ],
  [
    "src/adapters/node/platform.ts",
    'import process from "node:process"; process.platform; process.getuid?.();',
  ],
  [
    "src/adapters/node/platform.ts",
    'import { posix, win32 } from "node:path"; posix.join("/a", "b"); win32.join("C:\\\\a", "b");',
  ],
  ["src/adapters/node/clock.ts", "Date.now();"],
  [
    "src/commands/setup-confirmation.ts",
    'import { mintSetupApproval as mint } from "./setup-approval.js"; import { claimSetupExecutionSidecar as claim } from "./setup-execution-authority.js"; mint({}, {}); claim({}, {}, {});',
  ],
  [
    "src/commands/setup-host-execution.ts",
    'import type { CodexDotenvProjectionAdapter, CodexDotenvProjectionIdentity } from "../credentials/codex-dotenv-contracts.js"; import { isOwnedCodexDotenvProjectionAdapter } from "../credentials/codex-dotenv-projection.js"; void isOwnedCodexDotenvProjectionAdapter; type Pair = [CodexDotenvProjectionAdapter, CodexDotenvProjectionIdentity];',
  ],
  [
    "src/commands/setup-host-execution.ts",
    'import { setupDisplayText } from "./setup-display.js"; setupDisplayText("safe");',
  ],
  [
    "src/credentials/codex-dotenv-setup-observation.ts",
    'import { createSetupConfirmationAttempt as createAttempt } from "../commands/setup-confirmation.js"; createAttempt();',
  ],
  [
    "src/adapters/node/setup-interaction.ts",
    'import { createSetupInputFreePlanPresenter as createInputFreePresenter, createSetupInteractiveSessionPorts as createInteractivePorts } from "../../commands/setup-confirmation.js"; createInputFreePresenter(); createInteractivePorts();',
  ],
  ["src/example.ts", "new Date(0); Date.parse('2026-01-01'); Date.UTC(2026, 0);"],
  [
    "src/adapters/node/native-credential-store.ts",
    "Reflect.apply(() => 1, undefined, []);",
  ],
  [
    "src/adapters/node/native-credential-store.ts",
    "Reflect.ownKeys(Object.freeze({}));",
  ],
  [
    "src/adapters/node/native-credential-store.ts",
    'Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength");',
  ],
  [
    "src/system/credential-environment.ts",
    'Object.getOwnPropertyDescriptor({}, "key"); Object.getPrototypeOf({});',
  ],
  [
    "src/commands/setup-approval.ts",
    'Object.getOwnPropertyDescriptor({}, "key"); Object.getPrototypeOf({});',
  ],
  [
    "src/commands/setup-credential-plan.ts",
    'Object.getOwnPropertyDescriptor({}, "key"); Object.getPrototypeOf({});',
  ],
  [
    "src/commands/setup-registration-execution.ts",
    'Object.getOwnPropertyDescriptor({}, "key"); Object.getPrototypeOf({});',
  ],
  [
    "src/hosts/claude-code/output.ts",
    'Object.getOwnPropertyDescriptor({}, "key"); Object.getPrototypeOf({});',
  ],
  [
    "src/hosts/claude-code/adapter.ts",
    'Object.getOwnPropertyDescriptor({}, "key"); Object.getPrototypeOf({});',
  ],
  [
    "src/hosts/claude-code/headers-helper.ts",
    'Object.getOwnPropertyDescriptor({}, "key");',
  ],
  [
    "src/credentials/codex-dotenv-projection.ts",
    'Object.getOwnPropertyDescriptor({}, "key"); Object.getPrototypeOf({});',
  ],
  [
    "src/hosts/codex/output.ts",
    'Object.getOwnPropertyDescriptor({}, "key"); Object.getPrototypeOf({}); Reflect.ownKeys({});',
  ],
  [
    "src/hosts/codex/adapter.ts",
    'Object.getOwnPropertyDescriptor({}, "key"); Object.getPrototypeOf({});',
  ],
  [
    "src/data/uint8-array.ts",
    'const getter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength")?.get; Reflect.apply(getter, new Uint8Array(), []);',
  ],
  [
    "src/hosts/status.ts",
    'import { createHostPreflightPlan } from "./planner.js"; createHostPreflightPlan({}, {});',
  ],
  [
    "src/credentials/codex-dotenv-status.ts",
    'import { CODEX_DOTENV_PROJECTION_STATUSES, type CodexDotenvProjectionStatus } from "./codex-dotenv-contracts.js"; Object.getOwnPropertyDescriptor({}, "key"); Object.getPrototypeOf({}); Reflect.ownKeys({}); void CODEX_DOTENV_PROJECTION_STATUSES; type Status = CodexDotenvProjectionStatus;',
  ],
  [
    "src/api/reachability.ts",
    'Object.getOwnPropertyDescriptor({}, "key"); Object.getPrototypeOf({}); Reflect.ownKeys({});',
  ],
  [
    "src/commands/status-output.ts",
    'import type { DiagnosticRuntime } from "../runtime.js"; import type { HostId } from "../hosts/contracts.js"; type Output = [DiagnosticRuntime, HostId];',
  ],
  [
    "src/commands/status-observation.ts",
    'import { observeCodexDotenvStatus, type CodexDotenvStatusObservationAdapter } from "../credentials/codex-dotenv-status.js"; void observeCodexDotenvStatus; type Adapter = CodexDotenvStatusObservationAdapter;',
  ],
  [
    "src/system/runtime-support.ts",
    'async function check(adapter: object) { const observe = () => undefined; Object.getOwnPropertyDescriptor({}, "observe"); Object.getPrototypeOf({}); Reflect.ownKeys({}); snapshotObservation(await Reflect.apply(observe, adapter, [])); }',
  ],
  [
    "src/commands/doctor-observation.ts",
    'import { probeMcpAuthenticationBoundary, type McpAuthenticationBoundaryResult } from "../api/reachability.js"; import { observeRuntimePlatformSupport, type RuntimePlatformSupportResult, type RuntimeSupportObservationAdapter } from "../system/runtime-support.js"; import { observeStatus, type StatusObservationDependencies } from "./status-observation.js"; import type { StatusReportV1 } from "./status-contracts.js"; import type { DoctorCapabilities } from "../system/contracts.js"; void probeMcpAuthenticationBoundary; void observeRuntimePlatformSupport; void observeStatus; type Dependencies = [McpAuthenticationBoundaryResult, RuntimePlatformSupportResult, RuntimeSupportObservationAdapter, StatusObservationDependencies, StatusReportV1, DoctorCapabilities];',
  ],
  [
    "src/commands/doctor-contracts.ts",
    'import type { McpAuthenticationBoundaryResult } from "../api/reachability.js"; import type { HostId } from "../hosts/contracts.js"; import type { RuntimePlatformSupportResult } from "../system/runtime-support.js"; import type { StatusJsonSuccessEnvelope, StatusReportV1 } from "./status-contracts.js"; type Report = [McpAuthenticationBoundaryResult, HostId, RuntimePlatformSupportResult, StatusJsonSuccessEnvelope, StatusReportV1];',
  ],
  [
    "src/commands/doctor-output.ts",
    'import { createStatusJsonEnvelope } from "./status-output.js"; import { CLAUDE_CODE_MINIMUM_VERSION, CLAUDE_CODE_PLUGIN_COMPATIBLE_MAXIMUM_EXCLUSIVE, CLAUDE_CODE_PLUGIN_VERSION } from "../hosts/claude-code/configuration.js"; import { CODEX_MINIMUM_VERSION, CODEX_PLUGIN_COMPATIBLE_MAXIMUM_EXCLUSIVE, CODEX_PLUGIN_VERSION } from "../hosts/codex/configuration.js"; import { compareCanonicalVersions } from "../hosts/version.js"; import { RECOGNIZED_RUNTIME_TARGETS, RELEASED_RUNTIME_TARGETS, type ReleasedRuntimePlatformTarget, type RuntimePlatformTarget } from "../system/runtime-support.js"; import type { DiagnosticRuntime } from "../runtime.js"; import type { DoctorReportV1 } from "./doctor-contracts.js"; Object.getOwnPropertyDescriptor({}, "value"); Object.getPrototypeOf({}); Reflect.ownKeys({}); void createStatusJsonEnvelope; void CLAUDE_CODE_MINIMUM_VERSION; void CLAUDE_CODE_PLUGIN_COMPATIBLE_MAXIMUM_EXCLUSIVE; void CLAUDE_CODE_PLUGIN_VERSION; void CODEX_MINIMUM_VERSION; void CODEX_PLUGIN_COMPATIBLE_MAXIMUM_EXCLUSIVE; void CODEX_PLUGIN_VERSION; void compareCanonicalVersions; void RECOGNIZED_RUNTIME_TARGETS; void RELEASED_RUNTIME_TARGETS; type Output = [DiagnosticRuntime, DoctorReportV1, ReleasedRuntimePlatformTarget, RuntimePlatformTarget];',
  ],
  [
    "src/commands/doctor-observation.ts",
    'import { CLAUDE_CODE_PLUGIN_VERSION } from "../hosts/claude-code/configuration.js"; import { CODEX_PLUGIN_VERSION } from "../hosts/codex/configuration.js"; import { HOST_IDS, type HostId } from "../hosts/contracts.js"; import { compareCanonicalVersions } from "../hosts/version.js"; void CLAUDE_CODE_PLUGIN_VERSION; void CODEX_PLUGIN_VERSION; void HOST_IDS; void compareCanonicalVersions; type Client = HostId;',
  ],
  [
    "src/api/reachability.ts",
    'import type { ReadOnlyNetworkAdapter, ReadOnlyNetworkRequest } from "../system/contracts.js"; const request: ReadOnlyNetworkRequest = { url: "https://mcp.plurum.ai/mcp", method: "GET", headers: {}, timeoutMs: 1, maxResponseBytes: 1, redirect: "error" }; type Network = ReadOnlyNetworkAdapter; void request; type Pair = [Network];',
  ],
];

for (const [file, fixture, expectedRule] of negativeFixtures) {
  const rules = new Set(scanText(file, fixture).map(({ rule }) => rule));
  if (!rules.has(expectedRule)) {
    throw new Error(`Capability verifier self-test failed (${expectedRule}).`);
  }
}
for (const [file, fixture] of positiveFixtures) {
  if (scanText(file, fixture).length !== 0) {
    throw new Error("Capability verifier positive self-test failed.");
  }
}

const walked = walkSource(sourceRoot);
const findings = [...walked.findings];
for (const sourcePath of walked.files) {
  findings.push(
    ...scanText(normalizedRelative(sourcePath), readFileSync(sourcePath, "utf8")),
  );
}

findings.sort((left, right) =>
  [left.file, left.line, left.column, left.rule]
    .join(":")
    .localeCompare([right.file, right.line, right.column, right.rule].join(":")),
);

if (findings.length > 0) {
  for (const finding of findings) {
    process.stderr.write(
      `${finding.file}:${finding.line}:${finding.column} [${finding.rule}] ${finding.reason}\n`,
    );
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    `capability boundary verified (${walked.files.length} source files, ${negativeFixtures.length} negative fixtures)\n`,
  );
}
