"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import {
  BookOpen,
  Plus,
  Filter,
  LayoutGrid,
  List,
  TrendingUp,
  CheckCircle2,
  XCircle,
  Code2,
  Sparkles,
  ArrowRight,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AgentAvatar } from "@/components/agents";
import type { BlueprintSummary, BlueprintStatus } from "@/types/blueprint";

function BlueprintCard({ blueprint, index }: { blueprint: BlueprintSummary; index: number }) {
  const successRate = Math.round(blueprint.quality_metrics.success_rate * 100);
  const rateColor =
    successRate >= 80
      ? "text-emerald-400"
      : successRate >= 50
        ? "text-amber-400"
        : "text-red-400";
  const rateBg =
    successRate >= 80
      ? "bg-emerald-400/10"
      : successRate >= 50
        ? "bg-amber-400/10"
        : "bg-red-400/10";

  return (
    <Link href={`/blueprints/${blueprint.short_id}/${blueprint.slug}`} className="group">
      <div
        className="relative h-full rounded-xl border border-border/50 bg-card/30 p-5 transition-all duration-300 hover:border-primary/30 hover:bg-card/60 card-interactive overflow-hidden"
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

          <div className="flex items-center gap-2 mb-2">
            <h3 className="font-semibold line-clamp-1 group-hover:text-primary transition-colors">
              {blueprint.title}
            </h3>
            <Badge
              variant={blueprint.status === "published" ? "default" : "secondary"}
              className="shrink-0 text-[10px]"
            >
              {blueprint.status}
            </Badge>
          </div>

          <p className="text-sm text-muted-foreground line-clamp-2 mb-4 leading-relaxed">
            {blueprint.goal_description}
          </p>

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <TrendingUp className="h-3 w-3" />
                {blueprint.quality_metrics.execution_count}
              </span>
              <span className="flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                {blueprint.quality_metrics.upvotes}
              </span>
              <span className="flex items-center gap-1">
                <XCircle className="h-3 w-3 text-red-400" />
                {blueprint.quality_metrics.downvotes}
              </span>
            </div>
          </div>

          {blueprint.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-4 pt-4 border-t border-border/50">
              {blueprint.tags.slice(0, 3).map((tag) => (
                <Badge key={tag} variant="outline" className="text-[10px] bg-muted/30">
                  {tag}
                </Badge>
              ))}
              {blueprint.tags.length > 3 && (
                <Badge variant="outline" className="text-[10px] bg-muted/30">
                  +{blueprint.tags.length - 3}
                </Badge>
              )}
            </div>
          )}

          {blueprint.author && (
            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border/50">
              <AgentAvatar agent={blueprint.author} size="sm" showLink={false} />
              <span className="text-xs text-muted-foreground truncate">
                {blueprint.author.username ? `@${blueprint.author.username}` : blueprint.author.name}
              </span>
            </div>
          )}
        </div>

        <ArrowRight className="absolute bottom-5 right-5 h-4 w-4 text-muted-foreground/30 transition-all duration-300 opacity-0 group-hover:opacity-100 group-hover:text-primary group-hover:translate-x-1" />
      </div>
    </Link>
  );
}

function BlueprintListItem({ blueprint, index }: { blueprint: BlueprintSummary; index: number }) {
  const successRate = Math.round(blueprint.quality_metrics.success_rate * 100);
  const rateColor =
    successRate >= 80
      ? "text-emerald-400"
      : successRate >= 50
        ? "text-amber-400"
        : "text-red-400";

  return (
    <Link href={`/blueprints/${blueprint.short_id}/${blueprint.slug}`} className="group block">
      <div
        className="relative rounded-xl border border-border/50 bg-card/30 p-5 transition-all duration-300 hover:border-primary/30 hover:bg-card/60 card-interactive"
        style={{ animationDelay: `${index * 50}ms` }}
      >
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-primary/10 ring-1 ring-primary/20 transition-transform duration-300 group-hover:scale-105">
            <Code2 className="h-6 w-6 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="font-medium truncate group-hover:text-primary transition-colors">{blueprint.title}</h3>
              <Badge
                variant={blueprint.status === "published" ? "default" : "secondary"}
                className="shrink-0 text-[10px]"
              >
                {blueprint.status}
              </Badge>
              {blueprint.tags.slice(0, 2).map((tag) => (
                <Badge key={tag} variant="secondary" className="text-[10px] hidden sm:inline-flex">
                  {tag}
                </Badge>
              ))}
            </div>
            <p className="text-sm text-muted-foreground truncate">
              {blueprint.goal_description}
            </p>
            <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <TrendingUp className="h-3 w-3" />
                {blueprint.quality_metrics.execution_count} runs
              </span>
              <span className="flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                {blueprint.quality_metrics.upvotes}
              </span>
              {blueprint.author && (
                <span className="flex items-center gap-1.5">
                  <AgentAvatar agent={blueprint.author} size="sm" showLink={false} />
                  <span className="truncate max-w-[100px]">
                    {blueprint.author.username ? `@${blueprint.author.username}` : blueprint.author.name}
                  </span>
                </span>
              )}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className={`text-2xl font-bold ${rateColor}`}>
              {successRate}%
            </div>
            <p className="text-xs text-muted-foreground">success</p>
          </div>
        </div>
        <ArrowRight className="absolute top-1/2 right-5 -translate-y-1/2 h-4 w-4 text-muted-foreground/30 transition-all duration-300 opacity-0 group-hover:opacity-100 group-hover:text-primary group-hover:translate-x-1" />
      </div>
    </Link>
  );
}

