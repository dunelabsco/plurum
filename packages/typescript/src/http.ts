/**
 * HTTP client for Plurum API
 */

import {
  PlurimError,
  AuthenticationError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from "./errors.js";
import type { PlurimConfig } from "./types/index.js";

const DEFAULT_API_URL = "https://api.plurum.dev";
const DEFAULT_TIMEOUT = 30000;

export class HttpClient {
  private apiKey?: string;
  private apiUrl: string;
  private timeout: number;

  constructor(config: PlurimConfig = {}) {
    this.apiKey = config.apiKey || process.env.PLURUM_API_KEY;
    this.apiUrl = (
      config.apiUrl ||
      process.env.PLURUM_API_URL ||
      DEFAULT_API_URL
    ).replace(/\/$/, "");
    this.timeout = config.timeout || DEFAULT_TIMEOUT;
  }

  private headers(requiresAuth: boolean = false): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (requiresAuth) {
      if (!this.apiKey) {
        throw new AuthenticationError(
          "API key required. Set PLURUM_API_KEY environment variable or pass apiKey to client."
        );
      }
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    return headers;
  }

  private async handleError(response: Response): Promise<void> {
    if (response.status === 401) {
      throw new AuthenticationError();
    } else if (response.status === 404) {
      throw new NotFoundError();
    } else if (response.status === 429) {
      throw new RateLimitError();
    } else if (response.status === 422) {
      const body = await response.json().catch(() => ({ detail: response.statusText })) as { detail?: string };
      throw new ValidationError(body.detail || "Validation failed");
    } else if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new PlurimError(`API request failed: ${text}`, response.status);
    }
  }

  async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const url = new URL(`${this.apiUrl}${path}`);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          if (Array.isArray(value)) {
            value.forEach((v) => url.searchParams.append(key, String(v)));
          } else {
            url.searchParams.set(key, String(value));
          }
        }
      });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: this.headers(),
        signal: controller.signal,
      });

      await this.handleError(response);
      return response.json() as Promise<T>;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async post<T>(
    path: string,
    data?: Record<string, unknown>,
    requiresAuth: boolean = false
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.apiUrl}${path}`, {
        method: "POST",
        headers: this.headers(requiresAuth),
        body: data ? JSON.stringify(data) : undefined,
        signal: controller.signal,
      });

      await this.handleError(response);
      return response.json() as Promise<T>;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async put<T>(
    path: string,
    data?: Record<string, unknown>,
    requiresAuth: boolean = false
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.apiUrl}${path}`, {
        method: "PUT",
        headers: this.headers(requiresAuth),
        body: data ? JSON.stringify(data) : undefined,
        signal: controller.signal,
      });

      await this.handleError(response);
      return response.json() as Promise<T>;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async delete<T>(path: string, requiresAuth: boolean = false): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.apiUrl}${path}`, {
        method: "DELETE",
        headers: this.headers(requiresAuth),
        signal: controller.signal,
      });

      await this.handleError(response);
      return response.json() as Promise<T>;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
