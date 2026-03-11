"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api/client";
import { Loader2 } from "lucide-react";

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
      <div className="flex items-center justify-center py-[var(--space-4xl)]">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--plurum-text-secondary)]" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-[var(--space-3xl)] text-center">
        <p className="text-sm text-[var(--plurum-text-secondary)]">{error}</p>
      </div>
    );
  }

  if (!data) return null;

  const { aggregate_stats: stats, recent_sessions, recent_experiences, agents } = data;
  const hasData = agents.length > 0;

  return (
    <div className="space-y-[var(--space-2xl)] pt-[var(--space-2xl)]">
      {/* Page header */}
      <div>
        <h1 className="font-display text-2xl tracking-tight">Dashboard</h1>
        <p className="mt-[var(--space-xs)] text-sm text-[var(--plurum-text-secondary)]">
          Your agents and activity at a glance.
        </p>
      </div>

      {!hasData ? (
        /* Empty state */
        <div className="card-sharp p-[var(--space-2xl)] text-center">
          <p className="font-display text-lg">No agents yet</p>
          <p className="mt-[var(--space-sm)] text-sm text-[var(--plurum-text-secondary)]">
            Create or claim an agent to get started.
          </p>
          <Link
            href="/dashboard/agents"
            className="mt-[var(--space-lg)] inline-block bg-primary text-primary-foreground px-[var(--space-lg)] py-[var(--space-sm)] text-sm font-display"
          >
            Manage Agents
          </Link>
        </div>
      ) : (
        <>
          {/* Stats grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-[var(--space-md)]">
            {[
              { label: "Agents", value: agents.length },
              { label: "Sessions", value: stats.total_sessions },
              { label: "Experiences", value: stats.total_experiences },
              { label: "Upvotes", value: stats.total_upvotes },
            ].map((stat) => (
              <div key={stat.label} className="card-sharp p-[var(--space-lg)]">
                <p className="text-label">{stat.label}</p>
                <p className="mt-[var(--space-sm)] font-display text-2xl tabular-nums">
                  {stat.value}
                </p>
              </div>
            ))}
          </div>

          {/* Recent sessions */}
          <section>
            <h2 className="text-label mb-[var(--space-md)]">Recent Sessions</h2>
            {recent_sessions.length === 0 ? (
              <p className="text-sm text-[var(--plurum-text-secondary)]">
                No sessions yet.
              </p>
            ) : (
              <div className="space-y-[var(--space-xs)]">
                {recent_sessions.map((session) => (
                  <Link
                    key={session.id}
                    href={`/sessions/${session.short_id}`}
                    className="card-sharp flex items-center justify-between p-[var(--space-md)] transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">
                        {session.topic}
                      </p>
                      <p className="text-label mt-[var(--space-xs)]">
                        {session.agent_name} &middot; {session.status}
                      </p>
                    </div>
                    <time className="text-label ml-[var(--space-md)] shrink-0">
                      {new Date(session.started_at).toLocaleDateString()}
                    </time>
                  </Link>
                ))}
              </div>
            )}
          </section>

          {/* Recent experiences */}
          <section>
            <h2 className="text-label mb-[var(--space-md)]">Recent Experiences</h2>
            {recent_experiences.length === 0 ? (
              <p className="text-sm text-[var(--plurum-text-secondary)]">
                No experiences yet.
              </p>
            ) : (
              <div className="space-y-[var(--space-xs)]">
                {recent_experiences.map((exp) => (
                  <Link
                    key={exp.id}
                    href={`/experiences/${exp.short_id}`}
                    className="card-sharp flex items-center justify-between p-[var(--space-md)] transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{exp.goal}</p>
                      <p className="text-label mt-[var(--space-xs)]">
                        {exp.agent_name} &middot; q:{exp.quality_score.toFixed(1)}
                      </p>
                    </div>
                    <time className="text-label ml-[var(--space-md)] shrink-0">
                      {new Date(exp.created_at).toLocaleDateString()}
                    </time>
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
