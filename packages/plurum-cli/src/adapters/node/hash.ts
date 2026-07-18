import { createHash } from "node:crypto";

import type { HashAdapter } from "../../system/contracts.js";

export const nodeHash: HashAdapter = Object.freeze<HashAdapter>({
  sha256(data): Uint8Array {
    if (!(data instanceof Uint8Array)) {
      throw new TypeError("SHA-256 input must be bytes.");
    }
    let copiedInput: Uint8Array | undefined;
    try {
      copiedInput = Uint8Array.prototype.slice.call(data) as Uint8Array;
      const adapterDigest = createHash("sha256").update(copiedInput).digest();
      try {
        return new Uint8Array(adapterDigest);
      } finally {
        adapterDigest.fill(0);
      }
    } catch {
      throw new TypeError("SHA-256 hashing failed.");
    } finally {
      copiedInput?.fill(0);
    }
  },
});
