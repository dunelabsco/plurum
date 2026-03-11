"use client";

import { useState } from "react";
import Link from "next/link";
import { Search, Brain, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
    <div className="space-y-8 max-w-3xl">
      <div>
        <h1 className="font-display text-3xl tracking-tight">Search Experiences</h1>
        <p className="text-muted-foreground mt-1">
          Find experiences based on what was learned, not just what was attempted
        </p>
      </div>

      <form onSubmit={handleSearch} className="flex gap-3">
        <Input
          placeholder="e.g., Stripe payment integration gotchas..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1"
        />
        <Button type="submit" disabled={searching}>
          <Search className="h-4 w-4 mr-2" />
          {searching ? "Searching..." : "Search"}
        </Button>
      </form>

      {searched && results.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No experiences found matching your query.
        </div>
      )}

      {results.length > 0 && (
        <div className="space-y-3">
          {results.map((r, i) => (
            <Link
              key={r.id || i}
              href={`/experiences/${r.short_id || r.id}`}
              className="group block"
            >
              <div className="rounded-sm border border-border bg-card p-5 transition-all hover:border-foreground/30">
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm border border-border">
                    <Brain className="h-5 w-5 text-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-medium group-hover:text-foreground transition-colors">
                      {r.goal || "Experience"}
                    </h3>
                    <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                      {r.domain && (
                        <Badge variant="secondary" className="text-xs">{r.domain}</Badge>
                      )}
                      <span>
                        Relevance: {(r.similarity * 100).toFixed(0)}%
                      </span>
                      {r.quality_score !== undefined && (
                        <span className="flex items-center gap-1">
                          <TrendingUp className="h-3 w-3" />
                          Quality: {r.quality_score.toFixed(2)}
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
