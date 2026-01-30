import { PageHeader } from "@/components/layout/page-header";
import { Skeleton } from "@/components/ui/skeleton";

export default function BlueprintDetailLoading() {
  return (
    <>
      <PageHeader />

      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-8 space-y-6">
          {/* Hero Section Skeleton */}
          <section className="relative overflow-hidden rounded-2xl border border-border/50 bg-gradient-to-br from-card via-card to-accent/20 p-6 md:p-8">
            <div className="absolute inset-0 dot-pattern opacity-20" />

            <div className="relative z-10">
              <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-6">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-4">
                    <Skeleton className="h-12 w-12 rounded-lg" />
                    <div className="flex items-center gap-2">
                      <Skeleton className="h-5 w-20 rounded-full" />
                      <Skeleton className="h-5 w-16 rounded-full" />
                      <Skeleton className="h-5 w-16 rounded-full" />
                    </div>
                  </div>

                  <Skeleton className="h-9 w-2/3 mb-3" />
                  <Skeleton className="h-5 w-full mb-1" />
                  <Skeleton className="h-5 w-3/4" />
                </div>

                <div className="flex flex-wrap md:flex-col gap-3 shrink-0">
                  <Skeleton className="h-16 w-24 rounded-lg" />
                  <Skeleton className="h-16 w-24 rounded-lg" />
                </div>
              </div>

              <div className="flex items-center gap-3 mt-6 pt-6 border-t border-border/50">
                <Skeleton className="h-9 w-20" />
                <Skeleton className="h-9 w-20" />
                <Skeleton className="h-4 w-24 ml-auto" />
              </div>
            </div>
          </section>

          {/* Author Section Skeleton */}
          <section className="flex items-center gap-4 p-4 rounded-xl border border-border/50 bg-card/30">
            <Skeleton className="h-12 w-12 rounded-full" />
            <div>
              <Skeleton className="h-5 w-32 mb-1" />
              <Skeleton className="h-4 w-24" />
            </div>
          </section>

          {/* Strategy Section Skeleton */}
          <section className="rounded-xl border border-border/50 bg-card/30 p-5">
            <div className="flex items-center gap-3 mb-4">
              <Skeleton className="h-10 w-10 rounded-lg" />
              <div>
                <Skeleton className="h-5 w-20 mb-1" />
                <Skeleton className="h-4 w-32" />
              </div>
            </div>
            <Skeleton className="h-4 w-full mb-2" />
            <Skeleton className="h-4 w-full mb-2" />
            <Skeleton className="h-4 w-2/3" />
          </section>

          {/* Execution Steps Skeleton */}
          <section className="space-y-4">
            <div className="flex items-center gap-3">
              <Skeleton className="h-10 w-10 rounded-lg" />
              <div>
                <Skeleton className="h-5 w-32 mb-1" />
                <Skeleton className="h-4 w-48" />
              </div>
            </div>

            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="rounded-xl border border-border/50 bg-card/30 p-5"
                >
                  <div className="flex items-start gap-4">
                    <Skeleton className="h-10 w-10 rounded-lg shrink-0" />
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <Skeleton className="h-5 w-40" />
                        <Skeleton className="h-5 w-20 rounded-full" />
                      </div>
                      <Skeleton className="h-4 w-full mb-1" />
                      <Skeleton className="h-4 w-3/4" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Code Snippets Skeleton */}
          <section className="space-y-4">
            <div className="flex items-center gap-3">
              <Skeleton className="h-10 w-10 rounded-lg" />
              <div>
                <Skeleton className="h-5 w-28 mb-1" />
                <Skeleton className="h-4 w-36" />
              </div>
            </div>

            <div className="rounded-xl border border-border/50 bg-card/30 overflow-hidden">
              <div className="px-4 py-2.5 bg-muted/30 border-b border-border/50">
                <Skeleton className="h-5 w-24" />
              </div>
              <div className="p-4 bg-zinc-950/50">
                <Skeleton className="h-4 w-full mb-2" />
                <Skeleton className="h-4 w-3/4 mb-2" />
                <Skeleton className="h-4 w-5/6 mb-2" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
