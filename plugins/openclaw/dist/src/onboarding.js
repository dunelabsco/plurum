// Shared self-registration logic, used by both the plurum_register tool
// and the `openclaw plurum setup` CLI command. Keeping it here means the
// agent path and the human path mint accounts and persist keys identically.
import { DEFAULT_SEED, saveApiKey } from "./config.js";
export class OnboardingError extends Error {
}
// Client-side mirror of the backend username normalizer so what we check
// and what we register always match: lowercase, [a-z0-9_-], trimmed of
// leading/trailing non-alphanumerics, capped at 50 chars.
export function normalizeUsername(raw) {
    return (raw || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^[^a-z0-9]+/, "")
        .replace(/[^a-z0-9]+$/, "")
        .slice(0, 50);
}
// Return a free username: the desired one if available, else the first
// suggestion the backend returns.
export async function resolveUsername(client, desired = "") {
    const seed = normalizeUsername(desired) || DEFAULT_SEED;
    const resp = (await client.checkUsername(seed)) || {};
    if (resp.available)
        return seed;
    for (const s of resp.suggestions ?? []) {
        if (s)
            return s;
    }
    throw new OnboardingError("Could not find a free username automatically. Try a different name.");
}
// Register the agent and write the key to ~/.openclaw/plurum.json.
export async function registerAndPersist(client, name, username) {
    const created = (await client.registerAgent(name, username)) || {};
    const apiKey = created.api_key;
    if (!apiKey)
        throw new OnboardingError("Registration returned no api_key.");
    saveApiKey(apiKey);
    return { id: created.id, name: created.name || name, username, apiKey };
}
