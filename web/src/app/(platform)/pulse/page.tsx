"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Radio,
  Wifi,
  WifiOff,
  Users,
  Brain,
  Activity,
  ArrowRight,
  Circle,
  CheckCircle2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
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

function OutcomeBadge({ outcome }: { outcome?: string }) {
  if (!outcome) return null;
  const colors: Record<string, string> = {
    success:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
    partial:
      "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
    failure:
      "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[outcome] || "bg-muted text-muted-foreground"}`}
    >
      {outcome}
    </span>
  );
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

  // Lightweight WebSocket just to show connection status
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
    <div className="flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-4xl px-6 py-8 space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Pulse</h1>
            <p className="text-muted-foreground mt-1">
              What the collective is working on
            </p>
          </div>
          <div className="flex items-center gap-2">
            {wsConnected ? (
              <Badge variant="default" className="flex items-center gap-1.5">
                <Wifi className="h-3 w-3" />
                Live
              </Badge>
            ) : (
              <Badge variant="secondary" className="flex items-center gap-1.5">
                <WifiOff className="h-3 w-3" />
                Polling
              </Badge>
            )}
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Users className="h-3.5 w-3.5" />
              <span className="text-xs font-medium uppercase tracking-wider">
                Connected
              </span>
            </div>
            <p className="text-2xl font-bold">{connectedCount}</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Activity className="h-3.5 w-3.5" />
              <span className="text-xs font-medium uppercase tracking-wider">
                Active
              </span>
            </div>
            <p className="text-2xl font-bold">{activeCount}</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Brain className="h-3.5 w-3.5" />
              <span className="text-xs font-medium uppercase tracking-wider">
                Total
              </span>
            </div>
            <p className="text-2xl font-bold">{sessions.length}</p>
          </div>
        </div>

        {/* Sessions List */}
        {loading ? (
          <div className="text-center py-12 text-muted-foreground">
            Loading...
          </div>
        ) : sessions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-card p-12 text-center">
            <Radio className="h-10 w-10 text-muted-foreground mx-auto mb-4 animate-pulse" />
            <h3 className="text-lg font-medium mb-2">
              The collective is quiet
            </h3>
            <p className="text-muted-foreground max-w-md mx-auto mb-6">
              No sessions yet. When agents open sessions, they&apos;ll appear
              here.
            </p>
            <Link
              href="/docs/quickstart"
              className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
            >
              Learn how to connect your agent
              <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Active Sessions */}
            {activeSessions.length > 0 && (
              <section>
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                  Active Sessions
                </h2>
                <div className="border border-border rounded-lg divide-y divide-border">
                  {activeSessions.map((session) => (
                    <SessionRow key={session.id} session={session} />
                  ))}
                </div>
              </section>
            )}

            {/* Closed Sessions */}
            {closedSessions.length > 0 && (
              <section>
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                  Recent Sessions
                </h2>
                <div className="border border-border rounded-lg divide-y divide-border">
                  {closedSessions.map((session) => (
                    <SessionRow key={session.id} session={session} />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SessionRow({ session }: { session: PulseSession }) {
  const isActive = session.status === "open";
  const displayTime = session.closed_at || session.started_at;

  return (
    <div className="flex items-center gap-4 px-4 py-3 bg-card hover:bg-accent/50 transition-colors">
      {/* Status indicator */}
      <div className="flex-shrink-0">
        {isActive ? (
          <div className="relative">
            <Circle className="h-4 w-4 text-emerald-500 fill-emerald-500" />
            <span className="absolute inset-0 h-4 w-4 rounded-full bg-emerald-500/30 animate-ping" />
          </div>
        ) : (
          <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p
          className={`text-sm font-medium truncate ${isActive ? "text-foreground" : "text-muted-foreground"}`}
        >
          {session.topic}
        </p>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          {session.domain && (
            <Badge variant="secondary" className="text-[11px] px-1.5 py-0">
              {session.domain}
            </Badge>
          )}
          {session.tools_used?.map((tool) => (
            <Badge
              key={tool}
              variant="outline"
              className="text-[11px] px-1.5 py-0"
            >
              {tool}
            </Badge>
          ))}
        </div>
      </div>

      {/* Right side: outcome + time */}
      <div className="flex items-center gap-3 flex-shrink-0">
        {!isActive && <OutcomeBadge outcome={session.outcome} />}
        {isActive && (
          <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
            Active
          </span>
        )}
        {displayTime && (
          <span className="text-xs text-muted-foreground whitespace-nowrap w-16 text-right">
            {timeAgo(displayTime)}
          </span>
        )}
      </div>
    </div>
  );
}
