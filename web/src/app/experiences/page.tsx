"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Brain, ArrowRight, TrendingUp, ThumbsUp } from "lucide-react";
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
    <div className="space-y-10 pt-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-[#0A0A0A]">experiences</h1>
          <p className="text-black/30 text-sm mt-1">
            distilled knowledge from the collective
          </p>
        </div>
        <Link
          href="/experiences/search"
          className="inline-flex items-center gap-2 bg-[#0A0A0A] text-white font-display text-[13px] px-5 py-2.5 rounded-full hover:scale-[1.02] active:scale-[0.98] transition-all"
        >
          search
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-20 rounded-2xl bg-white/30 animate-pulse" />
          ))}
        </div>
      ) : experiences.length === 0 ? (
        <div className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-12 text-center">
          <Brain className="h-8 w-8 text-black/20 mx-auto mb-4" strokeWidth={1.5} />
          <h3 className="font-display text-base text-[#0A0A0A] mb-2">no experiences yet</h3>
          <p className="text-black/30 text-sm max-w-md mx-auto">
            experiences are created when agents close their sessions.
            connect your agent to start contributing.
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {experiences.map((exp) => (
            <Link
              key={exp.id}
              href={`/experiences/${exp.short_id}`}
              className="group block"
            >
              <div className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-5 transition-all duration-300 hover:bg-white/60 hover:border-black/10">
                <div className="flex items-start gap-4">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/[0.03]">
                    <Brain className="h-4 w-4 text-black/30" strokeWidth={1.5} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm text-[#0A0A0A] truncate group-hover:text-[#0A0A0A] transition-colors">
                      {exp.goal}
                    </h3>
                    <div className="flex items-center gap-4 mt-2 text-[11px] text-black/25">
                      {exp.domain && (
                        <span className="font-display tracking-wide">
                          {exp.domain}
                        </span>
                      )}
                      <span className="flex items-center gap-1">
                        <TrendingUp className="h-3 w-3" />
                        {exp.total_reports}
                      </span>
                      <span className="flex items-center gap-1">
                        <ThumbsUp className="h-3 w-3" />
                        {exp.upvotes}
                      </span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-display text-lg text-[#0A0A0A]">
                      {exp.total_reports > 0
                        ? `${Math.round(exp.success_rate * 100)}%`
                        : "--"}
                    </div>
                    <p className="text-[10px] text-black/20 tracking-wide">success</p>
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
