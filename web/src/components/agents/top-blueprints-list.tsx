"use client";

import Link from "next/link";
import { BookOpen, Play, TrendingUp, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TopBlueprint } from "@/types/agent-profile";

interface TopBlueprintsListProps {
  blueprints: TopBlueprint[];
  className?: string;
}

/**
 * List of top blueprints by impact score.
 */
export function TopBlueprintsList({
  blueprints,
  className,
}: TopBlueprintsListProps) {
  if (blueprints.length === 0) {
    return (
      <section className={cn("space-y-4", className)}>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 ring-1 ring-primary/20">
            <BookOpen className="h-5 w-5 text-primary" />
          </div>
          <h2 className="text-lg font-semibold">Top Blueprints</h2>
        </div>
        <div className="rounded-xl border border-dashed border-border/50 bg-card/30 p-8 text-center">
          <p className="text-muted-foreground">No blueprints published yet</p>
        </div>
      </section>
    );
  }

  return (
    <section className={cn("space-y-4", className)}>
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 ring-1 ring-primary/20">
          <BookOpen className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">Top Blueprints</h2>
          <p className="text-sm text-muted-foreground">
            Ranked by successful executions
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {blueprints.map((blueprint, index) => {
          const successRate = Math.round(blueprint.success_rate * 100);
          const rateColor =
            successRate >= 80
              ? "text-emerald-400"
              : successRate >= 50
                ? "text-amber-400"
                : "text-red-400";

          return (
            <Link
              key={blueprint.slug}
              href={`/blueprints/${blueprint.slug}`}
              className="group flex items-center gap-4 rounded-xl border border-border/50 bg-card/30 p-4 transition-all hover:border-primary/30 hover:bg-card/60"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/50 font-bold text-sm text-muted-foreground">
                {index + 1}
              </div>

              <div className="flex-1 min-w-0">
                <h3 className="font-medium truncate group-hover:text-primary transition-colors">
                  {blueprint.title}
                </h3>
                <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Play className="h-3 w-3" />
                    {blueprint.total_runs.toLocaleString()} runs
                  </span>
                  <span className={cn("flex items-center gap-1", rateColor)}>
                    <TrendingUp className="h-3 w-3" />
                    {successRate}% success
                  </span>
                </div>
              </div>

              <div className="text-right shrink-0">
                <p className="text-lg font-bold text-primary">
                  {blueprint.impact_score.toLocaleString()}
                </p>
                <p className="text-[10px] text-muted-foreground">impact</p>
              </div>

              <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
            </Link>
          );
        })}
      </div>
    </section>
  );
}
