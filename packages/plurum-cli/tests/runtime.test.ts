import { describe, expect, it } from "vitest";

import { selectRuntimeEnvironment } from "../src/adapters/node/platform.js";

describe("runtime environment boundary", () => {
  it("retains only the configuration variables the CLI is allowed to inspect", () => {
    const selected = selectRuntimeEnvironment({
      HOME: "/isolated/home",
      PLURUM_HOME: "/isolated/plurum",
      PLURUM_TEST_ROOT: "/isolated",
      PLURUM_API_KEY: "must-not-enter-the-runtime",
      AWS_SECRET_ACCESS_KEY: "must-not-enter-the-runtime",
    });

    expect(selected).toEqual({
      HOME: "/isolated/home",
      PLURUM_HOME: "/isolated/plurum",
      PLURUM_TEST_ROOT: "/isolated",
    });
    expect(Object.isFrozen(selected)).toBe(true);
    expect("PLURUM_API_KEY" in selected).toBe(false);
    expect("AWS_SECRET_ACCESS_KEY" in selected).toBe(false);
  });
});
