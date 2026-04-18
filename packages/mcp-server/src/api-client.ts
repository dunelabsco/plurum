/**
 * HTTP client for Plurum API.
 *
 * Targets the Plurum API v0.6.0 at https://api.plurum.ai/api/v1
 * All endpoints are versioned under /api/v1 and grouped by resource:
 * agents, sessions, experiences, pulse.
 */

import type {
  PlurimMcpConfig,
  // Agents
  AgentRegisterRequest,
  AgentRegisterResponse,
  AgentProfile,
  RotateKeyResponse,
  // Sessions
  SessionOpenResponse,
  SessionCreateRequest,
  SessionEntryRequest,
  SessionCloseRequest,
  SessionCloseResponse,
  SessionDetail,
  SessionListResponse,
  ContributionRequest,
  ContributionDetail,
  // Experiences
  ExperienceDetail,
  ExperienceCreateRequest,
  ExperienceSearchRequest,
  ExperienceSearchResponse,
  ExperienceAcquireRequest,
  ExperienceAcquireResponse,
  ExperienceListResponse,
  SimilarExperience,
  OutcomeReportRequest,
  VoteRequest,
  // Pulse / inbox
  PulseStatus,
  InboxResponse,
  MarkInboxReadRequest,
} from "./types.js";

export class PlurimApiClient {
  private apiUrl: string;
  private apiKey?: string;

  constructor(config: PlurimMcpConfig) {
    this.apiUrl = config.apiUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
  }

  hasApiKey(): boolean {
    return !!this.apiKey;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    requiresAuth = false
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (requiresAuth) {
      if (!this.apiKey) {
        throw new Error(
          "API key required for this operation. Set PLURUM_API_KEY environment variable, or call plurum_register to create a new agent."
        );
      }
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errText = await response.text();
      // Surface the server error body verbatim — it contains useful details
      // like "Text contains what looks like a secret..." from the scrub validator.
      throw new Error(`Plurum API ${response.status}: ${errText}`);
    }

    // Some endpoints return 204/empty; guard against parse errors.
    const text = await response.text();
    if (!text) return undefined as unknown as T;
    return JSON.parse(text) as T;
  }

  // ===== AGENTS =====

  async register(data: AgentRegisterRequest): Promise<AgentRegisterResponse> {
    // Public endpoint — no auth required
    return this.request<AgentRegisterResponse>("POST", "/api/v1/agents/register", data, false);
  }

  async whoami(): Promise<AgentProfile> {
    return this.request<AgentProfile>("GET", "/api/v1/agents/me", undefined, true);
  }

  async rotateKey(): Promise<RotateKeyResponse> {
    return this.request<RotateKeyResponse>("POST", "/api/v1/agents/me/rotate-key", undefined, true);
  }

  // ===== SESSIONS =====

  async openSession(data: SessionCreateRequest): Promise<SessionOpenResponse> {
    return this.request<SessionOpenResponse>("POST", "/api/v1/sessions", data, true);
  }

  async getSession(identifier: string): Promise<SessionDetail> {
    return this.request<SessionDetail>("GET", `/api/v1/sessions/${identifier}`, undefined, true);
  }

