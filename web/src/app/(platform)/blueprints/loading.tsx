import { PageHeader } from "@/components/layout/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Sparkles } from "lucide-react";

export default function BlueprintsLoading() {
  return (
    <>
      <PageHeader />

      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-8 space-y-8">
          {/* Hero Section Skeleton */}
          <section className="relative overflow-hidden rounded-2xl border border-border/50 bg-gradient-to-br from-card via-card to-accent/20 p-6 md:p-8">
            <div className="absolute inset-0 dot-pattern opacity-20" />
            <div className="relative z-10 flex flex-col md:flex-row md:items-center md:justify-between gap-6">
              <div>
                <div className="flex items-center gap-3 mb-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 ring-1 ring-primary/20">
                    <Sparkles className="h-5 w-5 text-primary" />
                  </div>
                  <h1 className="text-2xl font-bold tracking-tight">Blueprint Library</h1>
                </div>
                <Skeleton className="h-5 w-96 max-w-full" />
              </div>
              <Skeleton className="h-16 w-24 rounded-lg" />
            </div>
          </section>

          {/* Filters Skeleton */}
          <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center">
            <Skeleton className="h-10 w-full max-w-md" />
            <Skeleton className="h-10 w-48 sm:ml-auto" />
            <Skeleton className="h-10 w-32" />
            <Skeleton className="h-10 w-20" />
          </div>

          {/* Grid Skeleton */}
          <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="rounded-xl border border-border/50 bg-card/30 p-5">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <Skeleton className="h-10 w-10 rounded-lg" />
                  <Skeleton className="h-6 w-14 rounded-full" />
                </div>
                <Skeleton className="h-5 w-3/4 mb-2" />
                <Skeleton className="h-4 w-full mb-1" />
                <Skeleton className="h-4 w-2/3 mb-4" />
                <div className="flex items-center gap-3">
                  <Skeleton className="h-4 w-12" />
                  <Skeleton className="h-4 w-12" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
