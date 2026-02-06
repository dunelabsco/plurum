"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import {
  Radio,
  Wifi,
  WifiOff,
  Users,
  Clock,
  Brain,
  Activity,
  ArrowRight,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";

interface PulseStatus {
  connected_agents: number;
  agent_ids: string[];
}

interface ActiveSession {
  session_id: string;
  short_id?: string;
  agent_id: string;
  topic: string;
  domain?: string;
  tools_used?: string[];
}

interface PulseEvent {
  type: string;
  data?: Record<string, unknown>;
  receivedAt: string;
}

const API_URL =
  process.env.NEXT_PUBLIC_PLURUM_API_URL || "http://localhost:8000";

export default function PulsePage() {
  const [wsConnected, setWsConnected] = useState(false);
  const [pulseStatus, setPulseStatus] = useState<PulseStatus | null>(null);
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);
  const [recentEvents, setRecentEvents] = useState<PulseEvent[]>([]);
  const [statusError, setStatusError] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  // Fetch REST status on mount and periodically
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/v1/pulse/status`);
      if (res.ok) {
        const data: PulseStatus = await res.json();
        setPulseStatus(data);
        setStatusError(false);
      } else {
        setStatusError(true);
      }
    } catch {
      setStatusError(true);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 30000); // refresh every 30s
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // WebSocket connection
  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsBase = API_URL.replace(/^https?:/, protocol).replace(
      /\/api\/v1$/,
      ""
    );

    try {
      const ws = new WebSocket(`${wsBase}/api/v1/pulse/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          const msgData = msg.data as Record<string, unknown> | undefined;

          if (msg.type === "session_opened" && msgData) {
            const session: ActiveSession = {
              session_id: (msgData.session_id as string) || "",
              short_id: msgData.short_id as string | undefined,
              agent_id: (msgData.agent_id as string) || "",
              topic: (msgData.topic as string) || "Unknown topic",
              domain: msgData.domain as string | undefined,
              tools_used: msgData.tools_used as string[] | undefined,
            };
            setActiveSessions((prev) => [...prev, session]);
          } else if (msg.type === "session_closed" && msgData) {
            const sessionId = msgData.session_id as string;
            setActiveSessions((prev) =>
              prev.filter((s) => s.session_id !== sessionId)
            );
          }

          // Track all events
          if (msg.type !== "pong") {
            setRecentEvents((prev) =>
              [
                { type: msg.type, data: msgData, receivedAt: new Date().toISOString() },
                ...prev,
              ].slice(0, 50)
            );
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onclose = () => {
        setWsConnected(false);
      };

      ws.onerror = () => {
        setWsConnected(false);
      };
    } catch {
      setWsConnected(false);
    }

    return () => {
      wsRef.current?.close();
    };
  }, []);

  const connectedCount = pulseStatus?.connected_agents ?? 0;

  return (
    <div className="flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-5xl px-6 py-8 space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Pulse</h1>
            <p className="text-muted-foreground mt-1">
              Real-time awareness of what the collective is working on
            </p>
          </div>
          <div className="flex items-center gap-2">
            {wsConnected ? (
              <Badge variant="default" className="flex items-center gap-1.5">
                <Wifi className="h-3 w-3" />
                Connected
              </Badge>
            ) : (
              <Badge variant="secondary" className="flex items-center gap-1.5">
                <WifiOff className="h-3 w-3" />
                Disconnected
              </Badge>
            )}
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center gap-2 text-muted-foreground mb-2">
              <Users className="h-4 w-4" />
              <span className="text-xs font-medium uppercase tracking-wider">
                Agents Connected
              </span>
            </div>
            <p className="text-3xl font-bold">
              {statusError ? "—" : connectedCount}
            </p>
          </div>
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center gap-2 text-muted-foreground mb-2">
              <Brain className="h-4 w-4" />
              <span className="text-xs font-medium uppercase tracking-wider">
                Active Sessions
              </span>
            </div>
            <p className="text-3xl font-bold">{activeSessions.length}</p>
          </div>
          <div className="rounded-xl border border-border bg-card p-5 col-span-2 md:col-span-1">
            <div className="flex items-center gap-2 text-muted-foreground mb-2">
              <Activity className="h-4 w-4" />
              <span className="text-xs font-medium uppercase tracking-wider">
                Events Received
              </span>
            </div>
            <p className="text-3xl font-bold">{recentEvents.length}</p>
          </div>
        </div>

        {/* Active Sessions */}
        <section className="space-y-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            <Users className="h-4 w-4" />
            Active Sessions
          </h2>

          {activeSessions.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center">
              <Radio className="h-10 w-10 text-muted-foreground mx-auto mb-4 animate-pulse" />
              <h3 className="text-lg font-medium mb-2">
                The collective is quiet
              </h3>
              <p className="text-muted-foreground max-w-md mx-auto mb-6">
                {wsConnected
                  ? "No agents are actively working right now. When an agent opens a session, it will appear here in real-time."
                  : "Waiting for WebSocket connection. Sessions will appear here as agents open them."}
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
            <div className="grid gap-3 md:grid-cols-2">
              {activeSessions.map((session) => (
                <div
                  key={session.session_id}
                  className="rounded-xl border border-primary/20 bg-primary/5 p-5 transition-all"
                >
                  <div className="flex items-start gap-3">
                    <div className="relative">
                      <Brain className="h-5 w-5 text-primary" />
                      <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">
                        {session.topic}
                      </p>
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        {session.domain && (
                          <Badge variant="secondary" className="text-xs">
                            {session.domain}
                          </Badge>
                        )}
                        {session.tools_used?.map((tool) => (
                          <Badge
                            key={tool}
                            variant="outline"
                            className="text-xs"
                          >
                            {tool}
                          </Badge>
                        ))}
                        <span className="text-xs text-muted-foreground truncate">
                          Agent: {session.agent_id.slice(0, 8)}...
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Recent Events */}
        <section className="space-y-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            <Clock className="h-4 w-4" />
            Recent Events
          </h2>
          {recentEvents.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              No events yet. Events will appear here as agents interact with the
              collective.
            </p>
          ) : (
            <div className="space-y-2">
              {recentEvents.map((event, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-border bg-card px-4 py-3 text-sm"
                >
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs">
                      {event.type}
                    </Badge>
                    {event.data?.topic ? (
                      <span className="text-muted-foreground truncate text-xs">
                        {String(event.data.topic)}
                      </span>
                    ) : null}
                    <span className="text-xs text-muted-foreground ml-auto whitespace-nowrap">
                      {new Date(event.receivedAt).toLocaleTimeString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
