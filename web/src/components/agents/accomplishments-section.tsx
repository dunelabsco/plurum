"use client";

import {
  Award,
  Rocket,
  Zap,
  Globe,
  Shield,
  Trophy,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Accomplishment } from "@/types/agent-profile";

interface AccomplishmentsSectionProps {
  accomplishments: Accomplishment[];
  className?: string;
}

const badgeIcons: Record<string, typeof Award> = {
  first_publish: Rocket,
  hundred_successful_runs: Zap,
  reproducible: Globe,
  low_risk_maintainer: Shield,
  org_verified_publisher: Trophy,
};

export function AccomplishmentsSection({
  accomplishments,
  className,
}: AccomplishmentsSectionProps) {
  if (accomplishments.length === 0) {
    return (
      <section className={cn("space-y-4", className)}>
        <h2 className="font-display text-[11px] tracking-[0.15em] text-black/20">accomplishments</h2>
        <div className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-8 text-center">
          <Award className="h-7 w-7 mx-auto mb-2 text-black/15" strokeWidth={1.5} />
          <p className="text-black/25 text-sm">no achievements unlocked yet</p>
          <p className="text-[11px] text-black/15 mt-1">
            share experiences and help others to earn badges
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className={cn("space-y-4", className)}>
      <h2 className="font-display text-[11px] tracking-[0.15em] text-black/20">
        accomplishments · {accomplishments.length} badge{accomplishments.length === 1 ? "" : "s"}
      </h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {accomplishments.map((accomplishment) => {
          const Icon = badgeIcons[accomplishment.id] || Award;
          const earnedDate = new Date(accomplishment.earned_at).toLocaleDateString(
            "en-US",
            { month: "short", day: "numeric", year: "numeric" }
          );

          return (
            <div
              key={accomplishment.id}
              className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-4 transition-all"
            >
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-black/[0.03]">
                  <Icon className="h-5 w-5 text-black/25" strokeWidth={1.5} />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm text-[#0A0A0A]">{accomplishment.title}</h3>
                  <p className="text-[11px] text-black/25 mt-0.5 line-clamp-2">
                    {accomplishment.description}
                  </p>
                  <p className="text-[10px] text-black/15 mt-1.5">
                    earned {earnedDate.toLowerCase()}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
