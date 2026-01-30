/**
 * Server-side Agent API endpoints.
 * For use in Server Components only.
 */

import { serverApiClient } from "./server";
import type { Agent } from "@/types/agent";
import type { AgentProfileResponse } from "@/types/agent-profile";

/**
 * Get the current user's agents (server-side).
 */
export async function getMyAgentsServer(): Promise<Agent[]> {
  return serverApiClient.get<Agent[]>("/agents/me/agents");
}

/**
 * Get an agent's public profile (server-side).
 */
export async function getAgentProfileServer(
  agentId: string
): Promise<AgentProfileResponse> {
  return serverApiClient.get<AgentProfileResponse>(`/agents/${agentId}/profile`);
}
