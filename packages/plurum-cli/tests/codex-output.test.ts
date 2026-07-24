import { describe, expect, it } from "vitest";

import {
  CODEX_DESIRED_CONFIGURATION,
  CODEX_MARKETPLACE_SOURCE,
  CODEX_MCP_ENDPOINT,
  CODEX_MINIMUM_VERSION,
  CODEX_MUTATION_SUPPORT,
  CODEX_PLUGIN_ID,
} from "../src/hosts/codex/configuration.js";
import {
  normalizeCodexMarketplaceListJson,
  normalizeCodexPluginListJson,
  parseCodexMarketplaceListOutput,
  parseCodexPluginListOutput,
} from "../src/hosts/codex/output.js";
import { HostError } from "../src/hosts/errors.js";

const TARGET_MARKETPLACE = Object.freeze({
  name: "plurum",
  root: "/synthetic/codex/marketplaces/plurum",
  marketplaceSource: Object.freeze({
    sourceType: "git",
    source: "https://github.com/dunelabsco/plurum.git",
  }),
});

const TARGET_PLUGIN = Object.freeze({
  pluginId: "plurum@plurum",
  name: "plurum",
  marketplaceName: "plurum",
  version: "0.1.0",
  installed: true,
  enabled: true,
  source: Object.freeze({
    source: "local",
    path: "/synthetic/codex/marketplaces/plurum/plugins/plurum",
  }),
  marketplaceSource: Object.freeze({
    sourceType: "git",
    source: "https://github.com/dunelabsco/plurum.git",
  }),
  installPolicy: "AVAILABLE",
  authPolicy: "ON_INSTALL",
});

const OTHER_PLUGIN = Object.freeze({
  pluginId: "other@plurum",
  name: "other",
  marketplaceName: "plurum",
  version: "9.9.9",
  installed: true,
  enabled: true,
  source: Object.freeze({
    source: "local",
    path: "/synthetic/not-retained",
  }),
  marketplaceSource: Object.freeze({
    sourceType: "git",
    source: "https://github.com/dunelabsco/plurum.git",
  }),
  installPolicy: "AVAILABLE",
  authPolicy: "ON_USE",
});

function expectInvalid(operation: () => unknown): void {
  expect(operation).toThrowError(new HostError("host_output_invalid"));
}

function expectTooLarge(operation: () => unknown): void {
  expect(operation).toThrowError(new HostError("host_output_too_large"));
}

describe("Codex desired configuration", () => {
  it("locks the exact supported host, marketplace, plugin, and MCP contract", () => {
    expect(CODEX_MINIMUM_VERSION).toBe("0.144.5");
    expect(CODEX_MARKETPLACE_SOURCE).toBe(
      "https://github.com/dunelabsco/plurum.git",
    );
    expect(CODEX_PLUGIN_ID).toBe("plurum@plurum");
    expect(CODEX_MCP_ENDPOINT).toBe("https://mcp.plurum.ai/mcp");
    expect(CODEX_DESIRED_CONFIGURATION).toEqual({
      host: "codex",
      minimumHostVersion: "0.144.5",
      marketplace: {
        name: "plurum",
        source: "https://github.com/dunelabsco/plurum.git",
      },
      plugin: {
        name: "plurum",
        source: "plurum@plurum",
        version: "0.1.0",
        compatibleMinimum: "0.1.0",
        compatibleMaximumExclusive: "0.2.0",
      },
      mcp: {
        name: "plurum",
        endpoint: "https://mcp.plurum.ai/mcp",
      },
    });
    expect(Object.isFrozen(CODEX_DESIRED_CONFIGURATION)).toBe(true);
    expect(Object.isFrozen(CODEX_DESIRED_CONFIGURATION.marketplace)).toBe(
      true,
    );
    expect(Object.isFrozen(CODEX_DESIRED_CONFIGURATION.plugin)).toBe(true);
    expect(Object.isFrozen(CODEX_DESIRED_CONFIGURATION.mcp)).toBe(true);
  });

  it("supports only reversible add/remove mutation pairs", () => {
    expect(CODEX_MUTATION_SUPPORT).toEqual({
      addMarketplace: true,
      removeMarketplace: true,
      installPlugin: true,
      removePlugin: true,
      updatePlugin: false,
      restorePlugin: false,
      enablePlugin: false,
      disablePlugin: false,
    });
    expect(Object.isFrozen(CODEX_MUTATION_SUPPORT)).toBe(true);
  });
});

