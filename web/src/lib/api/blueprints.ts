/**
 * Blueprint API endpoints.
 */

import { apiClient } from "./client";
import type {
  BlueprintSummary,
  BlueprintDetail,
  BlueprintCreate,
  BlueprintUpdate,
  BlueprintStatusUpdate,
  BlueprintVersion,
  BlueprintListParams,
  BlueprintListResponse,
} from "@/types/blueprint";

/**
 * List blueprints with optional filters.
 */
export async function listBlueprints(
  params?: BlueprintListParams
): Promise<BlueprintListResponse> {
  const searchParams = new URLSearchParams();

  if (params?.mine) {
    searchParams.set("mine", "true");
  }
  if (params?.status) {
    searchParams.set("status", params.status);
  }
  if (params?.tags?.length) {
    params.tags.forEach((tag) => searchParams.append("tags", tag));
  }
  if (params?.limit) {
    searchParams.set("limit", params.limit.toString());
  }
  if (params?.offset) {
    searchParams.set("offset", params.offset.toString());
  }

  const query = searchParams.toString();
  const endpoint = `/blueprints${query ? `?${query}` : ""}`;

  return apiClient.get<BlueprintListResponse>(endpoint);
}

/**
 * Get a blueprint by slug.
 */
export async function getBlueprint(slug: string): Promise<BlueprintDetail> {
  return apiClient.get<BlueprintDetail>(`/blueprints/${slug}`);
}

/**
 * Create a new blueprint.
 */
export async function createBlueprint(
  data: BlueprintCreate
): Promise<BlueprintDetail> {
  return apiClient.post<BlueprintDetail>("/blueprints", data);
}

/**
 * Update a blueprint (creates a new version).
 */
export async function updateBlueprint(
  slug: string,
  data: BlueprintUpdate
): Promise<BlueprintDetail> {
  return apiClient.put<BlueprintDetail>(`/blueprints/${slug}`, data);
}

/**
 * Update a blueprint's status.
 */
export async function updateBlueprintStatus(
  slug: string,
  data: BlueprintStatusUpdate
): Promise<BlueprintDetail> {
  return apiClient.patch<BlueprintDetail>(`/blueprints/${slug}/status`, data);
}

/**
 * Delete a blueprint.
 */
export async function deleteBlueprint(slug: string): Promise<void> {
  return apiClient.delete<void>(`/blueprints/${slug}`);
}

/**
 * Get version history for a blueprint.
 */
export async function getBlueprintVersions(
  slug: string
): Promise<BlueprintVersion[]> {
  return apiClient.get<BlueprintVersion[]>(`/blueprints/${slug}/versions`);
}
