import { describe, expect, it } from "vitest";

import { HostError } from "../src/hosts/errors.js";
import { validateReconciliationJournalDocument } from "../src/hosts/journal-codec.js";

const OPERATION_ID = "ca908d9f-d901-4dac-b396-7f84377adfc8";
const CREATED_AT = "2026-07-20T12:00:00.000Z";

type MutableRecord = Record<string, any>;

function absentConfiguration(): MutableRecord {
  return {
    marketplace: { status: "absent" },
    plugin: { status: "absent" },
    pluginMcp: { status: "absent" },
    directMcp: { status: "absent" },
  };
}

function marketplaceConfiguration(): MutableRecord {
  return {
    ...absentConfiguration(),
    marketplace: {
      status: "present",
      value: {
        name: "plurum",
        source: "https://github.com/dunelabsco/plurum.git",
      },
    },
  };
}

function installedConfiguration(): MutableRecord {
  return {
    ...marketplaceConfiguration(),
    plugin: {
      status: "present",
      value: {
        name: "plurum",
        source: "@dunelabs/plurum",
        version: "1.2.3",
        enabled: true,
      },
    },
    pluginMcp: {
      status: "present",
      value: {
        name: "plurum",
        endpoint: "https://mcp.plurum.ai/mcp",
      },
    },
  };
}

function hostInput(
  host: "claude-code" | "codex" = "claude-code",
): MutableRecord {
  const absent = absentConfiguration();
  const marketplace = marketplaceConfiguration();
  const installed = installedConfiguration();
  return {
    host,
    stage: "committed",
    executable_revision: "sha256:executable-chain@v1",
    baseline_revision: "etag:baseline-state@v1",
    owned_state_revision: "state+owned=revision~1",
    actions: [
      {
        action_id: `${host}:01:add-marketplace`,
        kind: "add-marketplace",
        stage: "committed",
        before: absent,
        after: marketplace,
        rollback: { kind: "remove-cli-created-marketplace" },
      },
      {
        action_id: `${host}:02:install-plugin`,
        kind: "install-plugin",
        stage: "committed",
        before: marketplace,
        after: installed,
        rollback: { kind: "remove-cli-created-plugin" },
      },
    ],
  };
}

function journalInput(): MutableRecord {
  return {
    schema_version: 1,
    kind: "host-reconciliation",
    operation_id: OPERATION_ID,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    stage: "complete",
    hosts: [hostInput()],
  };
}

function expectInvalid(input: unknown, forbidden?: string): void {
  try {
    validateReconciliationJournalDocument(input);
  } catch (error) {
    expect(error).toBeInstanceOf(HostError);
    expect(error).toMatchObject({
      code: "invalid_reconciliation_journal",
    });
    if (forbidden !== undefined) {
      expect(String(error)).not.toContain(forbidden);
      expect(JSON.stringify(error)).not.toContain(forbidden);
    }
    return;
  }
  throw new Error("invalid reconciliation journal unexpectedly accepted");
}

function setStages(
  input: MutableRecord,
  operation: string,
  host: string,
  actions: readonly string[],
): MutableRecord {
  input.stage = operation;
  input.hosts[0].stage = host;
  for (const [index, stage] of actions.entries()) {
    input.hosts[0].actions[index].stage = stage;
  }
  return input;
}

function withOwnership(
  input: MutableRecord,
  revision: string | null,
): MutableRecord {
  input.hosts[0].owned_state_revision = revision;
  return input;
}

