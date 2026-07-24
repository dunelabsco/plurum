import { describe, expect, it } from "vitest";

import { selectCredentialEnvironment } from "../src/adapters/node/credential-environment.js";
import { selectRuntimeEnvironment } from "../src/adapters/node/platform.js";

describe("runtime environment boundary", () => {
  it("retains only the configuration variables the CLI is allowed to inspect", () => {
    const selected = selectRuntimeEnvironment({
      HOME: "/isolated/home",
      PLURUM_HOME: "/isolated/plurum",
      PLURUM_TEST_ROOT: "/isolated",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      WINDIR: "C:\\Windows",
      PLURUM_API_KEY: "must-not-enter-the-runtime",
      AWS_SECRET_ACCESS_KEY: "must-not-enter-the-runtime",
    });

    expect(selected).toEqual({
      HOME: "/isolated/home",
      PLURUM_HOME: "/isolated/plurum",
      PLURUM_TEST_ROOT: "/isolated",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      WINDIR: "C:\\Windows",
    });
    expect(Object.isFrozen(selected)).toBe(true);
    expect("PLURUM_API_KEY" in selected).toBe(false);
    expect("AWS_SECRET_ACCESS_KEY" in selected).toBe(false);
  });

  it("isolates the four credential-discovery variables from runtime paths", () => {
    const selected = selectCredentialEnvironment({
      PLURUM_API_KEY: "plrm_live_test_credential_key",
      PLURUM_API_URL: "https://api.plurum.ai",
      HERMES_HOME: "/isolated/hermes",
      OPENCLAW_HOME: "/isolated/openclaw",
      HOME: "/must-not-enter-secret-discovery",
      AWS_SECRET_ACCESS_KEY: "must-not-enter-secret-discovery",
    });

    expect(selected).toEqual({
      PLURUM_API_URL: "https://api.plurum.ai",
      HERMES_HOME: "/isolated/hermes",
      OPENCLAW_HOME: "/isolated/openclaw",
    });
    expect(selected.PLURUM_API_KEY).toBe("plrm_live_test_credential_key");
    expect(Object.keys(selected)).not.toContain("PLURUM_API_KEY");
    expect(Object.isFrozen(selected)).toBe(true);
    expect("HOME" in selected).toBe(false);
    expect("AWS_SECRET_ACCESS_KEY" in selected).toBe(false);
  });
});
