// Plugin entry — consumed by OpenClaw's plugin loader.
//
// The default export from `definePluginEntry(...)` is what the host
// calls to discover the plugin, validate config against the schema,
// and run `register()` once activation kicks in. Mirrors the shape of
// `extensions/diffs/index.ts` and the other in-tree plugins.

import { definePluginEntry } from "./api.js";
import { plurumConfigSchema } from "./src/config.js";
import { registerPlurumPlugin } from "./src/plugin.js";

export default definePluginEntry({
  id: "plurum",
  name: "Plurum",
  description:
    "Collective experience network for AI agents — search and publish to the world's shared agent knowledge.",
  configSchema: plurumConfigSchema,
  register: registerPlurumPlugin,
});
