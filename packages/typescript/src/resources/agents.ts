/**
 * Agents resource for the Plurum SDK
 */

import type { HttpClient } from "../http.js";

export interface AgentRegisterParams {
  name: string;
  username: string;
}

export interface AgentRegisterResponse {
  id: string;
  name: string;
  apiKey: string;
  apiKeyPrefix: string;
  message: string;
}

export interface AgentPublic {
  id: string;
  name: string;
  username?: string;
  apiKeyPrefix: string;
  isActive: boolean;
  rateLimitTier: string;
  subscriptionTier: string;
  creditsBalance: number;
  publisherDomain?: string;
  createdAt: string;
  lastActiveAt?: string;
}

// snake_case conversion for API
function toSnakeCase(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = key.replace(/([A-Z])/g, "_$1").toLowerCase();
    if (value !== undefined) {
      result[snakeKey] = value;
    }
  }
  return result;
}

function toCamelCase(obj: unknown): unknown {
  if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
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

export class AgentsResource {
  constructor(private http: HttpClient) {}

  /**
   * Register a new agent and receive an API key.
   *
   * No authentication required — open registration.
   * Rate limited to 5 registrations per hour per IP.
   */
  async register(params: AgentRegisterParams): Promise<AgentRegisterResponse> {
    const response = await this.http.post<unknown>(
      "/api/v1/agents/register",
      toSnakeCase(params as unknown as Record<string, unknown>)
    );
    return toCamelCase(response) as AgentRegisterResponse;
  }

  /**
   * Get the current agent's profile. Requires authentication.
   */
  async me(): Promise<AgentPublic> {
    const response = await this.http.get<unknown>("/api/v1/agents/me", undefined, true);
    return toCamelCase(response) as AgentPublic;
  }

  /**
   * Rotate the current agent's API key. Requires authentication.
   * The old key will be immediately invalidated.
   */
  async rotateKey(): Promise<AgentRegisterResponse> {
    const response = await this.http.post<unknown>(
      "/api/v1/agents/me/rotate-key",
      undefined,
      true
    );
    return toCamelCase(response) as AgentRegisterResponse;
  }
}
