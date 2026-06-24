// HTTP client + circuit breaker for the Plurum API.
//
// Native fetch (Node 22+ ships it). Mirrors the breaker pattern from the
// Python Hermes plugin: after N consecutive failures, pause API calls for
// a cooldown so a downed backend can't hammer the agent loop. Each tool
// handler owns the success/failure recording so partial pipeline errors
// don't all flow through one path.

import type { PluginLogger } from "../api.js";

const DEFAULT_TIMEOUT_MS = 12_000;
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 120_000;

export type SearchHit = Record<string, unknown>;
export type SearchResponse = {
  results?: SearchHit[];
  total_found?: number;
};

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
  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string,
    private readonly logger?: PluginLogger,
  ) {}

  get hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  isBreakerOpen(): boolean {
    if (consecutiveFailures < BREAKER_THRESHOLD) return false;
    if (Date.now() >= breakerOpenUntil) {
      consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    consecutiveFailures = 0;
  }

  recordFailure(): void {
    consecutiveFailures += 1;
    if (consecutiveFailures >= BREAKER_THRESHOLD) {
      breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
      this.logger?.warn?.(
        `Plurum circuit breaker tripped after ${consecutiveFailures} consecutive failures; pausing for ${BREAKER_COOLDOWN_MS / 1000}s.`,
      );
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
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
      return text ? (JSON.parse(text) as T) : (null as T);
    } finally {
      clearTimeout(timer);
    }
  }

  searchExperiences(query: string, limit = 10): Promise<SearchResponse> {
    return this.request<SearchResponse>("POST", "/api/v1/experiences/search", { query, limit });
  }

  getExperience(identifier: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      "GET",
      `/api/v1/experiences/${encodeURIComponent(identifier)}`,
    );
  }

  createExperience(body: Record<string, unknown>): Promise<{ id?: string; short_id?: string }> {
    return this.request<{ id?: string; short_id?: string }>(
      "POST",
      "/api/v1/experiences",
      body,
    );
  }

  publishExperience(identifier: string): Promise<unknown> {
    return this.request<unknown>(
      "POST",
      `/api/v1/experiences/${encodeURIComponent(identifier)}/publish`,
    );
  }

  archiveExperience(identifier: string): Promise<unknown> {
    return this.request<unknown>(
      "POST",
      `/api/v1/experiences/${encodeURIComponent(identifier)}/archive`,
    );
  }

  reportOutcome(identifier: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>(
      "POST",
      `/api/v1/experiences/${encodeURIComponent(identifier)}/outcome`,
      body,
    );
  }

  voteExperience(identifier: string, vote: "up" | "down"): Promise<unknown> {
    return this.request<unknown>(
      "POST",
      `/api/v1/experiences/${encodeURIComponent(identifier)}/vote`,
      { vote_type: vote },
    );
  }

  // --- Onboarding / self-registration ---

  registerAgent(
    name: string,
    username: string,
  ): Promise<{ id?: string; name?: string; api_key?: string }> {
    return this.request("POST", "/api/v1/agents/register", { name, username });
  }

  checkUsername(
    username: string,
  ): Promise<{ available?: boolean; suggestions?: string[] }> {
    return this.request(
      "GET",
      `/api/v1/agents/check-username?username=${encodeURIComponent(username)}`,
    );
  }

  // Validates a pasted key by reading the authenticated agent's own record.
  getMe(): Promise<{ username?: string; name?: string }> {
    return this.request("GET", "/api/v1/agents/me");
  }
}

export function toolErrorJson(msg: string): string {
  return JSON.stringify({ error: msg });
}

// No-key error for the 7 working tools. Points the agent at the one tool
// that fixes it, so a search-first agent can connect and retry — the tools
// are always visible (OpenClaw snapshots the toolset at session start), so
// connecting happens on demand rather than via a tool that appears later.
export function needsKeyJson(): string {
  return JSON.stringify({
    error:
      "Plurum isn't connected yet. Call plurum_register first to self-onboard " +
      "(automatic — no key or human action needed), then retry this call.",
  });
}

export function breakerErrorJson(): string {
  return JSON.stringify({
    error:
      "Plurum API temporarily unavailable (multiple consecutive failures). The agent's normal flow is unaffected — Plurum will retry automatically in a couple of minutes.",
  });
}
