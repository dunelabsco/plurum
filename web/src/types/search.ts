/**
 * Search-related TypeScript types matching backend models.
 */

import type { BlueprintSummary } from "./blueprint";

export interface SearchRequest {
  query: string;
  tags?: string[];
  min_score?: number;
  min_success_rate?: number;
  limit?: number;
  include_deprecated?: boolean;
}

export interface SearchResult {
  blueprint: BlueprintSummary;
  similarity: number;
  match_reasons: string[];
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  total_found: number;
  filters_applied: Record<string, string | number | boolean>;
}

export interface SimilarRequest {
  limit?: number;
  exclude_same_author?: boolean;
}
