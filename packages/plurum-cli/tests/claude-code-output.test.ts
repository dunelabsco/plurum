import { describe, expect, it } from "vitest";

import {
  CLAUDE_CODE_DESIRED_CONFIGURATION,
  CLAUDE_CODE_MARKETPLACE_SOURCE,
  CLAUDE_CODE_MCP_ENDPOINT,
  CLAUDE_CODE_MINIMUM_VERSION,
  CLAUDE_CODE_MUTATION_SUPPORT,
  CLAUDE_CODE_PLUGIN_ID,
} from "../src/hosts/claude-code/configuration.js";
import {
  normalizeClaudeCodeMarketplaceListJson,
  normalizeClaudeCodePluginListJson,
  parseClaudeCodeMarketplaceListOutput,
  parseClaudeCodePluginListOutput,
} from "../src/hosts/claude-code/output.js";
import { HostError } from "../src/hosts/errors.js";

const TARGET_MARKETPLACE = Object.freeze({
  name: "plurum",
  source: Object.freeze({
    source: "github",
    repo: "dunelabsco/plurum",
  }),
});

const TARGET_PLUGIN = Object.freeze({
  id: "plurum@plurum",
  version: "0.2.0",
  scope: "user",
  enabled: true,
});

function expectInvalid(operation: () => unknown): void {
  expect(operation).toThrowError(new HostError("host_output_invalid"));
}

function expectTooLarge(operation: () => unknown): void {
  expect(operation).toThrowError(new HostError("host_output_too_large"));
}

describe("Claude Code desired configuration", () => {
  it("locks the exact supported host, marketplace, plugin, and MCP contract", () => {
    expect(CLAUDE_CODE_MINIMUM_VERSION).toBe("2.1.212");
    expect(CLAUDE_CODE_MARKETPLACE_SOURCE).toBe("dunelabsco/plurum");
    expect(CLAUDE_CODE_PLUGIN_ID).toBe("plurum@plurum");
    expect(CLAUDE_CODE_MCP_ENDPOINT).toBe("https://mcp.plurum.ai/mcp");
    expect(CLAUDE_CODE_DESIRED_CONFIGURATION).toEqual({
      host: "claude-code",
      minimumHostVersion: "2.1.212",
      marketplace: {
        name: "plurum",
        source: "dunelabsco/plurum",
      },
      plugin: {
        name: "plurum",
        source: "plurum@plurum",
        version: "0.2.0",
        compatibleMinimum: "0.2.0",
        compatibleMaximumExclusive: "0.3.0",
      },
      mcp: {
        name: "plurum",
        endpoint: "https://mcp.plurum.ai/mcp",
      },
    });
    expect(Object.isFrozen(CLAUDE_CODE_DESIRED_CONFIGURATION)).toBe(true);
    expect(
      Object.isFrozen(CLAUDE_CODE_DESIRED_CONFIGURATION.marketplace),
    ).toBe(true);
    expect(Object.isFrozen(CLAUDE_CODE_DESIRED_CONFIGURATION.plugin)).toBe(
      true,
    );
    expect(Object.isFrozen(CLAUDE_CODE_DESIRED_CONFIGURATION.mcp)).toBe(true);
  });

  it("supports reversible lifecycle operations but no historical restore", () => {
    expect(CLAUDE_CODE_MUTATION_SUPPORT).toEqual({
      addMarketplace: true,
      removeMarketplace: true,
      installPlugin: true,
      removePlugin: true,
      updatePlugin: true,
      restorePlugin: false,
      enablePlugin: true,
      disablePlugin: true,
    });
    expect(Object.isFrozen(CLAUDE_CODE_MUTATION_SUPPORT)).toBe(true);
  });
});

