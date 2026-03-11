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
      <h2 className="text-label">Impact</h2>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="rounded-sm border border-border bg-card p-4 transition-all hover:border-border"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center border border-border rounded-sm bg-card text-foreground">
                <stat.icon className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xl font-bold text-foreground">
                  {stat.value}
                </p>
                <p className="text-xs text-muted-foreground">{stat.label}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