describe("host reconciliation journal privacy", () => {
  it("retains public repository URLs, package identifiers, endpoints, and opaque revisions", () => {
    const journal = validateReconciliationJournalDocument(journalInput());
    const host = journal.hosts[0];

    expect(host?.executable_revision).toBe("sha256:executable-chain@v1");
    expect(host?.baseline_revision).toBe("etag:baseline-state@v1");
    expect(host?.owned_state_revision).toBe("state+owned=revision~1");
    expect(
      host?.actions[0]?.after.marketplace.status === "present"
        ? host.actions[0].after.marketplace.value.source
        : undefined,
    ).toBe("https://github.com/dunelabsco/plurum.git");
    expect(
      host?.actions[1]?.after.plugin.status === "present"
        ? host.actions[1].after.plugin.value.source
        : undefined,
    ).toBe("@dunelabs/plurum");
    expect(
      host?.actions[1]?.after.pluginMcp.status === "present"
        ? host.actions[1].after.pluginMcp.value.endpoint
        : undefined,
    ).toBe("https://mcp.plurum.ai/mcp");
  });

  it.each([
    "/Users/alice/.claude/plugins/plurum",
    "/home/alice/.codex/plugins/plurum",
    "C:\\Users\\alice\\AppData\\Roaming\\Plurum",
    "C:Users\\alice\\AppData\\Roaming\\Plurum",
    "\\\\server\\users\\alice\\plurum",
    "file:///home/alice/.config/plurum",
    "~/Library/Application Support/Plurum",
    "~alice/.config/plurum",
    "../private/plurum",
    "$HOME/.config/plurum",
    "${HOME}/.config/plurum",
    "%APPDATA%\\Plurum",
  ])("rejects personal path %j from every public source field", (path) => {
    const marketplace = journalInput();
    marketplace.hosts[0].actions[0].after.marketplace.value.source = path;
    marketplace.hosts[0].actions[1].before.marketplace.value.source = path;
    marketplace.hosts[0].actions[1].after.marketplace.value.source = path;
    expectInvalid(marketplace, path);

    const plugin = journalInput();
    plugin.hosts[0].actions[1].after.plugin.value.source = path;
    expectInvalid(plugin, path);

    const endpoint = journalInput();
    endpoint.hosts[0].actions[1].after.pluginMcp.value.endpoint = path;
    expectInvalid(endpoint, path);
  });

  it.each([
    "/Users/alice/.claude/revision",
    "C:\\Users\\alice\\.codex\\revision",
    "C:Users\\alice\\.codex\\revision",
    "file:///home/alice/revision",
    "~/private-revision",
    "~alice/private-revision",
    "../private-revision",
    "$HOME/private-revision",
    "revision:/Users/alice/private-revision",
    "sha256:public-prefix/home/alice/private-revision",
    "revision:\\Users\\alice\\private-revision",
  ])("rejects rooted or embedded path material from revision fields: %j", (path) => {
    for (const field of [
      "executable_revision",
      "baseline_revision",
      "owned_state_revision",
    ]) {
      const input = journalInput();
      input.hosts[0][field] = path;
      expectInvalid(input, path);
    }
  });

  it.each([
    "plrm_test_NEVER_ALLOWED_IN_JOURNAL",
    "plrm_live_NEVER_ALLOWED_IN_JOURNAL",
    "Bearer NEVER_ALLOWED_IN_JOURNAL",
    "authorization: Bearer NEVER_ALLOWED_IN_JOURNAL",
    "api-key=NEVER_ALLOWED_IN_JOURNAL",
    "access_token:NEVER_ALLOWED_IN_JOURNAL",
    "secret=NEVER_ALLOWED_IN_JOURNAL",
    "password=NEVER_ALLOWED_IN_JOURNAL",
  ])("rejects secret-bearing public journal value %j", (secret) => {
    const marketplace = journalInput();
    marketplace.hosts[0].actions[0].after.marketplace.value.source = secret;
    expectInvalid(marketplace, secret);

    const plugin = journalInput();
    plugin.hosts[0].actions[1].after.plugin.value.source = secret;
    plugin.hosts[0].actions[1].after.plugin.value.version = secret;
    expectInvalid(plugin, secret);

    const endpoint = journalInput();
    endpoint.hosts[0].actions[1].after.pluginMcp.value.endpoint = secret;
    expectInvalid(endpoint, secret);

    for (const field of [
      "executable_revision",
      "baseline_revision",
      "owned_state_revision",
    ]) {
      const revision = journalInput();
      revision.hosts[0][field] = secret;
      expectInvalid(revision, secret);
    }
  });
});

