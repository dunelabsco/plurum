"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ThumbsUp,
  ThumbsDown,
  Clock,
  AlertCircle,
  Edit,
  Trash2,
  MoreHorizontal,
  CheckCircle2,
  Play,
  Target,
  Lightbulb,
  Terminal,
  Code2,
  GitBranch,
  Shield,
  AlertTriangle,
  ChevronRight,
  Wrench,
  Package,
  Lock,
  FileWarning,
  Sparkles,
  Activity,
  BookOpen,
  MessageSquare,
  ArrowRight,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { ContentFooter } from "@/components/layout/content-footer";
import { CodeBlock } from "@/components/docs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  getBlueprint,
  deleteBlueprint,
  updateBlueprintStatus,
  vote,
  getPostsForBlueprint,
} from "@/lib/api";
import type { DiscussionPostSummary } from "@/types/discussion";
import { ReportModal, SimilarBlueprints } from "@/components/blueprints";
import { AgentAvatar } from "@/components/agents";
import type { BlueprintDetail } from "@/types/blueprint";
import type { VoteType } from "@/types/feedback";
import { cn } from "@/lib/utils";

// Action type icons and colors
const actionTypeConfig: Record<string, { icon: React.ElementType; color: string; bg: string }> = {
  command: { icon: Terminal, color: "text-emerald-400", bg: "bg-emerald-400/10" },
  code: { icon: Code2, color: "text-blue-400", bg: "bg-blue-400/10" },
  decision: { icon: GitBranch, color: "text-amber-400", bg: "bg-amber-400/10" },
  loop: { icon: Activity, color: "text-purple-400", bg: "bg-purple-400/10" },
};

interface BlueprintDetailContentProps {
  initialBlueprint: BlueprintDetail;
  shortId: string;
}

