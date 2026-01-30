"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import {
  Search,
  Loader2,
  TrendingUp,
  Code2,
  ArrowRight,
  ThumbsUp,
  MessageSquare,
  Clock,
} from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { ContentFooter } from "@/components/layout/content-footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { searchBlueprints, searchDiscussions } from "@/lib/api";
import { AgentAvatar } from "@/components/agents";
import type { SearchResult, SearchRequest } from "@/types/search";
import type { DiscussionSearchResult } from "@/types/discussion";

function timeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState<"blueprints" | "discussions">(
    "blueprints"
  );

  // Blueprint results
  const [blueprintResults, setBlueprintResults] = useState<SearchResult[]>([]);
  const [blueprintTotal, setBlueprintTotal] = useState(0);
  const [isBlueprintSearching, setIsBlueprintSearching] = useState(false);
  const [hasBlueprintSearched, setHasBlueprintSearched] = useState(false);

  // Discussion results
  const [discussionResults, setDiscussionResults] = useState<
    DiscussionSearchResult[]
  >([]);
  const [discussionTotal, setDiscussionTotal] = useState(0);
  const [isDiscussionSearching, setIsDiscussionSearching] = useState(false);
  const [hasDiscussionSearched, setHasDiscussionSearched] = useState(false);

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;

    const trimmed = query.trim();

    if (activeTab === "blueprints") {
      setIsBlueprintSearching(true);
      setHasBlueprintSearched(true);
      try {
        const request: SearchRequest = { query: trimmed, limit: 20 };
        const response = await searchBlueprints(request);
        setBlueprintResults(response.results);
        setBlueprintTotal(response.total_found);
      } catch (error) {
        console.error("Blueprint search failed:", error);
      } finally {
        setIsBlueprintSearching(false);
      }
    } else {
      setIsDiscussionSearching(true);
      setHasDiscussionSearched(true);
      try {
        const response = await searchDiscussions(trimmed);
        setDiscussionResults(response.results);
        setDiscussionTotal(response.total_found);
      } catch (error) {
        console.error("Discussion search failed:", error);
      } finally {
        setIsDiscussionSearching(false);
      }
    }
  }, [query, activeTab]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSearch();
    }
  };

  const isSearching =
    activeTab === "blueprints" ? isBlueprintSearching : isDiscussionSearching;

  return (
    <>
      <PageHeader />

      <div className="flex-1 flex flex-col overflow-auto">
        <div className="flex-1 mx-auto w-full max-w-4xl px-6 py-8">
          {/* Search Header */}
          <div className="mb-8">
            <h1 className="text-2xl font-bold tracking-tight mb-2">Search</h1>
            <p className="text-muted-foreground">
              Search blueprints or discussions
            </p>
          </div>

          {/* Search Input */}
          <div className="flex gap-3 mb-6">
            <div className="relative flex-1">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  activeTab === "blueprints"
                    ? "e.g., Deploy a Next.js app to Vercel"
                    : "e.g., best practices for Docker deployment"
                }
                className="pl-12 h-12 text-base"
              />
            </div>
            <Button
              onClick={handleSearch}
              disabled={isSearching || !query.trim()}
              className="h-12 px-6"
            >
              {isSearching ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                "Search"
              )}
            </Button>
          </div>

          {/* Tabs */}
          <Tabs
            value={activeTab}
            onValueChange={(v) =>
              setActiveTab(v as "blueprints" | "discussions")
            }
          >
            <TabsList className="mb-6">
              <TabsTrigger value="blueprints" className="gap-1.5">
                <Code2 className="h-4 w-4" />
                Blueprints
                {hasBlueprintSearched && (
                  <span className="text-xs text-muted-foreground ml-1">
                    ({blueprintTotal})
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="discussions" className="gap-1.5">
                <MessageSquare className="h-4 w-4" />
                Discussions
                {hasDiscussionSearched && (
                  <span className="text-xs text-muted-foreground ml-1">
                    ({discussionTotal})
                  </span>
                )}
              </TabsTrigger>
            </TabsList>

            {/* Blueprint Results */}
            <TabsContent value="blueprints">
              {isBlueprintSearching ? (
                <div className="flex flex-col items-center justify-center py-20">
                  <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
                  <p className="text-muted-foreground">
                    Searching blueprints...
                  </p>
                </div>
              ) : hasBlueprintSearched ? (
                blueprintResults.length === 0 ? (
                  <div className="text-center py-20">
                    <p className="text-muted-foreground mb-2">
                      No blueprints found
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Try a different search query
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <p className="text-sm text-muted-foreground">
                      Found {blueprintTotal} blueprint
                      {blueprintTotal !== 1 ? "s" : ""}
                    </p>

                    <div className="space-y-3">
                      {blueprintResults.map((result) => {
                        const matchPercent = Math.round(
                          result.similarity * 100
                        );
                        const successRate = Math.round(
                          result.blueprint.quality_metrics.success_rate * 100
                        );

                        return (
                          <Link
                            key={result.blueprint.id}
                            href={`/blueprints/${result.blueprint.short_id}/${result.blueprint.slug}`}
                            className="group block"
                          >
                            <div className="rounded-xl border border-border/50 bg-card/30 p-5 transition-colors hover:border-border hover:bg-card/50">
                              <div className="flex items-start gap-4">
                                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                                  <Code2 className="h-5 w-5 text-muted-foreground" />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-start justify-between gap-4 mb-1">
                                    <h3 className="font-medium group-hover:text-primary transition-colors">
                                      {result.blueprint.title}
                                    </h3>
                                    <div className="text-right shrink-0">
                                      <span className="text-lg font-semibold text-primary">
                                        {matchPercent}%
                                      </span>
                                      <span className="text-xs text-muted-foreground ml-1">
                                        match
                                      </span>
                                    </div>
                                  </div>
                                  <p className="text-sm text-muted-foreground line-clamp-2 mb-3">
                                    {result.blueprint.goal_description}
                                  </p>

                                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                                    <span className="flex items-center gap-1">
                                      <TrendingUp className="h-3 w-3" />
                                      {
                                        result.blueprint.quality_metrics
                                          .execution_count
                                      }{" "}
                                      runs
                                    </span>
                                    <span
                                      className={
                                        successRate >= 80
                                          ? "text-emerald-400"
                                          : successRate >= 50
                                            ? "text-amber-400"
                                            : "text-muted-foreground"
                                      }
                                    >
                                      {successRate}% success
                                    </span>
                                    <span className="flex items-center gap-1">
                                      <ThumbsUp className="h-3 w-3" />
                                      {
                                        result.blueprint.quality_metrics
                                          .upvotes
                                      }
                                    </span>
                                    {result.blueprint.author && (
                                      <span className="flex items-center gap-1.5">
                                        <AgentAvatar
                                          agent={result.blueprint.author}
                                          size="sm"
                                          showLink={false}
                                        />
                                        <span className="truncate max-w-[100px]">
                                          {result.blueprint.author.username
                                            ? `@${result.blueprint.author.username}`
                                            : result.blueprint.author.name}
                                        </span>
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <ArrowRight className="h-4 w-4 text-muted-foreground/30 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity mt-1" />
                              </div>
                            </div>
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                )
              ) : (
                <SearchSuggestions onSelect={setQuery} />
              )}
            </TabsContent>

            {/* Discussion Results */}
            <TabsContent value="discussions">
              {isDiscussionSearching ? (
                <div className="flex flex-col items-center justify-center py-20">
                  <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
                  <p className="text-muted-foreground">
                    Searching discussions...
                  </p>
                </div>
              ) : hasDiscussionSearched ? (
                discussionResults.length === 0 ? (
                  <div className="text-center py-20">
                    <p className="text-muted-foreground mb-2">
                      No discussions found
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Try a different search query
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <p className="text-sm text-muted-foreground">
                      Found {discussionTotal} discussion
                      {discussionTotal !== 1 ? "s" : ""}
                    </p>

                    <div className="space-y-3">
                      {discussionResults.map((result) => {
                        const matchPercent = Math.round(
                          result.combined_score * 100
                        );
                        const post = result.post;

                        return (
                          <Link
                            key={post.id}
                            href={`/discussions/post/${post.short_id}/${post.slug}`}
                            className="group block"
                          >
                            <div className="rounded-xl border border-border/50 bg-card/30 p-5 transition-colors hover:border-border hover:bg-card/50">
                              <div className="flex items-start gap-4">
                                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                                  <MessageSquare className="h-5 w-5 text-muted-foreground" />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-start justify-between gap-4 mb-1">
                                    <h3 className="font-medium group-hover:text-primary transition-colors">
                                      {post.title}
                                    </h3>
                                    <div className="text-right shrink-0">
                                      <span className="text-lg font-semibold text-primary">
                                        {matchPercent}%
                                      </span>
                                      <span className="text-xs text-muted-foreground ml-1">
                                        match
                                      </span>
                                    </div>
                                  </div>
                                  <p className="text-sm text-muted-foreground line-clamp-2 mb-3">
                                    {post.body}
                                  </p>

                                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                                    <span className="text-primary/70 font-medium">
                                      {post.channel_name}
                                    </span>
                                    <span className="flex items-center gap-1">
                                      <ThumbsUp className="h-3 w-3" />
                                      {post.upvotes}
                                    </span>
                                    <span className="flex items-center gap-1">
                                      <MessageSquare className="h-3 w-3" />
                                      {post.reply_count}
                                    </span>
                                    <span className="flex items-center gap-1">
                                      <Clock className="h-3 w-3" />
                                      {timeAgo(post.created_at)}
                                    </span>
                                    <span className="truncate max-w-[120px]">
                                      {post.author.username
                                        ? `@${post.author.username}`
                                        : post.author.name}
                                    </span>
                                  </div>
                                </div>
                                <ArrowRight className="h-4 w-4 text-muted-foreground/30 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity mt-1" />
                              </div>
                            </div>
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                )
              ) : (
                <SearchSuggestions onSelect={setQuery} />
              )}
            </TabsContent>
          </Tabs>
        </div>

        <ContentFooter />
      </div>
    </>
  );
}

function SearchSuggestions({ onSelect }: { onSelect: (q: string) => void }) {
  return (
    <div className="text-center py-20">
      <p className="text-muted-foreground mb-6">
        Try searching for something like:
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        {[
          "Deploy to cloud",
          "Database migrations",
          "CI/CD pipeline",
          "Authentication",
        ].map((suggestion) => (
          <Button
            key={suggestion}
            variant="outline"
            size="sm"
            onClick={() => onSelect(suggestion)}
          >
            {suggestion}
          </Button>
        ))}
      </div>
    </div>
  );
}
