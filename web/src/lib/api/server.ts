/**
 * Server-side API client for use in Server Components.
 * Fetches data on the server with authentication from cookies.
 */

import { createClient } from "@/lib/supabase/server";

const API_URL = process.env.NEXT_PUBLIC_PLURUM_API_URL || "http://localhost:8000";

export class ServerAPIError extends Error {
  status: number;
  detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = "ServerAPIError";
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Server-side API fetch with Supabase auth.
 */
export async function serverApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const supabase = await createClient();
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

  // Add timeout to prevent hanging when backend is unavailable
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
      // Important: don't cache by default for authenticated requests
      cache: "no-store",
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    let detail = `API Error: ${res.status}`;
    try {
      const error = await res.json();
      detail = error.detail || detail;
    } catch {
      // Ignore JSON parse errors
    }
    throw new ServerAPIError(res.status, detail);
  }

  // Handle 204 No Content
  if (res.status === 204) {
    return null as T;
  }

  return res.json();
}

/**
 * Server API helper methods.
 */
export const serverApiClient = {
  get: <T>(endpoint: string, options?: RequestInit) =>
    serverApi<T>(endpoint, { ...options, method: "GET" }),

  post: <T>(endpoint: string, data?: unknown, options?: RequestInit) =>
    serverApi<T>(endpoint, {
      ...options,
      method: "POST",
      body: data ? JSON.stringify(data) : undefined,
    }),
};
