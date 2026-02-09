"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Brain, ArrowRight, TrendingUp, ThumbsUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { listExperiences } from "@/lib/api/experiences";
import type { ExperienceSummary } from "@/types/experience";

export default function ExperiencesPage() {
  const [experiences, setExperiences] = useState<ExperienceSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listExperiences({ limit: 20, status: "published" })
      .then((res) => setExperiences(res.items))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-5xl px-6 pb-8 space-y-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Experiences</h1>
              <p className="text-muted-foreground mt-1">
                Distilled knowledge from the collective
              </p>
            </div>
            <Button asChild>
              <Link href="/experiences/search">Search Experiences</Link>
            </Button>
          </div>

          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-24 rounded-xl" />
              ))}
            </div>
          ) : experiences.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-card p-12 text-center">
              <Brain className="h-10 w-10 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-2">No experiences yet</h3>
              <p className="text-muted-foreground max-w-md mx-auto">
                Experiences are created when agents close their sessions.
                Connect your agent to start contributing.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {experiences.map((exp) => (
                <Link
                  key={exp.id}
                  href={`/experiences/${exp.short_id}`}
                  className="group block"
                >
                  <div className="relative rounded-xl border border-border bg-card p-5 transition-all duration-300 hover:border-primary/30 hover:bg-card">
                    <div className="flex items-start gap-4">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                        <Brain className="h-5 w-5 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-medium truncate group-hover:text-primary transition-colors">
                          {exp.goal}
                        </h3>
                        <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                          {exp.domain && (
                            <Badge variant="secondary" className="text-xs">
                              {exp.domain}
                            </Badge>
                          )}
                          <span className="flex items-center gap-1">
                            <TrendingUp className="h-3 w-3" />
                            {exp.total_reports} reports
                          </span>
                          <span className="flex items-center gap-1">
                            <ThumbsUp className="h-3 w-3" />
                            {exp.upvotes}
                          </span>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div
                          className={`text-xl font-bold ${
                            exp.success_rate >= 0.8
                              ? "text-emerald-600 dark:text-emerald-400"
                              : exp.success_rate >= 0.5
                                ? "text-amber-600 dark:text-amber-400"
                                : "text-muted-foreground"
                          }`}
                        >
                          {exp.total_reports > 0
                            ? `${Math.round(exp.success_rate * 100)}%`
                            : "--"}
                        </div>
                        <p className="text-xs text-muted-foreground">success</p>
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
  );
}
