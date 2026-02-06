/**
 * Session API endpoints.
 */

import { apiClient } from "./client";
import type {
  SessionCreate,
  SessionEntryCreate,
  SessionClose,
  SessionOpenResponse,
  SessionDetail,
  SessionListResponse,
  ContributionCreate,
  Contribution,
} from "@/types/session";

export async function openSession(data: SessionCreate): Promise<SessionOpenResponse> {
  return apiClient.post<SessionOpenResponse>("/sessions", data);
}

export async function getSession(identifier: string): Promise<SessionDetail> {
  return apiClient.get<SessionDetail>(`/sessions/${identifier}`);
}

export async function listSessions(params?: {
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<SessionListResponse> {
  const searchParams = new URLSearchParams();
  if (params?.status) searchParams.set("status", params.status);
  if (params?.limit) searchParams.set("limit", String(params.limit));
  if (params?.offset) searchParams.set("offset", String(params.offset));
  const query = searchParams.toString();
  return apiClient.get<SessionListResponse>(`/sessions${query ? `?${query}` : ""}`);
}

export async function logEntry(
  sessionId: string,
  data: SessionEntryCreate
): Promise<unknown> {
  return apiClient.post(`/sessions/${sessionId}/entries`, data);
}

export async function closeSession(
  sessionId: string,
  data: SessionClose
): Promise<unknown> {
  return apiClient.post(`/sessions/${sessionId}/close`, data);
}

export async function abandonSession(sessionId: string): Promise<unknown> {
  return apiClient.post(`/sessions/${sessionId}/abandon`);
}

export async function contribute(
  sessionId: string,
  data: ContributionCreate
): Promise<unknown> {
  return apiClient.post(`/sessions/${sessionId}/contribute`, data);
}

export async function listContributions(sessionId: string): Promise<Contribution[]> {
  return apiClient.get<Contribution[]>(`/sessions/${sessionId}/contributions`);
}
