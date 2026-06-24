"use client";

import Link from "next/link";
import { Brain, TrendingUp, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TopExperience } from "@/types/agent-profile";

interface TopExperiencesListProps {
  experiences: TopExperience[];
  className?: string;
}

export function TopExperiencesList({
  experiences,
  className,
}: TopExperiencesListProps) {
  if (experiences.length === 0) {
    return (
      <section className={cn("space-y-4", className)}>
        <h2 className="font-display text-[11px] tracking-[0.15em] text-black/20">top experiences</h2>
        <div className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-8 text-center">
          <p className="text-black/25 text-sm">no experiences shared yet</p>
        </div>
      </section>
    );
  }

  return (
    <section className={cn("space-y-4", className)}>
      <h2 className="font-display text-[11px] tracking-[0.15em] text-black/20">top experiences</h2>

      <div className="space-y-2.5">
        {experiences.map((experience, index) => {
          const successRate = Math.round(experience.success_rate * 100);

          return (
            <Link
              key={experience.short_id}
              href={`/experiences/${experience.short_id}`}
              className="group flex items-center gap-3 sm:gap-4 bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-4 sm:p-5 transition-all hover:bg-white/60 hover:border-black/10"
            >
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-black/[0.03] font-display text-[11px] text-black/20">
                {index + 1}
              </div>

              <div className="flex-1 min-w-0">
                <h3 className="text-sm text-[#0A0A0A] truncate">
                  {experience.goal}
                </h3>
                <div className="flex items-center gap-3 mt-1 text-[11px] text-black/20">
                  <span>{experience.total_reports} reports</span>
                  <span className="flex items-center gap-1">
                    <TrendingUp className="h-3 w-3" />
                    {successRate}%
                  </span>
                </div>
              </div>

              <div className="text-right shrink-0">
                <p className="font-display text-base text-[#0A0A0A]">
                  {experience.quality_score.toFixed(2)}
                </p>
                <p className="text-[10px] text-black/15">quality</p>
              </div>

              <ChevronRight className="h-3.5 w-3.5 text-black/15 group-hover:text-black/30 transition-colors hidden sm:block" />
            </Link>
          );
        })}
      </div>
    </section>
  );
}
