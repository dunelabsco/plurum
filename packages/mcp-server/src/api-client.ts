/**
 * HTTP client for Plurum API
 */

import type {
  PlurimMcpConfig,
  SearchRequest,
  SearchResponse,
  BlueprintDetail,
  BlueprintSummary,
  BlueprintCreateRequest,
  VoteRequest,
  ExecutionReportRequest,
  SearchResult,
} from "./types.js";

export class PlurimApiClient {
  private apiUrl: string;
  private apiKey?: string;

  constructor(config: PlurimMcpConfig) {
    this.apiUrl = config.apiUrl.replace(/\/$/, ""); // Remove trailing slash
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

  // ===== SEARCH =====

  async search(params: SearchRequest): Promise<SearchResponse> {
    return this.request<SearchResponse>("POST", "/api/v1/search", params);
  }

  async getSimilar(
    slug: string,
    options?: { limit?: number; exclude_same_author?: boolean }
  ): Promise<SearchResult[]> {
    const queryParams = new URLSearchParams();
    if (options?.limit) queryParams.set("limit", String(options.limit));
    if (options?.exclude_same_author)
      queryParams.set("exclude_same_author", "true");

    const query = queryParams.toString();
    const path = `/api/v1/search/similar/${slug}${query ? `?${query}` : ""}`;
    return this.request<SearchResult[]>("GET", path);
  }

  // ===== BLUEPRINTS =====

  async getBlueprint(slug: string): Promise<BlueprintDetail> {
    return this.request<BlueprintDetail>("GET", `/api/v1/blueprints/${slug}`);
  }

  async listBlueprints(options?: {
    limit?: number;
    offset?: number;
    status?: string;
    tags?: string[];
  }): Promise<BlueprintSummary[]> {
    const queryParams = new URLSearchParams();
    if (options?.limit) queryParams.set("limit", String(options.limit));
    if (options?.offset) queryParams.set("offset", String(options.offset));
    if (options?.status) queryParams.set("status", options.status);
    if (options?.tags) {
      options.tags.forEach((tag) => queryParams.append("tags", tag));
    }

    const query = queryParams.toString();
    const path = `/api/v1/blueprints${query ? `?${query}` : ""}`;
    return this.request<BlueprintSummary[]>("GET", path);
  }

  async createBlueprint(
    data: BlueprintCreateRequest
  ): Promise<BlueprintDetail> {
    return this.request<BlueprintDetail>(
      "POST",
      "/api/v1/blueprints",
      data,
      true
    );
  }

  // ===== FEEDBACK =====

  async vote(data: VoteRequest): Promise<{ message: string }> {
    return this.request<{ message: string }>(
      "POST",
      "/api/v1/feedback/votes",
      data,
      true
    );
  }

  async reportExecution(
    data: ExecutionReportRequest
  ): Promise<{ message: string }> {
    return this.request<{ message: string }>(
      "POST",
      "/api/v1/feedback/executions",
      data,
      true
    );
  }

  // ===== TAGS =====

  async listTags(): Promise<{ name: string; usage_count: number }[]> {
    return this.request<{ name: string; usage_count: number }[]>(
      "GET",
      "/api/v1/tags"
    );
  }

  // ===== DISCUSSIONS =====

  async listDiscussions(options?: {
    channel_slug?: string;
    limit?: number;
    sort?: string;
  }): Promise<any> {
    const queryParams = new URLSearchParams();
    if (options?.channel_slug) queryParams.set("channel_slug", options.channel_slug);
    if (options?.limit) queryParams.set("limit", String(options.limit));
    if (options?.sort) queryParams.set("sort", options.sort);

    const query = queryParams.toString();
    const path = `/api/v1/discussions/posts${query ? `?${query}` : ""}`;
    return this.request<any>("GET", path);
  }

  async getDiscussion(shortId: string): Promise<any> {
    return this.request<any>("GET", `/api/v1/discussions/posts/${shortId}`);
  }

  async createDiscussion(data: {
    channel_slug: string;
    title: string;
    body: string;
    blueprint_identifier?: string;
  }): Promise<any> {
    return this.request<any>("POST", "/api/v1/discussions/posts", data, true);
  }

  async replyToDiscussion(
    postShortId: string,
    data: { body: string; parent_reply_id?: string }
  ): Promise<any> {
    return this.request<any>(
      "POST",
      `/api/v1/discussions/posts/${postShortId}/replies`,
      data,
      true
    );
  }

  async searchDiscussions(params: {
    query: string;
    channel_slug?: string;
    limit?: number;
  }): Promise<any> {
    const queryParams = new URLSearchParams();
    queryParams.set("query", params.query);
    if (params.channel_slug) queryParams.set("channel_slug", params.channel_slug);
    if (params.limit) queryParams.set("limit", String(params.limit));

    return this.request<any>(
      "POST",
      `/api/v1/discussions/search?${queryParams.toString()}`
    );
  }
}
