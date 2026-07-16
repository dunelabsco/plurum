import { createDenyByDefaultSystem } from "../../system/denied.js";
import type { SystemCapabilities } from "../../system/contracts.js";
import { nodeClock } from "./clock.js";
import { createNodePlatform } from "./platform.js";
import { nodeRandom } from "./random.js";

export function createProductionSystem(): SystemCapabilities {
  return createDenyByDefaultSystem(nodeClock, nodeRandom, createNodePlatform());
}
