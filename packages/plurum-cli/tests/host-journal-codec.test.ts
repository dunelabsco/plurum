import { describe, expect, it } from "vitest";

import type {
  HostConfiguration,
  HostRollbackRecipe,
} from "../src/hosts/contracts.js";
import { HostError } from "../src/hosts/errors.js";
import {
  MAX_RECONCILIATION_JOURNAL_BYTES,
  MAX_RECONCILIATION_JOURNAL_CHARACTERS,
  parseReconciliationJournalDocument,
  parseReconciliationJournalDocumentBytes,
  serializeReconciliationJournalDocument,
  serializeReconciliationJournalDocumentBytes,
  validateReconciliationActionId,
  validateReconciliationJournalDocument,
  validateReconciliationJournalLeaseNonce,
  validateReconciliationOperationId,
} from "../src/hosts/journal-codec.js";
import {
  RECONCILIATION_ACTION_STAGES,
  RECONCILIATION_HOST_STAGES,
  RECONCILIATION_JOURNAL_KIND,
  RECONCILIATION_JOURNAL_SCHEMA_VERSION,
  RECONCILIATION_OPERATION_STAGES,
  type ReconciliationJournalLease,
  type ReconciliationJournalLeaseAcquireResult,
  type ReconciliationJournalLeaseNonce,
  type ReconciliationJournalRevisionSnapshot,
  type ReconciliationJournalStoreAdapter,
  type ReconciliationJournalV1,
} from "../src/hosts/journal-contracts.js";

const OPERATION_ID = "ca908d9f-d901-4dac-b396-7f84377adfc8";
const ACTION_ID_ONE = "claude-code:01:add-marketplace";
const ACTION_ID_TWO = "claude-code:02:install-plugin";
const UPDATE_ACTION_ID = "claude-code:01:update-plugin";
const LEASE_NONCE = "5b4f52d6-15fe-467f-8f76-a47e16c2250e";
const CREATED_AT = "2026-07-20T12:00:00.000Z";
const UPDATED_AT = "2026-07-20T12:01:00.000Z";

const absentSlot = Object.freeze({ status: "absent" as const });

function configuration(
  overrides: Partial<HostConfiguration> = {},
): HostConfiguration {
  return {
    marketplace: absentSlot,
    plugin: absentSlot,
    pluginMcp: absentSlot,
    directMcp: absentSlot,
    ...overrides,
  };
}

function marketplacePresent() {
  return {
    status: "present" as const,
    value: {
      name: "plurum" as const,
      source: "https://github.com/dunelabsco/plurum.git",
    },
  };
}

function pluginPresent(enabled = true, version = "1.2.3") {
  return {
    status: "present" as const,
    value: {
      name: "plurum" as const,
      source: "dunelabsco/plurum",
      version,
      enabled,
    },
  };
}

function pluginMcpPresent() {
  return {
    status: "present" as const,
    value: {
      name: "plurum" as const,
      endpoint: "https://mcp.plurum.ai/mcp",
    },
  };
}

function addMarketplaceAction() {
  const before = configuration();
  const after = configuration({ marketplace: marketplacePresent() });
  return {
    action_id: ACTION_ID_ONE,
    kind: "add-marketplace",
    stage: "committed",
    before,
    after,
    rollback: {
      kind: "remove-cli-created-marketplace",
    } satisfies HostRollbackRecipe,
  };
}

function installPluginAction() {
  const before = configuration({ marketplace: marketplacePresent() });
  const after = configuration({
    marketplace: marketplacePresent(),
    plugin: pluginPresent(),
    pluginMcp: pluginMcpPresent(),
  });
  return {
    action_id: ACTION_ID_TWO,
    kind: "install-plugin",
    stage: "committed",
    before,
    after,
    rollback: {
      kind: "remove-cli-created-plugin",
    } satisfies HostRollbackRecipe,
  };
}

function updatePluginAction(
  beforeVersion = "1.2.3",
  afterVersion = "1.2.4",
  rollbackVersion = beforeVersion,
) {
  const before = configuration({
    marketplace: marketplacePresent(),
    plugin: pluginPresent(true, beforeVersion),
    pluginMcp: pluginMcpPresent(),
  });
  const after = configuration({
    marketplace: marketplacePresent(),
    plugin: pluginPresent(true, afterVersion),
    pluginMcp: pluginMcpPresent(),
  });
  return {
    action_id: UPDATE_ACTION_ID,
    kind: "update-plugin",
    stage: "committed",
    before,
    after,
    rollback: {
      kind: "restore-plugin-version",
      pluginVersion: rollbackVersion,
    } satisfies HostRollbackRecipe,
  };
}

