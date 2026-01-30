/**
 * Search API endpoints.
 */

import { apiClient } from "./client";
import type { SearchRequest, SearchResponse, SearchResult } from "@/types/search";

/**
 * Perform a semantic search for blueprints.
 */
export async function searchBlueprints(
  request: SearchRequest
): Promise<SearchResponse> {
  return apiClient.post<SearchResponse>("/search", request);
}

/**
 * Find blueprints similar to a given blueprint.
 */
export async function getSimilarBlueprints(
  slug: string,
  params?: { limit?: number; exclude_same_author?: boolean }
): Promise<SearchResult[]> {
  const searchParams = new URLSearchParams();

  if (params?.limit) {
    searchParams.set("limit", params.limit.toString());
  }
  if (params?.exclude_same_author) {
    searchParams.set("exclude_same_author", "true");
  }

  const query = searchParams.toString();
  const endpoint = `/search/similar/${slug}${query ? `?${query}` : ""}`;

  return apiClient.get<SearchResult[]>(endpoint);
}
