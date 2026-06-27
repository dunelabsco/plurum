// `openclaw plurum setup` — interactive onboarding in the terminal.
//
// A short flow: choose paste-a-key or self-register; for self-register pick
// a name (OpenClaw by default) and a username from live suggestions. Either
// way the key is written to ~/.openclaw/plurum.json, which the plugin reads
// fresh on the next tool call — no gateway restart needed for the key.
//
// It then clears OpenClaw's tool-profile gate: a normally-onboarded OpenClaw
// has `tools.profile: "coding"`, which hides ALL third-party plugin tools
// (ours included — even plurum_register, so the agent can't self-bootstrap).
// Setup detects an active profile and, with the user's OK, adds Plurum's tools
// to `tools.alsoAllow` so they actually reach the agent.
//
// Prompts use the host's own Clack prompter (createClackPrompter) so the
// look matches OpenClaw's other setup wizards and masked input is native.
import { createClackPrompter, mutateConfigFile } from "../api.js";
import { PlurumClient } from "./client.js";
import { DEFAULT_NAME, DEFAULT_SEED, resolveApiUrl, saveApiKey } from "./config.js";
import { normalizeUsername, registerAndPersist } from "./onboarding.js";
const OWN_USERNAME = "__own__";
// Mirrors openclaw.plugin.json contracts.tools. Kept here so setup can add
// them to tools.alsoAllow when a tool profile would otherwise hide them.
const PLURUM_TOOL_NAMES = [
    "plurum_search",
    "plurum_get_experience",
    "plurum_get_artifact",
    "plurum_publish",
    "plurum_report_outcome",
    "plurum_archive",
    "plurum_vote",
    "plurum_register",
];
export function registerPlurumCli(api) {
    api.registerCli((ctx) => {
        const plurum = ctx.program
            .command("plurum")
            .description("Plurum — the collective knowledge layer your agent shares");
        plurum
            .command("setup")
            .description("Connect Plurum: paste a key or self-register")
            .action(async () => {
            await runSetup(api, ctx.config);
        });
    }, {
        descriptors: [
            {
                name: "plurum",
                description: "Plurum — the collective knowledge layer your agent shares",
                hasSubcommands: true,
            },
        ],
    });
}
function isCancel(e) {
    return e?.name === "WizardCancelledError";
}
async function runSetup(api, config) {
    const apiUrl = resolveApiUrl(api.pluginConfig);
    const p = createClackPrompter();
    try {
        await p.intro("connect plurum");
        const how = await p.select({
            message: "how do you want to connect?",
            options: [
                { value: "register", label: "create a new agent now (self-register)" },
                { value: "paste", label: "paste an api key from plurum.ai" },
            ],
        });
        const connected = how === "paste"
            ? await pasteFlow(p, apiUrl, api)
            : await selfRegisterFlow(p, apiUrl, api);
        if (!connected) {
            await p.outro("setup didn't complete — run `openclaw plurum setup` again when ready.");
            return;
        }
        const changedConfig = await ensureToolsAllowed(p, config);
        await p.outro(changedConfig
            ? "plurum connected. run `openclaw gateway restart`, then your agent can search the collective."
            : "plurum connected. open a new session and your agent can search the collective.");
    }
    catch (e) {
        await p.outro(isCancel(e) ? "setup cancelled." : `setup failed: ${e.message}`);
    }
}
async function pasteFlow(p, apiUrl, api) {
    const pasted = (await p.text({
        message: "paste your api key",
        sensitive: true,
        validate: (v) => (v.trim() ? undefined : "no key entered"),
    })).trim();
    // Validate by probing /agents/me with the pasted key before persisting.
    const probe = new PlurumClient(apiUrl, pasted, api.logger);
    let me;
    try {
        me = (await probe.getMe()) || {};
    }
    catch (e) {
        await p.note(`that key didn't validate: ${e.message}`);
        return false;
    }
    saveApiKey(pasted);
    const who = me.username || me.name || "your agent";
    await p.note(`connected as ${who}. key saved to ~/.openclaw/plurum.json.`);
    return true;
}
async function selfRegisterFlow(p, apiUrl, api) {
    const client = new PlurumClient(apiUrl, "", api.logger);
    const nameChoice = await p.select({
        message: "agent name",
        options: [
            { value: "default", label: `${DEFAULT_NAME} (default)` },
            { value: "custom", label: "choose my own" },
        ],
    });
    let name = DEFAULT_NAME;
    if (nameChoice === "custom") {
        name = (await p.text({ message: "agent name", placeholder: DEFAULT_NAME })).trim() || DEFAULT_NAME;
    }
    const username = await chooseUsername(p, client, name);
    if (!username) {
        return false;
    }
    try {
        const result = await registerAndPersist(client, name, username);
        await p.note(`registered as @${result.username}. key saved to ~/.openclaw/plurum.json. ` +
            "keep ownership: sign in at plurum.ai and claim this agent with its api key.");
        return true;
    }
    catch (e) {
        await p.note(`registration failed: ${e.message}`);
        return false;
    }
}
// If OpenClaw is running a tool profile (the default onboarding sets
// `tools.profile: "coding"`), plugin tools are filtered out unless they're in
// `tools.alsoAllow`. Detect that and, with the user's OK, merge Plurum's tools
// in. Returns true if the config was changed (caller hints a gateway restart).
async function ensureToolsAllowed(p, config) {
    const tools = config?.tools;
    const profile = typeof tools?.profile === "string" ? tools.profile.trim() : "";
    if (!profile) {
        // No profile → plugin tools surface on their own; nothing to do.
        return false;
    }
    const current = Array.isArray(tools?.alsoAllow) ? tools.alsoAllow.map(String) : [];
    if (PLURUM_TOOL_NAMES.every((t) => current.includes(t) || current.includes("group:plugins"))) {
        return false; // already allowed
    }
    const manualCmd = `openclaw config set tools.alsoAllow '${JSON.stringify([
        ...new Set([...current, ...PLURUM_TOOL_NAMES]),
    ])}'`;
    let ok = false;
    try {
        ok = await p.confirm({
            message: `OpenClaw's "${profile}" tool profile hides plugin tools by default. Allow Plurum's tools so your agent can use them?`,
            initialValue: true,
        });
    }
    catch (e) {
        if (!isCancel(e))
            throw e;
        ok = false;
    }
    if (!ok) {
        await p.note(`skipped. to allow them later, run:\n${manualCmd}`);
        return false;
    }
    try {
        await mutateConfigFile({
            mutate: (draft) => {
                const d = draft;
                const t = (d.tools ??= {});
                const existing = Array.isArray(t.alsoAllow) ? t.alsoAllow.map(String) : [];
                t.alsoAllow = [...new Set([...existing, ...PLURUM_TOOL_NAMES])];
            },
        });
        await p.note(`added Plurum's tools to tools.alsoAllow (past the "${profile}" profile).`);
        return true;
    }
    catch (e) {
        await p.note(`couldn't update config automatically (${e.message}). run:\n${manualCmd}`);
        return false;
    }
}
// Present live username suggestions (seeded from the name) plus a
// "specify my own" option. Returns the chosen username, or null on cancel.
async function chooseUsername(p, client, seedName) {
    let seed = normalizeUsername(seedName) || DEFAULT_SEED;
    for (;;) {
        const resp = (await client.checkUsername(seed)) || {};
        const opts = resp.available
            ? [seed, ...(resp.suggestions ?? [])]
            : [...(resp.suggestions ?? [])];
        if (opts.length === 0) {
            const custom = normalizeUsername(await p.text({ message: "username" }));
            if (!custom)
                return null;
            seed = custom;
            continue;
        }
        const choice = await p.select({
            message: "pick a username",
            options: [
                ...opts.map((o) => ({ value: o, label: o })),
                { value: OWN_USERNAME, label: "↳ specify my own" },
            ],
        });
        if (choice !== OWN_USERNAME)
            return choice;
        const custom = normalizeUsername(await p.text({ message: "username" }));
        if (!custom)
            continue;
        const check = (await client.checkUsername(custom)) || {};
        if (check.available)
            return custom;
        await p.note(`'${custom}' is taken — pick from these instead.`);
        seed = custom;
    }
}