function journalInput(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: RECONCILIATION_JOURNAL_SCHEMA_VERSION,
    kind: RECONCILIATION_JOURNAL_KIND,
    operation_id: OPERATION_ID,
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
    stage: "complete",
    hosts: [
      {
        host: "claude-code",
        stage: "committed",
        executable_revision: "claude-chain-revision-1",
        baseline_revision: "claude-state-revision-1",
        owned_state_revision: "claude-owned-state-revision-2",
        actions: [addMarketplaceAction(), installPluginAction()],
      },
    ],
    ...overrides,
  };
}

function updateJournalInput(
  beforeVersion = "1.2.3",
  afterVersion = "1.2.4",
  rollbackVersion = beforeVersion,
) {
  return journalInput({
    hosts: [
      {
        host: "claude-code",
        stage: "committed",
        executable_revision: "claude-chain-revision-1",
        baseline_revision: "claude-state-revision-1",
        owned_state_revision: "claude-owned-state-revision-2",
        actions: [
          updatePluginAction(
            beforeVersion,
            afterVersion,
            rollbackVersion,
          ),
        ],
      },
    ],
  });
}

function expectJournalError(
  attempt: () => unknown,
  code:
    | "invalid_reconciliation_journal"
    | "unsupported_reconciliation_journal_schema" =
    "invalid_reconciliation_journal",
): void {
  try {
    attempt();
  } catch (error) {
    if (!(error instanceof HostError)) {
      throw new Error("journal validation raised an unsafe error type");
    }
    expect(error.code).toBe(code);
    expect(String(error)).not.toContain("plrm_live_");
    expect(String(error)).not.toContain("PLURUM_API_KEY");
    expect(String(error)).not.toContain("Authorization");
    expect(JSON.stringify(error)).not.toContain("plrm_live_");
    return;
  }
  throw new Error("invalid reconciliation journal unexpectedly accepted");
}

