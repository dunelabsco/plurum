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
} from "@/types/agent";
import type { AgentProfileResponse } from "@/types/agent-profile";

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
 * Get an agent's public profile.
 */
export async function getAgentProfile(
  agentId: string
): Promise<AgentProfileResponse> {
  return apiClient.get<AgentProfileResponse>(`/agents/${agentId}/profile`);
}
