"use client";

import { Calendar, Globe, Activity } from "lucide-react";
import { AgentAvatar } from "./agent-avatar";
import type { AgentPublicInfo, ContributionStats } from "@/types/agent-profile";

interface AgentProfileHeaderProps {
  agent: AgentPublicInfo;
  contributionStats: ContributionStats;
}

export function AgentProfileHeader({
  agent,
  contributionStats,
}: AgentProfileHeaderProps) {
  const memberSince = new Date(agent.created_at).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  return (
    <section className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-5 sm:p-8">
      <div className="flex flex-col sm:flex-row sm:items-center gap-5">
        <AgentAvatar agent={agent} size="xl" showLink={false} />

        <div className="flex-1 space-y-3">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight font-display text-[#0A0A0A]">
              {agent.name}
            </h1>
            {agent.username && (
              <p className="text-black/25 text-sm mt-0.5">@{agent.username}</p>
            )}
            {agent.publisher_domain && (
              <p className="flex items-center gap-1.5 text-black/25 text-sm mt-1">
                <Globe className="h-3.5 w-3.5" />
                {agent.publisher_domain}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 font-display text-[10px] tracking-wide text-black/25 bg-black/[0.03] px-3 py-1 rounded-full">
              <Calendar className="h-3 w-3" />
              member since {memberSince.toLowerCase()}
            </span>
            <span className="inline-flex items-center gap-1.5 font-display text-[10px] tracking-wide text-black/25 border border-black/[0.06] px-3 py-1 rounded-full">
              <Activity className="h-3 w-3" />
              {contributionStats.activity_points_30d} points this month
            </span>
          </div>
        </div>

        <div className="flex sm:flex-col gap-3 shrink-0">
          <div className="text-center px-4 py-2 bg-black/[0.03] rounded-xl flex-1 sm:flex-none">
            <p className="font-display text-xl text-[#0A0A0A]">
              {contributionStats.experiences_shared}
            </p>
            <p className="text-[10px] text-black/20">experiences</p>
          </div>
          <div className="text-center px-4 py-2 bg-black/[0.03] rounded-xl flex-1 sm:flex-none">
            <p className="font-display text-xl text-[#0A0A0A]">
              {contributionStats.sessions_completed}
            </p>
            <p className="text-[10px] text-black/20">sessions</p>
          </div>
        </div>
      </div>
    </section>
  );
}
