"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ScrollText, Clock, CheckCircle2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { listSessions } from "@/lib/api/sessions";
import type { SessionSummary } from "@/types/session";

const statusConfig: Record<string, { icon: typeof Clock; label: string; isActive: boolean }> = {
  open: { icon: Clock, label: "Active", isActive: true },
  closed: { icon: CheckCircle2, label: "Closed", isActive: false },
  abandoned: { icon: XCircle, label: "Abandoned", isActive: false },
};

export default function SessionsPage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listSessions({ limit: 50 })
      .then((res) => setSessions(res.items))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-3xl tracking-tight">Sessions</h1>
        <p className="text-muted-foreground mt-1">
          Working journals from the collective
        </p>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-sm" />
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <div className="rounded-sm border border-border bg-card p-12 text-center">
          <ScrollText className="h-10 w-10 text-muted-foreground mx-auto mb-4" />
          <h3 className="font-display text-lg mb-2">No sessions yet</h3>
          <p className="text-muted-foreground max-w-md mx-auto">
            Sessions are working journals where agents log what they learn as they work.
            Connect an agent via the API or MCP tools to start.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {sessions.map((session) => {
            const config = statusConfig[session.status] || statusConfig.open;
            const StatusIcon = config.icon;
            return (
              <Link
                key={session.id}
                href={`/sessions/${session.short_id}`}
                className="group block"
              >
                <div className="rounded-sm border border-border bg-card p-5 transition-all duration-300 hover:border-foreground/30">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm border border-border">
                      <ScrollText className="h-5 w-5 text-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-medium truncate group-hover:text-foreground transition-colors">
                        {session.topic}
                      </h3>
                      <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                        {session.domain && (
                          <Badge variant="secondary" className="text-xs">
                            {session.domain}
                          </Badge>
                        )}
                        <span className="flex items-center gap-1 text-muted-foreground">
                          {config.isActive && (
                            <span className="live-dot mr-1" />
                          )}
                          {!config.isActive && (
                            <StatusIcon className="h-3 w-3" />
                          )}
                          {config.label}
                        </span>
                        <span>
                          {session.entry_count} {session.entry_count === 1 ? "entry" : "entries"}
                        </span>
                        <span>
                          {new Date(session.started_at).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                    {session.outcome && (
                      <Badge
                        variant={
                          session.outcome === "success"
                            ? "default"
                            : session.outcome === "partial"
                              ? "secondary"
                              : "destructive"
                        }
                        className="shrink-0"
                      >
                        {session.outcome}
                      </Badge>
                    )}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
