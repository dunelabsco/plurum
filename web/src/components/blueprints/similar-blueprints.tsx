"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  TrendingUp,
  Sparkles,
  ArrowRight,
  Code2,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { getSimilarBlueprints } from "@/lib/api";
import type { SearchResult } from "@/types/search";

interface SimilarBlueprintsProps {
  slug: string;
  limit?: number;
}

export function SimilarBlueprints({ slug, limit = 5 }: SimilarBlueprintsProps) {
  const [similar, setSimilar] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadSimilar() {
      try {
        const results = await getSimilarBlueprints(slug, {
          limit,
          exclude_same_author: true,
        });
        setSimilar(results);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        setIsLoading(false);
      }
    }
    loadSimilar();
  }, [slug, limit]);

  if (isLoading) {
    return (
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 ring-1 ring-primary/20">
            <Skeleton className="h-5 w-5" />
          </div>
          <div className="space-y-1">
            <Skeleton className="h-5 w-36" />
            <Skeleton className="h-4 w-48" />
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="rounded-xl border border-border/50 bg-card/30 p-5">
              <div className="flex items-start justify-between gap-3 mb-3">
                <Skeleton className="h-10 w-10 rounded-lg" />
                <Skeleton className="h-6 w-14 rounded-full" />
              </div>
              <Skeleton className="h-5 w-3/4 mb-2" />
              <Skeleton className="h-4 w-full mb-1" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (error || similar.length === 0) {
    return null;
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 ring-1 ring-primary/20">
          <Sparkles className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h2 className="font-semibold">Similar Blueprints</h2>
          <p className="text-sm text-muted-foreground">Related strategies you might find useful</p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {similar.map((result, index) => {
          const matchPercent = Math.round(result.similarity * 100);
          const successRate = Math.round(result.blueprint.quality_metrics.success_rate * 100);
          const rateColor = successRate >= 80 ? "text-emerald-400" : successRate >= 50 ? "text-amber-400" : "text-red-400";
          const rateBg = successRate >= 80 ? "bg-emerald-400/10" : successRate >= 50 ? "bg-amber-400/10" : "bg-red-400/10";

          return (
            <Link
              key={result.blueprint.id}
              href={`/blueprints/${result.blueprint.short_id}/${result.blueprint.slug}`}
              className="group"
            >
              <div
                className="relative h-full rounded-xl border border-border/50 bg-card/30 p-5 transition-all duration-300 hover:border-primary/30 hover:bg-card/60 overflow-hidden"
                style={{ animationDelay: `${index * 50}ms` }}
              >
                {/* Subtle gradient overlay on hover */}
                <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />

                <div className="relative z-10">
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 ring-1 ring-primary/20 transition-transform duration-300 group-hover:scale-105">
                      <Code2 className="h-5 w-5 text-primary" />
                    </div>
                    <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${rateBg} ${rateColor}`}>
                      <span>{successRate}%</span>
                    </div>
                  </div>

                  <h3 className="font-semibold line-clamp-2 mb-2 group-hover:text-primary transition-colors">
                    {result.blueprint.title}
                  </h3>

                  <div className="flex items-center gap-3 text-xs text-muted-foreground mb-3">
                    <span className="flex items-center gap-1">
                      <TrendingUp className="h-3 w-3" />
                      {result.blueprint.quality_metrics.execution_count}
                    </span>
                    <span className="flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                      {result.blueprint.quality_metrics.upvotes}
                    </span>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                      {matchPercent}% match
                    </Badge>
                  </div>

                  {result.blueprint.tags && result.blueprint.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-3 border-t border-border/50">
                      {result.blueprint.tags.slice(0, 3).map((tag) => (
                        <Badge key={tag} variant="outline" className="text-[10px] bg-muted/30">
                          {tag}
                        </Badge>
                      ))}
                      {result.blueprint.tags.length > 3 && (
                        <Badge variant="outline" className="text-[10px] bg-muted/30">
                          +{result.blueprint.tags.length - 3}
                        </Badge>
                      )}
                    </div>
                  )}
                </div>

                <ArrowRight className="absolute bottom-5 right-5 h-4 w-4 text-muted-foreground/30 transition-all duration-300 opacity-0 group-hover:opacity-100 group-hover:text-primary group-hover:translate-x-1" />
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
