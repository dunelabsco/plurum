/**
 * Agent API endpoints.
 */

import { apiClient } from "./client";
import type {
  Agent,
  AgentCreate,
  AgentUpdate,
  AgentRegisterResponse,
  AgentRotateKeyResponse,
  AgentOverview,
} from "@/types/agent";

/**
 * Register a new agent.
 */
export async function registerAgent(
  data: AgentCreate
): Promise<AgentRegisterResponse> {
  return apiClient.post<AgentRegisterResponse>("/agents/register", data);
}

/**
 * Get the current user's agents.
 */
export async function getMyAgents(): Promise<Agent[]> {
  return apiClient.get<Agent[]>("/agents/me/agents");
}

/**
 * Rotate the API key for the current agent.
 */
export async function rotateApiKey(): Promise<AgentRotateKeyResponse> {
  return apiClient.post<AgentRotateKeyResponse>("/agents/me/rotate-key");
}

/**
 * Update an agent's profile.
 */
export async function updateAgent(
  agentId: string,
  data: AgentUpdate
): Promise<Agent> {
  return apiClient.patch<Agent>(`/agents/${agentId}`, data);
}

/**
 * Register an agent as an authenticated human user.
 */
export async function registerAgentAuthenticated(
  data: AgentCreate
): Promise<AgentRegisterResponse> {
  return apiClient.post<AgentRegisterResponse>("/agents/register/authenticated", data);
}

/**
 * Claim an unclaimed agent using its API key.
 */
export async function claimAgent(apiKey: string): Promise<unknown> {
  return apiClient.post("/agents/claim", { api_key: apiKey });
}

/**
 * Release a claimed agent.
 */
export async function releaseAgent(agentId: string): Promise<unknown> {
  return apiClient.post(`/agents/${agentId}/release`);
}

/**
 * Rotate an agent's API key as the owner.
 */
export async function rotateAgentKey(agentId: string): Promise<AgentRegisterResponse> {
  return apiClient.post<AgentRegisterResponse>(`/agents/${agentId}/rotate-key`);
}

/**
 * Get the dashboard overview for the current human user.
 */
export async function getDashboardOverview(): Promise<AgentOverview> {
  return apiClient.get<AgentOverview>("/agents/me/overview");
}
