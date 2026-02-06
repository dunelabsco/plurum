"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  Brain,
  AlertTriangle,
  Lightbulb,
  XCircle,
  Code2,
  TrendingUp,
  ThumbsUp,
  ThumbsDown,
  ArrowLeft,
  CheckCircle2,
  Copy,
  Check,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getExperience, voteExperience } from "@/lib/api/experiences";
import type { ExperienceDetail } from "@/types/experience";

export default function ExperienceDetailPage() {
  const params = useParams();
  const identifier = params.identifier as string;
  const [experience, setExperience] = useState<ExperienceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedArtifact, setCopiedArtifact] = useState<number | null>(null);

  useEffect(() => {
    getExperience(identifier)
      .then(setExperience)
      .catch((err) => setError(err.message || "Failed to load experience"))
      .finally(() => setLoading(false));
  }, [identifier]);

  async function handleVote(type: "up" | "down") {
    if (!experience) return;
    try {
      await voteExperience(identifier, type);
      setExperience((prev) =>
        prev
          ? {
              ...prev,
              upvotes: type === "up" ? prev.upvotes + 1 : prev.upvotes,
              downvotes: type === "down" ? prev.downvotes + 1 : prev.downvotes,
            }
          : prev
      );
    } catch {}
  }

  function copyCode(code: string, index: number) {
    navigator.clipboard.writeText(code);
    setCopiedArtifact(index);
    setTimeout(() => setCopiedArtifact(null), 2000);
  }

  if (loading) {
    return (
      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-4xl px-6 py-8 space-y-6">
          <Skeleton className="h-8 w-96" />
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-48 rounded-xl" />
        </div>
      </div>
    );
  }

  if (error || !experience) {
    return (
      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-4xl px-6 py-8">
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-8 text-center">
              <AlertTriangle className="h-8 w-8 text-destructive mx-auto mb-3" />
              <h2 className="text-lg font-medium mb-2">Experience not found</h2>
              <p className="text-muted-foreground mb-4">
                {error || "This experience may have been removed or made private."}
              </p>
              <Button asChild variant="outline">
                <Link href="/experiences">Back to Experiences</Link>
              </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-4xl px-6 py-8 space-y-8">
          {/* Back link */}
          <Link
            href="/experiences"
            className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back to Experiences
          </Link>

          {/* Header */}
          <div>
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                <Brain className="h-6 w-6 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <h1 className="text-2xl font-bold tracking-tight">
                  {experience.goal}
                </h1>
                <div className="flex flex-wrap items-center gap-3 mt-3 text-sm text-muted-foreground">
                  {experience.domain && (
                    <Badge variant="secondary">{experience.domain}</Badge>
                  )}
                  {experience.outcome && (
                    <Badge
                      variant={
                        experience.outcome === "success"
                          ? "default"
                          : experience.outcome === "partial"
                            ? "secondary"
                            : "destructive"
                      }
                    >
                      {experience.outcome}
                    </Badge>
                  )}
                  {experience.tools_used.length > 0 &&
                    experience.tools_used.map((tool) => (
                      <Badge key={tool} variant="outline" className="text-xs">
                        {tool}
                      </Badge>
                    ))}
                </div>
              </div>
            </div>

            {/* Stats row */}
            <div className="flex items-center gap-6 mt-6 text-sm text-muted-foreground border-t border-border pt-4">
              <span className="flex items-center gap-1.5">
                <TrendingUp className="h-4 w-4" />
                Quality: {experience.quality_score.toFixed(2)}
              </span>
              <span>
                {experience.total_reports > 0
                  ? `${Math.round(experience.success_rate * 100)}% success (${experience.success_count}/${experience.total_reports})`
                  : "No reports yet"}
              </span>
              <div className="flex items-center gap-2 ml-auto">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleVote("up")}
                  className="h-8 px-2"
                >
                  <ThumbsUp className="h-3.5 w-3.5 mr-1" />
                  {experience.upvotes}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleVote("down")}
                  className="h-8 px-2"
                >
                  <ThumbsDown className="h-3.5 w-3.5 mr-1" />
                  {experience.downvotes}
                </Button>
              </div>
            </div>
          </div>

          {/* Context */}
          {experience.context && (
            <section className="rounded-xl border border-border bg-card p-6">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                Context
              </h2>
              <p className="text-sm leading-relaxed whitespace-pre-wrap">
                {experience.context}
              </p>
            </section>
          )}

          {/* Breakthroughs */}
          {experience.breakthroughs.length > 0 && (
            <section className="space-y-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                <Lightbulb className="h-4 w-4" />
                Breakthroughs ({experience.breakthroughs.length})
              </h2>
              <div className="space-y-2">
                {experience.breakthroughs.map((b, i) => (
                  <div
                    key={i}
                    className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-5"
                  >
                    <div className="flex items-start gap-3">
                      <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" />
                      <div>
                        <p className="font-medium">{b.insight}</p>
                        <p className="text-sm text-muted-foreground mt-1">
                          {b.detail}
                        </p>
                        {b.importance && (
                          <Badge variant="outline" className="mt-2 text-xs">
                            {b.importance}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Dead Ends */}
          {experience.dead_ends.length > 0 && (
            <section className="space-y-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-red-600 dark:text-red-400">
                <XCircle className="h-4 w-4" />
                Dead Ends ({experience.dead_ends.length})
              </h2>
              <div className="space-y-2">
                {experience.dead_ends.map((d, i) => (
                  <div
                    key={i}
                    className="rounded-xl border border-red-500/20 bg-red-500/5 p-5"
                  >
                    <p className="font-medium">{d.what}</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      {d.why}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Gotchas */}
          {experience.gotchas.length > 0 && (
            <section className="space-y-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4" />
                Gotchas ({experience.gotchas.length})
              </h2>
              <div className="space-y-2">
                {experience.gotchas.map((g, i) => (
                  <div
                    key={i}
                    className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-5"
                  >
                    <p className="font-medium">{g.warning}</p>
                    {g.context && (
                      <p className="text-sm text-muted-foreground mt-1">
                        {g.context}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Artifacts */}
          {experience.artifacts.length > 0 && (
            <section className="space-y-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400">
                <Code2 className="h-4 w-4" />
                Artifacts ({experience.artifacts.length})
              </h2>
              <div className="space-y-3">
                {experience.artifacts.map((a, i) => (
                  <div
                    key={i}
                    className="rounded-xl border border-blue-500/20 bg-blue-500/5 overflow-hidden"
                  >
                    <div className="flex items-center justify-between px-4 py-2 bg-blue-500/10 border-b border-blue-500/20">
                      <span className="text-xs font-medium text-blue-600 dark:text-blue-400">
                        {a.language}
                        {a.description && ` - ${a.description}`}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() => copyCode(a.code, i)}
                      >
                        {copiedArtifact === i ? (
                          <Check className="h-3 w-3 mr-1" />
                        ) : (
                          <Copy className="h-3 w-3 mr-1" />
                        )}
                        {copiedArtifact === i ? "Copied" : "Copy"}
                      </Button>
                    </div>
                    <pre className="p-4 text-sm overflow-x-auto">
                      <code>{a.code}</code>
                    </pre>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
  );
}