describe("host reconciliation journal codec", () => {
  it("round-trips exact canonical JSON as deeply frozen defensive data", () => {
    const input = journalInput();
    const journal = validateReconciliationJournalDocument(input);

    expect((journal as unknown) === input).toBe(false);
    expect(Object.isFrozen(journal)).toBe(true);
    expect(Object.isFrozen(journal.hosts)).toBe(true);
    expect(Object.isFrozen(journal.hosts[0])).toBe(true);
    expect(Object.isFrozen(journal.hosts[0]?.actions)).toBe(true);
    expect(Object.isFrozen(journal.hosts[0]?.actions[0])).toBe(true);
    expect(
      Object.isFrozen(journal.hosts[0]?.actions[0]?.after.marketplace),
    ).toBe(true);
    expect(
      Object.isFrozen(
        journal.hosts[0]?.actions[0]?.after.marketplace.status === "present"
          ? journal.hosts[0].actions[0].after.marketplace.value
          : null,
      ),
    ).toBe(true);

    const serialized = serializeReconciliationJournalDocument(journal);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(parseReconciliationJournalDocument(serialized)).toEqual(journal);

    const mutableInput = journalInput();
    const validated = validateReconciliationJournalDocument(mutableInput);
    const mutableHost = (
      mutableInput.hosts as Array<{
        executable_revision: string;
      }>
    )[0];
    if (mutableHost !== undefined) {
      mutableHost.executable_revision = "mutated";
    }
    expect(validated.hosts[0]?.executable_revision).toBe(
      "claude-chain-revision-1",
    );
  });

  it("records public before/after recovery semantics without process data", () => {
    const journal = validateReconciliationJournalDocument(journalInput());
    const actions = journal.hosts[0]?.actions;

    expect(actions?.map((action) => action.kind)).toEqual([
      "add-marketplace",
      "install-plugin",
    ]);
    expect(actions?.[0]?.before.marketplace.status).toBe("absent");
    expect(actions?.[0]?.after.marketplace.status).toBe("present");
    expect(actions?.[1]?.before).toEqual(actions?.[0]?.after);
    expect(actions?.[1]?.after.plugin.status).toBe("present");
    expect(JSON.stringify(journal)).not.toContain("output");
    expect(JSON.stringify(journal)).not.toContain("environment");
    expect(JSON.stringify(journal)).not.toContain("command");
  });

  it("accepts only lowercase RFC 4122 version 4 operation and lease IDs", () => {
    expect(validateReconciliationOperationId(OPERATION_ID)).toBe(OPERATION_ID);
    expect(validateReconciliationJournalLeaseNonce(LEASE_NONCE)).toBe(
      LEASE_NONCE,
    );

    for (const value of [
      OPERATION_ID.toUpperCase(),
      "ca908d9f-d901-1dac-b396-7f84377adfc8",
      "ca908d9f-d901-4dac-7396-7f84377adfc8",
      "00000000-0000-0000-0000-000000000000",
      "",
      null,
    ]) {
      expectJournalError(() => validateReconciliationOperationId(value));
      expectJournalError(() =>
        validateReconciliationJournalLeaseNonce(value),
      );
    }
  });

  it("binds deterministic action IDs to host, ordinal, and action kind", () => {
    expect(validateReconciliationActionId(ACTION_ID_ONE)).toBe(ACTION_ID_ONE);
    expect(validateReconciliationActionId(ACTION_ID_TWO)).toBe(ACTION_ID_TWO);

    for (const value of [
      "claude-code:1:add-marketplace",
      "claude-code:01:remove-plugin",
      "CLAUDE-CODE:01:add-marketplace",
      "unknown:01:add-marketplace",
      "",
      null,
    ]) {
      expectJournalError(() => validateReconciliationActionId(value));
    }

    const wrongBinding = journalInput();
    const action = wrongBinding.hosts[0]?.actions[0];
    if (action !== undefined) {
      action.action_id = "codex:01:add-marketplace";
    }
    expectJournalError(() =>
      validateReconciliationJournalDocument(wrongBinding),
    );
  });

  it("distinguishes unsupported schemas from malformed schema values", () => {
    for (const schemaVersion of [0, 2, 999]) {
      expectJournalError(
        () =>
          validateReconciliationJournalDocument(
            journalInput({ schema_version: schemaVersion }),
          ),
        "unsupported_reconciliation_journal_schema",
      );
    }
    for (const schemaVersion of [null, "1", 1.5]) {
      expectJournalError(() =>
        validateReconciliationJournalDocument(
          journalInput({ schema_version: schemaVersion }),
        ),
      );
    }
  });

  it("exposes explicit apply, verify, commit, and rollback recovery stages", () => {
    expect(RECONCILIATION_OPERATION_STAGES).toEqual([
      "apply",
      "verify",
      "commit",
      "rollback",
      "complete",
      "failed",
    ]);
    expect(RECONCILIATION_HOST_STAGES).toContain("apply-started");
    expect(RECONCILIATION_HOST_STAGES).toContain("verify-started");
    expect(RECONCILIATION_HOST_STAGES).toContain("commit-started");
    expect(RECONCILIATION_HOST_STAGES).toContain("rollback-started");
    expect(RECONCILIATION_ACTION_STAGES).toContain("applied");
    expect(RECONCILIATION_ACTION_STAGES).toContain("verified");
    expect(RECONCILIATION_ACTION_STAGES).toContain("committed");
    expect(RECONCILIATION_ACTION_STAGES).toContain("rolled-back");
  });

  it("rejects secrets, raw output, environment snapshots, and arbitrary fields", () => {
    const secretMarkers = [
      `https://example.invalid/${`plrm_live_${"S".repeat(43)}`}`,
      "Authorization: Bearer public-looking-value",
      "PLURUM_API_KEY",
    ];
    for (const marker of secretMarkers) {
      const input = journalInput();
      const host = input.hosts[0];
      if (host !== undefined) {
        host.executable_revision = marker;
      }
      expectJournalError(() =>
        validateReconciliationJournalDocument(input),
      );
    }

    for (const extra of [
      { output: "host stdout" },
      { environment: { PATH: "/usr/bin" } },
      { command: ["claude", "plugin", "install"] },
      { arbitrary: true },
    ]) {
      expectJournalError(() =>
        validateReconciliationJournalDocument({
          ...journalInput(),
          ...extra,
        }),
      );
    }

    const nestedExtra = journalInput();
    const firstAction = nestedExtra.hosts[0]?.actions[0];
    if (firstAction !== undefined) {
      Object.assign(firstAction, { stdout: "raw" });
    }
    expectJournalError(() =>
      validateReconciliationJournalDocument(nestedExtra),
    );
  });

  it("rejects URL userinfo and private-key markers in public values", () => {
    const unsafeValues = [
      "https://user@example.invalid/plurum.git",
      "https://user:hunter2@example.invalid/plurum.git",
      "SSH://git@example.invalid/plurum.git",
      "-----BEGIN PRIVATE KEY-----",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "-----BEGIN PGP PRIVATE KEY BLOCK-----",
    ];
    for (const unsafe of unsafeValues) {
      for (const target of ["marketplace", "plugin"] as const) {
        const input: any = journalInput();
        if (target === "marketplace") {
          input.hosts[0].actions[0].after.marketplace.value.source = unsafe;
          input.hosts[0].actions[1].before.marketplace.value.source = unsafe;
          input.hosts[0].actions[1].after.marketplace.value.source = unsafe;
        } else {
          input.hosts[0].actions[1].after.plugin.value.source = unsafe;
        }
        expectJournalError(() =>
          validateReconciliationJournalDocument(input),
        );
      }
    }

    const ordinaryPublicValue: any = journalInput();
    ordinaryPublicValue.hosts[0].actions[0].after.marketplace.value.source =
      "https://example.invalid/private-key-guidance.git";
    ordinaryPublicValue.hosts[0].actions[1].before.marketplace.value.source =
      "https://example.invalid/private-key-guidance.git";
    ordinaryPublicValue.hosts[0].actions[1].after.marketplace.value.source =
      "https://example.invalid/private-key-guidance.git";
    expect(() =>
      validateReconciliationJournalDocument(ordinaryPublicValue),
    ).not.toThrow();
  });

  it("requires canonical plugin and rollback versions", () => {
    for (const version of [
      "latest",
      "--force",
      "v1.2.3",
      "01.2.3",
      "1.2.3-alpha",
      "1.2",
      "",
    ]) {
      const installed: any = journalInput();
      installed.hosts[0].actions[1].after.plugin.value.version = version;
      expectJournalError(() =>
        validateReconciliationJournalDocument(installed),
      );

      expectJournalError(() =>
        validateReconciliationJournalDocument(
          updateJournalInput(version, "2.0.0", version),
        ),
      );
      expectJournalError(() =>
        validateReconciliationJournalDocument(
          updateJournalInput("1.2.3", "2.0.0", version),
        ),
      );
    }

    expectJournalError(() =>
      validateReconciliationJournalDocument(
        updateJournalInput("1.2.3", "2.0.0", "1.2.2"),
      ),
    );
  });

  it("accepts only strict plugin upgrades in update journals", () => {
    expect(() =>
      validateReconciliationJournalDocument(
        updateJournalInput("1.9.0", "1.10.0"),
      ),
    ).not.toThrow();

    for (const [beforeVersion, afterVersion] of [
      ["1.2.3", "1.2.3"],
      ["1.2.3", "1.2.2"],
      ["2.0.0", "1.999.999"],
    ]) {
      expectJournalError(() =>
        validateReconciliationJournalDocument(
          updateJournalInput(beforeVersion, afterVersion),
        ),
      );
    }
  });

  it("requires deterministic hosts, actions, rollback recipes, and continuity", () => {
    const reversedHosts = [
      {
        ...journalInput().hosts[0],
        host: "codex",
      },
      journalInput().hosts[0],
    ];
    expectJournalError(() =>
      validateReconciliationJournalDocument(
        journalInput({ hosts: reversedHosts }),
      ),
    );

    const duplicateActions = journalInput();
    const hostWithDuplicates = duplicateActions.hosts[0];
    if (hostWithDuplicates !== undefined) {
      hostWithDuplicates.actions = [
        addMarketplaceAction(),
        addMarketplaceAction(),
      ];
    }
    expectJournalError(() =>
      validateReconciliationJournalDocument(duplicateActions),
    );

    const brokenContinuity = journalInput();
    const secondAction = brokenContinuity.hosts[0]?.actions[1];
    if (secondAction !== undefined) {
      secondAction.before = configuration();
    }
    expectJournalError(() =>
      validateReconciliationJournalDocument(brokenContinuity),
    );

    const wrongRollback = journalInput();
    const firstAction = wrongRollback.hosts[0]?.actions[0];
    if (firstAction !== undefined) {
      firstAction.rollback = { kind: "remove-cli-created-plugin" };
    }
    expectJournalError(() =>
      validateReconciliationJournalDocument(wrongRollback),
    );
  });

  it("rejects incomplete plugin/MCP state and direct-MCP recovery material", () => {
    const missingManagedMcp: any = journalInput();
    missingManagedMcp.hosts[0].actions[1].after.pluginMcp = {
      status: "absent",
    };
    expectJournalError(() =>
      validateReconciliationJournalDocument(missingManagedMcp),
    );

    const disabledWithManagedMcp: any = journalInput();
    disabledWithManagedMcp.hosts[0].actions[1].after.plugin.value.enabled =
      false;
    expectJournalError(() =>
      validateReconciliationJournalDocument(disabledWithManagedMcp),
    );

    const directMcp: any = journalInput();
    directMcp.hosts[0].actions[0].before.directMcp = {
      status: "present",
      value: {
        name: "plurum",
        endpoint: "https://mcp.plurum.ai/mcp",
      },
    };
    directMcp.hosts[0].actions[0].after.directMcp =
      directMcp.hosts[0].actions[0].before.directMcp;
    directMcp.hosts[0].actions[1].before.directMcp =
      directMcp.hosts[0].actions[0].before.directMcp;
    directMcp.hosts[0].actions[1].after.directMcp =
      directMcp.hosts[0].actions[0].before.directMcp;
    expectJournalError(() =>
      validateReconciliationJournalDocument(directMcp),
    );
  });

  it("requires canonical timestamps, strict field order/text, and bounded input", () => {
    for (const updatedAt of [
      "2026-07-20T12:01:00Z",
      "2026-02-31T12:01:00.000Z",
      "2026-07-20T11:59:59.999Z",
    ]) {
      expectJournalError(() =>
        validateReconciliationJournalDocument(
          journalInput({ updated_at: updatedAt }),
        ),
      );
    }

    const journal = validateReconciliationJournalDocument(journalInput());
    const serialized = serializeReconciliationJournalDocument(journal);
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    const reordered = `${JSON.stringify(
      {
        kind: parsed.kind,
        schema_version: parsed.schema_version,
        operation_id: parsed.operation_id,
        created_at: parsed.created_at,
        updated_at: parsed.updated_at,
        stage: parsed.stage,
        hosts: parsed.hosts,
      },
      null,
      2,
    )}\n`;

    for (const input of [
      "not json",
      `\ufeff${serialized}`,
      serialized.trimEnd(),
      `${serialized.trimEnd()}\r\n`,
      reordered,
      serialized.replace(
        '  "schema_version": 1,',
        '  "schema_version": 1,\n  "schema_version": 1,',
      ),
      "x".repeat(MAX_RECONCILIATION_JOURNAL_CHARACTERS + 1),
    ]) {
      expectJournalError(() => parseReconciliationJournalDocument(input));
    }
  });

  it("round-trips canonical UTF-8 bytes without mutating caller memory", () => {
    const journal = validateReconciliationJournalDocument(journalInput());
    const bytes = serializeReconciliationJournalDocumentBytes(journal);
    const callerCopy = Uint8Array.prototype.slice.call(bytes);
    const parsed = parseReconciliationJournalDocumentBytes(bytes);

    expect(parsed).toEqual(journal);
    expect(bytes.every((value, index) => value === callerCopy[index])).toBe(
      true,
    );

    const bomPrefixed = new Uint8Array(bytes.byteLength + 3);
    bomPrefixed.set([0xef, 0xbb, 0xbf]);
    bomPrefixed.set(bytes, 3);
    for (const invalid of [
      new Uint8Array(),
      new Uint8Array([0xc3, 0x28]),
      bomPrefixed,
      new Uint8Array(MAX_RECONCILIATION_JOURNAL_BYTES + 1),
    ]) {
      expectJournalError(() =>
        parseReconciliationJournalDocumentBytes(invalid),
      );
    }
  });

  it("normalizes hostile property access without reflecting attacker values", () => {
    const hostile = new Proxy(journalInput(), {
      ownKeys() {
        throw new Error(`plrm_live_${"X".repeat(43)}`);
      },
      get(_target, property) {
        if (property === "schema_version") {
          return 1;
        }
        throw new Error("Authorization: attacker-controlled");
      },
    });

    expectJournalError(() =>
      validateReconciliationJournalDocument(hostile),
    );
  });
});