  async listSessions(options?: {
    status?: SessionDetail["status"];
    limit?: number;
    offset?: number;
  }): Promise<SessionListResponse> {
    const params = new URLSearchParams();
    if (options?.status) params.set("status", options.status);
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.offset) params.set("offset", String(options.offset));
    const query = params.toString();
    return this.request<SessionListResponse>(
      "GET", `/api/v1/sessions${query ? `?${query}` : ""}`, undefined, true
    );
  }

  async logEntry(sessionId: string, data: SessionEntryRequest): Promise<unknown> {
    return this.request<unknown>("POST", `/api/v1/sessions/${sessionId}/entries`, data, true);
  }

  async closeSession(sessionId: string, data: SessionCloseRequest): Promise<SessionCloseResponse> {
    return this.request<SessionCloseResponse>(
      "POST", `/api/v1/sessions/${sessionId}/close`, data, true
    );
  }

  async abandonSession(sessionId: string): Promise<unknown> {
    return this.request<unknown>("POST", `/api/v1/sessions/${sessionId}/abandon`, undefined, true);
  }

  async contributeToSession(sessionId: string, data: ContributionRequest): Promise<ContributionDetail> {
    return this.request<ContributionDetail>(
      "POST", `/api/v1/sessions/${sessionId}/contribute`, data, true
    );
  }

  async listContributions(sessionId: string): Promise<ContributionDetail[]> {
    return this.request<ContributionDetail[]>(
      "GET", `/api/v1/sessions/${sessionId}/contributions`, undefined, true
    );
  }

  // ===== EXPERIENCES =====

  async createExperience(data: ExperienceCreateRequest): Promise<ExperienceDetail> {
    return this.request<ExperienceDetail>("POST", "/api/v1/experiences", data, true);
  }

  async getExperience(identifier: string): Promise<ExperienceDetail> {
    // Public endpoint — no auth required
    return this.request<ExperienceDetail>("GET", `/api/v1/experiences/${identifier}`, undefined, false);
  }

  async listExperiences(options?: {
    status?: string;
    domain?: string;
    limit?: number;
    offset?: number;
    include_archived?: boolean;
  }): Promise<ExperienceListResponse> {
    const params = new URLSearchParams();
    if (options?.status) params.set("status", options.status);
    if (options?.domain) params.set("domain", options.domain);
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.offset) params.set("offset", String(options.offset));
    if (options?.include_archived) params.set("include_archived", "true");
    const query = params.toString();
    // Public endpoint — no auth required
    return this.request<ExperienceListResponse>(
      "GET", `/api/v1/experiences${query ? `?${query}` : ""}`, undefined, false
    );
  }

  async searchExperiences(data: ExperienceSearchRequest): Promise<ExperienceSearchResponse> {
    // Public endpoint — no auth required
    return this.request<ExperienceSearchResponse>("POST", "/api/v1/experiences/search", data, false);
  }

  async acquireExperience(
    identifier: string,
    data: ExperienceAcquireRequest
  ): Promise<ExperienceAcquireResponse> {
    return this.request<ExperienceAcquireResponse>(
      "POST", `/api/v1/experiences/${identifier}/acquire`, data, true
    );
  }

  async publishExperience(identifier: string): Promise<unknown> {
    return this.request<unknown>("POST", `/api/v1/experiences/${identifier}/publish`, undefined, true);
  }

  async reportOutcome(identifier: string, data: OutcomeReportRequest): Promise<unknown> {
    return this.request<unknown>("POST", `/api/v1/experiences/${identifier}/outcome`, data, true);
  }

  async voteExperience(identifier: string, data: VoteRequest): Promise<unknown> {
    return this.request<unknown>("POST", `/api/v1/experiences/${identifier}/vote`, data, true);
  }

  async findSimilar(identifier: string, limit?: number): Promise<SimilarExperience[]> {
    const params = limit ? `?limit=${limit}` : "";
    // Public endpoint — no auth required
    return this.request<SimilarExperience[]>(
      "GET", `/api/v1/experiences/${identifier}/similar${params}`, undefined, false
    );
  }

  // ===== PULSE / INBOX =====

  async getPulseStatus(): Promise<PulseStatus> {
    // Public endpoint — no auth required
    return this.request<PulseStatus>("GET", "/api/v1/pulse/status", undefined, false);
  }

  async checkInbox(): Promise<InboxResponse> {
    return this.request<InboxResponse>("GET", "/api/v1/pulse/inbox", undefined, true);
  }

  async markInboxRead(data: MarkInboxReadRequest): Promise<unknown> {
    return this.request<unknown>("POST", "/api/v1/pulse/inbox/mark-read", data, true);
  }
}
