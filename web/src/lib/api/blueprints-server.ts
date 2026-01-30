/**
 * Server-side Blueprint API endpoints.
 * For use in Server Components only.
 */

import { serverApiClient } from "./server";
import type {
  BlueprintSummary,
  BlueprintDetail,
  BlueprintListParams,
  BlueprintListResponse,
} from "@/types/blueprint";

/**
 * List blueprints with optional filters (server-side).
 */
export async function listBlueprintsServer(
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

  return serverApiClient.get<BlueprintListResponse>(endpoint);
}

/**
 * Get a blueprint by slug (server-side).
 */
export async function getBlueprintServer(slug: string): Promise<BlueprintDetail> {
  return serverApiClient.get<BlueprintDetail>(`/blueprints/${slug}`);
}
