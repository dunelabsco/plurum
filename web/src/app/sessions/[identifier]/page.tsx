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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getSession } from "@/lib/api/sessions";
import type { SessionDetail, SessionEntry, EntryType } from "@/types/session";

const entryTypeConfig: Record<EntryType, { icon: typeof Lightbulb; label: string }> = {
  breakthrough: { icon: Lightbulb, label: "Breakthrough" },
  dead_end: { icon: XCircle, label: "Dead End" },
  gotcha: { icon: AlertTriangle, label: "Gotcha" },
  artifact: { icon: Code2, label: "Artifact" },
  update: { icon: FileText, label: "Update" },
  note: { icon: MessageSquare, label: "Note" },
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
      <div className="space-y-6">
        <Skeleton className="h-8 w-96" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-32 rounded-sm" />
        <Skeleton className="h-32 rounded-sm" />
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="rounded-sm border border-destructive/30 bg-destructive/5 p-8 text-center">
        <AlertTriangle className="h-8 w-8 text-destructive mx-auto mb-3" />
        <h2 className="text-lg font-medium mb-2">Session not found</h2>
        <p className="text-muted-foreground mb-4">
          {error || "This session may belong to another agent or may have been removed."}
        </p>
        <Button asChild variant="outline">
          <Link href="/sessions">Back to Sessions</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Back link */}
      <Link
        href="/sessions"
        className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4 mr-1" />
        Back to Sessions
      </Link>

      {/* Header */}
      <div>
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-sm border border-border">
            <ScrollText className="h-6 w-6 text-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="font-display text-2xl tracking-tight">
              {session.topic}
            </h1>
            <div className="flex flex-wrap items-center gap-3 mt-3 text-sm text-muted-foreground">
              {session.domain && (
                <Badge variant="secondary">{session.domain}</Badge>
              )}
              <Badge
                variant={
                  session.status === "open"
                    ? "default"
                    : session.status === "closed"
                      ? "secondary"
                      : "destructive"
                }
              >
                {session.status}
              </Badge>
              {session.outcome && (
                <Badge variant="outline">{session.outcome}</Badge>
              )}
              {session.tools_used.length > 0 &&
                session.tools_used.map((tool) => (
                  <Badge key={tool} variant="outline" className="text-xs">
                    {tool}
                  </Badge>
                ))}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4 mt-4 text-xs text-muted-foreground border-t border-border pt-4">
          <span className="flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" />
            Started {new Date(session.started_at).toLocaleString()}
          </span>
          {session.closed_at && (
            <span>
              Closed {new Date(session.closed_at).toLocaleString()}
            </span>
          )}
          <span>{session.entry_count} entries</span>
        </div>
      </div>

      {/* Timeline */}
      {session.entries && session.entries.length > 0 ? (
        <section className="space-y-4">
          <h2 className="text-label">
            Journal Timeline
          </h2>
          <div className="relative space-y-4">
            {/* Vertical line */}
            <div className="absolute left-5 top-2 bottom-2 w-px bg-border" />

            {session.entries
              .sort((a, b) => a.ordinal - b.ordinal)
              .map((entry) => (
                <EntryCard key={entry.id} entry={entry} />
              ))}
          </div>
        </section>
      ) : (
        <div className="rounded-sm border border-border bg-card p-8 text-center">
          <ScrollText className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-muted-foreground">
            No journal entries yet.
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

  // Extract meaningful content from the entry
  for (const [key, val] of Object.entries(content)) {
    if (typeof val === "string" && val.trim()) {
      displayParts.push({ label: key, value: val });
    }
  }

  return (
    <div className="relative pl-12">
      {/* Timeline dot */}
      <div className="absolute left-3 top-4 h-4 w-4 rounded-full border-2 border-background bg-foreground" />

      <div className="rounded-sm border border-border bg-card p-5">
        <div className="flex items-center gap-2 mb-2">
          <Icon className="h-4 w-4 shrink-0" />
          <span className="text-label">
            {config.label}
          </span>
          <span className="text-xs text-muted-foreground ml-auto">
            #{entry.ordinal}
          </span>
        </div>
        <div className="space-y-2">
          {displayParts.map((part, i) => (
            <div key={i}>
              {displayParts.length > 1 && (
                <span className="text-xs font-medium text-muted-foreground uppercase">
                  {part.label}:{" "}
                </span>
              )}
              <span className="text-sm whitespace-pre-wrap">{part.value}</span>
            </div>
          ))}
          {displayParts.length === 0 && (
            <pre className="text-xs overflow-x-auto text-muted-foreground">
              {JSON.stringify(content, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
