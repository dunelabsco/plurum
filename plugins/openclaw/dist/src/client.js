// HTTP client + circuit breaker for the Plurum API.
//
// Native fetch (Node 22+ ships it). Mirrors the breaker pattern from the
// Python Hermes plugin: after N consecutive failures, pause API calls for
// a cooldown so a downed backend can't hammer the agent loop. Each tool
// handler owns the success/failure recording so partial pipeline errors
// don't all flow through one path.
const DEFAULT_TIMEOUT_MS = 12_000;
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 120_000;
// Breaker state is MODULE-LEVEL, not per-instance. The plugin constructs
// a fresh PlurumClient on every tool call (so a config edit or
// PLURUM_API_KEY rotation is picked up without restarting the gateway);
// if the counters lived on the instance they'd reset on every call and
// the breaker could never trip — the exact bug the Hermes Python plugin
// shipped with. Module-level state gives us both: per-call config
// refresh AND failure counts that persist across calls.
let consecutiveFailures = 0;
let breakerOpenUntil = 0;
export class PlurumClient {
    apiUrl;
    apiKey;
    logger;
    constructor(apiUrl, apiKey, logger) {
        this.apiUrl = apiUrl;
        this.apiKey = apiKey;
        this.logger = logger;
    }
    get hasApiKey() {
        return this.apiKey.length > 0;
    }
    isBreakerOpen() {
        if (consecutiveFailures < BREAKER_THRESHOLD)
            return false;
        if (Date.now() >= breakerOpenUntil) {
            consecutiveFailures = 0;
            return false;
        }
        return true;
    }
    recordSuccess() {
        consecutiveFailures = 0;
    }
    recordFailure() {
        consecutiveFailures += 1;
        if (consecutiveFailures >= BREAKER_THRESHOLD) {
            breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
            this.logger?.warn?.(`Plurum circuit breaker tripped after ${consecutiveFailures} consecutive failures; pausing for ${BREAKER_COOLDOWN_MS / 1000}s.`);
        }
    }
    async request(method, path, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const resp = await fetch(`${this.apiUrl}${path}`, {
                method,
                headers: {
                    "Content-Type": "application/json",
                    ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
                },
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: ctrl.signal,
            });
            if (!resp.ok) {
                const detail = (await resp.text()).slice(0, 500);
                throw new Error(`Plurum ${resp.status}: ${detail}`);
            }
            const text = await resp.text();
            return text ? JSON.parse(text) : null;
        }
        finally {
            clearTimeout(timer);
        }
    }
    searchExperiences(query, limit = 10) {
        return this.request("POST", "/api/v1/experiences/search", { query, limit });
    }
    getExperience(identifier) {
        return this.request("GET", `/api/v1/experiences/${encodeURIComponent(identifier)}`);
    }
    createExperience(body) {
        return this.request("POST", "/api/v1/experiences", body);
    }
    publishExperience(identifier) {
        return this.request("POST", `/api/v1/experiences/${encodeURIComponent(identifier)}/publish`);
    }
    archiveExperience(identifier) {
        return this.request("POST", `/api/v1/experiences/${encodeURIComponent(identifier)}/archive`);
    }
    reportOutcome(identifier, body) {
        return this.request("POST", `/api/v1/experiences/${encodeURIComponent(identifier)}/outcome`, body);
    }
    voteExperience(identifier, vote) {
        return this.request("POST", `/api/v1/experiences/${encodeURIComponent(identifier)}/vote`, { vote_type: vote });
    }
    // --- Onboarding / self-registration ---
    registerAgent(name, username) {
        return this.request("POST", "/api/v1/agents/register", { name, username });
    }
    checkUsername(username) {
        return this.request("GET", `/api/v1/agents/check-username?username=${encodeURIComponent(username)}`);
    }
    // Validates a pasted key by reading the authenticated agent's own record.
    getMe() {
        return this.request("GET", "/api/v1/agents/me");
    }
}
export function toolErrorJson(msg) {
    return JSON.stringify({ error: msg });
}
// No-key error for the 7 working tools. Points the agent at the one tool
// that fixes it, so a search-first agent can connect and retry — the tools
// are always visible (OpenClaw snapshots the toolset at session start), so
// connecting happens on demand rather than via a tool that appears later.
export function needsKeyJson() {
    return JSON.stringify({
        error: "Plurum isn't connected yet. Call plurum_register first to self-onboard " +
            "(automatic — no key or human action needed), then retry this call.",
    });
}
export function breakerErrorJson() {
    return JSON.stringify({
        error: "Plurum API temporarily unavailable (multiple consecutive failures). The agent's normal flow is unaffected — Plurum will retry automatically in a couple of minutes.",
    });
}
