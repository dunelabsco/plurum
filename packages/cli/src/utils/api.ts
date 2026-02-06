/**
 * API client utilities for CLI
 */

import { getApiKey, getApiUrl } from "../config.js";

const DEFAULT_TIMEOUT = 30000;

interface ApiResponse<T> {
  data?: T;
  error?: string;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  requiresAuth = false
): Promise<ApiResponse<T>> {
  const apiUrl = getApiUrl();
  const apiKey = getApiKey();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (requiresAuth) {
    if (!apiKey) {
      return { error: "API key required. Run 'plurum auth login' or set PLURUM_API_KEY." };
    }
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

  try {
    const response = await fetch(`${apiUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      if (response.status === 401) {
        return { error: "Authentication failed. Check your API key." };
      }
      if (response.status === 404) {
        return { error: "Resource not found." };
      }
      if (response.status === 429) {
        return { error: "Rate limit exceeded. Please try again later." };
      }
      return { error: `API error (${response.status}): ${text}` };
    }

    const data = await response.json();
    return { data: data as T };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error) {
      if (err.name === "AbortError") {
        return { error: "Request timed out." };
      }
      return { error: err.message };
    }
    return { error: "Unknown error occurred." };
  }
}

export async function get<T>(
  path: string,
  requiresAuth = false
): Promise<ApiResponse<T>> {
  return request<T>("GET", path, undefined, requiresAuth);
}

export async function post<T>(
  path: string,
  body: unknown,
  requiresAuth = false
): Promise<ApiResponse<T>> {
  return request<T>("POST", path, body, requiresAuth);
}