describe("Claude Code marketplace-list output", () => {
  it("normalizes an exact GitHub marketplace without retaining raw fields", () => {
    const result = parseClaudeCodeMarketplaceListOutput(
      JSON.stringify([
        {
          name: "other-marketplace",
          source: {
            source: "directory",
            path: "/synthetic/not-retained",
          },
        },
        TARGET_MARKETPLACE,
      ]),
    );

    expect(result).toEqual({
      status: "present",
      value: {
        name: "plurum",
        source: "dunelabsco/plurum",
      },
    });
    expect(JSON.stringify(result)).not.toContain("synthetic");
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.status === "present" && Object.isFrozen(result.value)).toBe(
      true,
    );
  });

  it("returns absent for a valid list without Plurum", () => {
    expect(
      normalizeClaudeCodeMarketplaceListJson([
        {
          name: "another-marketplace",
          source: { source: "github", repo: "example/another" },
        },
      ]),
    ).toEqual({ status: "absent" });
  });

  it.each([
    [
      "wrong repository",
      [{ name: "plurum", source: { source: "github", repo: "attacker/repo" } }],
    ],
    [
      "wrong source type",
      [
        {
          name: "plurum",
          source: { source: "url", repo: "dunelabsco/plurum" },
        },
      ],
    ],
    [
      "pinned or otherwise unexpected source metadata",
      [
        {
          name: "plurum",
          source: {
            source: "github",
            repo: "dunelabsco/plurum",
            ref: "unexpected",
          },
        },
      ],
    ],
    [
      "unexpected target metadata",
      [{ ...TARGET_MARKETPLACE, installLocation: "/synthetic/cache" }],
    ],
    [
      "noncanonical target casing",
      [
        {
          name: "Plurum",
          source: { source: "github", repo: "dunelabsco/plurum" },
        },
      ],
    ],
    ["duplicate target entries", [TARGET_MARKETPLACE, TARGET_MARKETPLACE]],
  ])("rejects %s", (_label, value) => {
    expectInvalid(() => normalizeClaudeCodeMarketplaceListJson(value));
  });
});

