import { createDenyByDefaultSystem } from "../../src/system/denied.js";
import { createPlatformPathAdapter } from "../../src/adapters/node/platform.js";
import { nodeHash } from "../../src/adapters/node/hash.js";
import type {
  ElevationState,
  SupportedOs,
  SystemCapabilities,
} from "../../src/system/contracts.js";

export function createTestSystem(
  elevation: ElevationState = "standard",
  os: SupportedOs = "linux",
): SystemCapabilities {
  return createDenyByDefaultSystem(
    Object.freeze({ now: () => 1_750_000_000_000 }),
    Object.freeze({
      bytes(length: number): Uint8Array {
        return new Uint8Array(length).fill(0x42);
      },
      uuid(): string {
        return "00000000-0000-4000-8000-000000000001";
      },
    }),
    nodeHash,
    Object.freeze({
      os,
      arch: "test-arch",
      cwd: "/isolated/neutral",
      environment: Object.freeze({
        HOME: "/isolated/home",
        PLURUM_HOME: "/isolated/plurum",
        PLURUM_TEST_ROOT: "/isolated",
        PLURUM_TEST_RUN_ID: "test-run-id",
      }),
      elevation,
      paths: createPlatformPathAdapter(os),
    }),
  );
}
