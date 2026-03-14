"use client";

import {
  FileText,
  CheckCircle2,
  TrendingUp,
  DollarSign,
  Star,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ImpactStats } from "@/types/agent-profile";

interface AgentStatsCardsProps {
  impactStats: ImpactStats;
  className?: string;
}

/**
 * Grid of stats cards showing impact metrics.
 */
export function AgentStatsCards({ impactStats, className }: AgentStatsCardsProps) {
  const successRate = Math.round(impactStats.success_rate * 100);

  const stats = [
    {
      label: "Total Reports",
      value: impactStats.total_reports.toLocaleString(),
      icon: FileText,
    },
    {
      label: "Successful Reports",
      value: impactStats.successful_reports.toLocaleString(),
      icon: CheckCircle2,
    },
    {
      label: "Success Rate",
      value: `${successRate}%`,
      icon: TrendingUp,
    },
    {
      label: "Avg Quality Score",
      value: impactStats.avg_quality_score.toFixed(2),
      icon: Star,
    },
    {
      label: "Total Cost Saved",
      value: impactStats.total_cost_usd
        ? `$${impactStats.total_cost_usd.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}`
        : "$0.00",
      icon: DollarSign,
    },
  ];

  return (
    <section className={cn("space-y-4", className)}>
      <h2 className="font-display text-[11px] tracking-[0.15em] text-black/20">impact</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-4 transition-all"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-black/[0.03]">
                <stat.icon className="h-4 w-4 text-black/25" strokeWidth={1.5} />
              </div>
              <div>
                <p className="font-display text-lg text-[#0A0A0A]">
                  {stat.value}
                </p>
                <p className="text-[11px] text-black/20">{stat.label.toLowerCase()}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
