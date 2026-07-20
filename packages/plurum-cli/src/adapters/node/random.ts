import { randomBytes, randomUUID } from "node:crypto";

import type { RandomAdapter } from "../../system/contracts.js";

export const nodeRandom: RandomAdapter = Object.freeze<RandomAdapter>({
  bytes(length): Uint8Array {
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw new RangeError("Random byte length must be a positive safe integer.");
    }
    const source = randomBytes(length);
    try {
      return new Uint8Array(source);
    } finally {
      source.fill(0);
    }
  },
  uuid(): string {
    return randomUUID();
  },
});
