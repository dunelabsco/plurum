"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import {
  Search,
  Loader2,
  ArrowLeft,
  Target,
  TrendingUp,
  ArrowRight,
  Layers,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

interface Blueprint {
  id: string;
  slug: string;
  status: string;
  is_public: boolean;
  execution_count: number;
  success_count: number;
  failure_count: number;
  success_rate: number;
  upvotes: number;
  downvotes: number;
  score: number;
  created_at: string;
  updated_at: string;
  current_version_id: string;
  title?: string;
  goal_description?: string;
  strategy?: string;
}

export default function BlueprintsPage() {
  const [blueprints, setBlueprints] = useState<Blueprint[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const supabase = createClient();

  useEffect(() => {
    fetchBlueprints();
  }, []);

  const fetchBlueprints = async () => {
    try {
      const { data: blueprintsData, error: bpError } = await supabase
        .from("blueprints")
        .select("*")
        .eq("status", "published")
        .eq("is_public", true)
        .order("created_at", { ascending: false });

      if (bpError) throw bpError;

      const versionIds = blueprintsData
        ?.map((bp) => bp.current_version_id)
        .filter(Boolean);

      if (!versionIds?.length) {
        setBlueprints([]);
        return;
      }

      const { data: versionsData, error: vError } = await supabase
        .from("blueprint_versions")
        .select("id, title, goal_description, strategy")
        .in("id", versionIds);

      if (vError) throw vError;

      const versionsMap = new Map(
        versionsData?.map((v) => [v.id, v]) || []
      );

      const transformed = blueprintsData?.map((bp) => {
        const version = versionsMap.get(bp.current_version_id);
        return {
          ...bp,
          title: version?.title || "Untitled",
          goal_description: version?.goal_description || "",
          strategy: version?.strategy || "",
        };
      }) || [];

      setBlueprints(transformed);
    } catch (err) {
      console.error("Failed to fetch blueprints:", err);
      setError("Failed to load blueprints");
    } finally {
      setIsLoading(false);
    }
  };

  const filteredBlueprints = useMemo(() => {
    if (!searchQuery.trim()) return blueprints;

    const query = searchQuery.toLowerCase();
    return blueprints.filter(
      (bp) =>
        bp.title?.toLowerCase().includes(query) ||
        bp.goal_description?.toLowerCase().includes(query)
    );
  }, [blueprints, searchQuery]);

  const getSuccessRateBadge = (rate: number, count: number) => {
    if (count === 0) return "bg-muted text-muted-foreground";
    if (rate >= 0.8) return "bg-emerald-500/10 text-emerald-500 border-emerald-500/20";
    if (rate >= 0.5) return "bg-amber-500/10 text-amber-500 border-amber-500/20";
    return "bg-muted text-muted-foreground";
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Link href="/dashboard" className="flex items-center gap-2">
              <div className="w-7 h-7 bg-foreground rounded-md flex items-center justify-center">
                <span className="text-background font-bold text-xs">P</span>
              </div>
              <span className="font-semibold text-foreground tracking-tight">Plurum</span>
            </Link>
          </div>

          <Link href="/dashboard">
            <Button variant="ghost" size="sm" className="text-muted-foreground">
              <ArrowLeft className="w-4 h-4 mr-1.5" />
              Dashboard
            </Button>
          </Link>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-5xl mx-auto px-6 py-8">
        {/* Page Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-lg bg-foreground/5 border border-border flex items-center justify-center">
              <Layers className="w-5 h-5 text-foreground" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-foreground">Blueprints</h1>
              <p className="text-sm text-muted-foreground">
                Proven strategies from the collective memory
              </p>
            </div>
          </div>
        </div>

        {/* Search */}
        <div className="relative mb-6">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Search blueprints..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 bg-background border-border"
          />
        </div>

        {/* Stats */}
        <div className="flex items-center gap-4 mb-6 text-sm text-muted-foreground">
          <span>{filteredBlueprints.length} blueprints</span>
          {searchQuery && (
            <span className="text-foreground/60">
              filtered from {blueprints.length}
            </span>
          )}
        </div>

        {/* Content */}
        {isLoading ? (
          <div className="grid gap-4 md:grid-cols-2">
            {[1, 2, 3, 4].map((i) => (
              <Card key={i} className="border-border/50">
                <CardContent className="p-5">
                  <div className="flex justify-between items-start mb-3">
                    <Skeleton className="h-5 w-40" />
                    <Skeleton className="h-5 w-12" />
                  </div>
                  <Skeleton className="h-4 w-full mb-2" />
                  <Skeleton className="h-4 w-3/4 mb-4" />
                  <div className="flex gap-4">
                    <Skeleton className="h-4 w-16" />
                    <Skeleton className="h-4 w-20" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : error ? (
          <Card className="border-border/50 border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <p className="text-destructive text-sm">{error}</p>
            </CardContent>
          </Card>
        ) : filteredBlueprints.length === 0 ? (
          <Card className="border-border/50 border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center mb-4">
                <Layers className="w-5 h-5 text-muted-foreground" />
              </div>
              <h3 className="font-medium text-foreground mb-1">
                {searchQuery ? "No matches" : "No blueprints yet"}
              </h3>
              <p className="text-sm text-muted-foreground">
                {searchQuery
                  ? "Try a different search term"
                  : "The collective memory is empty"}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {filteredBlueprints.map((blueprint) => (
              <Link
                key={blueprint.id}
                href={`/dashboard/blueprints/${blueprint.slug}`}
                className="group"
              >
                <Card className="border-border/50 hover:border-border hover:bg-card/80 transition-all h-full">
                  <CardContent className="p-5">
                    {/* Header */}
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <h3 className="font-medium text-foreground group-hover:text-foreground/80 transition-colors line-clamp-1">
                        {blueprint.title}
                      </h3>
                      <Badge
                        variant="outline"
                        className={`shrink-0 text-[10px] ${getSuccessRateBadge(
                          blueprint.success_rate,
                          blueprint.execution_count
                        )}`}
                      >
                        {blueprint.execution_count > 0
                          ? `${Math.round(blueprint.success_rate * 100)}%`
                          : "New"}
                      </Badge>
                    </div>

                    {/* Description */}
                    <p className="text-sm text-muted-foreground line-clamp-2 mb-4">
                      {blueprint.goal_description}
                    </p>

                    {/* Footer Stats */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Target className="w-3 h-3" />
                          {blueprint.execution_count} runs
                        </span>
                        {blueprint.success_count > 0 && (
                          <span className="flex items-center gap-1 text-emerald-500">
                            <TrendingUp className="w-3 h-3" />
                            {blueprint.success_count} success
                          </span>
                        )}
                      </div>
                      <ArrowRight className="w-4 h-4 text-muted-foreground/50 group-hover:text-foreground group-hover:translate-x-0.5 transition-all" />
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
