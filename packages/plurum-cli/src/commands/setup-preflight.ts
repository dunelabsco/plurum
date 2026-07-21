import type { ClientTarget } from "./types.js";
import { DEFAULT_API_ORIGIN } from "../credentials/origin.js";
import { resolveCredentialLocations } from "../credentials/paths.js";
import {
  HOST_IDS,
  type DesiredHostConfiguration,
  type HostAction,
  type HostId,
  type HostPlanClassification,
  type HostPreflightPlan,
  type HostRollbackRecipe,
} from "../hosts/contracts.js";
import {
  claudeCodeApplyCommand,
  claudeCodeCommandSpecification,
  claudeCodeRollbackCommand,
} from "../hosts/claude-code/commands.js";
import {
  CLAUDE_CODE_DESIRED_CONFIGURATION,
} from "../hosts/claude-code/configuration.js";
import {
  codexApplyCommand,
  codexCommandSpecification,
  codexRollbackCommand,
} from "../hosts/codex/commands.js";
import {
  CODEX_DESIRED_CONFIGURATION,
} from "../hosts/codex/configuration.js";
import { createHostPreflightPlan } from "../hosts/planner.js";
import {
  containsHostControlCharacter,
  containsHostSensitiveMaterial,
} from "../hosts/privacy.js";
import type {
  HostPreflightCapabilities,
  PlanningCapabilities,
  SetupPreflightCapabilities,
} from "../system/contracts.js";

const MAX_DISPLAY_CHARACTERS = 32_767;
const UNSAFE_TERMINAL_FORMATTING = /[\p{Cf}\u2028\u2029]/u;

const DESIRED_BY_HOST: Readonly<
  Record<HostId, DesiredHostConfiguration>
> = Object.freeze({
  "claude-code": CLAUDE_CODE_DESIRED_CONFIGURATION,
  codex: CODEX_DESIRED_CONFIGURATION,
});

const BLOCKING_CLASSIFICATIONS: ReadonlySet<HostPlanClassification> =
  new Set([
    "unsafe",
    "unsupported-version",
    "direct-only",
    "duplicate",
    "mismatched",
    "ambiguous",
    "irreversible",
  ]);

export type SetupPreflightReadiness =
  | "ready"
  | "no-op"
  | "blocked"
  | "unavailable";

export type SetupHostPreviewClassification =
  | HostPlanClassification
  | "inspection-failed";

export interface SetupCommandPreview {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly shell: false;
  readonly scope: "user";
}

export interface SetupMutationPreview {
  readonly id: string;
  readonly client: HostId;
  readonly kind: HostAction["kind"];
  readonly description: string;
  readonly rollbackKind: HostRollbackRecipe["kind"];
  readonly apply: SetupCommandPreview;
  readonly rollback: SetupCommandPreview;
}

export interface SetupHostPreview {
  readonly client: HostId;
  readonly classification: SetupHostPreviewClassification;
  readonly automatic: boolean;
  readonly detectedVersion: string | null;
  readonly minimumVersion: string;
  readonly executable: Readonly<{
    readonly sourcePath: string;
    readonly resolvedPath: string;
    readonly launchExecutable: string;
    readonly argumentPrefix: readonly string[];
    readonly shell: false;
  }> | null;
  readonly desired: Readonly<{
    readonly marketplace: Readonly<{
      readonly name: "plurum";
      readonly source: string;
    }>;
    readonly plugin: Readonly<{
      readonly name: "plurum";
      readonly source: string;
      readonly version: string;
      readonly compatibleMinimum: string;
      readonly compatibleMaximumExclusive: string;
    }>;
    readonly mcp: Readonly<{
      readonly name: "plurum";
      readonly endpoint: string;
    }>;
  }>;
  readonly explanation: string;
}

declare const setupPreflightSnapshotBrand: unique symbol;

/*
 * This is the public half of one mutation-authority-derived apply inspection.
 * Exact semantic host plans are retained in a module-private WeakMap so
 * accidental serialization cannot expose executable attestations, revisions,
 * baselines, or rollback state. Apply composition must recover them from this
 * exact snapshot instead of inspecting or planning a second time.
 */
