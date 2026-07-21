import { describe, expect, it } from "vitest";

import {
  claimSetupSecretLeaseBytes,
  copySetupSecretLeaseBytes,
  createSetupSecretLease,
  discardSetupSecretLease,
  isOwnedSetupSecretLease,
} from "../src/commands/setup-secret-lease.js";

const KEY = `plrm_live_${"S".repeat(43)}`;

function retainedKey() {
  const source = new TextEncoder().encode(KEY);
  const lease = createSetupSecretLease(source);
  expect([...source].every((byte) => byte === 0)).toBe(true);
  return lease;
}

describe("setup secret lease", () => {
  it("keeps bytes behind a property-free one-use token and transfers ownership once", () => {
    const lease = retainedKey();

    expect(Object.isFrozen(lease)).toBe(true);
    expect(Object.keys(lease)).toEqual([]);
    expect(JSON.stringify({ lease })).toBe("{}");
    expect(isOwnedSetupSecretLease(lease)).toBe(true);

    const copied = copySetupSecretLeaseBytes(lease);
    expect(new TextDecoder().decode(copied)).toBe(KEY);
    copied?.fill(0);
    const secondCopy = copySetupSecretLeaseBytes(lease);
    expect(new TextDecoder().decode(secondCopy)).toBe(KEY);
    secondCopy?.fill(0);

    const claimed = claimSetupSecretLeaseBytes(lease);
    expect(new TextDecoder().decode(claimed)).toBe(KEY);
    expect(isOwnedSetupSecretLease(lease)).toBe(false);
    expect(copySetupSecretLeaseBytes(lease)).toBeUndefined();
    expect(claimSetupSecretLeaseBytes(lease)).toBeUndefined();
    expect(discardSetupSecretLease(lease)).toBe(false);
    claimed?.fill(0);
  });

  it("burns and wipes an abandoned lease idempotently", () => {
    const lease = retainedKey();

    expect(discardSetupSecretLease(lease)).toBe(true);
    expect(isOwnedSetupSecretLease(lease)).toBe(false);
    expect(copySetupSecretLeaseBytes(lease)).toBeUndefined();
    expect(discardSetupSecretLease(lease)).toBe(false);
  });
});
