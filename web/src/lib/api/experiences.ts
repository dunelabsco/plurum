/**
 * Experience API endpoints.
 */

import { apiClient } from "./client";
import type {
  ExperienceCreate,
  ExperienceDetail,
  ExperienceListResponse,
  ExperienceSearchRequest,
  ExperienceSearchResponse,
  ExperienceAcquireResponse,
  CompressionMode,
} from "@/types/experience";

export async function createExperience(data: ExperienceCreate): Promise<ExperienceDetail> {
  return apiClient.post<ExperienceDetail>("/experiences", data);
}

export async function getExperience(identifier: string): Promise<ExperienceDetail> {
  return apiClient.get<ExperienceDetail>(`/experiences/${identifier}`);
}

export async function listExperiences(params?: {
  status?: string;
  domain?: string;
  limit?: number;
  offset?: number;
  include_archived?: boolean;
}): Promise<ExperienceListResponse> {
  const searchParams = new URLSearchParams();
  if (params?.status) searchParams.set("status", params.status);
  if (params?.domain) searchParams.set("domain", params.domain);
  if (params?.limit) searchParams.set("limit", String(params.limit));
  if (params?.offset) searchParams.set("offset", String(params.offset));
  if (params?.include_archived) searchParams.set("include_archived", "true");
  const query = searchParams.toString();
  return apiClient.get<ExperienceListResponse>(`/experiences${query ? `?${query}` : ""}`);
}

export async function searchExperiences(
  data: ExperienceSearchRequest
): Promise<ExperienceSearchResponse> {
  return apiClient.post<ExperienceSearchResponse>("/experiences/search", data);
}

export async function acquireExperience(
  identifier: string,
  mode: CompressionMode = "full"
): Promise<ExperienceAcquireResponse> {
  return apiClient.post<ExperienceAcquireResponse>(
    `/experiences/${identifier}/acquire`,
    { mode }
  );
}

export async function publishExperience(identifier: string): Promise<unknown> {
  return apiClient.post(`/experiences/${identifier}/publish`);
}

export async function reportOutcome(
  identifier: string,
  data: { success: boolean; error_message?: string; context_notes?: string }
): Promise<unknown> {
  return apiClient.post(`/experiences/${identifier}/outcome`, data);
}

export async function voteExperience(
  identifier: string,
  vote_type: "up" | "down"
): Promise<unknown> {
  return apiClient.post(`/experiences/${identifier}/vote`, { vote_type });
}

export async function findSimilar(
  identifier: string,
  limit?: number
): Promise<unknown[]> {
  const params = limit ? `?limit=${limit}` : "";
  return apiClient.get<unknown[]>(`/experiences/${identifier}/similar${params}`);
}