describe("Claude Code plugin-list output", () => {
  it("normalizes only exact user-scope plugin metadata", () => {
    const result = parseClaudeCodePluginListOutput(
      JSON.stringify([
        {
          id: "another@marketplace",
          version: "9.9.9",
          scope: "project",
          enabled: true,
          installPath: "/synthetic/not-retained",
        },
        TARGET_PLUGIN,
      ]),
    );

    expect(result).toEqual({
      status: "present",
      value: {
        name: "plurum",
        source: "plurum@plurum",
        version: "0.2.0",
        enabled: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("synthetic");
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.status === "present" && Object.isFrozen(result.value)).toBe(
      true,
    );
  });

  it("preserves disabled state and accepts only an empty documented errors list", () => {
    expect(
      normalizeClaudeCodePluginListJson([
        { ...TARGET_PLUGIN, enabled: false, errors: [] },
      ]),
    ).toEqual({
      status: "present",
      value: {
        name: "plurum",
        source: "plurum@plurum",
        version: "0.2.0",
        enabled: false,
      },
    });
  });

  it("keeps installed-plugin output separate from MCP declaration and connectivity evidence", () => {
    expect(parseClaudeCodePluginListOutput("[]")).toEqual({
      status: "absent",
    });
  });

  it.each([
    ["wrong scope", [{ ...TARGET_PLUGIN, scope: "project" }]],
    ["wrong enabled type", [{ ...TARGET_PLUGIN, enabled: 1 }]],
    ["wrong ID", [{ ...TARGET_PLUGIN, id: "plurum@attacker" }]],
    ["noncanonical ID", [{ ...TARGET_PLUGIN, id: "Plurum@plurum" }]],
    ["malformed version", [{ ...TARGET_PLUGIN, version: "v0.1.0" }]],
    ["noncanonical version", [{ ...TARGET_PLUGIN, version: "0.01.0" }]],
    ["unexpected target field", [{ ...TARGET_PLUGIN, installPath: "/tmp/x" }]],
    [
      "reported plugin errors",
      [{ ...TARGET_PLUGIN, errors: ["dependency unavailable"] }],
    ],
    ["duplicate target entries", [TARGET_PLUGIN, TARGET_PLUGIN]],
  ])("rejects %s", (_label, value) => {
    expectInvalid(() => normalizeClaudeCodePluginListJson(value));
  });
});

describe("Claude Code JSON output hardening", () => {
  it.each([
    "",
    "not json",
    "{}",
    "null",
    "true",
    "[] trailing prose",
    '{"plugins":[]}',
  ])("rejects malformed or non-list output %j", (value) => {
    expectInvalid(() => parseClaudeCodePluginListOutput(value));
    expectInvalid(() => parseClaudeCodeMarketplaceListOutput(value));
  });

  it("rejects secret material, including escaped JSON string content", () => {
    const liveKey = `plrm_live_${"A".repeat(43)}`;
    expectInvalid(() =>
      parseClaudeCodePluginListOutput(
        JSON.stringify([{ id: "other@other", diagnostic: liveKey }]),
      ),
    );
    expectInvalid(() =>
      parseClaudeCodeMarketplaceListOutput(
        '[{"name":"other","note":"plrm\\u005flive_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}]',
      ),
    );
    expectInvalid(() =>
      parseClaudeCodePluginListOutput(
        '[{"id":"other@other","Authorization":"redacted"}]',
      ),
    );
  });

  it("rejects C0/C1 content even when JSON escaping makes it parseable", () => {
    expectInvalid(() =>
      parseClaudeCodePluginListOutput(
        '[{"id":"other@other","note":"line\\u0000break"}]',
      ),
    );
    expectInvalid(() =>
      parseClaudeCodeMarketplaceListOutput(
        '[{"name":"other","note":"line\\u0085break"}]',
      ),
    );
  });

  it("rejects accessors without invoking them", () => {
    let getterCalls = 0;
    const hostile = Object.defineProperty(
      Object.create(null) as Record<string, unknown>,
      "name",
      {
        enumerable: true,
        get() {
          getterCalls += 1;
          return "plurum";
        },
      },
    );

    expectInvalid(() => normalizeClaudeCodeMarketplaceListJson([hostile]));
    expect(getterCalls).toBe(0);
  });

  it("rejects symbols, custom prototypes, shared references, and sparse arrays", () => {
    const symbolEntry = { ...TARGET_PLUGIN, [Symbol("hidden")]: "value" };
    const customPrototype = Object.create({ inherited: true }) as Record<
      string,
      unknown
    >;
    Object.assign(customPrototype, TARGET_MARKETPLACE);
    const shared = { name: "other" };
    const sparse = new Array<unknown>(2);
    sparse[1] = TARGET_PLUGIN;

    expectInvalid(() => normalizeClaudeCodePluginListJson([symbolEntry]));
    expectInvalid(() =>
      normalizeClaudeCodeMarketplaceListJson([customPrototype]),
    );
    expectInvalid(() =>
      normalizeClaudeCodeMarketplaceListJson([shared, shared]),
    );
    expectInvalid(() => normalizeClaudeCodePluginListJson(sparse));
  });

  it("rejects oversized text, arrays, objects, and depth with one bounded error", () => {
    expectTooLarge(() =>
      parseClaudeCodePluginListOutput(" ".repeat(131_073)),
    );
    expectTooLarge(() =>
      normalizeClaudeCodePluginListJson(
        Array.from({ length: 129 }, (_, index) => ({
          id: `other-${index}@marketplace`,
        })),
      ),
    );
    expectTooLarge(() =>
      normalizeClaudeCodeMarketplaceListJson([
        Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [
            `field-${index}`,
            "value",
          ]),
        ),
      ]),
    );

    let nested: unknown = "leaf";
    for (let index = 0; index < 18; index += 1) {
      nested = { nested };
    }
    expectTooLarge(() => normalizeClaudeCodePluginListJson([nested]));
  });
});
