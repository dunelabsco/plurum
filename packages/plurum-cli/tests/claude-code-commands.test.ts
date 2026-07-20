import { describe, expect, it } from "vitest";

import {
  claudeCodeCommandSpecification,
} from "../src/hosts/claude-code/commands.js";
import {
  CLAUDE_CODE_MUTATION_COMMANDS,
  CLAUDE_CODE_READ_COMMANDS,
} from "../src/hosts/claude-code/contracts.js";

describe("Claude Code fixed command contract", () => {
  it("uses only the documented noninteractive read commands", () => {
    expect(claudeCodeCommandSpecification("version")).toMatchObject({
      args: ["--version"],
      timeoutMs: 30_000,
      preferHttps: false,
    });
    expect(claudeCodeCommandSpecification("list-marketplaces").args).toEqual([
      "plugin",
      "marketplace",
      "list",
      "--json",
    ]);
    expect(claudeCodeCommandSpecification("list-plugins").args).toEqual([
      "plugin",
      "list",
      "--json",
    ]);
  });

  it("binds every mutation to an exact user-scope command", () => {
    expect(
      Object.fromEntries(
        CLAUDE_CODE_MUTATION_COMMANDS.map((command) => [
          command,
          claudeCodeCommandSpecification(command).args,
        ]),
      ),
    ).toEqual({
      "add-marketplace": [
        "plugin",
        "marketplace",
        "add",
        "dunelabsco/plurum",
        "--scope",
        "user",
      ],
      "remove-marketplace": [
        "plugin",
        "marketplace",
        "remove",
        "plurum",
        "--scope",
        "user",
      ],
      "install-plugin": [
        "plugin",
        "install",
        "plurum@plurum",
        "--scope",
        "user",
      ],
      "uninstall-plugin": [
        "plugin",
        "uninstall",
        "plurum@plurum",
        "--scope",
        "user",
      ],
      "update-plugin": [
        "plugin",
        "update",
        "plurum@plurum",
        "--scope",
        "user",
      ],
      "enable-plugin": [
        "plugin",
        "enable",
        "plurum@plurum",
        "--scope",
        "user",
      ],
      "disable-plugin": [
        "plugin",
        "disable",
        "plurum@plurum",
        "--scope",
        "user",
      ],
    });
  });

  it("reserves the official 120-second ceiling only for network mutations", () => {
    const network = new Set([
      "add-marketplace",
      "install-plugin",
      "update-plugin",
    ]);
    for (const command of [
      ...CLAUDE_CODE_READ_COMMANDS,
      ...CLAUDE_CODE_MUTATION_COMMANDS,
    ]) {
      const specification = claudeCodeCommandSpecification(command);
      expect(specification.maxOutputBytes).toBe(64 * 1024);
      expect(specification.timeoutMs).toBe(
        network.has(command) ? 120_000 : 30_000,
      );
      expect(specification.preferHttps).toBe(network.has(command));
      expect(specification.gitTimeoutMs).toBe(
        network.has(command) ? 110_000 : null,
      );
      expect(Object.isFrozen(specification)).toBe(true);
      expect(Object.isFrozen(specification.args)).toBe(true);
      const joined = specification.args.join(" ");
      expect(joined).not.toContain("--config");
      expect(joined).not.toContain("api_key");
      expect(joined).not.toContain("plrm_");
    }
  });
});
