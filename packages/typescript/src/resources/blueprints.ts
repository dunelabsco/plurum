/**
 * Blueprints resource for the Plurum SDK
 */

import type { HttpClient } from "../http.js";
import type {
  BlueprintDetail,
  BlueprintSummary,
  SearchParams,
  SearchResponse,
  SearchResult,
  ListBlueprintsParams,
  CreateBlueprintParams,
  UpdateBlueprintParams,
  SimilarParams,
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

export class BlueprintsResource {
  constructor(private http: HttpClient) {}

  /**
   * Search for blueprints using semantic similarity.
   */
  async search(params: SearchParams): Promise<SearchResponse> {
    const response = await this.http.post<unknown>(
      "/api/v1/search",
      toSnakeCase(params)
    );
    return toCamelCase(response) as SearchResponse;
  }

  /**
   * Get a blueprint by its slug.
   */
  async get(slug: string): Promise<BlueprintDetail> {
    const response = await this.http.get<unknown>(`/api/v1/blueprints/${slug}`);
    return toCamelCase(response) as BlueprintDetail;
  }

  /**
   * List blueprints with optional filtering.
   */
  async list(params: ListBlueprintsParams = {}): Promise<BlueprintSummary[]> {
    const response = await this.http.get<unknown[]>(
      "/api/v1/blueprints",
      toSnakeCase(params)
    );
    return toCamelCase(response) as BlueprintSummary[];
  }

  /**
   * Create a new blueprint.
   */
  async create(params: CreateBlueprintParams): Promise<BlueprintDetail> {
    const response = await this.http.post<unknown>(
      "/api/v1/blueprints",
      toSnakeCase(params),
      true
    );
    return toCamelCase(response) as BlueprintDetail;
  }

  /**
   * Update an existing blueprint.
   */
  async update(
    slug: string,
    params: UpdateBlueprintParams
  ): Promise<BlueprintDetail> {
    const response = await this.http.put<unknown>(
      `/api/v1/blueprints/${slug}`,
      toSnakeCase(params),
      true
    );
    return toCamelCase(response) as BlueprintDetail;
  }

  /**
   * Find blueprints similar to the given blueprint.
   */
  async similar(slug: string, params: SimilarParams = {}): Promise<SearchResult[]> {
    const response = await this.http.get<unknown[]>(
      `/api/v1/search/similar/${slug}`,
      toSnakeCase(params)
    );
    return toCamelCase(response) as SearchResult[];
  }
}
