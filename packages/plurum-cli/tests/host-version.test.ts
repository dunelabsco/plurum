import { describe, expect, it } from "vitest";

import { HostError } from "../src/hosts/errors.js";
import {
  compareCanonicalVersions,
  isCanonicalVersionInRange,
  parseCanonicalVersion,
} from "../src/hosts/version.js";

describe("canonical host versions", () => {
  it.each([
    "",
    "1",
    "1.2",
    "1.2.3.4",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "v1.2.3",
    "1.2.3-alpha",
    "1.2.3+build",
    " 1.2.3",
    "1.2.3 ",
    "1.٢.3",
    "1.2.-3",
    "1e2.2.3",
    `${"9".repeat(127)}.1.1`,
  ])("rejects non-canonical input %j", (value) => {
    expect(() => parseCanonicalVersion(value)).toThrowError(
      new HostError("invalid_host_version"),
    );
  });

  it("returns an immutable canonical representation", () => {
    const parsed = parseCanonicalVersion("12.34.56");

    expect(parsed).toEqual({
      canonical: "12.34.56",
      major: "12",
      minor: "34",
      patch: "56",
    });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("compares arbitrarily large canonical identifiers without number loss", () => {
    expect(
      compareCanonicalVersions(
        "900719925474099300000000000.0.0",
        "900719925474099299999999999.999.999",
      ),
    ).toBe(1);
    expect(compareCanonicalVersions("1.10.0", "1.9.999")).toBe(1);
    expect(compareCanonicalVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareCanonicalVersions("0.0.9", "0.1.0")).toBe(-1);
  });

  it("uses an inclusive minimum and exclusive maximum", () => {
    expect(isCanonicalVersionInRange("1.2.0", "1.2.0", "2.0.0")).toBe(
      true,
    );
    expect(isCanonicalVersionInRange("1.99.99", "1.2.0", "2.0.0")).toBe(
      true,
    );
    expect(isCanonicalVersionInRange("2.0.0", "1.2.0", "2.0.0")).toBe(
      false,
    );
    expect(isCanonicalVersionInRange("1.1.99", "1.2.0", "2.0.0")).toBe(
      false,
    );
  });

  it("rejects an empty or inverted range", () => {
    expect(() =>
      isCanonicalVersionInRange("1.0.0", "2.0.0", "2.0.0"),
    ).toThrowError(new HostError("invalid_host_version"));
    expect(() =>
      isCanonicalVersionInRange("1.0.0", "3.0.0", "2.0.0"),
    ).toThrowError(new HostError("invalid_host_version"));
  });
});