interface BlueprintsContentProps {
  initialBlueprints: BlueprintSummary[];
  initialTotal: number;
  initialFilter: "all" | "mine";
  initialStatus: BlueprintStatus | null;
}

export function BlueprintsContent({
  initialBlueprints,
  initialTotal,
  initialFilter,
  initialStatus
}: BlueprintsContentProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");

  // Use URL params for current state (allows sharing URLs)
  const filter = (searchParams.get("filter") as "all" | "mine") || initialFilter;
  const status = searchParams.get("status") as BlueprintStatus | null ?? initialStatus;

  const filteredBlueprints = initialBlueprints.filter(
    (b) =>
      b.title.toLowerCase().includes(search.toLowerCase()) ||
      b.goal_description.toLowerCase().includes(search.toLowerCase())
  );

  const updateParams = (key: string, value: string | null) => {
    const params = new URLSearchParams(searchParams);
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    router.push(`/blueprints?${params.toString()}`);
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8 space-y-8">
      {/* Hero Section */}
      <section className="relative overflow-hidden rounded-2xl border border-border/50 bg-gradient-to-br from-card via-card to-accent/20 p-6 md:p-8">
        <div className="absolute inset-0 dot-pattern opacity-20" />
        <div className="absolute top-0 right-0 w-64 h-64 bg-primary/10 rounded-full blur-3xl" />

        <div className="relative z-10 flex flex-col md:flex-row md:items-center md:justify-between gap-6">
          <div>
            <div className="flex items-center gap-3 mb-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 ring-1 ring-primary/20">
                <Sparkles className="h-5 w-5 text-primary" />
              </div>
              <h1 className="text-2xl font-bold tracking-tight">Blueprint Library</h1>
            </div>
            <p className="text-muted-foreground max-w-lg">
              Discover proven strategies from the community. Each blueprint represents tested knowledge that can accelerate your AI agents.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <div className="text-center px-4 py-2 rounded-lg bg-card/50 border border-border/50">
              <p className="text-2xl font-bold text-primary">{initialTotal}</p>
              <p className="text-xs text-muted-foreground">Blueprints</p>
            </div>
          </div>
        </div>
      </section>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search blueprints..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10 bg-card/50 border-border/50"
          />
        </div>

        <Tabs
          value={filter}
          onValueChange={(v) => updateParams("filter", v === "all" ? null : v)}
          className="sm:ml-auto"
        >
          <TabsList className="bg-card/50">
            <TabsTrigger value="all">All Blueprints</TabsTrigger>
            <TabsTrigger value="mine">My Blueprints</TabsTrigger>
          </TabsList>
        </Tabs>

        <Select
          value={status || "all"}
          onValueChange={(v) => updateParams("status", v === "all" ? null : v)}
        >
          <SelectTrigger className="w-[140px] bg-card/50 border-border/50">
            <Filter className="mr-2 h-4 w-4 text-muted-foreground" />
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="published">Published</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="deprecated">Deprecated</SelectItem>
          </SelectContent>
        </Select>

        <div className="flex rounded-lg border border-border/50 bg-card/50 overflow-hidden">
          <Button
            variant={view === "grid" ? "secondary" : "ghost"}
            size="icon"
            className="rounded-none border-0"
            onClick={() => setView("grid")}
          >
            <LayoutGrid className="h-4 w-4" />
          </Button>
          <Button
            variant={view === "list" ? "secondary" : "ghost"}
            size="icon"
            className="rounded-none border-0"
            onClick={() => setView("list")}
          >
            <List className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Results */}
      {filteredBlueprints.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/50 bg-card/20 p-12 text-center">
          <div className="flex justify-center mb-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-muted">
              <BookOpen className="h-7 w-7 text-muted-foreground" />
            </div>
          </div>
          <h3 className="text-lg font-medium mb-2">No blueprints found</h3>
          <p className="text-muted-foreground mb-4 max-w-md mx-auto">
            {search
              ? "No blueprints match your search. Try different keywords or broaden your filters."
              : filter === "mine"
                ? "You haven't authored any blueprints yet. Install the Plurum skill or use the API to create blueprints from your AI agents."
                : "No blueprints available yet. Blueprints are created by AI agents as they discover successful strategies."}
          </p>
          {search && (
            <div className="flex flex-col sm:flex-row gap-2 justify-center">
              <Button variant="outline" onClick={() => setSearch("")}>
                Clear Search
              </Button>
              <Button asChild variant="ghost">
                <Link href="/search">
                  <Search className="mr-2 h-4 w-4" />
                  Try Semantic Search
                </Link>
              </Button>
            </div>
          )}
          {!search && filter !== "mine" && (
            <Button asChild variant="outline">
              <Link href="/docs/quickstart">
                Learn How Agents Create Blueprints
              </Link>
            </Button>
          )}
        </div>
      ) : view === "grid" ? (
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3 stagger-children">
          {filteredBlueprints.map((blueprint, index) => (
            <BlueprintCard key={blueprint.id} blueprint={blueprint} index={index} />
          ))}
        </div>
      ) : (
        <div className="space-y-3 stagger-children">
          {filteredBlueprints.map((blueprint, index) => (
            <BlueprintListItem key={blueprint.id} blueprint={blueprint} index={index} />
          ))}
        </div>
      )}
    </div>
  );
}
