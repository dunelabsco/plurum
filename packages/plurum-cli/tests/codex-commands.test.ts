import { describe, expect, it } from "vitest";

import {
  codexApplyCommand,
  codexCommandSpecification,
  codexRollbackCommand,
} from "../src/hosts/codex/commands.js";
import {
  CODEX_MUTATION_COMMANDS,
} from "../src/hosts/codex/contracts.js";

describe("Codex fixed command contract", () => {
  it("does not expose normal Codex CLI reads through the process capability", () => {
    expect(CODEX_MUTATION_COMMANDS).toEqual([
      "add-marketplace",
      "remove-marketplace",
      "install-plugin",
      "uninstall-plugin",
    ]);
  });

  it("binds every mutation to an exact official user-level command", () => {
    expect(
      Object.fromEntries(
        CODEX_MUTATION_COMMANDS.map((command) => [
          command,
          codexCommandSpecification(command).args,
        ]),
      ),
    ).toEqual({
      "add-marketplace": [
        "plugin",
        "marketplace",
        "add",
        "dunelabsco/plurum",
        "--json",
      ],
      "remove-marketplace": [
        "plugin",
        "marketplace",
        "remove",
        "plurum",
        "--json",
      ],
      "install-plugin": [
        "plugin",
        "add",
        "plurum@plurum",
        "--json",
      ],
      "uninstall-plugin": [
        "plugin",
        "remove",
        "plurum@plurum",
        "--json",
      ],
    });
  });

  it("uses one mapping for adapter execution and setup previews", () => {
    expect({
      addMarketplace: codexApplyCommand("add-marketplace"),
      installPlugin: codexApplyCommand("install-plugin"),
      updatePlugin: codexApplyCommand("update-plugin"),
      enablePlugin: codexApplyCommand("enable-plugin"),
    }).toEqual({
      addMarketplace: "add-marketplace",
      installPlugin: "install-plugin",
      updatePlugin: null,
      enablePlugin: null,
    });
    expect({
      removeMarketplace: codexRollbackCommand(
        "remove-cli-created-marketplace",
      ),
      removePlugin: codexRollbackCommand(
        "remove-cli-created-plugin",
      ),
      restoreVersion: codexRollbackCommand(
        "restore-plugin-version",
      ),
      restoreDisabled: codexRollbackCommand(
        "restore-plugin-disabled",
      ),
    }).toEqual({
      removeMarketplace: "remove-marketplace",
      removePlugin: "uninstall-plugin",
      restoreVersion: null,
      restoreDisabled: null,
    });
  });

  it("reserves the 120-second ceiling for the Git marketplace fetch", () => {
    for (const command of CODEX_MUTATION_COMMANDS) {
      const specification = codexCommandSpecification(command);
      expect(specification.maxOutputBytes).toBe(64 * 1024);
      expect(specification.timeoutMs).toBe(
        command === "add-marketplace" ? 120_000 : 30_000,
      );
      expect(Object.isFrozen(specification)).toBe(true);
      expect(Object.isFrozen(specification.args)).toBe(true);

      const joined = specification.args.join(" ");
      expect(joined).not.toContain("config.toml");
      expect(joined).not.toContain(" mcp ");
      expect(joined).not.toContain("api_key");
      expect(joined).not.toContain("plrm_");
      expect(specification.args).not.toContain("-c");
      expect(specification.args).not.toContain("--config");
    }
  });
});
