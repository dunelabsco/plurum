// Config resolution for the Plurum plugin.
//
// The API key is intentionally NOT in the manifest configSchema. Per the
// OpenClaw extension boundary rules, secrets belong in env / credential
// flows, not in plugin metadata that gets inspected during discovery. We
// resolve the key from PLURUM_API_KEY first, then a local key file written
// by `openclaw plurum setup` or self-registration; the URL can be set via
// the standard plugin config so users can self-host without env edits.
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const DEFAULT_API_URL = "https://api.plurum.ai";
// Default identity used when an agent self-registers without supplying its
// own. Display name is non-unique (the backend dedupes usernames, not
// names); the seed is the starting point for username suggestions.
export const DEFAULT_NAME = "OpenClaw";
export const DEFAULT_SEED = "openclaw";
export const plurumConfigSchema = {
    jsonSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
            apiUrl: {
                type: "string",
                format: "uri",
                default: DEFAULT_API_URL,
                description: "Plurum API base URL.",
            },
        },
    },
};
export function resolveApiUrl(pluginConfig) {
    if (pluginConfig && typeof pluginConfig === "object") {
        const v = pluginConfig.apiUrl;
        if (typeof v === "string" && v.length > 0)
            return v.replace(/\/+$/, "");
    }
    const fromEnv = process.env.PLURUM_API_URL;
    if (typeof fromEnv === "string" && fromEnv.length > 0) {
        return fromEnv.replace(/\/+$/, "");
    }
    return DEFAULT_API_URL;
}
// OpenClaw's home is `<OPENCLAW_HOME or OS home>/.openclaw` (mirrors the
// host's own resolver in openclaw/dist home-dir). We keep the key file
// there — colocated with OpenClaw's own state, just like the Hermes plugin
// keeps it in ~/.hermes.
function openclawHome() {
    const osHome = homedir();
    const explicit = (process.env.OPENCLAW_HOME ?? "").trim();
    let home = osHome;
    if (explicit && explicit !== "undefined" && explicit !== "null") {
        home = explicit.startsWith("~")
            ? explicit.replace(/^~(?=$|[\\/])/, osHome)
            : explicit;
    }
    return join(home, ".openclaw");
}
function keyFilePath() {
    return join(openclawHome(), "plurum.json");
}
// Key precedence: env var wins (lets a deployment inject a key without
// touching disk), then the local key file written by setup / self-register.
// Read fresh on every call so a `setup` run or rotation is picked up without
// restarting the gateway.
export function resolveApiKey() {
    const fromEnv = (process.env.PLURUM_API_KEY ?? "").trim();
    if (fromEnv)
        return fromEnv;
    try {
        const raw = readFileSync(keyFilePath(), "utf8");
        const parsed = JSON.parse(raw);
        if (typeof parsed.api_key === "string")
            return parsed.api_key.trim();
    }
    catch {
        // No file yet, or unreadable — treated as "not connected".
    }
    return "";
}
// Persist the key to ~/.openclaw/plurum.json, merging with any existing
// content so we don't clobber future fields. Used by both the self-register
// tool and the setup CLI so the agent path and human path persist identically.
export function saveApiKey(apiKey) {
    const path = keyFilePath();
    let existing = {};
    try {
        existing = JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        // Fresh file.
    }
    existing.api_key = apiKey;
    mkdirSync(openclawHome(), { recursive: true });
    writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
}
export function keyFileLocation() {
    return keyFilePath();
}
