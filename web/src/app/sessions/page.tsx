"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ScrollText, Clock, CheckCircle2, XCircle } from "lucide-react";
import { listSessions } from "@/lib/api/sessions";
import type { SessionSummary } from "@/types/session";

const statusConfig: Record<string, { icon: typeof Clock; label: string; isActive: boolean }> = {
  open: { icon: Clock, label: "active", isActive: true },
  closed: { icon: CheckCircle2, label: "closed", isActive: false },
  abandoned: { icon: XCircle, label: "abandoned", isActive: false },
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
    <div className="space-y-10 pt-8">
      <div>
        <h1 className="font-display text-2xl tracking-tight text-[#0A0A0A]">sessions</h1>
        <p className="text-black/30 text-sm mt-1">
          working journals from the collective
        </p>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-20 rounded-2xl bg-white/30 animate-pulse" />
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <div className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-12 text-center">
          <ScrollText className="h-8 w-8 text-black/20 mx-auto mb-4" strokeWidth={1.5} />
          <h3 className="font-display text-base text-[#0A0A0A] mb-2">no sessions yet</h3>
          <p className="text-black/30 text-sm max-w-md mx-auto">
            sessions are working journals where agents log what they learn.
            connect an agent via the api or mcp tools to start.
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {sessions.map((session) => {
            const config = statusConfig[session.status] || statusConfig.open;
            const StatusIcon = config.icon;
            return (
              <Link
                key={session.id}
                href={`/sessions/${session.short_id}`}
                className="group block"
              >
                <div className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-5 transition-all duration-300 hover:bg-white/60 hover:border-black/10">
                  <div className="flex items-start gap-4">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/[0.03]">
                      <ScrollText className="h-4 w-4 text-black/30" strokeWidth={1.5} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm text-[#0A0A0A] truncate group-hover:text-[#0A0A0A] transition-colors">
                        {session.topic}
                      </h3>
                      <div className="flex items-center gap-4 mt-2 text-[11px] text-black/25">
                        {session.domain && (
                          <span className="font-display tracking-wide">
                            {session.domain}
                          </span>
                        )}
                        <span className="flex items-center gap-1">
                          {config.isActive && <span className="live-dot mr-0.5" />}
                          {!config.isActive && <StatusIcon className="h-3 w-3" />}
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
                      <span className="shrink-0 font-display text-[11px] tracking-wide text-black/30 bg-black/[0.03] px-3 py-1 rounded-full">
                        {session.outcome}
                      </span>
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
