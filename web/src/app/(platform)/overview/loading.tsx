import { Skeleton } from "@/components/ui/skeleton";

export default function OverviewLoading() {
  return (
    <div className="flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-5xl px-6 pb-8 space-y-12">
          {/* Hero Section */}
          <section className="relative overflow-hidden rounded-2xl border border-border bg-card p-8 md:p-12">
            <div className="absolute inset-0 dot-pattern opacity-30" />
            <div className="absolute top-0 right-0 w-96 h-96 bg-primary/10 rounded-full blur-3xl" />

            <div className="relative z-10">
              <Skeleton className="h-10 w-80 mb-4" />
              <Skeleton className="h-6 w-full max-w-xl mb-8" />

              <div className="flex flex-wrap gap-4">
                <Skeleton className="h-11 w-44" />
                <Skeleton className="h-11 w-40" />
              </div>
            </div>
          </section>

          {/* Stats Grid */}
          <section className="grid gap-4 md:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="rounded-xl border border-border bg-card p-6"
              >
                <div className="flex items-center justify-between mb-4">
                  <Skeleton className="h-10 w-10 rounded-lg" />
                  <Skeleton className="h-4 w-4" />
                </div>
                <Skeleton className="h-9 w-16 mb-1" />
                <Skeleton className="h-4 w-24" />
              </div>
            ))}
          </section>

          {/* Quick Actions */}
          <section className="space-y-6">
            <div>
              <Skeleton className="h-6 w-32 mb-2" />
              <Skeleton className="h-4 w-48" />
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              {[1, 2, 3, 4].map((i) => (
                <div
                  key={i}
                  className="rounded-xl border border-border bg-card p-5"
                >
                  <Skeleton className="h-5 w-5 mb-4" />
                  <Skeleton className="h-5 w-28 mb-1" />
                  <Skeleton className="h-4 w-24" />
                </div>
              ))}
            </div>
          </section>

          {/* Recent Experiences */}
          <section className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <Skeleton className="h-6 w-40 mb-2" />
                <Skeleton className="h-4 w-56" />
              </div>
              <Skeleton className="h-9 w-20" />
            </div>

            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="rounded-xl border border-border bg-card p-5"
                >
                  <div className="flex items-start gap-4">
                    <Skeleton className="h-12 w-12 rounded-lg shrink-0" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-5 w-48" />
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-3 w-32" />
                    </div>
                    <div className="text-right">
                      <Skeleton className="h-8 w-14 mb-1" />
                      <Skeleton className="h-3 w-12" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Getting Started */}
          <section className="relative overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/5 via-card to-card p-8">
            <div className="relative z-10">
              <div className="flex items-center gap-3 mb-6">
                <Skeleton className="h-10 w-10 rounded-lg" />
                <Skeleton className="h-6 w-36" />
              </div>

              <div className="grid gap-6 md:grid-cols-3">
                {[1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="rounded-xl border border-border bg-card p-5"
                  >
                    <Skeleton className="h-8 w-8 rounded-full mb-4" />
                    <Skeleton className="h-5 w-28 mb-2" />
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-3/4 mt-1" />
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>

      </div>
  );
}