export interface SetupPreflightSnapshot {
  readonly [setupPreflightSnapshotBrand]: never;
  readonly requestedTarget: ClientTarget;
  readonly selectedClients: readonly HostId[];
  readonly readiness: SetupPreflightReadiness;
  readonly services: Readonly<{
    readonly apiOrigin: string;
    readonly mcpEndpoint: string;
  }>;
  readonly destinations: SetupDryRunPreflight["destinations"];
  readonly hosts: readonly SetupHostPreview[];
  readonly mutations: readonly SetupMutationPreview[];
}

type SetupPreflightData = Omit<
  SetupPreflightSnapshot,
  typeof setupPreflightSnapshotBrand
>;

interface InspectedSetupPreflight {
  readonly publicData: SetupPreflightData;
  readonly plans: readonly HostPreflightPlan[];
}

export interface SetupDryRunPreflight {
  readonly schemaVersion: 1;
  readonly mode: "dry-run";
  readonly requestedTarget: ClientTarget;
  readonly selectedClients: readonly HostId[];
  readonly readiness: SetupPreflightReadiness;
  readonly services: Readonly<{
    readonly apiOrigin: string;
    readonly mcpEndpoint: string;
  }>;
  readonly destinations: readonly Readonly<{
    readonly kind:
      | "credential-directory"
      | "canonical-credential"
      | "setup-lock"
      | "credential-transaction";
    readonly path: string;
    readonly futureEffect:
      | "may-create"
      | "may-create-or-replace";
  }>[];
  readonly credential: Readonly<{
    readonly status: "not-inspected";
  }>;
  readonly hosts: readonly SetupHostPreview[];
  readonly mutations: readonly SetupMutationPreview[];
  readonly confirmation: "not-requested";
}

class SetupPreflightError extends Error {
  constructor() {
    super("The setup preflight could not be created safely.");
    this.name = "SetupPreflightError";
  }
}

const RETAINED_HOST_PLANS = new WeakMap<
  SetupPreflightSnapshot,
  readonly HostPreflightPlan[]
>();

function invalidPreflight(): never {
  throw new SetupPreflightError();
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

export function setupDisplayText(
  value: unknown,
  maximumLength = MAX_DISPLAY_CHARACTERS,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    containsHostControlCharacter(value) ||
    containsHostSensitiveMaterial(value) ||
    UNSAFE_TERMINAL_FORMATTING.test(value)
  ) {
    return invalidPreflight();
  }
  return value;
}

function selectedClients(target: ClientTarget): readonly HostId[] {
  return Object.freeze(
    target === "all" ? [...HOST_IDS] : [target],
  );
}

function desiredPreview(
  desired: DesiredHostConfiguration,
): SetupHostPreview["desired"] {
  return {
    marketplace: {
      name: "plurum",
      source: setupDisplayText(desired.marketplace.source),
    },
    plugin: {
      name: "plurum",
      source: setupDisplayText(desired.plugin.source),
      version: setupDisplayText(desired.plugin.version, 128),
      compatibleMinimum: setupDisplayText(
        desired.plugin.compatibleMinimum,
        128,
      ),
      compatibleMaximumExclusive: setupDisplayText(
        desired.plugin.compatibleMaximumExclusive,
        128,
      ),
    },
    mcp: {
      name: "plurum",
      endpoint: setupDisplayText(desired.mcp.endpoint, 2_048),
    },
  };
}

function commandPreview(
  plan: HostPreflightPlan,
  args: readonly string[],
): SetupCommandPreview {
  if (plan.executable === null) {
    return invalidPreflight();
  }
  return {
    executable: setupDisplayText(
      plan.executable.launch.executable,
    ),
    arguments: [
      ...plan.executable.launch.argumentPrefix.map((argument) =>
        setupDisplayText(argument),
      ),
      ...args.map((argument) => setupDisplayText(argument)),
    ],
    shell: false,
    scope: "user",
  };
}