describe("Codex marketplace-list output", () => {
  it("normalizes the exact configured Git marketplace without retaining roots", () => {
    const result = parseCodexMarketplaceListOutput(
      JSON.stringify({
        marketplaces: [
          {
            name: "openai-bundled",
            root: "/synthetic/not-retained",
          },
          TARGET_MARKETPLACE,
        ],
      }),
    );

    expect(result).toEqual({
      status: "present",
      value: {
        name: "plurum",
        source: "https://github.com/dunelabsco/plurum.git",
      },
    });
    expect(JSON.stringify(result)).not.toContain("synthetic");
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.status === "present" && Object.isFrozen(result.value)).toBe(
      true,
    );
  });

  it("returns absent for a valid output without Plurum", () => {
    expect(
      normalizeCodexMarketplaceListJson({
        marketplaces: [
          {
            name: "another-marketplace",
            root: "/synthetic/another",
            marketplaceSource: {
              sourceType: "local",
              source: "/synthetic/source",
            },
          },
        ],
      }),
    ).toEqual({ status: "absent" });
  });

  it.each([
    [
      "wrong repository",
      {
        marketplaces: [
          {
            ...TARGET_MARKETPLACE,
            marketplaceSource: {
              sourceType: "git",
              source: "https://github.com/attacker/plurum.git",
            },
          },
        ],
      },
    ],
    [
      "wrong source type",
      {
        marketplaces: [
          {
            ...TARGET_MARKETPLACE,
            marketplaceSource: {
              sourceType: "local",
              source: "https://github.com/dunelabsco/plurum.git",
            },
          },
        ],
      },
    ],
    [
      "missing semantic source",
      {
        marketplaces: [
          {
            name: "plurum",
            root: "/synthetic/plurum",
          },
        ],
      },
    ],
    [
      "unexpected source metadata",
      {
        marketplaces: [
          {
            ...TARGET_MARKETPLACE,
            marketplaceSource: {
              ...TARGET_MARKETPLACE.marketplaceSource,
              ref: "unexpected",
            },
          },
        ],
      },
    ],
    [
      "unexpected target metadata",
      {
        marketplaces: [
          {
            ...TARGET_MARKETPLACE,
            installedAt: "now",
          },
        ],
      },
    ],
    [
      "noncanonical target casing",
      {
        marketplaces: [
          {
            ...TARGET_MARKETPLACE,
            name: "Plurum",
          },
        ],
      },
    ],
    [
      "duplicate target entries",
      {
        marketplaces: [TARGET_MARKETPLACE, TARGET_MARKETPLACE],
      },
    ],
  ])("rejects %s", (_label, value) => {
    expectInvalid(() => normalizeCodexMarketplaceListJson(value));
  });
});

