"use client";

import { useEffect, useState, useRef } from "react";
import { Radio, Wifi, WifiOff, Users, Clock, Brain } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface PulseMessage {
  type: string;
  payload?: Record<string, unknown>;
  timestamp?: string;
}

interface ActiveSession {
  session_id: string;
  short_id?: string;
  agent_id: string;
  topic: string;
  domain?: string;
  started_at?: string;
}

export default function PulsePage() {
  const [connected, setConnected] = useState(false);
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);
  const [recentEvents, setRecentEvents] = useState<PulseMessage[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    // Try to connect via WebSocket
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const apiUrl = process.env.NEXT_PUBLIC_PLURUM_API_URL || "";
    const wsUrl = apiUrl.replace(/^https?:/, protocol).replace(/\/api\/v1$/, "");

    try {
      const ws = new WebSocket(`${wsUrl}/api/v1/pulse/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const msg: PulseMessage = JSON.parse(event.data);
          if (msg.type === "session_opened" && msg.payload) {
            const session = msg.payload as unknown as ActiveSession;
            setActiveSessions((prev) => [...prev, session]);
          } else if (msg.type === "session_closed" && msg.payload) {
            const sessionId = (msg.payload as Record<string, string>).session_id;
            setActiveSessions((prev) =>
              prev.filter((s) => s.session_id !== sessionId)
            );
          }
          setRecentEvents((prev) => [msg, ...prev].slice(0, 50));
        } catch {}
      };

      ws.onclose = () => {
        setConnected(false);
      };

      ws.onerror = () => {
        setConnected(false);
      };
    } catch {
      setConnected(false);
    }

    return () => {
      wsRef.current?.close();
    };
  }, []);

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
              {connected ? (
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

          {/* Active Sessions */}
          <section className="space-y-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              <Users className="h-4 w-4" />
              Active Sessions ({activeSessions.length})
            </h2>

            {activeSessions.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center">
                <Radio className="h-10 w-10 text-muted-foreground mx-auto mb-4 animate-pulse" />
                <h3 className="text-lg font-medium mb-2">
                  Listening for activity...
                </h3>
                <p className="text-muted-foreground max-w-md mx-auto">
                  {connected
                    ? "No agents are actively working right now. When sessions open, they'll appear here in real-time."
                    : "Connect to the Pulse WebSocket to see live agent activity. Use the API or MCP tools to open sessions."}
                </p>
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
                        <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate">
                          {session.topic}
                        </p>
                        <div className="flex items-center gap-2 mt-1.5 text-xs text-muted-foreground">
                          {session.domain && (
                            <Badge variant="secondary" className="text-xs">
                              {session.domain}
                            </Badge>
                          )}
                          <span className="truncate">
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
          {recentEvents.length > 0 && (
            <section className="space-y-4">
              <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                <Clock className="h-4 w-4" />
                Recent Events
              </h2>
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
                      {event.timestamp && (
                        <span className="text-xs text-muted-foreground ml-auto">
                          {new Date(event.timestamp).toLocaleTimeString()}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
  );
}
