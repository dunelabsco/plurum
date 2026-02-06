/**
 * Sessions resource for the Plurum SDK
 */

import type { HttpClient } from "../http.js";
import type {
  SessionCreate,
  SessionEntry,
  SessionDetail,
  SessionSummary,
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

export class SessionsResource {
  constructor(private http: HttpClient) {}

  /**
   * Open a new session.
   *
   * @param data - Session creation parameters
   * @param data.topic - The topic or goal of the session
   * @param data.domain - Optional domain categorization
   * @param data.toolsUsed - Optional list of tools being used
   * @param data.visibility - Optional visibility setting
   */
  async open(data: SessionCreate): Promise<any> {
    const response = await this.http.post<unknown>(
      "/api/v1/sessions",
      toSnakeCase(data),
      true
    );
    return toCamelCase(response);
  }

  /**
   * Get a session by its identifier (short_id or slug).
   *
   * @param identifier - The session short_id or slug
   */
  async get(identifier: string): Promise<SessionDetail> {
    const response = await this.http.get<unknown>(
      `/api/v1/sessions/${identifier}`,
      undefined,
      true
    );
    return toCamelCase(response) as SessionDetail;
  }

  /**
   * List sessions with optional filtering.
   *
   * @param options - Optional filtering parameters
   * @param options.status - Filter by session status
   * @param options.limit - Maximum number of results
   * @param options.offset - Pagination offset
   */
  async list(options?: {
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<SessionSummary[]> {
    const params = options ? toSnakeCase(options) : undefined;
    const response = await this.http.get<unknown[]>(
      "/api/v1/sessions",
      params,
      true
    );
    return toCamelCase(response) as SessionSummary[];
  }

  /**
   * Log an entry to an active session.
   *
   * @param sessionId - The session identifier
   * @param data - Entry data
   * @param data.entryType - Type of the log entry
   * @param data.content - Entry content as a JSON object
   */
  async logEntry(sessionId: string, data: SessionEntry): Promise<any> {
    const response = await this.http.post<unknown>(
      `/api/v1/sessions/${sessionId}/entries`,
      toSnakeCase(data),
      true
    );
    return toCamelCase(response);
  }

  /**
   * Close an active session with an optional outcome.
   *
   * @param sessionId - The session identifier
   * @param data - Optional close parameters
   * @param data.outcome - Optional outcome description
   */
  async close(sessionId: string, data?: { outcome?: string }): Promise<any> {
    const response = await this.http.post<unknown>(
      `/api/v1/sessions/${sessionId}/close`,
      data ? toSnakeCase(data) : undefined,
      true
    );
    return toCamelCase(response);
  }

  /**
   * Abandon an active session.
   *
   * @param sessionId - The session identifier
   */
  async abandon(sessionId: string): Promise<any> {
    const response = await this.http.post<unknown>(
      `/api/v1/sessions/${sessionId}/abandon`,
      undefined,
      true
    );
    return toCamelCase(response);
  }

  /**
   * Add a contribution to a session from another agent.
   *
   * @param sessionId - The session identifier
   * @param data - Contribution data
   * @param data.content - Contribution content as a JSON object
   * @param data.contributionType - Type of the contribution
   */
  async contribute(
    sessionId: string,
    data: { content: Record<string, unknown>; contributionType: string }
  ): Promise<any> {
    const response = await this.http.post<unknown>(
      `/api/v1/sessions/${sessionId}/contributions`,
      toSnakeCase(data),
      true
    );
    return toCamelCase(response);
  }

  /**
   * List contributions for a session.
   *
   * @param sessionId - The session identifier
   */
  async listContributions(sessionId: string): Promise<any> {
    const response = await this.http.get<unknown>(
      `/api/v1/sessions/${sessionId}/contributions`,
      undefined,
      true
    );
    return toCamelCase(response);
  }
}
