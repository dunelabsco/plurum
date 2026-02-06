/**
 * Experiences resource for the Plurum SDK
 */

import type { HttpClient } from "../http.js";
import type {
  ExperienceCreate,
  ExperienceDetail,
  ExperienceSummary,
  ExperienceSearchRequest,
  ExperienceAcquireRequest,
  ExperienceAcquireResponse,
  OutcomeReport,
  VoteCreate,
} from "../types/index.js";

// Helper to convert camelCase to snake_case for API
function toSnakeCase<T extends object>(obj: T): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = key.replace(/([A-Z])/g, "_$1").toLowerCase();
    if (value !== undefined) {
      if (Array.isArray(value)) {
        result[snakeKey] = value.map((item) =>
          typeof item === "object" && item !== null
            ? toSnakeCase(item as Record<string, unknown>)
            : item
        );
      } else if (typeof value === "object" && value !== null) {
        result[snakeKey] = toSnakeCase(value as Record<string, unknown>);
      } else {
        result[snakeKey] = value;
      }
    }
  }
  return result;
}

// Helper to convert snake_case to camelCase for response
function toCamelCase(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(toCamelCase);
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const camelKey = key.replace(/_([a-z])/g, (_, letter) =>
        letter.toUpperCase()
      );
      result[camelKey] = toCamelCase(value);
    }
    return result;
  }
  return obj;
}

export class ExperiencesResource {
  constructor(private http: HttpClient) {}

  /**
   * Create a new experience from a completed session.
   *
   * @param data - Experience creation parameters
   */
  async create(data: ExperienceCreate): Promise<ExperienceDetail> {
    const response = await this.http.post<unknown>(
      "/api/v1/experiences",
      toSnakeCase(data),
      true
    );
    return toCamelCase(response) as ExperienceDetail;
  }

  /**
   * Get an experience by its identifier (short_id or slug).
   *
   * @param identifier - The experience short_id or slug
   */
  async get(identifier: string): Promise<ExperienceDetail> {
    const response = await this.http.get<unknown>(
      `/api/v1/experiences/${identifier}`
    );
    return toCamelCase(response) as ExperienceDetail;
  }

  /**
   * List experiences with optional filtering.
   *
   * @param options - Optional filtering parameters
   * @param options.status - Filter by experience status
   * @param options.domain - Filter by domain
   * @param options.limit - Maximum number of results
   * @param options.offset - Pagination offset
   */
  async list(options?: {
    status?: string;
    domain?: string;
    limit?: number;
    offset?: number;
  }): Promise<ExperienceSummary[]> {
    const params = options ? toSnakeCase(options) : undefined;
    const response = await this.http.get<unknown[]>(
      "/api/v1/experiences",
      params
    );
    return toCamelCase(response) as ExperienceSummary[];
  }

  /**
   * Search for experiences using semantic similarity.
   *
   * @param data - Search parameters
   * @param data.query - Search query string
   * @param data.domain - Optional domain filter
   * @param data.tools - Optional tools filter
   * @param data.minQuality - Optional minimum quality score
   * @param data.limit - Maximum number of results
   */
  async search(data: ExperienceSearchRequest): Promise<any> {
    const response = await this.http.post<unknown>(
      "/api/v1/experiences/search",
      toSnakeCase(data)
    );
    return toCamelCase(response);
  }

  /**
   * Acquire an experience for use. Creates a local copy or reference.
   *
   * @param identifier - The experience short_id or slug
   * @param data - Optional acquire parameters
   * @param data.mode - Acquisition mode
   */
  async acquire(
    identifier: string,
    data?: ExperienceAcquireRequest
  ): Promise<ExperienceAcquireResponse> {
    const response = await this.http.post<unknown>(
      `/api/v1/experiences/${identifier}/acquire`,
      data ? toSnakeCase(data) : undefined,
      true
    );
    return toCamelCase(response) as ExperienceAcquireResponse;
  }

  /**
   * Publish a draft experience, making it publicly available.
   *
   * @param identifier - The experience short_id or slug
   */
  async publish(identifier: string): Promise<any> {
    const response = await this.http.post<unknown>(
      `/api/v1/experiences/${identifier}/publish`,
      undefined,
      true
    );
    return toCamelCase(response);
  }

  /**
   * Report the outcome of using an experience.
   *
   * @param identifier - The experience short_id or slug
   * @param data - Outcome report data
   * @param data.success - Whether the outcome was successful
   * @param data.errorMessage - Optional error message if unsuccessful
   * @param data.contextNotes - Optional additional context
   */
  async reportOutcome(
    identifier: string,
    data: OutcomeReport
  ): Promise<any> {
    const response = await this.http.post<unknown>(
      `/api/v1/experiences/${identifier}/outcomes`,
      toSnakeCase(data),
      true
    );
    return toCamelCase(response);
  }

  /**
   * Vote on an experience.
   *
   * @param identifier - The experience short_id or slug
   * @param data - Vote data
   * @param data.voteType - "up" for helpful, "down" for unhelpful
   */
  async vote(identifier: string, data: VoteCreate): Promise<any> {
    const response = await this.http.post<unknown>(
      `/api/v1/experiences/${identifier}/votes`,
      toSnakeCase(data),
      true
    );
    return toCamelCase(response);
  }

  /**
   * Find experiences similar to the given experience.
   *
   * @param identifier - The experience short_id or slug
   * @param limit - Optional maximum number of results
   */
  async findSimilar(identifier: string, limit?: number): Promise<any> {
    const params = limit !== undefined ? { limit } : undefined;
    const response = await this.http.get<unknown>(
      `/api/v1/experiences/${identifier}/similar`,
      params
    );
    return toCamelCase(response);
  }
}
