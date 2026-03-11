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

// Map badge IDs to icons
const badgeIcons: Record<string, typeof Award> = {
  first_publish: Rocket,
  hundred_successful_runs: Zap,
  reproducible: Globe,
  low_risk_maintainer: Shield,
  org_verified_publisher: Trophy,
};

/**
 * Grid of earned accomplishment badges.
 */
export function AccomplishmentsSection({
  accomplishments,
  className,
}: AccomplishmentsSectionProps) {
  if (accomplishments.length === 0) {
    return (
      <section className={cn("space-y-4", className)}>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center border border-border rounded-sm bg-card">
            <Award className="h-5 w-5 text-foreground" />
          </div>
          <h2 className="text-label">Accomplishments</h2>
        </div>
        <div className="rounded-sm border border-border bg-card p-8 text-center">
          <Award className="h-8 w-8 mx-auto mb-2 text-muted-foreground/50" />
          <p className="text-muted-foreground">No achievements unlocked yet</p>
          <p className="text-sm text-muted-foreground/70 mt-1">
            Share experiences and help others to earn badges
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className={cn("space-y-4", className)}>
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center border border-border rounded-sm bg-card">
          <Award className="h-5 w-5 text-foreground" />
        </div>
        <div>
          <h2 className="text-label">Accomplishments</h2>
          <p className="text-sm text-muted-foreground">
            {accomplishments.length} badge{accomplishments.length === 1 ? "" : "s"} earned
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {accomplishments.map((accomplishment) => {
          const Icon = badgeIcons[accomplishment.id] || Award;
          const earnedDate = new Date(accomplishment.earned_at).toLocaleDateString(
            "en-US",
            {
              month: "short",
              day: "numeric",
              year: "numeric",
            }
          );

          return (
            <div
              key={accomplishment.id}
              className="group rounded-sm border border-border bg-card p-4 transition-all hover:border-foreground/30 hover:bg-card"
            >
              <div className="flex items-start gap-3">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center border border-border rounded-sm bg-card text-foreground">
                  <Icon className="h-6 w-6" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-medium text-sm">{accomplishment.title}</h3>
                  <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                    {accomplishment.description}
                  </p>
                  <p className="text-[10px] text-muted-foreground/70 mt-1.5">
                    Earned {earnedDate}
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