function mutationPreview(
  plan: HostPreflightPlan,
  action: HostAction,
): SetupMutationPreview {
  if (
    action.host !== plan.host ||
    plan.executable === null ||
    !plan.automatic
  ) {
    return invalidPreflight();
  }

  if (plan.host === "claude-code") {
    const applyCommand = claudeCodeApplyCommand(action.kind);
    const rollbackCommand = claudeCodeRollbackCommand(
      action.rollback.kind,
    );
    if (applyCommand === null || rollbackCommand === null) {
      return invalidPreflight();
    }
    return {
      id: setupDisplayText(action.id, 256),
      client: plan.host,
      kind: action.kind,
      description: setupDisplayText(action.display, 1_024),
      rollbackKind: action.rollback.kind,
      apply: commandPreview(
        plan,
        claudeCodeCommandSpecification(applyCommand).args,
      ),
      rollback: commandPreview(
        plan,
        claudeCodeCommandSpecification(rollbackCommand).args,
      ),
    };
  }

  const applyCommand = codexApplyCommand(action.kind);
  const rollbackCommand = codexRollbackCommand(action.rollback.kind);
  if (applyCommand === null || rollbackCommand === null) {
    return invalidPreflight();
  }
  return {
    id: setupDisplayText(action.id, 256),
    client: plan.host,
    kind: action.kind,
    description: setupDisplayText(action.display, 1_024),
    rollbackKind: action.rollback.kind,
    apply: commandPreview(
      plan,
      codexCommandSpecification(applyCommand).args,
    ),
    rollback: commandPreview(
      plan,
      codexCommandSpecification(rollbackCommand).args,
    ),
  };
}

function hostPreview(plan: HostPreflightPlan): SetupHostPreview {
  const executable =
    plan.executable === null
      ? null
      : {
          sourcePath: setupDisplayText(plan.executable.sourcePath),
          resolvedPath: setupDisplayText(plan.executable.resolvedPath),
          launchExecutable: setupDisplayText(
            plan.executable.launch.executable,
          ),
          argumentPrefix:
            plan.executable.launch.argumentPrefix.map((argument) =>
              setupDisplayText(argument),
            ),
          shell: false as const,
        };
  return {
    client: plan.host,
    classification: plan.classification,
    automatic: plan.automatic,
    detectedVersion:
      plan.detectedVersion === null
        ? null
        : setupDisplayText(plan.detectedVersion, 128),
    minimumVersion: setupDisplayText(plan.minimumVersion, 128),
    executable,
    desired: desiredPreview(plan.desired),
    explanation: setupDisplayText(plan.explanation, 1_024),
  };
}

function inspectionFailedPreview(host: HostId): SetupHostPreview {
  const desired = DESIRED_BY_HOST[host];
  return {
    client: host,
    classification: "inspection-failed",
    automatic: false,
    detectedVersion: null,
    minimumVersion: setupDisplayText(
      desired.minimumHostVersion,
      128,
    ),
    executable: null,
    desired: desiredPreview(desired),
    explanation:
      "The host state could not be inspected safely.",
  };
}

function readinessFor(
  hosts: readonly SetupHostPreview[],
  mutations: readonly SetupMutationPreview[],
): SetupPreflightReadiness {
  if (
    hosts.some(
      ({ classification }) =>
        classification === "inspection-failed" ||
        classification === "unavailable",
    )
  ) {
    return "unavailable";
  }
  if (
    hosts.some(
      ({ classification }) =>
        classification !== "inspection-failed" &&
        BLOCKING_CLASSIFICATIONS.has(classification),
    )
  ) {
    return "blocked";
  }

  const supported = hosts.some(({ classification }) =>
    ["healthy", "healthy-newer", "needs-changes"].includes(
      classification,
    ),
  );
  if (!supported) {
    return "blocked";
  }
  return mutations.length === 0 ? "no-op" : "ready";
}

