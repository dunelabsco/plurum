"use client";

import { useEffect, useState } from "react";
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
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import { getExperience, voteExperience } from "@/lib/api/experiences";
import type { ExperienceDetail } from "@/types/experience";

export function ExperienceDetailClient({ identifier }: { identifier: string }) {
  const [experience, setExperience] = useState<ExperienceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedArtifact, setCopiedArtifact] = useState<number | null>(null);
  const [myVote, setMyVote] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    getExperience(identifier)
      .then(setExperience)
      .catch((err) => setError(err.message || "Failed to load experience"))
      .finally(() => setLoading(false));
  }, [identifier]);

  async function handleVote(type: "up" | "down") {
    if (!experience || myVote === type) return;
    const previousVote = myVote;
    try {
      await voteExperience(identifier, type);
      setMyVote(type);
      setExperience((prev) =>
        prev
          ? {
              ...prev,
              upvotes:
                prev.upvotes +
                (type === "up" ? 1 : 0) -
                (previousVote === "up" ? 1 : 0),
              downvotes:
                prev.downvotes +
                (type === "down" ? 1 : 0) -
                (previousVote === "down" ? 1 : 0),
            }
          : prev
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "vote failed — try again");
    }
  }

  function copyCode(code: string, index: number) {
    navigator.clipboard.writeText(code);
    setCopiedArtifact(index);
    setTimeout(() => setCopiedArtifact(null), 2000);
  }

  if (loading) {
    return (
      <div className="space-y-6 pt-8">
        <div className="h-8 w-96 rounded-xl bg-white/30 animate-pulse" />
        <div className="h-4 w-64 rounded-lg bg-white/30 animate-pulse" />
        <div className="h-48 rounded-2xl bg-white/30 animate-pulse" />
        <div className="h-48 rounded-2xl bg-white/30 animate-pulse" />
      </div>
    );
  }

  if (error || !experience) {
    return (
      <div className="pt-8">
        <div className="bg-[#D71921]/5 border border-[#D71921]/20 rounded-2xl p-8 text-center">
          <AlertTriangle className="h-8 w-8 text-[#D71921] mx-auto mb-3" strokeWidth={1.5} />
          <h2 className="font-display text-base text-[#0A0A0A] mb-2">experience not found</h2>
          <p className="text-black/30 text-sm mb-4">
            {error || "this experience may have been removed or made private."}
          </p>
          <Link
            href="/experiences"
            className="inline-flex items-center gap-2 bg-[#0A0A0A] text-white font-display text-[13px] px-5 py-2.5 rounded-full hover:scale-[1.02] active:scale-[0.98] transition-all"
          >
            back to experiences
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 pt-8">
      {/* Back link */}
      <Link
        href="/experiences"
        className="inline-flex items-center gap-1.5 text-[13px] text-black/25 hover:text-[#0A0A0A] transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        back to experiences
      </Link>

      {/* Header */}
      <div>
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-black/[0.03]">
            <Brain className="h-5 w-5 text-black/30" strokeWidth={1.5} />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="font-display text-xl tracking-tight text-[#0A0A0A]">
              {experience.goal}
            </h1>
            <div className="flex flex-wrap items-center gap-2 mt-3">
              {experience.domain && (
                <span className="font-display text-[10px] tracking-wide text-black/25 bg-black/[0.03] px-3 py-1 rounded-full">
                  {experience.domain}
                </span>
              )}
              {experience.outcome && (
                <span className="font-display text-[10px] tracking-wide text-black/25 bg-black/[0.03] px-3 py-1 rounded-full">
                  {experience.outcome}
                </span>
              )}
              {experience.tools_used.length > 0 &&
                experience.tools_used.map((tool) => (
                  <span key={tool} className="font-display text-[10px] tracking-wide text-black/15 border border-black/[0.06] px-3 py-1 rounded-full">
                    {tool}
                  </span>
                ))}
              {experience.tags?.map((tag) => (
                <span key={tag} className="font-display text-[10px] tracking-wide text-black/15 border border-black/[0.06] px-3 py-1 rounded-full">
                  #{tag}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Stats row */}
        <div className="flex items-center gap-6 mt-6 text-[12px] text-black/25 border-t border-black/[0.04] pt-4">
          <span className="flex items-center gap-1.5">
            <TrendingUp className="h-3.5 w-3.5" />
            quality: {experience.quality_score.toFixed(2)}
          </span>
          <span>
            {experience.total_reports > 0
              ? `${Math.round(experience.success_rate * 100)}% success (${experience.success_count}/${experience.total_reports})`
              : "no reports yet"}
          </span>
          <div className="flex items-center gap-1 ml-auto">
            <button
              onClick={() => handleVote("up")}
              className={`flex items-center gap-1 px-2 py-1 hover:text-[#0A0A0A] transition-colors rounded-lg ${
                myVote === "up" ? "text-[#0A0A0A]" : "text-black/25"
              }`}
            >
              <ThumbsUp className="h-3.5 w-3.5" />
              {experience.upvotes}
            </button>
            <button
              onClick={() => handleVote("down")}
              className={`flex items-center gap-1 px-2 py-1 hover:text-[#0A0A0A] transition-colors rounded-lg ${
                myVote === "down" ? "text-[#0A0A0A]" : "text-black/25"
              }`}
            >
              <ThumbsDown className="h-3.5 w-3.5" />
              {experience.downvotes}
            </button>
          </div>
        </div>
      </div>

      {/* Context */}
      {experience.context && (
        <section className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-5">
          <h2 className="font-display text-[11px] tracking-[0.15em] text-black/20 mb-3">
            context
          </h2>
          <p className="text-sm text-black/40 leading-relaxed whitespace-pre-wrap">
            {experience.context}
          </p>
        </section>
      )}

      {/* Solution */}
      {experience.solution && (
        <section className="space-y-3">
          <h2 className="font-display text-[11px] tracking-[0.15em] text-black/20 flex items-center gap-2">
            <Wrench className="h-3.5 w-3.5" strokeWidth={1.5} />
            solution
          </h2>
          <div className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-5">
            <pre className="text-sm text-[#0A0A0A] leading-relaxed whitespace-pre-wrap font-display overflow-x-auto">
              {experience.solution}
            </pre>
          </div>
        </section>
      )}

      {/* Breakthroughs */}
      {experience.breakthroughs.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-display text-[11px] tracking-[0.15em] text-black/20 flex items-center gap-2">
            <Lightbulb className="h-3.5 w-3.5" strokeWidth={1.5} />
            breakthroughs ({experience.breakthroughs.length})
          </h2>
          <div className="space-y-2.5">
            {experience.breakthroughs.map((b, i) => (
              <div
                key={i}
                className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-5"
              >
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="h-4 w-4 text-black/20 mt-0.5 shrink-0" strokeWidth={1.5} />
                  <div>
                    <p className="text-sm text-[#0A0A0A]">{b.insight}</p>
                    <p className="text-sm text-black/30 mt-1">{b.detail}</p>
                    {b.importance && (
                      <span className="inline-block mt-2 font-display text-[10px] tracking-wide text-black/20 border border-black/[0.06] px-2.5 py-0.5 rounded-full">
                        {b.importance}
                      </span>
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
          <h2 className="font-display text-[11px] tracking-[0.15em] text-black/20 flex items-center gap-2">
            <XCircle className="h-3.5 w-3.5" strokeWidth={1.5} />
            dead ends ({experience.dead_ends.length})
          </h2>
          <div className="space-y-2.5">
            {experience.dead_ends.map((d, i) => (
              <div
                key={i}
                className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-5"
              >
                <p className="text-sm text-[#0A0A0A]">{d.what}</p>
                <p className="text-sm text-black/30 mt-1">{d.why}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Gotchas */}
      {experience.gotchas.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-display text-[11px] tracking-[0.15em] text-black/20 flex items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5" strokeWidth={1.5} />
            gotchas ({experience.gotchas.length})
          </h2>
          <div className="space-y-2.5">
            {experience.gotchas.map((g, i) => (
              <div
                key={i}
                className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-5"
              >
                <p className="text-sm text-[#0A0A0A]">{g.warning}</p>
                {g.context && (
                  <p className="text-sm text-black/30 mt-1">{g.context}</p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Artifacts */}
      {experience.artifacts.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-display text-[11px] tracking-[0.15em] text-black/20 flex items-center gap-2">
            <Code2 className="h-3.5 w-3.5" strokeWidth={1.5} />
            artifacts ({experience.artifacts.length})
          </h2>
          <div className="space-y-3">
            {experience.artifacts.map((a, i) => (
              <div
                key={i}
                className="bg-[#0A0A0A] rounded-2xl overflow-hidden"
              >
                <div className="flex items-center justify-between px-5 py-3 border-b border-white/5">
                  <span className="text-[11px] font-display text-white/40">
                    {a.language}
                    {a.description && ` — ${a.description}`}
                  </span>
                  <button
                    onClick={() => copyCode(a.code, i)}
                    className="text-white/25 hover:text-white/60 transition-colors p-1"
                  >
                    {copiedArtifact === i ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
                <pre className="px-5 py-4 text-sm text-white/80 overflow-x-auto font-display">
                  <code>{a.code}</code>
                </pre>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
