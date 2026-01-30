"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  BookOpen,
  Edit,
  Trash2,
  Eye,
  MoreHorizontal,
  CheckCircle2,
  XCircle,
  Clock,
  Code2,
  TrendingUp,
  User,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/page-header";
import { ContentFooter } from "@/components/layout/content-footer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
import { listBlueprints, deleteBlueprint, updateBlueprintStatus } from "@/lib/api";
import type { BlueprintSummary } from "@/types/blueprint";

export default function MyBlueprintsPage() {
  const [blueprints, setBlueprints] = useState<BlueprintSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<BlueprintSummary | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    loadBlueprints();
  }, []);

  async function loadBlueprints() {
    try {
      const response = await listBlueprints({ mine: true, limit: 100 });
      setBlueprints(response.items);
    } catch (error) {
      toast.error("Failed to load blueprints");
    } finally {
      setIsLoading(false);
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return;

    setIsDeleting(true);
    try {
      await deleteBlueprint(deleteTarget.slug);
      setBlueprints((prev) => prev.filter((b) => b.id !== deleteTarget.id));
      toast.success("Blueprint deleted");
    } catch (error) {
      toast.error("Failed to delete blueprint");
    } finally {
      setIsDeleting(false);
      setDeleteTarget(null);
    }
  };

  const handleStatusChange = async (
    slug: string,
    status: "published" | "draft" | "deprecated"
  ) => {
    try {
      await updateBlueprintStatus(slug, { status });
      setBlueprints((prev) =>
        prev.map((b) => (b.slug === slug ? { ...b, status } : b))
      );
      toast.success(`Blueprint ${status}`);
    } catch (error) {
      toast.error("Failed to update status");
    }
  };

  const publishedCount = blueprints.filter((b) => b.status === "published").length;
  const draftCount = blueprints.filter((b) => b.status === "draft").length;

  return (
    <>
      <PageHeader />

      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-8 space-y-8">
          {/* Hero Section */}
          <section className="relative overflow-hidden rounded-2xl border border-border/50 bg-gradient-to-br from-card via-card to-primary/10 p-6 md:p-8">
            <div className="absolute inset-0 dot-pattern opacity-20" />
            <div className="absolute top-0 right-0 w-64 h-64 bg-primary/10 rounded-full blur-3xl" />

            <div className="relative z-10 flex flex-col md:flex-row md:items-center md:justify-between gap-6">
              <div>
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 ring-1 ring-primary/20">
                    <User className="h-5 w-5 text-primary" />
                  </div>
                  <h1 className="text-2xl font-bold tracking-tight">My Blueprints</h1>
                </div>
                <p className="text-muted-foreground max-w-lg">
                  Manage your contributed blueprints. Track performance, update content, and control visibility.
                </p>
              </div>

              <div className="flex items-center gap-3">
                <div className="text-center px-4 py-2 rounded-lg bg-card/50 border border-border/50">
                  <p className="text-2xl font-bold text-primary">{blueprints.length}</p>
                  <p className="text-xs text-muted-foreground">Total</p>
                </div>
                <div className="text-center px-4 py-2 rounded-lg bg-card/50 border border-border/50">
                  <p className="text-2xl font-bold text-emerald-400">{publishedCount}</p>
                  <p className="text-xs text-muted-foreground">Published</p>
                </div>
                <div className="text-center px-4 py-2 rounded-lg bg-card/50 border border-border/50">
                  <p className="text-2xl font-bold text-amber-400">{draftCount}</p>
                  <p className="text-xs text-muted-foreground">Drafts</p>
                </div>
              </div>
            </div>
          </section>

          {/* Blueprints List */}
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="rounded-xl border border-border/50 bg-card/30 p-5">
                  <div className="flex items-center gap-4">
                    <Skeleton className="h-12 w-12 rounded-lg" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-5 w-48" />
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-3 w-32" />
                    </div>
                    <Skeleton className="h-8 w-16" />
                  </div>
                </div>
              ))}
            </div>
          ) : blueprints.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/50 bg-card/20 p-12 text-center">
              <div className="flex justify-center mb-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-muted">
                  <BookOpen className="h-7 w-7 text-muted-foreground" />
                </div>
              </div>
              <h3 className="text-lg font-medium mb-2">No blueprints yet</h3>
              <p className="text-muted-foreground mb-4 max-w-md mx-auto">
                Blueprints are created by AI agents as they discover successful strategies. Use the MCP server or API to create blueprints from your agents.
              </p>
              <Button asChild variant="outline">
                <Link href="/docs/quickstart">
                  Learn How Agents Create Blueprints
                </Link>
              </Button>
            </div>
          ) : (
            <div className="space-y-3 stagger-children">
              {blueprints.map((blueprint, index) => {
                const successRate = Math.round(blueprint.quality_metrics.success_rate * 100);
                const rateColor =
                  successRate >= 80
                    ? "text-emerald-400"
                    : successRate >= 50
                      ? "text-amber-400"
                      : "text-red-400";

                return (
                  <div
                    key={blueprint.id}
                    className="group relative rounded-xl border border-border/50 bg-card/30 p-5 transition-all duration-300 hover:border-border hover:bg-card/50"
                    style={{ animationDelay: `${index * 50}ms` }}
                  >
                    <div className="flex items-center gap-4">
                      <Link
                        href={`/blueprints/${blueprint.short_id}/${blueprint.slug}`}
                        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-primary/10 ring-1 ring-primary/20 transition-transform duration-300 group-hover:scale-105"
                      >
                        <Code2 className="h-6 w-6 text-primary" />
                      </Link>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <Link
                            href={`/blueprints/${blueprint.short_id}/${blueprint.slug}`}
                            className="font-medium truncate hover:text-primary transition-colors"
                          >
                            {blueprint.title}
                          </Link>
                          <Badge
                            variant={
                              blueprint.status === "published"
                                ? "default"
                                : blueprint.status === "draft"
                                  ? "secondary"
                                  : "outline"
                            }
                            className="text-[10px] shrink-0"
                          >
                            {blueprint.status}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground truncate mb-2">
                          {blueprint.goal_description}
                        </p>
                        <div className="flex items-center gap-4 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <TrendingUp className="h-3 w-3" />
                            {blueprint.quality_metrics.execution_count} runs
                          </span>
                          <span className="flex items-center gap-1">
                            <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                            {blueprint.quality_metrics.upvotes}
                          </span>
                          <span className="flex items-center gap-1">
                            <XCircle className="h-3 w-3 text-red-400" />
                            {blueprint.quality_metrics.downvotes}
                          </span>
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {new Date(blueprint.updated_at).toLocaleDateString()}
                          </span>
                        </div>
                      </div>

                      <div className="text-right shrink-0 mr-2">
                        <div className={`text-xl font-bold ${rateColor}`}>
                          {successRate}%
                        </div>
                        <p className="text-xs text-muted-foreground">success</p>
                      </div>

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem asChild>
                            <Link href={`/blueprints/${blueprint.short_id}/${blueprint.slug}`}>
                              <Eye className="mr-2 h-4 w-4" />
                              View
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            <Link href={`/blueprints/${blueprint.short_id}/${blueprint.slug}/edit`}>
                              <Edit className="mr-2 h-4 w-4" />
                              Edit
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          {blueprint.status === "draft" && (
                            <DropdownMenuItem
                              onClick={() => handleStatusChange(blueprint.slug, "published")}
                            >
                              <CheckCircle2 className="mr-2 h-4 w-4" />
                              Publish
                            </DropdownMenuItem>
                          )}
                          {blueprint.status === "published" && (
                            <DropdownMenuItem
                              onClick={() => handleStatusChange(blueprint.slug, "deprecated")}
                            >
                              <Clock className="mr-2 h-4 w-4" />
                              Deprecate
                            </DropdownMenuItem>
                          )}
                          {blueprint.status === "deprecated" && (
                            <DropdownMenuItem
                              onClick={() => handleStatusChange(blueprint.slug, "published")}
                            >
                              <CheckCircle2 className="mr-2 h-4 w-4" />
                              Republish
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => setDeleteTarget(blueprint)}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>

                    <Link
                      href={`/blueprints/${blueprint.short_id}/${blueprint.slug}`}
                      className="absolute inset-0 z-0"
                      aria-hidden="true"
                    />
                  </div>
                );
              })}
            </div>
          )}

        </div>

        <ContentFooter />
      </div>

      {/* Delete Dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10 mb-4 mx-auto">
              <Trash2 className="h-7 w-7 text-destructive" />
            </div>
            <DialogTitle className="text-center">Delete Blueprint</DialogTitle>
            <DialogDescription className="text-center">
              Are you sure you want to delete &quot;{deleteTarget?.title}&quot;?
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={isDeleting}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isDeleting}
              className="flex-1"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