async function inspectHost(
  host: HostId,
  capabilities: HostPreflightCapabilities,
): Promise<Readonly<{
  host: SetupHostPreview;
  mutations: readonly SetupMutationPreview[];
  plan: HostPreflightPlan | null;
}>> {
  try {
    const inspection =
      await capabilities.hosts.inspection[host].inspect(
        Object.freeze({
          host,
          scope: "user",
          excludedProjectDirectory: capabilities.platform.cwd,
        }),
      );
    const plan = createHostPreflightPlan(
      inspection,
      DESIRED_BY_HOST[host],
    );
    const mutations = plan.actions.map((action) =>
      mutationPreview(plan, action),
    );
    if (
      (plan.classification === "needs-changes") !==
      (mutations.length > 0)
    ) {
      return invalidPreflight();
    }
    return {
      host: hostPreview(plan),
      mutations,
      plan,
    };
  } catch {
    return {
      host: inspectionFailedPreview(host),
      mutations: [],
      plan: null,
    };
  }
}

async function inspectSetupPreflight(
  target: ClientTarget,
  capabilities: HostPreflightCapabilities,
): Promise<InspectedSetupPreflight> {
  const selected = selectedClients(target);
  const locations = resolveCredentialLocations(
    capabilities.platform,
  );
  const destinations: SetupDryRunPreflight["destinations"] = [
    {
      kind: "credential-directory",
      path: setupDisplayText(locations.directory),
      futureEffect: "may-create",
    },
    {
      kind: "canonical-credential",
      path: setupDisplayText(locations.credentials),
      futureEffect: "may-create-or-replace",
    },
    {
      kind: "setup-lock",
      path: setupDisplayText(locations.setupLock),
      futureEffect: "may-create",
    },
    {
      kind: "credential-transaction",
      path: setupDisplayText(
        locations.credentialTransaction,
      ),
      futureEffect: "may-create",
    },
  ];
  const inspected: Array<Awaited<ReturnType<typeof inspectHost>>> = [];
  for (const host of selected) {
    inspected.push(await inspectHost(host, capabilities));
  }

  const hosts = inspected.map((result) => result.host);
  const mutations = inspected.flatMap((result) => result.mutations);
  const endpoint = DESIRED_BY_HOST[selected[0] ?? invalidPreflight()]
    .mcp.endpoint;
  if (
    selected.some(
      (host) => DESIRED_BY_HOST[host].mcp.endpoint !== endpoint,
    )
  ) {
    return invalidPreflight();
  }

  return deepFreeze({
    publicData: {
      requestedTarget: target,
      selectedClients: selected,
      readiness: readinessFor(hosts, mutations),
      services: {
        apiOrigin: setupDisplayText(DEFAULT_API_ORIGIN, 2_048),
        mcpEndpoint: setupDisplayText(endpoint, 2_048),
      },
      destinations,
      hosts,
      mutations,
    },
    plans: Object.freeze(
      inspected.flatMap(({ plan }) =>
        plan === null ? [] : [plan],
      ),
    ),
  });
}

export async function createSetupPreflightSnapshot(
  target: ClientTarget,
  capabilities: SetupPreflightCapabilities,
): Promise<SetupPreflightSnapshot> {
  const inspected = await inspectSetupPreflight(target, capabilities);
  const snapshot = inspected.publicData as SetupPreflightSnapshot;
  RETAINED_HOST_PLANS.set(snapshot, inspected.plans);
  return snapshot;
}

export function retainedSetupHostPlans(
  snapshot: unknown,
): readonly HostPreflightPlan[] {
  if (typeof snapshot !== "object" || snapshot === null) {
    return invalidPreflight();
  }
  const plans = RETAINED_HOST_PLANS.get(
    snapshot as SetupPreflightSnapshot,
  );
  return plans ?? invalidPreflight();
}

export async function createSetupDryRunPreflight(
  target: ClientTarget,
  capabilities: PlanningCapabilities,
): Promise<SetupDryRunPreflight> {
  const { publicData: snapshot } = await inspectSetupPreflight(
    target,
    capabilities,
  );
  return deepFreeze({
    schemaVersion: 1,
    mode: "dry-run",
    requestedTarget: snapshot.requestedTarget,
    selectedClients: snapshot.selectedClients,
    readiness: snapshot.readiness,
    services: snapshot.services,
    destinations: snapshot.destinations,
    credential: {
      status: "not-inspected",
    },
    hosts: snapshot.hosts,
    mutations: snapshot.mutations,
    confirmation: "not-requested",
  });
}