class InMemoryJournalStore implements ReconciliationJournalStoreAdapter {
  private held = false;
  private bytes: Uint8Array | null = null;
  private revision = 0;

  async acquire(
    _options: Readonly<{ nonce: ReconciliationJournalLeaseNonce }>,
  ): Promise<ReconciliationJournalLeaseAcquireResult> {
    if (this.held) {
      return Object.freeze({ status: "busy" });
    }
    this.held = true;
    let active = true;

    const snapshot = (): ReconciliationJournalRevisionSnapshot =>
      Object.freeze({
        revision: this.revision,
      }) as unknown as ReconciliationJournalRevisionSnapshot;
    const matches = (
      candidate: ReconciliationJournalRevisionSnapshot,
    ): boolean =>
      (candidate as unknown as { revision?: unknown }).revision ===
      this.revision;
    const requireActive = (): void => {
      if (!active) {
        throw new Error("inactive fake lease");
      }
    };
    const finish = (): void => {
      requireActive();
      active = false;
      this.held = false;
    };

    const lease: ReconciliationJournalLease = Object.freeze({
      renew: async () => {
        requireActive();
        return Object.freeze({ status: "held" as const });
      },
      observe: async () => {
        requireActive();
        const revision = snapshot();
        return this.bytes === null
          ? Object.freeze({ status: "missing" as const, revision })
          : Object.freeze({
              status: "present" as const,
              revision,
              bytes: Uint8Array.prototype.slice.call(this.bytes),
            });
      },
      replace: async (
        options: Parameters<ReconciliationJournalLease["replace"]>[0],
      ) => {
        requireActive();
        if (!matches(options.expected)) {
          return Object.freeze({ status: "conflict" as const });
        }
        this.bytes = Uint8Array.prototype.slice.call(options.bytes);
        this.revision += 1;
        return Object.freeze({
          status: "replaced" as const,
          revision: snapshot(),
        });
      },
      remove: async (
        options: Parameters<ReconciliationJournalLease["remove"]>[0],
      ) => {
        requireActive();
        if (this.bytes === null || !matches(options.expected)) {
          return Object.freeze({ status: "conflict" as const });
        }
        this.bytes = null;
        this.revision += 1;
        return Object.freeze({ status: "removed" as const });
      },
      release: async () => finish(),
      abandon: async () => finish(),
    });
    return Object.freeze({
      status: "acquired",
      priorLease: "absent",
      lease,
    });
  }
}

