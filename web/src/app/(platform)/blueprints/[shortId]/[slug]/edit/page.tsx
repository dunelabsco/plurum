"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { ArrowLeft, AlertCircle, Edit } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { ContentFooter } from "@/components/layout/content-footer";
import { BlueprintForm } from "@/components/blueprints";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { getBlueprint } from "@/lib/api";
import type { BlueprintDetail } from "@/types/blueprint";

interface PageProps {
  params: Promise<{ shortId: string; slug: string }>;
}

export default function EditBlueprintPage({ params }: PageProps) {
  const { shortId } = use(params);
  const [blueprint, setBlueprint] = useState<BlueprintDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadBlueprint() {
      try {
        const data = await getBlueprint(shortId);
        setBlueprint(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load blueprint");
      } finally {
        setIsLoading(false);
      }
    }
    loadBlueprint();
  }, [shortId]);

  if (isLoading) {
    return (
      <>
        <PageHeader />
        <div className="flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-5xl px-6 py-8 space-y-6">
            <div className="rounded-2xl border border-border/50 bg-card/30 p-6 md:p-8">
              <div className="flex items-start gap-4 mb-4">
                <Skeleton className="h-10 w-10 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-7 w-48" />
                  <Skeleton className="h-4 w-96" />
                </div>
              </div>
            </div>
            <Skeleton className="h-48 rounded-xl" />
            <Skeleton className="h-32 rounded-xl" />
          </div>
        </div>
      </>
    );
  }

  if (error || !blueprint) {
    return (
      <>
        <PageHeader />
        <div className="flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-5xl px-6 py-8">
            <div className="rounded-xl border border-dashed border-destructive/30 bg-destructive/5 p-12 text-center">
              <div className="flex justify-center mb-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-destructive/10">
                  <AlertCircle className="h-7 w-7 text-destructive" />
                </div>
              </div>
              <h3 className="text-lg font-medium mb-2">Blueprint not found</h3>
              <p className="text-muted-foreground mb-6 max-w-sm mx-auto">
                {error || "This blueprint doesn't exist or has been removed"}
              </p>
              <Button asChild>
                <Link href="/blueprints">
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Back to Blueprints
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader />

      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-8 space-y-6">
          {/* Hero Section */}
          <section className="relative overflow-hidden rounded-2xl border border-border/50 bg-gradient-to-br from-card via-card to-accent/20 p-6 md:p-8">
            <div className="absolute inset-0 dot-pattern opacity-20" />
            <div className="absolute top-0 right-0 w-64 h-64 bg-primary/10 rounded-full blur-3xl" />

            <div className="relative z-10">
              <div className="flex items-center gap-3 mb-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 ring-1 ring-primary/20">
                  <Edit className="h-5 w-5 text-primary" />
                </div>
                <div className="flex items-center gap-2">
                  <h1 className="text-2xl font-bold tracking-tight">Edit Blueprint</h1>
                  <Badge variant="secondary" className="text-[10px]">
                    v{blueprint.current_version?.version_number || 1}
                  </Badge>
                </div>
              </div>
              <p className="text-muted-foreground max-w-2xl">
                Update your blueprint. This will create a new version while
                preserving the version history.
              </p>
            </div>
          </section>

          <BlueprintForm mode="edit" blueprint={blueprint} />
        </div>

        <ContentFooter />
      </div>
    </>
  );
}
