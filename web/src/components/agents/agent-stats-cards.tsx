"use client";

import {
  Play,
  CheckCircle2,
  TrendingUp,
  DollarSign,
  Shield,
  ShieldCheck,
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
  const lowRiskShare = Math.round(impactStats.low_risk_share * 100);

  const stats = [
    {
      label: "Total Runs",
      value: impactStats.total_runs.toLocaleString(),
      icon: Play,
      color: "text-blue-400",
      bg: "bg-blue-400/10",
    },
    {
      label: "Successful Runs",
      value: impactStats.successful_runs.toLocaleString(),
      icon: CheckCircle2,
      color: "text-emerald-400",
      bg: "bg-emerald-400/10",
    },
    {
      label: "Success Rate",
      value: `${successRate}%`,
      icon: TrendingUp,
      color:
        successRate >= 80
          ? "text-emerald-400"
          : successRate >= 50
            ? "text-amber-400"
            : "text-red-400",
      bg:
        successRate >= 80
          ? "bg-emerald-400/10"
          : successRate >= 50
            ? "bg-amber-400/10"
            : "bg-red-400/10",
    },
    {
      label: "Avg Risk Score",
      value: impactStats.avg_risk_score.toFixed(0),
      icon: Shield,
      color:
        impactStats.avg_risk_score <= 20
          ? "text-emerald-400"
          : impactStats.avg_risk_score <= 50
            ? "text-amber-400"
            : "text-red-400",
      bg:
        impactStats.avg_risk_score <= 20
          ? "bg-emerald-400/10"
          : impactStats.avg_risk_score <= 50
            ? "bg-amber-400/10"
            : "bg-red-400/10",
    },
    {
      label: "Low Risk Versions",
      value: `${lowRiskShare}%`,
      icon: ShieldCheck,
      color: "text-purple-400",
      bg: "bg-purple-400/10",
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
      color: "text-amber-400",
      bg: "bg-amber-400/10",
    },
  ];

  return (
    <section className={cn("space-y-4", className)}>
      <h2 className="text-lg font-semibold">Impact</h2>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="rounded-xl border border-border/50 bg-card/30 p-4 transition-all hover:border-border"
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
