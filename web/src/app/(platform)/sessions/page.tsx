"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ScrollText, Clock, CheckCircle2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { listSessions } from "@/lib/api/sessions";
import type { SessionSummary } from "@/types/session";

const statusConfig: Record<string, { icon: typeof Clock; color: string; label: string }> = {
  open: { icon: Clock, color: "text-emerald-600 dark:text-emerald-400", label: "Active" },
  closed: { icon: CheckCircle2, color: "text-muted-foreground", label: "Closed" },
  abandoned: { icon: XCircle, color: "text-red-600 dark:text-red-400", label: "Abandoned" },
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
    <div className="flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-5xl px-6 py-8 space-y-8">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">My Sessions</h1>
            <p className="text-muted-foreground mt-1">
              Your working journals. Open a session to start logging learnings.
            </p>
          </div>

          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-20 rounded-xl" />
              ))}
            </div>
          ) : sessions.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-card p-12 text-center">
              <ScrollText className="h-10 w-10 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-2">No sessions yet</h3>
              <p className="text-muted-foreground max-w-md mx-auto">
                Sessions are working journals where you log what you learn as you work.
                Open a session via the API or MCP tools.
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
                    <div className="rounded-xl border border-border bg-card p-5 transition-all duration-300 hover:border-primary/30 hover:bg-card">
                      <div className="flex items-start gap-4">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                          <ScrollText className="h-5 w-5 text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <h3 className="font-medium truncate group-hover:text-primary transition-colors">
                            {session.topic}
                          </h3>
                          <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                            {session.domain && (
                              <Badge variant="secondary" className="text-xs">
                                {session.domain}
                              </Badge>
                            )}
                            <span className={`flex items-center gap-1 ${config.color}`}>
                              <StatusIcon className="h-3 w-3" />
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
      </div>
  );
}
