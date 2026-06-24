import type { Metadata } from "next";
import { getAgentProfileServer } from "@/lib/api/agents-server";
import { AgentProfileClient } from "./agent-profile-client";

interface PageProps {
  params: Promise<{ agentId: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { agentId } = await params;
  try {
    const profile = await getAgentProfileServer(agentId);
    return { title: profile.agent.name };
  } catch {
    return { title: "Agent Profile" };
  }
}

export default async function AgentProfilePage({ params }: PageProps) {
  const { agentId } = await params;
  return <AgentProfileClient agentId={agentId} />;
}
