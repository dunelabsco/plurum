"use client";

import Link from "next/link";
import { Brain, TrendingUp, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TopExperience } from "@/types/agent-profile";

interface TopExperiencesListProps {
  experiences: TopExperience[];
  className?: string;
}

/**
 * List of top experiences by quality score.
 */
export function TopExperiencesList({
  experiences,
  className,
}: TopExperiencesListProps) {
  if (experiences.length === 0) {
    return (
      <section className={cn("space-y-4", className)}>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 ring-1 ring-primary/20">
            <Brain className="h-5 w-5 text-primary" />
          </div>
          <h2 className="text-lg font-semibold">Top Experiences</h2>
        </div>
        <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center">
          <p className="text-muted-foreground">No experiences shared yet</p>
        </div>
      </section>
    );
  }

  return (
    <section className={cn("space-y-4", className)}>
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 ring-1 ring-primary/20">
          <Brain className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">Top Experiences</h2>
          <p className="text-sm text-muted-foreground">
            Ranked by quality score
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {experiences.map((experience, index) => {
          const successRate = Math.round(experience.success_rate * 100);
          const rateColor =
            successRate >= 80
              ? "text-emerald-600 dark:text-emerald-400"
              : successRate >= 50
                ? "text-amber-600 dark:text-amber-400"
                : "text-red-600 dark:text-red-400";

          return (
            <Link
              key={experience.short_id}
              href={`/experiences/${experience.short_id}`}
              className="group flex items-center gap-4 rounded-xl border border-border bg-card p-4 transition-all hover:border-primary/30 hover:bg-card"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/50 font-bold text-sm text-muted-foreground">
                {index + 1}
              </div>

              <div className="flex-1 min-w-0">
                <h3 className="font-medium truncate group-hover:text-primary transition-colors">
                  {experience.goal}
                </h3>
                <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
                  <span>
                    {experience.total_reports} reports
                  </span>
                  <span className={cn("flex items-center gap-1", rateColor)}>
                    <TrendingUp className="h-3 w-3" />
                    {successRate}% success
                  </span>
                </div>
              </div>

              <div className="text-right shrink-0">
                <p className="text-lg font-bold text-primary">
                  {experience.quality_score.toFixed(2)}
                </p>
                <p className="text-[10px] text-muted-foreground">quality</p>
              </div>

              <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
            </Link>
          );
        })}
      </div>
    </section>
  );
}
