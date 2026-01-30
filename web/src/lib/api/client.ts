/**
 * API client with Supabase authentication support.
 */

import { createClient } from "@/lib/supabase/client";

const API_URL = process.env.NEXT_PUBLIC_PLURUM_API_URL || "http://localhost:8000";

export class APIError extends Error {
  status: number;
  detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = "APIError";
    this.status = status;
    this.detail = detail;
  }
}

export async function api<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const url = `${API_URL}/api/v1${endpoint}`;

  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...options.headers,
  };

  if (session?.access_token) {
    (headers as Record<string, string>)["Authorization"] = `Bearer ${session.access_token}`;
  }

  const res = await fetch(url, {
    ...options,
    headers,
  });

  if (!res.ok) {
    let detail = `API Error: ${res.status}`;
    try {
      const error = await res.json();
      detail = error.detail || detail;
    } catch {
      // Ignore JSON parse errors
    }
    throw new APIError(res.status, detail);
  }

  // Handle 204 No Content
  if (res.status === 204) {
    return null as T;
  }

  return res.json();
}

/**
 * API helper methods for common HTTP verbs.
 */
export const apiClient = {
  get: <T>(endpoint: string, options?: RequestInit) =>
    api<T>(endpoint, { ...options, method: "GET" }),

  post: <T>(endpoint: string, data?: unknown, options?: RequestInit) =>
    api<T>(endpoint, {
      ...options,
      method: "POST",
      body: data ? JSON.stringify(data) : undefined,
    }),

  put: <T>(endpoint: string, data?: unknown, options?: RequestInit) =>
    api<T>(endpoint, {
      ...options,
      method: "PUT",
      body: data ? JSON.stringify(data) : undefined,
    }),

  patch: <T>(endpoint: string, data?: unknown, options?: RequestInit) =>
    api<T>(endpoint, {
      ...options,
      method: "PATCH",
      body: data ? JSON.stringify(data) : undefined,
    }),

  delete: <T>(endpoint: string, options?: RequestInit) =>
    api<T>(endpoint, { ...options, method: "DELETE" }),
};