describe("Codex plugin-list output", () => {
  it("normalizes only exact installed Plurum metadata", () => {
    const result = parseCodexPluginListOutput(
      JSON.stringify({
        installed: [OTHER_PLUGIN, TARGET_PLUGIN],
        available: [],
      }),
    );

    expect(result).toEqual({
      status: "present",
      value: {
        name: "plurum",
        source: "plurum@plurum",
        version: "0.1.0",
        enabled: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("synthetic");
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.status === "present" && Object.isFrozen(result.value)).toBe(
      true,
    );
  });

  it("preserves an installed disabled state", () => {
    expect(
      normalizeCodexPluginListJson({
        installed: [{ ...TARGET_PLUGIN, enabled: false }],
        available: [],
      }),
    ).toEqual({
      status: "present",
      value: {
        name: "plurum",
        source: "plurum@plurum",
        version: "0.1.0",
        enabled: false,
      },
    });
  });

  it("treats the exact uninstalled available plugin as absent", () => {
    expect(
      normalizeCodexPluginListJson({
        installed: [],
        available: [
          {
            ...TARGET_PLUGIN,
            installed: false,
            enabled: false,
          },
        ],
      }),
    ).toEqual({ status: "absent" });
  });

  it("keeps plugin-list output separate from native MCP declaration evidence", () => {
    expect(
      parseCodexPluginListOutput(
        JSON.stringify({ installed: [], available: [] }),
      ),
    ).toEqual({ status: "absent" });
  });

  it.each([
    [
      "wrong plugin ID",
      {
        installed: [{ ...TARGET_PLUGIN, pluginId: "plurum@attacker" }],
        available: [],
      },
    ],
    [
      "noncanonical plugin ID",
      {
        installed: [{ ...TARGET_PLUGIN, pluginId: "Plurum@plurum" }],
        available: [],
      },
    ],
    [
      "wrong plugin name",
      {
        installed: [{ ...TARGET_PLUGIN, name: "attacker" }],
        available: [],
      },
    ],
    [
      "wrong marketplace",
      {
        installed: [{ ...TARGET_PLUGIN, marketplaceName: "attacker" }],
        available: [],
      },
    ],
    [
      "noncanonical marketplace",
      {
        installed: [{ ...TARGET_PLUGIN, marketplaceName: "Plurum" }],
        available: [],
      },
    ],
    [
      "malformed version",
      {
        installed: [{ ...TARGET_PLUGIN, version: "v0.1.0" }],
        available: [],
      },
    ],
    [
      "noncanonical version",
      {
        installed: [{ ...TARGET_PLUGIN, version: "0.01.0" }],
        available: [],
      },
    ],
    [
      "wrong installed bucket",
      {
        installed: [{ ...TARGET_PLUGIN, installed: false }],
        available: [],
      },
    ],
    [
      "enabled uninstalled plugin",
      {
        installed: [],
        available: [{ ...TARGET_PLUGIN, installed: false }],
      },
    ],
    [
      "non-local plugin source",
      {
        installed: [
          {
            ...TARGET_PLUGIN,
            source: {
              source: "git",
              url: "https://github.com/dunelabsco/plurum.git",
            },
          },
        ],
        available: [],
      },
    ],
    [
      "missing marketplace source",
      {
        installed: [
          Object.fromEntries(
            Object.entries(TARGET_PLUGIN).filter(
              ([key]) => key !== "marketplaceSource",
            ),
          ),
        ],
        available: [],
      },
    ],
    [
      "wrong installation policy",
      {
        installed: [
          {
            ...TARGET_PLUGIN,
            installPolicy: "INSTALLED_BY_DEFAULT",
          },
        ],
        available: [],
      },
    ],
    [
      "wrong authentication policy",
      {
        installed: [{ ...TARGET_PLUGIN, authPolicy: "ON_USE" }],
        available: [],
      },
    ],
    [
      "unexpected target metadata",
      {
        installed: [
          {
            ...TARGET_PLUGIN,
            installedPath: "/synthetic/cache",
          },
        ],
        available: [],
      },
    ],
    [
      "duplicate target entries",
      {
        installed: [TARGET_PLUGIN, TARGET_PLUGIN],
        available: [],
      },
    ],
    [
      "target in both buckets",
      {
        installed: [TARGET_PLUGIN],
        available: [
          {
            ...TARGET_PLUGIN,
            installed: false,
            enabled: false,
          },
        ],
      },
    ],
  ])("rejects %s", (_label, value) => {
    expectInvalid(() => normalizeCodexPluginListJson(value));
  });
});

describe("Codex JSON output hardening", () => {
  it.each([
    "",
    "not json",
    "[]",
    "null",
    "true",
    "{}",
    "[] trailing prose",
  ])("rejects malformed or wrong-root output %j", (value) => {
    expectInvalid(() => parseCodexPluginListOutput(value));
    expectInvalid(() => parseCodexMarketplaceListOutput(value));
  });

  it("rejects the other command's otherwise-valid root schema", () => {
    expectInvalid(() =>
      parseCodexPluginListOutput('{"marketplaces":[]}'),
    );
    expectInvalid(() =>
      parseCodexMarketplaceListOutput('{"installed":[],"available":[]}'),
    );
  });

  it("rejects secret material, including escaped JSON content", () => {
    const liveKey = `plrm_live_${"A".repeat(43)}`;
    expectInvalid(() =>
      parseCodexPluginListOutput(
        JSON.stringify({
          installed: [],
          available: [
            {
              ...OTHER_PLUGIN,
              installed: false,
              enabled: false,
              diagnostic: liveKey,
            },
          ],
        }),
      ),
    );
    expectInvalid(() =>
      parseCodexMarketplaceListOutput(
        '{"marketplaces":[{"name":"other","root":"/tmp","note":"plrm\\u005flive_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}]}',
      ),
    );
    expectInvalid(() =>
      parseCodexPluginListOutput(
        '{"installed":[],"available":[{"pluginId":"other@other","Authorization":"redacted"}]}',
      ),
    );
  });

  it("rejects C0/C1 content even when JSON escaping makes it parseable", () => {
    expectInvalid(() =>
      parseCodexPluginListOutput(
        '{"installed":[],"available":[{"pluginId":"other@other","note":"line\\u0000break"}]}',
      ),
    );
    expectInvalid(() =>
      parseCodexMarketplaceListOutput(
        '{"marketplaces":[{"name":"other","root":"line\\u0085break"}]}',
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

    expectInvalid(() =>
      normalizeCodexMarketplaceListJson({ marketplaces: [hostile] }),
    );
    expect(getterCalls).toBe(0);
  });

  it("takes one stable own-key snapshot without invoking proxy getters", () => {
    let ownKeysCalls = 0;
    let descriptorCalls = 0;
    const payload = new Proxy(
      { marketplaces: [TARGET_MARKETPLACE] },
      {
        ownKeys(target) {
          ownKeysCalls += 1;
          if (ownKeysCalls !== 1) {
            throw new Error("own keys observed more than once");
          }
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, property) {
          descriptorCalls += 1;
          return Object.getOwnPropertyDescriptor(target, property);
        },
        get() {
          throw new Error("proxy getter must not run");
        },
      },
    );

    expect(normalizeCodexMarketplaceListJson(payload)).toEqual({
      status: "present",
      value: {
        name: "plurum",
        source: CODEX_MARKETPLACE_SOURCE,
      },
    });
    expect(ownKeysCalls).toBe(1);
    expect(descriptorCalls).toBe(1);
  });

  it("rejects symbols, custom prototypes, shared references, and sparse arrays", () => {
    const symbolEntry = { ...TARGET_PLUGIN, [Symbol("hidden")]: "value" };
    const customPrototype = Object.create({ inherited: true }) as Record<
      string,
      unknown
    >;
    Object.assign(customPrototype, TARGET_MARKETPLACE);
    const shared = { name: "other", root: "/synthetic/other" };
    const sparse = new Array<unknown>(2);
    sparse[1] = TARGET_PLUGIN;

    expectInvalid(() =>
      normalizeCodexPluginListJson({
        installed: [symbolEntry],
        available: [],
      }),
    );
    expectInvalid(() =>
      normalizeCodexMarketplaceListJson({
        marketplaces: [customPrototype],
      }),
    );
    expectInvalid(() =>
      normalizeCodexMarketplaceListJson({
        marketplaces: [shared, shared],
      }),
    );
    expectInvalid(() =>
      normalizeCodexPluginListJson({
        installed: sparse,
        available: [],
      }),
    );
  });

  it("rejects oversized text, arrays, objects, and depth with one bounded error", () => {
    expectTooLarge(() =>
      parseCodexPluginListOutput(" ".repeat(131_073)),
    );
    expectTooLarge(() =>
      normalizeCodexPluginListJson({
        installed: Array.from({ length: 129 }, (_, index) => ({
          pluginId: `other-${index}@plurum`,
        })),
        available: [],
      }),
    );
    expectTooLarge(() =>
      normalizeCodexMarketplaceListJson({
        marketplaces: [
          Object.fromEntries(
            Array.from({ length: 33 }, (_, index) => [
              `field-${index}`,
              "value",
            ]),
          ),
        ],
      }),
    );

    let nested: unknown = "leaf";
    for (let index = 0; index < 18; index += 1) {
      nested = { nested };
    }
    expectTooLarge(() =>
      normalizeCodexPluginListJson({
        installed: [nested],
        available: [],
      }),
    );
  });
});
