"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ScrollText,
  ArrowLeft,
  AlertTriangle,
  Lightbulb,
  XCircle,
  Code2,
  FileText,
  MessageSquare,
  Clock,
} from "lucide-react";
import { getSession } from "@/lib/api/sessions";
import type { SessionDetail, SessionEntry, EntryType } from "@/types/session";

const entryTypeConfig: Record<EntryType, { icon: typeof Lightbulb; label: string }> = {
  breakthrough: { icon: Lightbulb, label: "breakthrough" },
  dead_end: { icon: XCircle, label: "dead end" },
  gotcha: { icon: AlertTriangle, label: "gotcha" },
  artifact: { icon: Code2, label: "artifact" },
  update: { icon: FileText, label: "update" },
  note: { icon: MessageSquare, label: "note" },
};

export default function SessionDetailPage() {
  const params = useParams();
  const identifier = params.identifier as string;
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSession(identifier)
      .then(setSession)
      .catch((err) => setError(err.message || "Failed to load session"))
      .finally(() => setLoading(false));
  }, [identifier]);

  if (loading) {
    return (
      <div className="space-y-6 pt-8">
        <div className="h-8 w-96 rounded-xl bg-white/30 animate-pulse" />
        <div className="h-4 w-64 rounded-lg bg-white/30 animate-pulse" />
        <div className="h-32 rounded-2xl bg-white/30 animate-pulse" />
        <div className="h-32 rounded-2xl bg-white/30 animate-pulse" />
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="pt-8">
        <div className="bg-[#D71921]/5 border border-[#D71921]/20 rounded-2xl p-8 text-center">
          <AlertTriangle className="h-8 w-8 text-[#D71921] mx-auto mb-3" strokeWidth={1.5} />
          <h2 className="font-display text-base text-[#0A0A0A] mb-2">session not found</h2>
          <p className="text-black/30 text-sm mb-4">
            {error || "this session may belong to another agent or may have been removed."}
          </p>
          <Link
            href="/sessions"
            className="inline-flex items-center gap-2 bg-[#0A0A0A] text-white font-display text-[13px] px-5 py-2.5 rounded-full hover:scale-[1.02] active:scale-[0.98] transition-all"
          >
            back to sessions
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 pt-8">
      {/* Back link */}
      <Link
        href="/sessions"
        className="inline-flex items-center gap-1.5 text-[13px] text-black/25 hover:text-[#0A0A0A] transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        back to sessions
      </Link>

      {/* Header */}
      <div>
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-black/[0.03]">
            <ScrollText className="h-5 w-5 text-black/30" strokeWidth={1.5} />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="font-display text-xl tracking-tight text-[#0A0A0A]">
              {session.topic}
            </h1>
            <div className="flex flex-wrap items-center gap-2 mt-3">
              {session.domain && (
                <span className="font-display text-[10px] tracking-wide text-black/25 bg-black/[0.03] px-3 py-1 rounded-full">
                  {session.domain}
                </span>
              )}
              <span className="font-display text-[10px] tracking-wide text-black/25 bg-black/[0.03] px-3 py-1 rounded-full">
                {session.status}
              </span>
              {session.outcome && (
                <span className="font-display text-[10px] tracking-wide text-black/25 border border-black/[0.06] px-3 py-1 rounded-full">
                  {session.outcome}
                </span>
              )}
              {session.tools_used.length > 0 &&
                session.tools_used.map((tool) => (
                  <span key={tool} className="font-display text-[10px] tracking-wide text-black/15 border border-black/[0.06] px-3 py-1 rounded-full">
                    {tool}
                  </span>
                ))}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4 mt-4 text-[11px] text-black/20 border-t border-black/[0.04] pt-4">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            started {new Date(session.started_at).toLocaleString()}
          </span>
          {session.closed_at && (
            <span>
              closed {new Date(session.closed_at).toLocaleString()}
            </span>
          )}
          <span>{session.entry_count} entries</span>
        </div>
      </div>

      {/* Timeline */}
      {session.entries && session.entries.length > 0 ? (
        <section className="space-y-4">
          <h2 className="font-display text-[11px] tracking-[0.15em] text-black/20">
            journal timeline
          </h2>
          <div className="relative space-y-4">
            {/* Vertical line */}
            <div className="absolute left-5 top-2 bottom-2 w-px bg-black/[0.06]" />

            {session.entries
              .sort((a, b) => a.ordinal - b.ordinal)
              .map((entry) => (
                <EntryCard key={entry.id} entry={entry} />
              ))}
          </div>
        </section>
      ) : (
        <div className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-8 text-center">
          <ScrollText className="h-8 w-8 text-black/20 mx-auto mb-3" strokeWidth={1.5} />
          <p className="text-black/30 text-sm">
            no journal entries yet.
          </p>
        </div>
      )}
    </div>
  );
}

function EntryCard({ entry }: { entry: SessionEntry }) {
  const config = entryTypeConfig[entry.entry_type] || entryTypeConfig.note;
  const Icon = config.icon;

  const content = entry.content;
  const displayParts: { label: string; value: string }[] = [];

  for (const [key, val] of Object.entries(content)) {
    if (typeof val === "string" && val.trim()) {
      displayParts.push({ label: key, value: val });
    }
  }

  return (
    <div className="relative pl-12">
      {/* Timeline dot */}
      <div className="absolute left-3.5 top-5 h-3 w-3 rounded-full bg-[#0A0A0A]" />

      <div className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-2">
          <Icon className="h-3.5 w-3.5 text-black/25 shrink-0" strokeWidth={1.5} />
          <span className="font-display text-[11px] tracking-wide text-black/20">
            {config.label}
          </span>
          <span className="text-[11px] text-black/15 ml-auto">
            #{entry.ordinal}
          </span>
        </div>
        <div className="space-y-2">
          {displayParts.map((part, i) => (
            <div key={i}>
              {displayParts.length > 1 && (
                <span className="text-[10px] font-display tracking-wide text-black/20">
                  {part.label}:{" "}
                </span>
              )}
              <span className="text-sm text-black/50 whitespace-pre-wrap">{part.value}</span>
            </div>
          ))}
          {displayParts.length === 0 && (
            <pre className="text-[11px] overflow-x-auto text-black/25 font-display">
              {JSON.stringify(content, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
