"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import {
  ArrowLeft,
  Target,
  CheckCircle,
  XCircle,
  Code2,
  ListOrdered,
  Lightbulb,
  Loader2,
  Clock,
  TrendingUp,
  Copy,
  Check,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

interface ExecutionStep {
  order: number;
  title: string;
  description: string;
  action_type: string;
  expected_outcome?: string;
}

interface CodeSnippet {
  language: string;
  code: string;
  description?: string;
}

interface BlueprintDetail {
  id: string;
  slug: string;
  status: string;
  execution_count: number;
  success_count: number;
  failure_count: number;
  success_rate: number;
  upvotes: number;
  downvotes: number;
  created_at: string;
  title: string;
  goal_description: string;
  strategy: string;
  execution_steps: ExecutionStep[];
  code_snippets: CodeSnippet[];
}

export default function BlueprintDetailPage() {
  const params = useParams();
  const slug = params.slug as string;
  const [blueprint, setBlueprint] = useState<BlueprintDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const supabase = createClient();

  useEffect(() => {
    if (slug) {
      fetchBlueprint();
    }
  }, [slug]);

  const fetchBlueprint = async () => {
    try {
      const { data: bp, error: bpError } = await supabase
        .from("blueprints")
        .select("*")
        .eq("slug", slug)
        .single();

      if (bpError) throw bpError;

      const { data: version, error: vError } = await supabase
        .from("blueprint_versions")
        .select("title, goal_description, strategy, execution_steps, code_snippets")
        .eq("id", bp.current_version_id)
        .single();

      if (vError) throw vError;

      setBlueprint({
        ...bp,
        title: version?.title || "Untitled",
        goal_description: version?.goal_description || "",
        strategy: version?.strategy || "",
        execution_steps: version?.execution_steps || [],
        code_snippets: version?.code_snippets || [],
      });
    } catch (err) {
      console.error("Failed to fetch blueprint:", err);
      setError("Blueprint not found");
    } finally {
      setIsLoading(false);
    }
  };

  const copyCode = async (code: string, index: number) => {
    await navigator.clipboard.writeText(code);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const getSuccessRateColor = (rate: number) => {
    if (rate >= 0.8) return "text-emerald-500";
    if (rate >= 0.5) return "text-amber-500";
    return "text-muted-foreground";
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <header className="border-b border-border">
          <div className="max-w-3xl mx-auto px-6 h-14 flex items-center">
            <Skeleton className="h-7 w-32" />
          </div>
        </header>
        <main className="max-w-3xl mx-auto px-6 py-8">
          <Skeleton className="h-8 w-64 mb-4" />
          <Skeleton className="h-4 w-full mb-2" />
          <Skeleton className="h-4 w-3/4 mb-8" />
          <Skeleton className="h-40 w-full mb-6" />
          <Skeleton className="h-40 w-full" />
        </main>
      </div>
    );
  }

  if (error || !blueprint) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <p className="text-muted-foreground mb-4">{error || "Blueprint not found"}</p>
          <Link href="/dashboard/blueprints">
            <Button variant="outline" size="sm">
              <ArrowLeft className="w-4 h-4 mr-1.5" />
              Back to Blueprints
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="max-w-3xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/dashboard" className="flex items-center gap-2">
            <div className="w-7 h-7 bg-foreground rounded-md flex items-center justify-center">
              <span className="text-background font-bold text-xs">P</span>
            </div>
            <span className="font-semibold text-foreground tracking-tight">Plurum</span>
          </Link>

          <Link href="/dashboard/blueprints">
            <Button variant="ghost" size="sm" className="text-muted-foreground">
              <ArrowLeft className="w-4 h-4 mr-1.5" />
              Blueprints
            </Button>
          </Link>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-3xl mx-auto px-6 py-8">
        {/* Title & Stats */}
        <div className="mb-8">
          <h1 className="text-2xl font-semibold text-foreground mb-4">
            {blueprint.title}
          </h1>

          <div className="flex flex-wrap items-center gap-3">
            <Badge
              variant="outline"
              className={`${
                blueprint.success_rate >= 0.8
                  ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20"
                  : blueprint.success_rate >= 0.5
                  ? "bg-amber-500/10 text-amber-500 border-amber-500/20"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {blueprint.execution_count > 0
                ? `${Math.round(blueprint.success_rate * 100)}% success`
                : "New"}
            </Badge>

            <Separator orientation="vertical" className="h-4" />

            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Target className="w-3.5 h-3.5" />
                {blueprint.execution_count} runs
              </span>
              {blueprint.success_count > 0 && (
                <span className="flex items-center gap-1.5 text-emerald-500">
                  <CheckCircle className="w-3.5 h-3.5" />
                  {blueprint.success_count}
                </span>
              )}
              {blueprint.failure_count > 0 && (
                <span className="flex items-center gap-1.5 text-destructive">
                  <XCircle className="w-3.5 h-3.5" />
                  {blueprint.failure_count}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Goal */}
        <Card className="border-border/50 mb-6">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2 text-muted-foreground">
              <Lightbulb className="w-4 h-4" />
              Goal
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-foreground">{blueprint.goal_description}</p>
          </CardContent>
        </Card>

        {/* Strategy */}
        <Card className="border-border/50 mb-6">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2 text-muted-foreground">
              <TrendingUp className="w-4 h-4" />
              Strategy
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-foreground whitespace-pre-wrap">{blueprint.strategy}</p>
          </CardContent>
        </Card>

        {/* Execution Steps */}
        {blueprint.execution_steps.length > 0 && (
          <Card className="border-border/50 mb-6">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2 text-muted-foreground">
                <ListOrdered className="w-4 h-4" />
                Steps
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="space-y-4">
                {blueprint.execution_steps.map((step, index) => (
                  <div
                    key={index}
                    className="flex gap-4 p-4 bg-muted/30 rounded-lg"
                  >
                    <div className="w-6 h-6 rounded-full bg-foreground/10 flex items-center justify-center text-xs font-medium text-foreground shrink-0">
                      {step.order}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="font-medium text-foreground text-sm mb-1">
                        {step.title}
                      </h4>
                      <p className="text-muted-foreground text-sm">
                        {step.description}
                      </p>
                      {step.expected_outcome && (
                        <p className="text-emerald-500 text-xs mt-2 flex items-center gap-1">
                          <CheckCircle className="w-3 h-3" />
                          {step.expected_outcome}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Code Snippets */}
        {blueprint.code_snippets.length > 0 && (
          <Card className="border-border/50 mb-6">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2 text-muted-foreground">
                <Code2 className="w-4 h-4" />
                Code
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="space-y-4">
                {blueprint.code_snippets.map((snippet, index) => (
                  <div key={index}>
                    {snippet.description && (
                      <p className="text-muted-foreground text-sm mb-2">
                        {snippet.description}
                      </p>
                    )}
                    <div className="relative group">
                      <div className="absolute top-2 right-2 flex items-center gap-2 z-10">
                        <Badge variant="secondary" className="text-[10px] bg-background/80">
                          {snippet.language}
                        </Badge>
                        <button
                          onClick={() => copyCode(snippet.code, index)}
                          className="p-1.5 rounded bg-background/80 hover:bg-background text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {copiedIndex === index ? (
                            <Check className="w-3.5 h-3.5" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                      <pre className="bg-muted/50 rounded-lg p-4 overflow-x-auto">
                        <code className="text-sm text-foreground font-mono">
                          {snippet.code}
                        </code>
                      </pre>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Metadata */}
        <div className="text-center text-xs text-muted-foreground flex items-center justify-center gap-1.5">
          <Clock className="w-3.5 h-3.5" />
          Created {new Date(blueprint.created_at).toLocaleDateString()}
        </div>
      </main>
    </div>
  );
}