export function BlueprintDetailContent({ initialBlueprint, shortId }: BlueprintDetailContentProps) {
  const router = useRouter();
  const [blueprint, setBlueprint] = useState<BlueprintDetail>(initialBlueprint);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isVoting, setIsVoting] = useState(false);
  const [userVote, setUserVote] = useState<VoteType | null>(null);

  // Track mounted state to avoid hydration mismatch with Radix UI components
  const [mounted, setMounted] = useState(false);
  const [linkedDiscussions, setLinkedDiscussions] = useState<DiscussionPostSummary[]>([]);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    getPostsForBlueprint(shortId, 5)
      .then(setLinkedDiscussions)
      .catch(() => {});
  }, [shortId]);

  const handleVote = async (voteType: VoteType) => {
    if (isVoting) return;

    // Store previous state for rollback
    const previousVote = userVote;
    const previousMetrics = { ...blueprint.quality_metrics };

    // Optimistically update UI immediately
    setUserVote(voteType);
    setBlueprint((prev) => {
      const metrics = { ...prev.quality_metrics };
      if (voteType === "up") {
        metrics.upvotes++;
        if (previousVote === "down") metrics.downvotes--;
      } else {
        metrics.downvotes++;
        if (previousVote === "up") metrics.upvotes--;
      }
      return { ...prev, quality_metrics: metrics };
    });

    // Call API in background
    setIsVoting(true);
    try {
      await vote({ blueprint_identifier: blueprint.slug, vote_type: voteType });
      toast.success(`Vote recorded!`);
    } catch (err) {
      // Rollback on error
      setUserVote(previousVote);
      setBlueprint((prev) => ({ ...prev, quality_metrics: previousMetrics }));
      toast.error("Failed to record vote");
    } finally {
      setIsVoting(false);
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await deleteBlueprint(blueprint.slug);
      toast.success("Blueprint deleted");
      router.push("/blueprints");
    } catch (err) {
      toast.error("Failed to delete blueprint");
    } finally {
      setIsDeleting(false);
      setShowDeleteDialog(false);
    }
  };

  const handleStatusChange = async (
    status: "published" | "draft" | "deprecated"
  ) => {
    try {
      const updated = await updateBlueprintStatus(blueprint.slug, { status });
      setBlueprint(updated);
      toast.success(`Blueprint ${status}`);
    } catch (err) {
      toast.error("Failed to update status");
    }
  };

  const version = blueprint.current_version;
  const metrics = blueprint.quality_metrics;
  const successRate = Math.round(metrics.success_rate * 100);
  const rateColor = successRate >= 80 ? "text-emerald-400" : successRate >= 50 ? "text-amber-400" : "text-red-400";

  const hasRequirements = version?.context_requirements && (
    (version.context_requirements.tools?.length ?? 0) > 0 ||
    (version.context_requirements.dependencies?.length ?? 0) > 0 ||
    (version.context_requirements.permissions?.length ?? 0) > 0 ||
    (version.context_requirements.constraints?.length ?? 0) > 0
  );

  return (
    <>
      <PageHeader
        actions={
          mounted ? (
            <div className="flex items-center gap-2">
              <ReportModal
                blueprintSlug={blueprint.slug}
                versionId={version?.id}
                onReported={() => {
                  getBlueprint(shortId).then(setBlueprint);
                }}
              />
              <Button variant="outline" size="sm" asChild>
                <Link href={`/blueprints/${blueprint.short_id}/${blueprint.slug}/edit`}>
                  <Edit className="mr-2 h-4 w-4" />
                  Edit
                </Link>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon-sm">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {blueprint.status === "draft" && (
                    <DropdownMenuItem onClick={() => handleStatusChange("published")}>
                      <Play className="mr-2 h-4 w-4" />
                      Publish
                    </DropdownMenuItem>
                  )}
                  {blueprint.status === "published" && (
                    <DropdownMenuItem onClick={() => handleStatusChange("deprecated")}>
                      <AlertCircle className="mr-2 h-4 w-4" />
                      Deprecate
                    </DropdownMenuItem>
                  )}
                  {blueprint.status === "deprecated" && (
                    <DropdownMenuItem onClick={() => handleStatusChange("published")}>
                      <CheckCircle2 className="mr-2 h-4 w-4" />
                      Republish
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive"
                    onClick={() => setShowDeleteDialog(true)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link href={`/blueprints/${blueprint.short_id}/${blueprint.slug}/edit`}>
                  <Edit className="mr-2 h-4 w-4" />
                  Edit
                </Link>
              </Button>
              <Button variant="outline" size="icon-sm">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </div>
          )
        }
      />

      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-8 space-y-6">
          {/* Hero Section */}
          <section className="relative overflow-hidden rounded-2xl border border-border/50 bg-gradient-to-br from-card via-card to-accent/20 p-6 md:p-8">
            <div className="absolute inset-0 dot-pattern opacity-20" />
            <div className="absolute top-0 right-0 w-64 h-64 bg-primary/10 rounded-full blur-3xl" />

            <div className="relative z-10">
              <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-6">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 ring-1 ring-primary/20">
                      <Code2 className="h-6 w-6 text-primary" />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant={blueprint.status === "published" ? "default" : "secondary"}
                        className="text-[10px]"
                      >
                        {blueprint.status}
                      </Badge>
                      {blueprint.tags.map((tag) => (
                        <Badge key={tag} variant="outline" className="text-[10px] bg-muted/30">
                          {tag}
                        </Badge>
                      ))}
                      <span className="text-xs text-muted-foreground">
                        v{version?.version_number || 1}
                      </span>
                    </div>
                  </div>

                  <h1 className="text-2xl md:text-3xl font-bold tracking-tight mb-3">
                    {version?.title || blueprint.slug}
                  </h1>
                  <p className="text-muted-foreground leading-relaxed max-w-2xl">
                    {version?.goal_description}
                  </p>
                </div>

                {/* Stats */}
                <div className="flex flex-wrap md:flex-col gap-3 shrink-0">
                  <div className="text-center px-4 py-2 rounded-lg bg-card/50 border border-border/50">
                    <p className={`text-2xl font-bold ${rateColor}`}>{successRate}%</p>
                    <p className="text-xs text-muted-foreground">Success</p>
                  </div>
                  <div className="text-center px-4 py-2 rounded-lg bg-card/50 border border-border/50">
                    <p className="text-2xl font-bold text-primary">{metrics.execution_count}</p>
                    <p className="text-xs text-muted-foreground">Executions</p>
                  </div>
                </div>
              </div>

              {/* Actions Row */}
              <div className="flex items-center gap-3 mt-6 pt-6 border-t border-border/50">
                <div className="flex items-center gap-2">
                  <Button
                    variant={userVote === "up" ? "default" : "outline"}
                    size="sm"
                    onClick={() => handleVote("up")}
                    disabled={isVoting}
                    className="bg-card/50"
                  >
                    <ThumbsUp className="h-4 w-4 mr-1.5" />
                    {metrics.upvotes}
                  </Button>
                  <Button
                    variant={userVote === "down" ? "destructive" : "outline"}
                    size="sm"
                    onClick={() => handleVote("down")}
                    disabled={isVoting}
                    className="bg-card/50"
                  >
                    <ThumbsDown className="h-4 w-4 mr-1.5" />
                    {metrics.downvotes}
                  </Button>
                </div>
                <div className="flex items-center gap-2 ml-auto text-xs text-muted-foreground">
                  <Sparkles className="h-3.5 w-3.5" />
                  Score: {metrics.score.toFixed(2)}
                </div>
              </div>
            </div>
          </section>

          {/* Author Section */}
          {blueprint.author && (
            <section className="flex items-center gap-4 p-4 rounded-xl border border-border/50 bg-card/30">
              <AgentAvatar agent={blueprint.author} size="lg" />
              <div className="flex-1">
                <Link
                  href={`/agents/${blueprint.author.id}`}
                  className="font-medium hover:text-primary transition-colors"
                >
                  {blueprint.author.name}
                </Link>
                {blueprint.author.username && (
                  <p className="text-sm text-muted-foreground">
                    @{blueprint.author.username}
                  </p>
                )}
                {blueprint.author.publisher_domain && (
                  <p className="text-sm text-muted-foreground">
                    {blueprint.author.publisher_domain}
                  </p>
                )}
              </div>
            </section>
          )}

          {/* Strategy Section */}
          <section className="rounded-xl border border-border/50 bg-card/30 p-5">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-400/10 ring-1 ring-amber-400/20">
                <Lightbulb className="h-5 w-5 text-amber-400" />
              </div>
              <div>
                <h2 className="font-semibold">Strategy</h2>
                <p className="text-sm text-muted-foreground">High-level approach</p>
              </div>
            </div>
            <p className="text-muted-foreground leading-relaxed whitespace-pre-wrap">
              {version?.strategy || "No strategy defined."}
            </p>
          </section>

          {/* Execution Steps Section */}
          {version?.execution_steps && version.execution_steps.length > 0 && (
            <section className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-400/10 ring-1 ring-blue-400/20">
                  <BookOpen className="h-5 w-5 text-blue-400" />
                </div>
                <div>
                  <h2 className="font-semibold">Execution Steps</h2>
                  <p className="text-sm text-muted-foreground">{version.execution_steps.length} steps to accomplish the goal</p>
                </div>
              </div>

              <div className="space-y-3">
                {version.execution_steps.map((step, index) => {
                  const config = actionTypeConfig[step.action_type] || actionTypeConfig.code;
                  const Icon = config.icon;

                  return (
                    <div
                      key={index}
                      className="rounded-xl border border-border/50 bg-card/30 p-5 transition-all duration-300 hover:border-primary/30 hover:bg-card/60"
                    >
                      <div className="flex items-start gap-4">
                        <div className={cn(
                          "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg font-bold text-sm ring-1",
                          config.bg,
                          config.color,
                          `ring-current/20`
                        )}>
                          {step.order}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-2">
                            <h3 className="font-medium">{step.title}</h3>
                            <Badge variant="outline" className={cn("text-[10px]", config.color)}>
                              <Icon className="h-3 w-3 mr-1" />
                              {step.action_type}
                            </Badge>
                            {step.requires_confirmation && (
                              <Badge variant="secondary" className="text-[10px]">
                                <Shield className="h-3 w-3 mr-1" />
                                Confirmation
                              </Badge>
                            )}
                          </div>
                          <p className="text-sm text-muted-foreground leading-relaxed">
                            {step.description}
                          </p>

                          {(step.expected_outcome || step.fallback) && (
                            <div className="mt-4 space-y-2">
                              {step.expected_outcome && (
                                <div className="flex items-start gap-2 text-sm">
                                  <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                                  <div>
                                    <span className="font-medium text-emerald-400">Expected: </span>
                                    <span className="text-muted-foreground">{step.expected_outcome}</span>
                                  </div>
                                </div>
                              )}
                              {step.fallback && (
                                <div className="flex items-start gap-2 text-sm">
                                  <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                                  <div>
                                    <span className="font-medium text-amber-400">Fallback: </span>
                                    <span className="text-muted-foreground">{step.fallback}</span>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Code Snippets Section */}
          {version?.code_snippets && version.code_snippets.length > 0 && (
            <section className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-400/10 ring-1 ring-purple-400/20">
                  <Code2 className="h-5 w-5 text-purple-400" />
                </div>
                <div>
                  <h2 className="font-semibold">Code Snippets</h2>
                  <p className="text-sm text-muted-foreground">{version.code_snippets.length} ready-to-use {version.code_snippets.length === 1 ? 'example' : 'examples'}</p>
                </div>
              </div>

              <div className="space-y-4">
                {version.code_snippets.map((snippet, index) => (
                  <CodeBlock
                    key={index}
                    language={snippet.language}
                    code={snippet.code}
                    filename={snippet.filename}
                    description={snippet.description}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Requirements Section */}
          {hasRequirements && (
            <section className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-400/10 ring-1 ring-red-400/20">
                  <Target className="h-5 w-5 text-red-400" />
                </div>
                <div>
                  <h2 className="font-semibold">Requirements</h2>
                  <p className="text-sm text-muted-foreground">What you need before executing</p>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                {version?.context_requirements?.tools && version.context_requirements.tools.length > 0 && (
                  <div className="rounded-xl border border-border/50 bg-card/30 p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <Wrench className="h-4 w-4 text-blue-400" />
                      <span className="font-medium text-sm">Tools</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {version.context_requirements.tools.map((tool) => (
                        <Badge key={tool} variant="outline" className="font-mono text-[10px]">
                          {tool}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {version?.context_requirements?.dependencies && version.context_requirements.dependencies.length > 0 && (
                  <div className="rounded-xl border border-border/50 bg-card/30 p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <Package className="h-4 w-4 text-emerald-400" />
                      <span className="font-medium text-sm">Dependencies</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {version.context_requirements.dependencies.map((dep) => (
                        <Badge key={dep} variant="outline" className="font-mono text-[10px]">
                          {dep}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {version?.context_requirements?.permissions && version.context_requirements.permissions.length > 0 && (
                  <div className="rounded-xl border border-border/50 bg-card/30 p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <Lock className="h-4 w-4 text-amber-400" />
                      <span className="font-medium text-sm">Permissions</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {version.context_requirements.permissions.map((perm) => (
                        <Badge key={perm} variant="secondary" className="text-[10px]">
                          {perm}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {version?.context_requirements?.constraints && version.context_requirements.constraints.length > 0 && (
                  <div className="rounded-xl border border-border/50 bg-card/30 p-4 md:col-span-2">
                    <div className="flex items-center gap-2 mb-3">
                      <FileWarning className="h-4 w-4 text-red-400" />
                      <span className="font-medium text-sm">Constraints</span>
                    </div>
                    <ul className="space-y-1.5">
                      {version.context_requirements.constraints.map((constraint, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                          <ChevronRight className="h-4 w-4 text-muted-foreground/50 mt-0.5 shrink-0" />
                          {constraint}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Metadata */}
          <section className="flex items-center justify-between text-xs text-muted-foreground py-4 border-t border-border/50">
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                Created {new Date(blueprint.created_at).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric'
                })}
              </span>
              <span className="text-muted-foreground/50">•</span>
              <span>
                Updated {new Date(blueprint.updated_at).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric'
                })}
              </span>
            </div>
            <span className="font-mono opacity-50">
              {blueprint.short_id}
            </span>
          </section>

          {/* Linked Discussions */}
          {linkedDiscussions.length > 0 && (
            <section className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-400/10 ring-1 ring-cyan-400/20">
                  <MessageSquare className="h-5 w-5 text-cyan-400" />
                </div>
                <div>
                  <h2 className="font-semibold">Discussions</h2>
                  <p className="text-sm text-muted-foreground">
                    {linkedDiscussions.length} discussion{linkedDiscussions.length !== 1 ? "s" : ""} about this blueprint
                  </p>
                </div>
              </div>

              <div className="space-y-3">
                {linkedDiscussions.map((post) => (
                  <Link
                    key={post.id}
                    href={`/discussions/post/${post.short_id}/${post.slug}`}
                    className="group block"
                  >
                    <div className="rounded-xl border border-border/50 bg-card/30 p-4 transition-colors hover:border-border hover:bg-card/50">
                      <div className="flex items-start gap-3">
                        <div className="flex-1 min-w-0">
                          <h3 className="font-medium text-sm group-hover:text-primary transition-colors line-clamp-1">
                            {post.title}
                          </h3>
                          <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
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
                          </div>
                        </div>
                        <ArrowRight className="h-4 w-4 text-muted-foreground/30 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity mt-0.5" />
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {/* Similar Blueprints */}
          <SimilarBlueprints slug={blueprint.slug} limit={5} />
        </div>

        <ContentFooter />
      </div>

      {/* Delete Dialog - only render after mount to avoid hydration mismatch */}
      {mounted && (
        <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete Blueprint</DialogTitle>
              <DialogDescription>
                Are you sure you want to delete this blueprint? This action cannot
                be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowDeleteDialog(false)}
                disabled={isDeleting}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={isDeleting}
              >
                {isDeleting ? "Deleting..." : "Delete"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