describe("host reconciliation journal progress reachability", () => {
  it.each([
    {
      name: "complete operation before host commit",
      operation: "complete",
      host: "commit-started",
      actions: ["committed", "committed"],
    },
    {
      name: "committed host with an uncommitted action",
      operation: "complete",
      host: "committed",
      actions: ["committed", "verified"],
    },
    {
      name: "apply operation carrying verify progress",
      operation: "apply",
      host: "verify-started",
      actions: ["verify-started", "pending"],
    },
    {
      name: "verify operation carrying only applied progress",
      operation: "verify",
      host: "apply-complete",
      actions: ["applied", "pending"],
    },
    {
      name: "later action applying before its predecessor verifies",
      operation: "apply",
      host: "apply-started",
      actions: ["pending", "apply-started"],
    },
    {
      name: "two simultaneously active actions",
      operation: "apply",
      host: "apply-started",
      actions: ["apply-started", "apply-started"],
    },
    {
      name: "commit advancing actions out of order",
      operation: "commit",
      host: "commit-started",
      actions: ["verified", "committed"],
    },
    {
      name: "rollback without a failure or reverse progress",
      operation: "rollback",
      host: "rollback-started",
      actions: ["verified", "pending"],
    },
    {
      name: "rollback advancing in forward order",
      operation: "rollback",
      host: "rollback-started",
      actions: ["rolled-back", "verified"],
    },
    {
      name: "failed operation without a failed or restored host",
      operation: "failed",
      host: "rollback-started",
      actions: ["rollback-started", "rolled-back"],
    },
  ])("rejects $name", ({ operation, host, actions }) => {
    expectInvalid(setStages(journalInput(), operation, host, actions));
  });

  it("rejects more than one active host and unreachable cross-host ordering", () => {
    const twoActive = setStages(
      journalInput(),
      "apply",
      "apply-started",
      ["apply-started", "pending"],
    );
    const codexActive = hostInput("codex");
    codexActive.stage = "verify-started";
    codexActive.actions[0].stage = "verify-started";
    codexActive.actions[1].stage = "pending";
    twoActive.hosts.push(codexActive);
    expectInvalid(twoActive);

    const outOfOrder = journalInput();
    outOfOrder.stage = "commit";
    outOfOrder.hosts[0] = hostInput();
    outOfOrder.hosts[0].stage = "pending";
    outOfOrder.hosts[0].owned_state_revision = null;
    outOfOrder.hosts[0].actions[0].stage = "pending";
    outOfOrder.hosts[0].actions[1].stage = "pending";
    outOfOrder.hosts.push(hostInput("codex"));
    expectInvalid(outOfOrder);

    const wrongBetweenHostsStage = journalInput();
    wrongBetweenHostsStage.stage = "apply";
    const codexPending = hostInput("codex");
    codexPending.stage = "pending";
    codexPending.owned_state_revision = null;
    codexPending.actions[0].stage = "pending";
    codexPending.actions[1].stage = "pending";
    wrongBetweenHostsStage.hosts.push(codexPending);
    expectInvalid(wrongBetweenHostsStage);

    wrongBetweenHostsStage.stage = "commit";
    expect(() =>
      validateReconciliationJournalDocument(wrongBetweenHostsStage),
    ).not.toThrow();
  });

  it.each([
    {
      operation: "apply",
      host: "pending",
      actions: ["pending", "pending"],
      revision: null,
    },
    {
      operation: "apply",
      host: "apply-started",
      actions: ["verified", "apply-started"],
      revision: "state:owned",
    },
    {
      operation: "apply",
      host: "apply-complete",
      actions: ["verified", "applied"],
      revision: "state:owned",
    },
    {
      operation: "verify",
      host: "verify-started",
      actions: ["verified", "verify-started"],
      revision: "state:owned",
    },
    {
      operation: "verify",
      host: "verify-complete",
      actions: ["verified", "verified"],
      revision: "state:owned",
    },
    {
      operation: "commit",
      host: "commit-started",
      actions: ["committed", "verified"],
      revision: "state:owned",
    },
    {
      operation: "rollback",
      host: "rollback-started",
      actions: ["rollback-started", "rolled-back"],
      revision: "state:owned",
    },
    {
      operation: "failed",
      host: "failed",
      actions: ["failed", "rolled-back"],
      revision: "state:owned",
    },
    {
      operation: "failed",
      host: "rolled-back",
      actions: ["rolled-back", "pending"],
      revision: null,
    },
    {
      operation: "complete",
      host: "committed",
      actions: ["committed", "committed"],
      revision: "state:owned",
    },
  ])(
    "accepts reachable $operation/$host progress",
    ({ operation, host, actions, revision }) => {
      expect(() =>
        validateReconciliationJournalDocument(
          withOwnership(
            setStages(journalInput(), operation, host, actions),
            revision,
          ),
        ),
      ).not.toThrow();
    },
  );
});

