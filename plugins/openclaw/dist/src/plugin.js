// Plugin registration — wires the 7 collective tools and the directive
// hook into the OpenClaw runtime.
//
// Architectural choice (vs. the Hermes plugin): the directive lives in
// `before_prompt_build` returning `prependSystemContext`, which the
// OpenClaw runtime concatenates directly into the system prompt
// (verified at `src/agents/pi-embedded-runner/run/attempt.thread-helpers.ts:24`
// upstream — `joinPresentTextSegments([prependSystem, baseSystemPrompt, appendSystem])`).
// That's the high-authority slot the equivalent Hermes hook can't reach
// (Hermes appends pre_llm_call context to the user message tail, a
// low-authority slot). Same plugin, more reliable directive landing.
import { PlurumClient } from "./client.js";
import { resolveApiKey, resolveApiUrl } from "./config.js";
import { PLURUM_DIRECTIVE, PLURUM_DIRECTIVE_NO_KEY } from "./directive.js";
import { registerPlurumCli } from "./setup.js";
import { createArchiveTool, createGetArtifactTool, createGetExperienceTool, createPublishTool, createRegisterTool, createReportOutcomeTool, createSearchTool, createVoteTool, } from "./tools.js";
export function registerPlurumPlugin(api) {
    // Lazy client factory — re-reads config and env on every tool call so
    // a config edit or `PLURUM_API_KEY` rotation is picked up without
    // restarting the gateway. Cheap: no persistent connection state.
    // Circuit-breaker counters live at module level in client.ts, so they
    // persist across these per-call instances (the per-instance variant
    // could never trip — see the note in client.ts).
    const getClient = () => new PlurumClient(resolveApiUrl(api.pluginConfig), resolveApiKey(), api.logger);
    api.registerTool(() => createSearchTool(getClient), { name: "plurum_search" });
    api.registerTool(() => createGetExperienceTool(getClient), {
        name: "plurum_get_experience",
    });
    api.registerTool(() => createGetArtifactTool(getClient), {
        name: "plurum_get_artifact",
    });
    api.registerTool(() => createPublishTool(getClient), { name: "plurum_publish" });
    api.registerTool(() => createReportOutcomeTool(getClient), {
        name: "plurum_report_outcome",
    });
    api.registerTool(() => createArchiveTool(getClient), { name: "plurum_archive" });
    api.registerTool(() => createVoteTool(getClient), { name: "plurum_vote" });
    // Always registered, never key-gated — see createRegisterTool. The toolset
    // is snapshotted at session start, so a key-gated register tool could never
    // appear mid-session; the working tools point here when unconfigured.
    api.registerTool(() => createRegisterTool(getClient), { name: "plurum_register" });
    // `openclaw plurum setup` — paste a key or self-register in the terminal.
    registerPlurumCli(api);
    // The directive runs per prompt build, so unlike the snapshotted toolset it
    // can switch on live key state: a not-connected agent is told to call
    // plurum_register; once a key exists it sees the normal search/publish loop.
    api.on("before_prompt_build", async () => ({
        prependSystemContext: resolveApiKey() ? PLURUM_DIRECTIVE : PLURUM_DIRECTIVE_NO_KEY,
    }));
    api.logger?.info?.("Plurum plugin registered (8 tools + system-prompt directive + setup CLI)");
}
