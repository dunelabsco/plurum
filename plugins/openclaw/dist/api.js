// Local barrel for the OpenClaw plugin SDK surface.
//
// OpenClaw's extension boundary requires plugin code to import only from
// `openclaw/plugin-sdk/*` and own local barrels (see extensions/CLAUDE.md
// in the upstream repo). Re-exporting through this file keeps every other
// file in the plugin one import away from a single SDK source of truth —
// if the SDK ships breaking renames, we adjust here, not in 6 places.
export { definePluginEntry, } from "openclaw/plugin-sdk/plugin-entry";
// Native setup-wizard prompter — used by `openclaw plurum setup` so masked
// input and styling match the host's other setup flows.
export { createClackPrompter, } from "openclaw/plugin-sdk/setup-runtime";
// Config mutation — used by `openclaw plurum setup` to add Plurum's tools to
// `tools.alsoAllow` so they clear an active tool profile (e.g. "coding").
export { mutateConfigFile } from "openclaw/plugin-sdk/config-mutation";