describe("host reconciliation journal mutation ownership", () => {
  it.each([
    {
      name: "pending host claiming mutation ownership",
      operation: "apply",
      host: "pending",
      actions: ["pending", "pending"],
      revision: "state:unexpected",
    },
    {
      name: "first action start claiming ownership before mutation",
      operation: "apply",
      host: "apply-started",
      actions: ["apply-started", "pending"],
      revision: "state:unexpected",
    },
    {
      name: "later action start missing ownership of verified prefix",
      operation: "apply",
      host: "apply-started",
      actions: ["verified", "apply-started"],
      revision: null,
    },
    {
      name: "applied action without a changed-state receipt",
      operation: "apply",
      host: "apply-complete",
      actions: ["applied", "pending"],
      revision: null,
    },
    {
      name: "verification without mutation ownership",
      operation: "verify",
      host: "verify-started",
      actions: ["verify-started", "pending"],
      revision: null,
    },
    {
      name: "commit without mutation ownership",
      operation: "commit",
      host: "commit-started",
      actions: ["commit-started", "verified"],
      revision: null,
    },
    {
      name: "committed host without mutation ownership",
      operation: "complete",
      host: "committed",
      actions: ["committed", "committed"],
      revision: null,
    },
    {
      name: "fully rolled-back host retaining mutation ownership",
      operation: "failed",
      host: "rolled-back",
      actions: ["rolled-back", "pending"],
      revision: "state:stale",
    },
    {
      name: "later-action failure missing ownership",
      operation: "failed",
      host: "failed",
      actions: ["verified", "failed"],
      revision: null,
    },
    {
      name: "rollback progress beyond the first action missing ownership",
      operation: "rollback",
      host: "rollback-started",
      actions: ["verified", "rollback-started"],
      revision: null,
    },
    {
      name: "first-action failure with impossible later rollback and no ownership",
      operation: "failed",
      host: "failed",
      actions: ["failed", "rolled-back"],
      revision: null,
    },
  ])(
    "rejects $name",
    ({ operation, host, actions, revision }) => {
      expectInvalid(
        withOwnership(
          setStages(journalInput(), operation, host, actions),
          revision,
        ),
      );
    },
  );

  it.each([
    {
      name: "initial apply marker before any mutation",
      operation: "apply",
      host: "apply-started",
      actions: ["apply-started", "pending"],
      revision: null,
    },
    {
      name: "later apply marker retaining ownership",
      operation: "apply",
      host: "apply-started",
      actions: ["verified", "apply-started"],
      revision: "state:owned",
    },
    {
      name: "first-action pre-mutation failure",
      operation: "failed",
      host: "failed",
      actions: ["failed", "pending"],
      revision: null,
    },
    {
      name: "first-action pre-mutation rollback from failure",
      operation: "rollback",
      host: "rollback-started",
      actions: ["failed", "pending"],
      revision: null,
    },
    {
      name: "first-action historical recovery marker",
      operation: "rollback",
      host: "rollback-started",
      actions: ["rollback-started", "pending"],
      revision: null,
    },
    {
      name: "first-action exact-baseline rollback marker",
      operation: "rollback",
      host: "rollback-started",
      actions: ["rolled-back", "pending"],
      revision: null,
    },
    {
      name: "completed rollback relinquishing ownership",
      operation: "failed",
      host: "rolled-back",
      actions: ["rolled-back", "pending"],
      revision: null,
    },
  ])(
    "accepts $name",
    ({ operation, host, actions, revision }) => {
      expect(() =>
        validateReconciliationJournalDocument(
          withOwnership(
            setStages(journalInput(), operation, host, actions),
            revision,
          ),
        ),
      ).not.toThrow();
    },
  );
});
