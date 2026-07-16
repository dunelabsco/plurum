import { randomBytes, randomUUID } from "node:crypto";

import type { RandomAdapter } from "../../system/contracts.js";

export const nodeRandom: RandomAdapter = Object.freeze<RandomAdapter>({
  bytes(length): Uint8Array {
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw new RangeError("Random byte length must be a positive safe integer.");
    }
    return new Uint8Array(randomBytes(length));
  },
  uuid(): string {
    return randomUUID();
  },
});
