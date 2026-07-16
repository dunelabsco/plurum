import type { ClockAdapter } from "../../system/contracts.js";

export const nodeClock: ClockAdapter = Object.freeze({
  now(): number {
    return Date.now();
  },
});
