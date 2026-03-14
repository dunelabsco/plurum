"use client";

import { useState } from "react";
import Link from "next/link";
import { Search, Brain, TrendingUp, ArrowRight } from "lucide-react";
import { searchExperiences } from "@/lib/api/experiences";
import type { ExperienceSearchResult } from "@/types/experience";

export default function SearchExperiencesPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ExperienceSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;

    setSearching(true);
    try {
      const res = await searchExperiences({ query, limit: 20 });
      setResults(res.results);
      setSearched(true);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="space-y-10 pt-8 max-w-3xl">
      <div>
        <h1 className="font-display text-2xl tracking-tight text-[#0A0A0A]">search experiences</h1>
        <p className="text-black/30 text-sm mt-1">
          find experiences based on what was learned, not just what was attempted
        </p>
      </div>

      <form onSubmit={handleSearch} className="flex gap-3">
        <input
          placeholder="e.g., stripe payment integration gotchas..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-full px-5 py-3 text-sm text-[#0A0A0A] placeholder:text-black/20 focus:border-black/15 focus:outline-none transition-colors"
        />
        <button
          type="submit"
          disabled={searching}
          className="inline-flex items-center gap-2 bg-[#0A0A0A] text-white font-display text-[13px] px-6 py-3 rounded-full hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-30"
        >
          <Search className="h-3.5 w-3.5" />
          {searching ? "searching..." : "search"}
        </button>
      </form>

      {searched && results.length === 0 && (
        <div className="text-center py-12 text-black/25 text-sm">
          no experiences found matching your query.
        </div>
      )}

      {results.length > 0 && (
        <div className="space-y-2.5">
          {results.map((r, i) => (
            <Link
              key={r.id || i}
              href={`/experiences/${r.short_id || r.id}`}
              className="group block"
            >
              <div className="bg-white/40 backdrop-blur-sm border border-black/[0.06] rounded-2xl p-5 transition-all hover:bg-white/60 hover:border-black/10">
                <div className="flex items-start gap-4">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/[0.03]">
                    <Brain className="h-4 w-4 text-black/30" strokeWidth={1.5} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm text-[#0A0A0A] group-hover:text-[#0A0A0A] transition-colors">
                      {r.goal || "experience"}
                    </h3>
                    <div className="flex items-center gap-3 mt-2 text-[11px] text-black/25">
                      {r.domain && (
                        <span className="font-display tracking-wide">{r.domain}</span>
                      )}
                      <span>
                        relevance: {(r.similarity * 100).toFixed(0)}%
                      </span>
                      {r.quality_score !== undefined && (
                        <span className="flex items-center gap-1">
                          <TrendingUp className="h-3 w-3" />
                          quality: {r.quality_score.toFixed(2)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
