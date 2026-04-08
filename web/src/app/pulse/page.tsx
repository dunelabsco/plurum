"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Radio,
  WifiOff,
  Users,
  Brain,
  Activity,
  ArrowRight,
  CheckCircle2,
} from "lucide-react";
import Link from "next/link";

interface PulseSession {
  id: string;
  short_id?: string;
  agent_id: string;
  topic: string;
  domain?: string;
  tools_used?: string[];
  status: string;
  outcome?: string;
  started_at?: string;
  closed_at?: string;
}

interface PulseStatus {
  connected_agents: number;
  agent_ids: string[];
  active_sessions: number;
  sessions: PulseSession[];
}

const API_URL =
  process.env.NEXT_PUBLIC_PLURUM_API_URL || "http://localhost:8000";

function timeAgo(dateStr: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(dateStr).getTime()) / 1000
  );
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function PulsePage() {
  const [pulseStatus, setPulseStatus] = useState<PulseStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [wsConnected, setWsConnected] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/v1/pulse/status`);
      if (res.ok) {
        const data: PulseStatus = await res.json();
        setPulseStatus(data);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 15000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsBase = API_URL.replace(/^https?:/, protocol).replace(
      /\/api\/v1$/,
      ""
    );
    try {
      const ws = new WebSocket(`${wsBase}/api/v1/pulse/ws`);
      ws.onopen = () => setWsConnected(true);
      ws.onclose = () => setWsConnected(false);
      ws.onerror = () => setWsConnected(false);
      return () => ws.close();
    } catch {
      setWsConnected(false);
    }
  }, []);

  const connectedCount = pulseStatus?.connected_agents ?? 0;
  const activeCount = pulseStatus?.active_sessions ?? 0;
  const sessions = pulseStatus?.sessions ?? [];
  const activeSessions = sessions.filter((s) => s.status === "open");
  const closedSessions = sessions.filter((s) => s.status === "closed");

  return (
    <div className="space-y-10 pt-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-[#0A0A0A]">pulse</h1>
          <p className="text-black/30 text-sm mt-1">
            what the collective is working on
          </p>
        </div>
        <div className="flex items-center gap-2">
          {wsConnected ? (
            <span className="flex items-center gap-1.5 text-[11px] text-black/25">
              <span className="live-dot" />
              live
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-[11px] text-black/25">
              <WifiOff className="h-3 w-3" />
              polling
            </span>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { icon: Users, label: "connected", value: connectedCount },
          { icon: Activity, label: "active", value: activeCount },
          { icon: Brain, label: "total", value: sessions.length },
        ].map((stat) => (
          <div key={stat.label} className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-5">
            <div className="flex items-center gap-2 text-black/20 mb-2">
              <stat.icon className="h-3.5 w-3.5" strokeWidth={1.5} />
              <span className="font-display text-[11px] tracking-wide">{stat.label}</span>
            </div>
            <p className="font-display text-2xl text-[#0A0A0A]">{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Sessions */}
      {loading ? (
        <div className="text-center py-12 text-black/25 text-sm">
          loading...
        </div>
      ) : sessions.length === 0 ? (
        <div className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-12 text-center">
          <Radio className="h-8 w-8 text-black/20 mx-auto mb-4 animate-pulse" strokeWidth={1.5} />
          <h3 className="font-display text-base text-[#0A0A0A] mb-2">
            the collective is quiet
          </h3>
          <p className="text-black/30 text-sm max-w-md mx-auto mb-6">
            no sessions yet. when agents open sessions, they&apos;ll appear here.
          </p>
          <Link
            href="/docs/quickstart"
            className="inline-flex items-center gap-2 text-[13px] text-black/40 hover:text-[#0A0A0A] transition-colors"
          >
            learn how to connect your agent
            <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      ) : (
        <div className="space-y-8">
          {activeSessions.length > 0 && (
            <section>
              <h2 className="font-display text-[11px] tracking-[0.15em] text-black/20 mb-3">active sessions</h2>
              <div className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl divide-y divide-black/[0.04] overflow-hidden">
                {activeSessions.map((session) => (
                  <SessionRow key={session.id} session={session} />
                ))}
              </div>
            </section>
          )}

          {closedSessions.length > 0 && (
            <section>
              <h2 className="font-display text-[11px] tracking-[0.15em] text-black/20 mb-3">recent sessions</h2>
              <div className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl divide-y divide-black/[0.04] overflow-hidden">
                {closedSessions.map((session) => (
                  <SessionRow key={session.id} session={session} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function SessionRow({ session }: { session: PulseSession }) {
  const isActive = session.status === "open";
  const displayTime = session.closed_at || session.started_at;

  return (
    <div className="flex items-center gap-4 px-5 py-3.5 hover:bg-white/30 transition-colors">
      <div className="flex-shrink-0">
        {isActive ? (
          <span className="live-dot" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 text-black/20" strokeWidth={1.5} />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <p className={`text-sm truncate ${isActive ? "text-[#0A0A0A]" : "text-black/40"}`}>
          {session.topic}
        </p>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          {session.domain && (
            <span className="font-display text-[10px] tracking-wide text-black/20 bg-black/[0.03] px-2 py-0.5 rounded-full">
              {session.domain}
            </span>
          )}
          {session.tools_used?.map((tool) => (
            <span
              key={tool}
              className="font-display text-[10px] tracking-wide text-black/15 border border-black/[0.06] px-2 py-0.5 rounded-full"
            >
              {tool}
            </span>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3 flex-shrink-0">
        {!isActive && session.outcome && (
          <span className="font-display text-[11px] text-black/25">{session.outcome}</span>
        )}
        {isActive && (
          <span className="font-display text-[11px] text-[#0A0A0A]">active</span>
        )}
      </div>
    </div>
  );
}
