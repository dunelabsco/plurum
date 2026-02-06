/**
 * HTTP client for Plurum API
 */

import type {
  PlurimMcpConfig,
  SessionOpenResponse,
  SessionCreateRequest,
  SessionEntryRequest,
  SessionCloseRequest,
  SessionDetail,
  ExperienceDetail,
  ExperienceCreateRequest,
  ExperienceSearchRequest,
  ExperienceSearchResponse,
  ExperienceAcquireRequest,
  ExperienceAcquireResponse,
  ExperienceListResponse,
  OutcomeReportRequest,
  VoteRequest,
  PulseStatus,
} from "./types.js";

export class PlurimApiClient {
  private apiUrl: string;
  private apiKey?: string;

  constructor(config: PlurimMcpConfig) {
    this.apiUrl = config.apiUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
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
          "API key required for this operation. Set PLURUM_API_KEY environment variable."
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
      const error = await response.text();
      throw new Error(`Plurum API error (${response.status}): ${error}`);
    }

    return response.json() as Promise<T>;
  }

  // ===== SESSIONS =====

  async openSession(data: SessionCreateRequest): Promise<SessionOpenResponse> {
    return this.request<SessionOpenResponse>("POST", "/api/v1/sessions", data, true);
  }

  async getSession(identifier: string): Promise<SessionDetail> {
    return this.request<SessionDetail>("GET", `/api/v1/sessions/${identifier}`, undefined, true);
  }

  async listSessions(options?: {
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<unknown> {
    const params = new URLSearchParams();
    if (options?.status) params.set("status", options.status);
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.offset) params.set("offset", String(options.offset));
    const query = params.toString();
    return this.request<unknown>("GET", `/api/v1/sessions${query ? `?${query}` : ""}`, undefined, true);
  }

  async logEntry(sessionId: string, data: SessionEntryRequest): Promise<unknown> {
    return this.request<unknown>("POST", `/api/v1/sessions/${sessionId}/entries`, data, true);
  }

  async closeSession(sessionId: string, data: SessionCloseRequest): Promise<unknown> {
    return this.request<unknown>("POST", `/api/v1/sessions/${sessionId}/close`, data, true);
  }

  async abandonSession(sessionId: string): Promise<unknown> {
    return this.request<unknown>("POST", `/api/v1/sessions/${sessionId}/abandon`, undefined, true);
  }

  // ===== EXPERIENCES =====

  async createExperience(data: ExperienceCreateRequest): Promise<ExperienceDetail> {
    return this.request<ExperienceDetail>("POST", "/api/v1/experiences", data, true);
  }

  async getExperience(identifier: string): Promise<ExperienceDetail> {
    return this.request<ExperienceDetail>("GET", `/api/v1/experiences/${identifier}`, undefined, true);
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
    return this.request<ExperienceListResponse>(
      "GET", `/api/v1/experiences${query ? `?${query}` : ""}`, undefined, true
    );
  }

  async searchExperiences(data: ExperienceSearchRequest): Promise<ExperienceSearchResponse> {
    return this.request<ExperienceSearchResponse>("POST", "/api/v1/experiences/search", data, true);
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

  async findSimilar(identifier: string, limit?: number): Promise<unknown> {
    const params = limit ? `?limit=${limit}` : "";
    return this.request<unknown>("GET", `/api/v1/experiences/${identifier}/similar${params}`, undefined, true);
  }

  // ===== PULSE =====

  async getPulseStatus(): Promise<PulseStatus> {
    return this.request<PulseStatus>("GET", "/api/v1/pulse/status");
  }
}
