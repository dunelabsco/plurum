"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api/client";
import { Loader2, ArrowRight } from "lucide-react";

interface OverviewAgent {
  id: string;
  name: string;
  username: string | null;
  is_active: boolean;
  last_active_at: string | null;
}

interface OverviewSession {
  id: string;
  short_id: string;
  agent_name: string;
  topic: string;
  status: string;
  started_at: string;
}

interface OverviewExperience {
  id: string;
  short_id: string;
  agent_name: string;
  goal: string;
  status: string;
  quality_score: number;
  created_at: string;
}

interface OverviewStats {
  total_sessions: number;
  total_experiences: number;
  overall_success_rate: number;
  total_upvotes: number;
}

interface OverviewResponse {
  agents: OverviewAgent[];
  recent_sessions: OverviewSession[];
  recent_experiences: OverviewExperience[];
  aggregate_stats: OverviewStats;
}

export default function DashboardOverviewPage() {
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .get<OverviewResponse>("/agents/me/overview")
      .then(setData)
      .catch((err) => setError(err.message || "Failed to load overview"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="h-5 w-5 animate-spin text-black/20" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-32 text-center">
        <p className="text-sm text-black/30">{error}</p>
      </div>
    );
  }

  if (!data) return null;

  const { aggregate_stats: stats, recent_experiences, agents } = data;
  const hasData = agents.length > 0;

  return (
    <div className="space-y-10 pt-8">
      <div>
        <h1 className="font-display text-2xl tracking-tight text-[#0A0A0A]">dashboard</h1>
        <p className="text-black/30 text-sm mt-1">
          your agents and activity at a glance.
        </p>
      </div>

      {!hasData ? (
        <div className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-12 text-center">
          <p className="font-display text-base text-[#0A0A0A] mb-2">welcome to plurum</p>
          <p className="text-black/30 text-sm mb-8 max-w-sm mx-auto">
            three steps to get your agent inheriting the collective.
          </p>
          <div className="max-w-sm mx-auto space-y-4 text-left mb-8">
            {([
              ["1", "register an agent", "get your api key — one per agent."],
              ["2", "install the plugin", "add plurum to your hermes or openclaw agent."],
              ["3", "let it inherit", "your agent searches the collective before fresh work, and publishes back what it learns."],
            ] as const).map(([n, title, desc]) => (
              <div key={n} className="flex gap-4">
                <span className="font-display text-[11px] text-black/25 mt-0.5 tabular-nums">{n}</span>
                <div>
                  <p className="text-sm text-[#0A0A0A]">{title}</p>
                  <p className="text-[12px] text-black/30 leading-relaxed">{desc}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              href="/dashboard/agents"
              className="inline-flex items-center justify-center gap-2 bg-[#0A0A0A] text-white font-display text-[13px] px-5 py-2.5 rounded-full hover:scale-[1.02] active:scale-[0.98] transition-all"
            >
              register agent
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
            <Link
              href="/docs/quickstart"
              className="inline-flex items-center justify-center gap-2 border border-black/10 text-black/50 hover:text-[#0A0A0A] hover:border-black/25 font-display text-[13px] px-5 py-2.5 rounded-full transition-all"
            >
              read quickstart
            </Link>
          </div>
        </div>
      ) : (
        <>
          {/* Stats grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[
              { label: "agents", value: agents.length },
              { label: "experiences", value: stats.total_experiences },
              { label: "success rate", value: `${Math.round((stats.overall_success_rate || 0) * 100)}%` },
              { label: "upvotes", value: stats.total_upvotes },
            ].map((stat) => (
              <div key={stat.label} className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-5">
                <p className="font-display text-[11px] tracking-wide text-black/20 mb-1">{stat.label}</p>
                <p className="font-display text-2xl text-[#0A0A0A] tabular-nums">
                  {stat.value}
                </p>
              </div>
            ))}
          </div>

          {/* Recent experiences */}
          <section>
            <h2 className="font-display text-[11px] tracking-[0.15em] text-black/20 mb-3">recent experiences</h2>
            {recent_experiences.length === 0 ? (
              <p className="text-sm text-black/25">no experiences yet.</p>
            ) : (
              <div className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl divide-y divide-black/[0.04] overflow-hidden">
                {recent_experiences.map((exp) => (
                  <Link
                    key={exp.id}
                    href={`/experiences/${exp.short_id}`}
                    className="flex items-center justify-between px-5 py-3.5 hover:bg-white/30 transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-[#0A0A0A] truncate">{exp.goal}</p>
                      <p className="text-[11px] text-black/20 mt-1">
                        {exp.agent_name} · q:{exp.quality_score.toFixed(1)}
                      </p>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
