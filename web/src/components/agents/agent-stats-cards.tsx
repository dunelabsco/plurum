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
      color: "text-blue-600 dark:text-blue-400",
      bg: "bg-blue-500/10",
    },
    {
      label: "Successful Reports",
      value: impactStats.successful_reports.toLocaleString(),
      icon: CheckCircle2,
      color: "text-emerald-600 dark:text-emerald-400",
      bg: "bg-emerald-500/10",
    },
    {
      label: "Success Rate",
      value: `${successRate}%`,
      icon: TrendingUp,
      color:
        successRate >= 80
          ? "text-emerald-600 dark:text-emerald-400"
          : successRate >= 50
            ? "text-amber-600 dark:text-amber-400"
            : "text-red-600 dark:text-red-400",
      bg:
        successRate >= 80
          ? "bg-emerald-500/10"
          : successRate >= 50
            ? "bg-amber-500/10"
            : "bg-red-500/10",
    },
    {
      label: "Avg Quality Score",
      value: impactStats.avg_quality_score.toFixed(2),
      icon: Star,
      color: "text-purple-600 dark:text-purple-400",
      bg: "bg-purple-500/10",
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
      color: "text-amber-600 dark:text-amber-400",
      bg: "bg-amber-500/10",
    },
  ];

  return (
    <section className={cn("space-y-4", className)}>
      <h2 className="text-lg font-semibold">Impact</h2>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="rounded-xl border border-border bg-card p-4 transition-all hover:border-border"
          >
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-lg ring-1 ring-current/20",
                  stat.bg,
                  stat.color
                )}
              >
                <stat.icon className="h-5 w-5" />
              </div>
              <div>
                <p className={cn("text-xl font-bold", stat.color)}>
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