describe("protected reconciliation journal capability", () => {
  it("offers lease exclusion and revision-bound CAS without path methods", async () => {
    const store = new InMemoryJournalStore();
    const nonce = validateReconciliationJournalLeaseNonce(LEASE_NONCE);
    const acquired = await store.acquire({ nonce });
    expect(acquired.status).toBe("acquired");
    expect((await store.acquire({ nonce })).status).toBe("busy");
    if (acquired.status !== "acquired") {
      throw new Error("fake journal lease was not acquired");
    }

    expect("path" in acquired.lease).toBe(false);
    expect("open" in acquired.lease).toBe(false);
    const missing = await acquired.lease.observe();
    expect(missing.status).toBe("missing");

    const bytes = serializeReconciliationJournalDocumentBytes(
      validateReconciliationJournalDocument(journalInput()),
    );
    const callerCopy = Uint8Array.prototype.slice.call(bytes);
    const replaced = await acquired.lease.replace({
      expected: missing.revision,
      bytes,
    });
    expect(replaced.status).toBe("replaced");
    bytes.fill(0);

    const present = await acquired.lease.observe();
    expect(present.status).toBe("present");
    if (present.status !== "present" || replaced.status !== "replaced") {
      throw new Error("fake journal replace failed");
    }
    expect(present.bytes).toEqual(callerCopy);
    present.bytes.fill(0);
    expect((await acquired.lease.observe()).status).toBe("present");

    expect(
      await acquired.lease.replace({
        expected: missing.revision,
        bytes: callerCopy,
      }),
    ).toEqual({ status: "conflict" });
    expect(
      await acquired.lease.remove({ expected: replaced.revision }),
    ).toEqual({ status: "removed" });
    await acquired.lease.release();
    expect((await store.acquire({ nonce })).status).toBe("acquired");
  });
});
