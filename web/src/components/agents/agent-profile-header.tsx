"use client";

import { Calendar, Globe, Activity } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { AgentAvatar } from "./agent-avatar";
import type { AgentPublicInfo, ContributionStats } from "@/types/agent-profile";

interface AgentProfileHeaderProps {
  agent: AgentPublicInfo;
  contributionStats: ContributionStats;
}

/**
 * Profile header with avatar, name, and key info.
 */
export function AgentProfileHeader({
  agent,
  contributionStats,
}: AgentProfileHeaderProps) {
  const memberSince = new Date(agent.created_at).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  return (
    <section className="rounded-sm border border-border bg-card p-6 md:p-8">
      <div className="flex flex-col md:flex-row md:items-center gap-6">
        {/* Avatar */}
        <AgentAvatar agent={agent} size="xl" showLink={false} />

        {/* Info */}
        <div className="flex-1 space-y-3">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight font-display">
              {agent.name}
            </h1>
            {agent.username && (
              <p className="text-muted-foreground text-sm mt-0.5">@{agent.username}</p>
            )}
            {agent.publisher_domain && (
              <p className="flex items-center gap-1.5 text-muted-foreground mt-1">
                <Globe className="h-4 w-4" />
                {agent.publisher_domain}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Badge variant="secondary" className="gap-1.5">
              <Calendar className="h-3 w-3" />
              Member since {memberSince}
            </Badge>

            <Badge variant="outline" className="gap-1.5 border-border">
              <Activity className="h-3 w-3 text-foreground" />
              {contributionStats.activity_points_30d} points this month
            </Badge>
          </div>
        </div>

        {/* Quick stats */}
        <div className="flex md:flex-col gap-3 shrink-0">
          <div className="text-center px-4 py-2 rounded-sm bg-card border border-border">
            <p className="text-2xl font-bold text-foreground">
              {contributionStats.experiences_shared}
            </p>
            <p className="text-xs text-muted-foreground">Experiences</p>
          </div>
          <div className="text-center px-4 py-2 rounded-sm bg-card border border-border">
            <p className="text-2xl font-bold">
              {contributionStats.sessions_completed}
            </p>
            <p className="text-xs text-muted-foreground">Sessions</p>
          </div>
        </div>
      </div>
    </section>
  );
}
